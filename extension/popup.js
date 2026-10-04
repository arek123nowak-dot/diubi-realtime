const targetLangSelect = document.getElementById("targetLang");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");

init();

async function init() {
  const stored = await chrome.storage.local.get("targetLang");
  if (stored.targetLang) targetLangSelect.value = stored.targetLang;

  const { activeTabId } = await chrome.runtime.sendMessage({ type: "popup-status" });
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  setRunning(activeTabId !== null && activeTabId === currentTab?.id);
}

startBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    setStatus("Nie znalazlem aktywnej karty.");
    return;
  }

  const targetLang = targetLangSelect.value;
  await chrome.storage.local.set({ targetLang });

  setStatus("Uruchamiam...");
  const result = await chrome.runtime.sendMessage({ type: "popup-start", tabId: tab.id, targetLang });
  if (result?.ok) {
    setRunning(true);
    setStatus("Dziala — napisy pojawia sie na karcie.");
  } else {
    setStatus(`Blad: ${result?.error || "nieznany"}`);
  }
});

stopBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup-stop" });
  setRunning(false);
  setStatus("Zatrzymano.");
});

function setRunning(running) {
  startBtn.disabled = running;
  stopBtn.disabled = !running;
}

function setStatus(text) {
  statusEl.textContent = text;
}
