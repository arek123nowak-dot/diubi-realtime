(function () {
  const HOST_ID = "diubi-overlay-host";
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    document.documentElement.appendChild(host);
  }
  const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap {
        position: fixed;
        right: 16px;
        bottom: 16px;
        width: 420px;
        max-width: calc(100vw - 32px);
        background: #171a21;
        color: #e8eaed;
        border: 1px solid #2a2f3a;
        border-radius: 12px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
        z-index: 2147483647;
        overflow: hidden;
        display: none;
      }
      .wrap.visible { display: block; }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 12px;
        border-bottom: 1px solid #2a2f3a;
        font-size: 12px;
        color: #8a92a3;
        cursor: move;
        user-select: none;
      }
      .closeBtn { background: none; border: none; color: #8a92a3; cursor: pointer; font-size: 16px; line-height: 1; }
      .reel { max-height: 220px; overflow-y: auto; scroll-behavior: smooth; }
      .row { display: grid; grid-template-columns: 1fr 1fr; border-bottom: 1px solid #2a2f3a; }
      .cell { padding: 10px 12px; font-size: 0.9rem; line-height: 1.4; transition: background-color 0.3s ease; }
      .cell.original { border-right: 1px solid #2a2f3a; background: rgba(255, 107, 107, 0.07); }
      .cell.original.active { background: rgba(255, 107, 107, 0.22); }
      .cell.translation { background: rgba(76, 175, 80, 0.07); font-weight: 500; }
      .cell.translation.active { background: rgba(76, 175, 80, 0.22); }
      .cell.translation.failed { background: rgba(255, 107, 107, 0.15); font-style: italic; font-weight: 400; color: #8a92a3; }
      .status { padding: 6px 12px; font-size: 11px; color: #8a92a3; min-height: 1.3em; }
      .headerBtns { display: flex; gap: 10px; align-items: center; }
      .notebookBtn { background: none; border: none; color: #8a92a3; cursor: pointer; font-size: 14px; line-height: 1; }

      /* Word/phrase lookup — selecting text in the original column shows
         this, same idea and markup as the web app's version (public/app.js),
         just scoped into this shadow tree so it can't leak host-page styles
         in or its own styles out. */
      .word {
        cursor: pointer;
        border-radius: 3px;
        padding: 0 1px;
        transition: background-color 0.15s ease;
      }
      .word:hover { background: rgba(79, 140, 255, 0.35); }
      .word-badge {
        position: fixed;
        transform: translate(-50%, -100%);
        background: #4f8cff;
        color: white;
        border-radius: 999px;
        padding: 3px 10px;
        font-size: 0.7rem;
        font-weight: 600;
        pointer-events: none;
        z-index: 2147483647;
        white-space: nowrap;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2147483647;
        padding: 16px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .modal-card {
        background: #171a21;
        color: #e8eaed;
        border: 1px solid #2a2f3a;
        border-radius: 14px;
        padding: 20px 22px;
        max-width: 420px;
        width: 100%;
        max-height: 80vh;
        overflow-y: auto;
      }
      .modal-card h2 { font-size: 1.05rem; margin: 0 0 4px; }
      .modal-card .phrase-src { color: #8a92a3; font-size: 0.8rem; margin: 0 0 14px; font-style: italic; }
      .modal-card .field-label { color: #8a92a3; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; margin: 14px 0 3px; }
      .modal-card .field-value { font-size: 0.95rem; line-height: 1.45; }
      .modal-card .modal-actions { display: flex; gap: 10px; margin-top: 20px; }
      .modal-card .modal-actions button { flex: 1; padding: 10px 14px; border: none; border-radius: 8px; font-size: 0.9rem; font-weight: 600; cursor: pointer; }
      .btn-remember { background: #4f8cff; color: white; }
      .btn-remember[disabled] { background: #2a2f3a; color: #8a92a3; cursor: default; }
      .btn-close { background: #2a2f3a; color: #e8eaed; }
      .modal-card .loading, .modal-card .error-text { color: #8a92a3; font-size: 0.88rem; }
      .modal-card .error-text { color: #ff5a5a; }
      .notebook-list { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
      .notebook-item { border: 1px solid #2a2f3a; border-radius: 10px; padding: 12px 14px; position: relative; }
      .notebook-item .np-phrase { font-weight: 700; font-size: 0.95rem; }
      .notebook-item .np-translation { color: #4f8cff; margin-top: 2px; }
      .notebook-item .np-context { color: #8a92a3; font-size: 0.8rem; margin-top: 6px; font-style: italic; }
      .notebook-item .np-meta { color: #8a92a3; font-size: 0.7rem; margin-top: 8px; }
      .notebook-item .np-delete { position: absolute; top: 10px; right: 10px; background: none; border: none; color: #8a92a3; font-size: 1rem; padding: 2px 6px; cursor: pointer; }
      .notebook-empty { color: #8a92a3; font-size: 0.88rem; text-align: center; padding: 20px 0; }
    </style>
    <div class="wrap" id="wrap">
      <div class="header" id="dragHandle">
        <span>DIUBI</span>
        <div class="headerBtns">
          <button class="notebookBtn" id="notebookBtn" title="Moj pamietnik">📖</button>
          <button class="closeBtn" id="closeBtn" title="Zatrzymaj i ukryj">×</button>
        </div>
      </div>
      <div class="status" id="status"></div>
      <div class="reel" id="reel"></div>
    </div>
  `;

  const wrapEl = shadow.getElementById("wrap");
  const reelEl = shadow.getElementById("reel");
  const statusEl = shadow.getElementById("status");

  shadow.getElementById("closeBtn").addEventListener("click", () => {
    wrapEl.classList.remove("visible");
    chrome.runtime.sendMessage({ type: "popup-stop" });
  });

  makeDraggable(shadow.getElementById("dragHandle"), wrapEl);

  const rows = new Map();

  function getOrCreateRow(id) {
    let row = rows.get(id);
    if (!row) {
      const el = document.createElement("div");
      el.className = "row";
      const originalCell = document.createElement("div");
      originalCell.className = "cell original";
      const translationCell = document.createElement("div");
      translationCell.className = "cell translation";
      el.append(originalCell, translationCell);
      reelEl.appendChild(el);
      row = { el, originalCell, translationCell };
      rows.set(id, row);
    }
    return row;
  }

  function claimRow(segmentId) {
    const pending = rows.get("pending");
    if (pending) {
      rows.delete("pending");
      rows.set(segmentId, pending);
      return pending;
    }
    return getOrCreateRow(segmentId);
  }

  function pruneOldRows() {
    while (rows.size > 30) {
      const oldestId = rows.keys().next().value;
      rows.get(oldestId).el.remove();
      rows.delete(oldestId);
    }
  }

  function scrollToBottom() {
    reelEl.scrollTop = reelEl.scrollHeight;
  }

  let currentTargetLang = "pl";

  function handleEvent(msg) {
    switch (msg.type) {
      case "status":
      case "error":
        statusEl.textContent = msg.message;
        break;
      case "transcript_delta": {
        const row = getOrCreateRow("pending");
        row.originalCell.textContent += msg.text;
        row.originalCell.classList.add("active");
        scrollToBottom();
        break;
      }
      case "transcript_final": {
        const row = claimRow(msg.segmentId);
        renderClickableWords(row.originalCell, msg.text);
        row.originalCell.classList.remove("active");
        scrollToBottom();
        break;
      }
      case "translation_delta": {
        const row = getOrCreateRow(msg.segmentId);
        row.translationCell.textContent += msg.text;
        row.translationCell.classList.add("active");
        scrollToBottom();
        break;
      }
      case "translation_final": {
        const row = getOrCreateRow(msg.segmentId);
        row.translationCell.textContent = msg.text;
        row.translationCell.classList.remove("active");
        pruneOldRows();
        scrollToBottom();
        break;
      }
      case "translation_error": {
        const row = getOrCreateRow(msg.segmentId);
        row.translationCell.textContent = "Nie udalo sie przetlumaczyc tej linii.";
        row.translationCell.classList.remove("active");
        row.translationCell.classList.add("failed");
        scrollToBottom();
        break;
      }
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "show-overlay") {
      rows.clear();
      reelEl.innerHTML = "";
      statusEl.textContent = "";
      wrapEl.classList.add("visible");
      if (message.targetLang) currentTargetLang = message.targetLang;
    } else if (message.type === "hide-overlay") {
      wrapEl.classList.remove("visible");
    } else if (message.type === "caption-event") {
      handleEvent(message.payload);
    }
  });

  function makeDraggable(handle, target) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      const rect = target.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      target.style.right = "auto";
      target.style.bottom = "auto";
      target.style.left = `${e.clientX - offsetX}px`;
      target.style.top = `${e.clientY - offsetY}px`;
    });

    document.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  // -------------------------------------------------------------------------
  // Word/phrase lookup + Moj pamietnik — same feature and backend endpoints
  // as public/app.js, just living inside this overlay's shadow tree instead
  // of the host page's document, and reading real page context (document
  // title + URL) instead of the web app's loaded-source metadata, since the
  // extension runs directly on the real page rather than an embedded player.
  // -------------------------------------------------------------------------
  const BACKEND_HTTP_URL = "http://localhost:3000"; // see README known limitations re: BACKEND_WS_URL

  function getUserId() {
    return new Promise((resolve) => {
      chrome.storage.local.get("diubiUserId", ({ diubiUserId }) => {
        if (diubiUserId) {
          resolve(diubiUserId);
        } else {
          const id = crypto.randomUUID();
          chrome.storage.local.set({ diubiUserId: id }, () => resolve(id));
        }
      });
    });
  }

  function currentSourceMeta() {
    return { sourceLabel: (document.title || location.hostname).slice(0, 120), sourceUrl: location.href };
  }

  /** Same tokenizer as public/app.js — see the comment there for why this
   * replaced a text-selection based picker: host pages like YouTube
   * commonly suppress selection globally (so dragging the seek bar etc.
   * doesn't accidentally select page text), which silently broke the
   * selection approach here specifically, even though it worked fine on
   * DIUBI's own web app page. Hover+click never touches the Selection API,
   * so it isn't exposed to that at all. */
  function renderClickableWords(cell, text) {
    cell.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const token of text.split(/(\s+)/)) {
      if (token === "") continue;
      if (/^\s+$/.test(token)) {
        frag.appendChild(document.createTextNode(token));
      } else {
        const span = document.createElement("span");
        span.className = "word";
        span.textContent = token;
        frag.appendChild(span);
      }
    }
    cell.appendChild(frag);
  }

  let wordBadge = null;

  function showWordBadge(wordEl) {
    removeWordBadge();
    const rect = wordEl.getBoundingClientRect();
    const badge = document.createElement("div");
    badge.className = "word-badge";
    badge.textContent = "Wyjasnij ⭐";
    badge.style.left = `${rect.left + rect.width / 2}px`;
    badge.style.top = `${rect.top - 6}px`;
    shadow.appendChild(badge);
    wordBadge = badge;
  }

  function removeWordBadge() {
    if (wordBadge) {
      wordBadge.remove();
      wordBadge = null;
    }
  }

  reelEl.addEventListener("mouseover", (e) => {
    const wordEl = e.target.closest(".word");
    if (wordEl) showWordBadge(wordEl);
  });
  reelEl.addEventListener("mouseout", (e) => {
    if (e.target.closest(".word")) removeWordBadge();
  });
  reelEl.addEventListener("click", (e) => {
    const wordEl = e.target.closest(".word");
    if (!wordEl) return;
    const cell = wordEl.closest(".cell.original");
    if (!cell) return;
    const phrase = wordEl.textContent.replace(/^[.,!?;:"'()]+|[.,!?;:"'()]+$/g, "");
    if (!phrase) return;
    removeWordBadge();
    openExplainCard(phrase, cell.textContent);
  });

  function openModal(innerHtml) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `<div class="modal-card">${innerHtml}</div>`;
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    shadow.appendChild(overlay);
    return overlay;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }

  function formatDate(ms) {
    if (!ms) return "";
    return new Date(ms).toLocaleDateString("pl-PL", { day: "numeric", month: "short" });
  }

  async function openExplainCard(phrase, contextSentence) {
    const overlay = openModal(`
      <h2>${escapeHtml(phrase)}</h2>
      <p class="phrase-src">${escapeHtml(contextSentence)}</p>
      <p class="loading">Szukam wyjasnienia...</p>
    `);

    let data;
    try {
      const res = await fetch(`${BACKEND_HTTP_URL}/api/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase, contextSentence, targetLang: currentTargetLang }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      overlay.querySelector(".modal-card").innerHTML = `
        <h2>${escapeHtml(phrase)}</h2>
        <p class="error-text">Nie udalo sie pobrac wyjasnienia: ${escapeHtml(err.message)}</p>
        <div class="modal-actions"><button class="btn-close">Zamknij</button></div>
      `;
      overlay.querySelector(".btn-close").addEventListener("click", () => overlay.remove());
      return;
    }

    const card = overlay.querySelector(".modal-card");
    card.innerHTML = `
      <h2>${escapeHtml(phrase)}</h2>
      <p class="phrase-src">${escapeHtml(contextSentence)}</p>
      <div class="field-label">Tlumaczenie</div>
      <div class="field-value">${escapeHtml(data.translation)}</div>
      ${data.meaning ? `<div class="field-label">Znaczenie w tym zdaniu</div><div class="field-value">${escapeHtml(data.meaning)}</div>` : ""}
      ${data.example ? `<div class="field-label">Przyklad</div><div class="field-value">${escapeHtml(data.example)}</div>` : ""}
      ${data.pronunciation ? `<div class="field-label">Wymowa</div><div class="field-value">${escapeHtml(data.pronunciation)}</div>` : ""}
      <div class="modal-actions">
        <button class="btn-remember">⭐ Zapamietaj</button>
        <button class="btn-close">Zamknij</button>
      </div>
    `;
    card.querySelector(".btn-close").addEventListener("click", () => overlay.remove());
    const rememberBtn = card.querySelector(".btn-remember");
    rememberBtn.addEventListener("click", async () => {
      rememberBtn.disabled = true;
      rememberBtn.textContent = "Zapisywanie...";
      try {
        await saveToNotebook(phrase, contextSentence, data);
        rememberBtn.textContent = "⭐ Zapisano";
      } catch {
        rememberBtn.disabled = false;
        rememberBtn.textContent = "⭐ Zapamietaj (sprobuj znowu)";
      }
    });
  }

  async function saveToNotebook(phrase, contextSentence, explainData) {
    const userId = await getUserId();
    const { sourceLabel, sourceUrl } = currentSourceMeta();
    const res = await fetch(`${BACKEND_HTTP_URL}/api/phrases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        phrase,
        translation: explainData.translation,
        targetLang: currentTargetLang,
        contextSentence,
        meaning: explainData.meaning,
        example: explainData.example,
        pronunciation: explainData.pronunciation,
        sourceLabel,
        sourceUrl,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  shadow.getElementById("notebookBtn").addEventListener("click", openNotebook);

  async function openNotebook() {
    const overlay = openModal(`<h2>📖 Moj pamietnik</h2><p class="loading">Wczytuje...</p>`);
    const card = overlay.querySelector(".modal-card");

    let phrases;
    try {
      const userId = await getUserId();
      const res = await fetch(`${BACKEND_HTTP_URL}/api/phrases?userId=${encodeURIComponent(userId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      phrases = await res.json();
    } catch (err) {
      card.innerHTML = `<h2>📖 Moj pamietnik</h2><p class="error-text">Nie udalo sie wczytac: ${escapeHtml(err.message)}</p><div class="modal-actions"><button class="btn-close">Zamknij</button></div>`;
      card.querySelector(".btn-close").addEventListener("click", () => overlay.remove());
      return;
    }

    renderNotebook(card, phrases);
  }

  function renderNotebook(card, phrases) {
    if (phrases.length === 0) {
      card.innerHTML = `
        <h2>📖 Moj pamietnik</h2>
        <p class="notebook-empty">Jeszcze nic tu nie masz. Zaznacz slowo lub fraze w transkrypcji i kliknij ⭐ Zapamietaj.</p>
        <div class="modal-actions"><button class="btn-close">Zamknij</button></div>
      `;
      card.querySelector(".btn-close").addEventListener("click", () => card.closest(".modal-overlay").remove());
      return;
    }

    const itemsHtml = phrases
      .map(
        (p) => `
        <div class="notebook-item" data-id="${p.id}">
          <button class="np-delete" title="Usun">✕</button>
          <div class="np-phrase">${escapeHtml(p.phrase)}</div>
          <div class="np-translation">${escapeHtml(p.translation)}</div>
          ${p.contextSentence ? `<div class="np-context">"${escapeHtml(p.contextSentence)}"</div>` : ""}
          <div class="np-meta">${[p.sourceLabel, formatDate(p.capturedAt)].filter(Boolean).join(" · ")}</div>
        </div>`
      )
      .join("");

    card.innerHTML = `
      <h2>📖 Moj pamietnik</h2>
      <div class="notebook-list">${itemsHtml}</div>
      <div class="modal-actions"><button class="btn-close">Zamknij</button></div>
    `;
    card.querySelector(".btn-close").addEventListener("click", () => card.closest(".modal-overlay").remove());
    card.querySelectorAll(".np-delete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const item = btn.closest(".notebook-item");
        const id = item.dataset.id;
        btn.disabled = true;
        try {
          const userId = await getUserId();
          const res = await fetch(`${BACKEND_HTTP_URL}/api/phrases/${id}?userId=${encodeURIComponent(userId)}`, {
            method: "DELETE",
          });
          if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
          item.remove();
        } catch {
          btn.disabled = false;
        }
      });
    });
  }
})();
