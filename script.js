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

  let history = []; // the conversation sent to Gemini
  let busy = false;

  // ---------- Apply settings from config.js ----------
  document.title = C.name + " " + C.emoji;
  $("botName").textContent = C.name;
  $("botEmoji").textContent = C.emoji;
  $("botTagline").textContent = C.tagline;
  document.documentElement.style.setProperty("--accent", C.themeColor);

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
    if (key) saveKey(key, rememberBox.checked);
    dialog.close();
  });
  $("clearKeyBtn").addEventListener("click", () => { clearKey(); dialog.close(); });

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
  function addMessage(role, text, isError) {
    const div = document.createElement("div");
    div.className = "msg " + role + (isError ? " error" : "");
    if (role === "bot") div.innerHTML = formatText(text);
    else div.textContent = text;
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
    history.push({ role: "user", parts: [{ text }] });

    busy = true;
    sendBtn.disabled = true;
    const typing = showTyping();

    try {
      const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(C.model) + ":generateContent";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: C.systemInstruction }] },
          contents: history,
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
      addMessage("bot", reply);
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
  input.addEventListener("input", resizeInput);
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

  newChat();
})();
