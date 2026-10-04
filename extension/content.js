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
      .status { padding: 6px 12px; font-size: 11px; color: #8a92a3; min-height: 1.3em; }
    </style>
    <div class="wrap" id="wrap">
      <div class="header" id="dragHandle">
        <span>DIUBI</span>
        <button class="closeBtn" id="closeBtn" title="Zatrzymaj i ukryj">×</button>
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
        row.originalCell.textContent = msg.text;
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
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "show-overlay") {
      rows.clear();
      reelEl.innerHTML = "";
      statusEl.textContent = "";
      wrapEl.classList.add("visible");
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
})();
