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
    const bold = (s) => s.replace(/\*\*(.+?)\*\*/g,
