const BACKEND_WS_URL = "ws://localhost:3000/stream";
const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");

let activeTabId = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === "background" && message.type === "relay") {
    // Caption/status/error events from the offscreen document — forward to
    // the content script overlay on the tab we're actually capturing.
    if (activeTabId !== null) {
      chrome.tabs.sendMessage(activeTabId, { type: "caption-event", payload: message.payload }).catch(() => {
        // Content script may not be ready yet (first event can race the
        // injection below) or the tab was closed — safe to ignore.
      });
    }
    return;
  }

  if (message.type === "popup-start") {
    startCapture(message.tabId, message.targetLang)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep the message channel open for the async response
  }

  if (message.type === "popup-stop") {
    stopCapture()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "popup-status") {
    sendResponse({ activeTabId });
    return true;
  }
});

async function startCapture(tabId, targetLang) {
  if (activeTabId !== null) {
    await stopCapture();
  }

  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError || !id) {
        reject(new Error(chrome.runtime.lastError?.message || "Brak streamId"));
      } else {
        resolve(id);
      }
    });
  });

  await ensureOffscreenDocument();

  // content.js builds its own Shadow DOM with inline styles rather than a
  // page-level stylesheet, so it can't collide with (or be overridden by)
  // whatever CSS the host page itself uses.
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });

  activeTabId = tabId;
  chrome.tabs.sendMessage(tabId, { type: "show-overlay" }).catch(() => {});

  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "start-capture",
    streamId,
    targetLang,
    wsUrl: BACKEND_WS_URL,
  });
}

async function stopCapture() {
  chrome.runtime.sendMessage({ target: "offscreen", type: "stop-capture" });
  if (activeTabId !== null) {
    chrome.tabs.sendMessage(activeTabId, { type: "hide-overlay" }).catch(() => {});
  }
  activeTabId = null;
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Przetwarzanie przechwyconego dzwieku karty do transkrypcji na zywo.",
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) {
    stopCapture();
  }
});
