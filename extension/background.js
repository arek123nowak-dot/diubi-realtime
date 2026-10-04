const BACKEND_WS_URL = "ws://localhost:3000/stream";
const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");

// MV3 service workers get killed after ~30s of inactivity and respawn on
// the next event with a completely clean slate — a plain `let activeTabId`
// here would silently reset to null mid-session (nothing about relaying
// messages or driving the offscreen document counts as "activity" that
// keeps this worker alive), and every relay after that point would be
// dropped with the overlay just sitting on its last status forever.
// chrome.storage.session survives worker restarts for the lifetime of the
// browser session, which is exactly the lifetime we need here.
async function getActiveTabId() {
  const { activeTabId } = await chrome.storage.session.get("activeTabId");
  return activeTabId ?? null;
}

async function setActiveTabId(tabId) {
  if (tabId === null) {
    await chrome.storage.session.remove("activeTabId");
  } else {
    await chrome.storage.session.set({ activeTabId: tabId });
  }
}

// Same persistent anonymous ID (and same storage key) content.js already
// uses for the notebook - reused here so the backend can apply its daily
// listening-time cap per device without any real login. chrome.storage.local
// (unlike .session) survives service worker restarts AND browser restarts,
// which is what we want for something meant to persist across days.
async function getUserId() {
  const { diubiUserId } = await chrome.storage.local.get("diubiUserId");
  if (diubiUserId) return diubiUserId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ diubiUserId: id });
  return id;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === "background" && message.type === "relay") {
    // Caption/status/error events from the offscreen document — forward to
    // the content script overlay on the tab we're actually capturing.
    getActiveTabId().then((activeTabId) => {
      if (activeTabId !== null) {
        chrome.tabs.sendMessage(activeTabId, { type: "caption-event", payload: message.payload }).catch(() => {
          // Content script may not be ready yet (first event can race the
          // injection below) or the tab was closed — safe to ignore.
        });
      }
    });
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
    getActiveTabId().then((activeTabId) => sendResponse({ activeTabId }));
    return true;
  }
});

async function startCapture(tabId, targetLang) {
  if ((await getActiveTabId()) !== null) {
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

  await setActiveTabId(tabId);
  chrome.tabs.sendMessage(tabId, { type: "show-overlay", targetLang }).catch(() => {});

  const userId = await getUserId();
  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "start-capture",
    streamId,
    targetLang,
    userId,
    wsUrl: BACKEND_WS_URL,
  });
}

async function stopCapture() {
  chrome.runtime.sendMessage({ target: "offscreen", type: "stop-capture" });
  const activeTabId = await getActiveTabId();
  if (activeTabId !== null) {
    chrome.tabs.sendMessage(activeTabId, { type: "hide-overlay" }).catch(() => {});
  }
  await setActiveTabId(null);
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

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === (await getActiveTabId())) {
    stopCapture();
  }
});
