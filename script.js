(function () {
  const C = BOT_CONFIG;
  const $ = (id) => document.getElementById(id);

  const messagesEl = $("messages");
  const startersEl = $("starters");
  const form = $("chatForm");
  const input = $("input");
  const sendBtn = $("sendBtn");
  const dialog = $("keyDialog");
  const keyInput = $("keyInput");
  const rememberBox = $("rememberBox");

  let history = []; // the conversation sent to Gemini (plain questions, no notes)
  let busy = false;

  // ---------- Apply settings from config.js ----------
  document.title = C.name + " " + C.emoji;
  $("botName").textContent = C.name;
  $("botEmoji").textContent = C.emoji;
  $("botTagline").textContent = C.tagline;
  document.documentElement.style.setProperty("--accent", C.themeColor);

  // ---------- Character limit ----------
  const MAX = C.maxMessageLength || 500;
  input.maxLength = MAX; // stops typing and pasting past the limit
  const counter = document.createElement("div");
  counter.style.cssText = "font-size:0.75rem;text-align:right;padding:0 16px;color:var(--muted);visibility:hidden;";
  form.parentNode.insertBefore(counter, form);
  function updateCounter() {
    const n = input.value.length;
    counter.textContent = n + " / " + MAX;
    counter.style.visibility = n > 0 ? "visible" : "hidden";
    counter.style.color = n >= MAX ? "var(--error-text)" : "var(--muted)";
    counter.style.fontWeight = n >= MAX ? "600" : "normal";
  }

  // ---------- Knowledge (RAG) settings ----------
  const USE_KB = C.useKnowledge === true;
  const KB_FILE = C.knowledgeFile || "knowledge.md";
  const WANT_METHOD = C.searchMethod === "keywords" ? "keywords" : "meaning";
  const TOP_K = Math.max(1, parseInt(C.topK, 10) || 3);
  const EMBED_MODEL = C.embeddingModel || "gemini-embedding-2";
  const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
  const MAX_NOTE_CHARS = 1500; // longer notes are split at blank lines
  const BATCH_SIZE = 50;       // notes per embedding request
  const KB_STORAGE_KEY = "bot_kb_vectors";

  const KB = {
    notes: [],          // [{ title, text, part, parts }]
    vectors: null,      // one list of numbers per note
    method: WANT_METHOD,
    fingerprint: "",
    embedPromise: null,
  };

  // ---------- Status line under the header ----------
  let statusEl = null;
  if (USE_KB) {
    statusEl = document.createElement("div");
    statusEl.className = "kb-status";
    statusEl.setAttribute("role", "status");
    statusEl.textContent = "📚 Loading notes…";
    document.querySelector("header").insertAdjacentElement("afterend", statusEl);
  }
  function setStatus(text, warn) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle("warn", !!warn);
  }
  function showLoadedStatus(extra) {
    const n = KB.notes.length;
    const label = KB.method === "meaning" ? "meaning search" : "keyword search";
    setStatus("📚 " + n + (n === 1 ? " note" : " notes") + " loaded · " + label + (extra ? " " + extra : ""), false);
  }

  // ---------- API key storage (always wrapped in try/catch) ----------
  function getKey() {
    try { const k = sessionStorage.getItem("bot_api_key"); if (k) return k; } catch (e) {}
    try { return localStorage.getItem("bot_api_key") || ""; } catch (e) {}
    return "";
  }
  function saveKey(key, remember) {
    try { sessionStorage.setItem("bot_api_key", key); } catch (e) {}
    try {
      if (remember) localStorage.setItem("bot_api_key", key);
      else localStorage.removeItem("bot_api_key");
    } catch (e) {}
  }
  function clearKey() {
    try { sessionStorage.removeItem("bot_api_key"); } catch (e) {}
    try { localStorage.removeItem("bot_api_key"); } catch (e) {}
  }
  function openKeyDialog() {
    keyInput.value = "";
    try { rememberBox.checked = !!localStorage.getItem("bot_api_key"); } catch (e) { rememberBox.checked = false; }
    dialog.showModal();
  }

  $("keyBtn").addEventListener("click", openKeyDialog);
  $("cancelKeyBtn").addEventListener("click", () => dialog.close());
  $("saveKeyBtn").addEventListener("click", () => {
    const key = keyInput.value.trim();
    if (key) {
      saveKey(key, rememberBox.checked);
      onKeySaved();
    }
    dialog.close();
  });
  $("clearKeyBtn").addEventListener("click", () => { clearKey(); dialog.close(); });

  // ---------- Reading knowledge.md ----------
  function splitLong(body) {
    if (body.length <= MAX_NOTE_CHARS) return [body];
    const parts = [];
    let cur = "";
    body.split(/\n\s*\n/).forEach((p) => {
      p = p.trim();
      if (!p) return;
      if (cur && cur.length + p.length + 2 > MAX_NOTE_CHARS) {
        parts.push(cur);
        cur = p;
      } else {
        cur = cur ? cur + "\n\n" + p : p;
      }
    });
    if (cur) parts.push(cur);
    return parts;
  }
  function parseNotes(md) {
    const notes = [];
    let title = null;
    let buf = [];
    function flush() {
      if (title === null) return;
      const body = buf.join("\n").trim();
      if (!body) return;
      const parts = splitLong(body);
      parts.forEach((text, i) => notes.push({ title, text, part: i + 1, parts: parts.length }));
    }
    md.replace(/\r/g, "").split("\n").forEach((line) => {
      const m = line.match(/^##\s+(.+?)\s*$/);
      if (m) { flush(); title = m[1]; buf = []; }
      else if (title !== null) buf.push(line); // lines above the first ## are ignored
    });
    flush();
    return notes;
  }
  function noteLabel(n) {
    return n.title + (n.parts > 1 ? " (part " + n.part + " of " + n.parts + ")" : "");
  }
  function fingerprint(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16) + "-" + str.length;
  }

  // ---------- Embeddings (meaning search) ----------
  async function embedTexts(texts, key) {
    const url = API_BASE + encodeURIComponent(EMBED_MODEL) + ":batchEmbedContents";
    const out = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          requests: batch.map((t) => ({
            model: "models/" + EMBED_MODEL,
            content: { parts: [{ text: t }] },
          })),
        }),
      });
      if (!res.ok) throw { status: res.status };
      const data = await res.json();
      const list = data.embeddings || [];
      if (list.length !== batch.length) throw { empty: true };
      list.forEach((e) => {
        if (!e || !e.values || !e.values.length) throw { empty: true };
        out.push(e.values);
      });
    }
    return out;
  }
  function readStoredVectors(fp) {
    try {
      const raw = localStorage.getItem(KB_STORAGE_KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (saved && saved.fp === fp && Array.isArray(saved.vectors)) return saved.vectors;
    } catch (e) {}
    return null;
  }
  function storeVectors(fp, vectors) {
    try {
      // rounding keeps the saved data smaller
      const small = vectors.map((v) => v.map((x) => Math.round(x * 1e5) / 1e5));
      localStorage.setItem(KB_STORAGE_KEY, JSON.stringify({ fp, vectors: small }));
    } catch (e) {}
  }
  async function runEmbeddings() {
    const key = getKey();
    try {
      let vectors = readStoredVectors(KB.fingerprint);
      if (!vectors || vectors.length !== KB.notes.length) {
        setStatus("📚 Reading " + KB.notes.length + " notes…", false);
        const texts = KB.notes.map((n) => "title: " + n.title + " | text: " + n.text);
        vectors = await embedTexts(texts, key);
        storeVectors(KB.fingerprint, vectors);
      }
      KB.vectors = vectors;
      KB.method = "meaning";
      showLoadedStatus();
      return true;
    } catch (e) {
      KB.method = "keywords";
      showLoadedStatus("(meaning search unavailable)");
      return false;
    }
  }
  function prepareEmbeddings() {
    if (KB.vectors) return Promise.resolve(true);
    if (!getKey()) return Promise.resolve(false);
    if (!KB.embedPromise) KB.embedPromise = runEmbeddings();
    return KB.embedPromise;
  }
  function onKeySaved() {
    if (!USE_KB || KB.notes.length === 0) return;
    if (WANT_METHOD === "meaning" && !KB.vectors) {
      KB.method = "meaning";
      KB.embedPromise = null;
      prepareEmbeddings();
    }
  }

  // ---------- Searching the notes ----------
  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  }
  function topNotes(scores, dropZeros) {
    let list = scores.map((s, i) => ({ note: KB.notes[i], score: s }));
    if (dropZeros) list = list.filter((x) => x.score > 0);
    return list.sort((x, y) => y.score - x.score).slice(0, TOP_K);
  }
  const STOP = new Set(("the and for are but not you your with this that have from they will would there their " +
    "what when where which who how can could should about into than then them these those been being was were " +
    "has had does did its our out any all use les des une est que qui dans pour par sur pas ces cet cette aux " +
    "nous vous ils elles mon mes ton tes son ses avec sont plus tout tous comment quoi").split(" "));
  function tokens(text) {
    return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w))
      .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w));
  }
  function keywordSearch(question) {
    const q = Array.from(new Set(tokens(question)));
    if (!q.length) return [];
    const scores = KB.notes.map((n) => {
      const inTitle = new Set(tokens(n.title));
      const inText = new Set(tokens(n.text));
      let got = 0;
      q.forEach((w) => {
        if (inTitle.has(w)) got += 2;
        else if (inText.has(w)) got += 1;
      });
      return got / (q.length * 2);
    });
    return topNotes(scores, true);
  }
  async function retrieve(question) {
    if (!USE_KB || KB.notes.length === 0) return [];
    if (KB.method === "meaning") await prepareEmbeddings(); // may switch to keywords
    if (KB.method === "meaning" && KB.vectors) {
      try {
        const q = await embedTexts(["task: search result | query: " + question], getKey());
        return topNotes(KB.vectors.map((v) => cosine(q[0], v)), false);
      } catch (e) {
        KB.method = "keywords";
        showLoadedStatus("(meaning search unavailable)");
      }
    }
    return keywordSearch(question);
  }
  function buildPrompt(question, hits) {
    let p = "NOTES:\n";
    if (hits.length === 0) p += "(No matching notes were found.)\n";
    hits.forEach((h, i) => {
      p += "\n[" + (i + 1) + "] " + noteLabel(h.note) + "\n" + h.note.text + "\n";
    });
    return p + "\nQUESTION:\n" + question;
  }

  // ---------- Safe formatting: escape HTML first, then **bold** and bullets ----------
  function formatText(text) {
    const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const bold = (s) => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    let html = "";
    let inList = false;
    esc.split("\n").forEach((line) => {
      const m = line.match(/^\s*[*-]\s+(.*)/);
      if (m) {
        if (!inList) { html += "<ul>"; inList = true; }
        html += "<li>" + bold(m[1]) + "</li>";
      } else {
        if (inList) { html += "</ul>"; inList = false; }
        if (line.trim()) html += "<p>" + bold(line) + "</p>";
      }
    });
    if (inList) html += "</ul>";
    return html;
  }

  // ---------- Chat bubbles ----------
  function addSources(bubble, hits) {
    const box = document.createElement("details");
    box.className = "sources";
    const sum = document.createElement("summary");
    sum.textContent = "Sources (" + hits.length + ")";
    box.appendChild(sum);
    hits.forEach((h, i) => {
      const item = document.createElement("div");
      item.className = "source";
      const head = document.createElement("div");
      head.className = "source-head";
      head.textContent = "[" + (i + 1) + "] " + noteLabel(h.note) + " · score " + h.score.toFixed(2);
      const body = document.createElement("div");
      body.className = "source-text";
      const t = h.note.text.replace(/\s+/g, " ");
      body.textContent = t.length > 200 ? t.slice(0, 200) + "…" : t;
      item.appendChild(head);
      item.appendChild(body);
      box.appendChild(item);
    });
    bubble.appendChild(box);
  }
  function addMessage(role, text, isError, hits) {
    const div = document.createElement("div");
    div.className = "msg " + role + (isError ? " error" : "");
    if (role === "bot") div.innerHTML = formatText(text);
    else div.textContent = text;
    if (hits && hits.length) addSources(div, hits);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }
  function showTyping() {
    const div = document.createElement("div");
    div.className = "msg bot typing";
    div.innerHTML = "<span></span><span></span><span></span>";
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  // ---------- Friendly errors ----------
  function friendlyError(err) {
    const s = err && err.status;
    if (s === 400 || s === 403) return "Your API key looks wrong or isn't allowed. Click \"API key\" and paste a valid key.";
    if (s === 404) return "The AI model name wasn't found. Check the \"model\" line in config.js.";
    if (s === 429) return "Too many requests right now. Please wait a minute and try again.";
    if (s >= 500) return "Google's servers are having trouble. Please try again in a moment.";
    if (s) return "Something went wrong (error " + s + "). Please try again.";
    if (err && err.empty) return "I didn't get an answer that time. Please try rephrasing your message.";
    return "I can't reach the internet. Check your connection and try again.";
  }

  // ---------- Sending a message ----------
  async function send(text) {
    text = text.trim();
    if (!text || busy) return;

    if (text.length > MAX) {
      addMessage("bot", "Your message is too long. Please keep it under " + MAX + " characters.", true);
      return;
    }

    const key = getKey();
    if (!key) {
      addMessage("bot", "Please add your API key first (top right), then send your message again.", true);
      openKeyDialog();
      return;
    }

    startersEl.innerHTML = "";
    addMessage("user", text);
    input.value = "";
    resizeInput();
    updateCounter();
    history.push({ role: "user", parts: [{ text }] }); // plain question only

    busy = true;
    sendBtn.disabled = true;
    const typing = showTyping();

    try {
      // Find the best notes, then attach them to this one question only
      const hits = await retrieve(text);
      const useNotes = USE_KB && KB.notes.length > 0;
      const contents = history.slice(0, -1).concat([
        { role: "user", parts: [{ text: useNotes ? buildPrompt(text, hits) : text }] },
      ]);
      const system = C.systemInstruction + (useNotes && C.knowledgeRules ? "\n\n" + C.knowledgeRules : "");

      const url = API_BASE + encodeURIComponent(C.model) + ":generateContent";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: contents,
        }),
      });
      if (!res.ok) throw { status: res.status };
      const data = await res.json();
      const parts = (data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts) || [];
      const reply = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("");
      if (!reply) throw { empty: true };
      history.push({ role: "model", parts: [{ text: reply }] });
      typing.remove();
      addMessage("bot", reply, false, hits);
    } catch (err) {
      typing.remove();
      history.pop(); // forget the failed message so you can retry
      addMessage("bot", friendlyError(err), true);
    } finally {
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  // ---------- Starters and new chat ----------
  function showStarters() {
    startersEl.innerHTML = "";
    C.starterQuestions.forEach((q) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = q;
      b.addEventListener("click", () => send(q));
      startersEl.appendChild(b);
    });
  }
  function newChat() {
    if (busy) return;
    history = [];
    messagesEl.innerHTML = "";
    addMessage("bot", C.welcomeMessage);
    showStarters();
  }
  $("newChatBtn").addEventListener("click", newChat);

  // ---------- Input handling ----------
  function resizeInput() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  }
  input.addEventListener("input", () => { resizeInput(); updateCounter(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(input.value);
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    send(input.value);
  });

  // ---------- Load the notes when the page opens ----------
  async function loadKnowledge() {
    if (!USE_KB) return;
    let md = "";
    try {
      const res = await fetch(KB_FILE, { cache: "no-cache" });
      if (!res.ok) throw new Error("missing");
      md = await res.text();
    } catch (e) {
      setStatus("⚠️ Couldn't find " + KB_FILE + ". Add it to your repository, next to index.html.", true);
      return;
    }
    KB.notes = parseNotes(md);
    if (KB.notes.length === 0) {
      setStatus("⚠️ " + KB_FILE + " has no notes yet. Start each note with a line like \"## My note title\".", true);
      return;
    }
    KB.fingerprint = fingerprint(EMBED_MODEL + "\n" + md);
    KB.method = WANT_METHOD;
    if (WANT_METHOD === "keywords") {
      showLoadedStatus();
    } else if (getKey()) {
      prepareEmbeddings();
    } else {
      const n = KB.notes.length;
      setStatus("📚 " + n + (n === 1 ? " note" : " notes") + " loaded · add your API key to turn on meaning search", false);
    }
  }

  newChat();
  loadKnowledge();
})();
