const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const originalReelEl = document.getElementById("originalReel");
const translationReelEl = document.getElementById("translationReel");
const sourceLangInput = document.getElementById("sourceLang");
const targetLangInput = document.getElementById("targetLang");

const TARGET_SAMPLE_RATE = 24000; // GA Realtime API requires >= 24000 Hz
const MAX_LINES_KEPT = 50; // prune old lines so a long session doesn't grow the DOM forever

let ws = null;
let audioContext = null;
let processorNode = null;
let sourceNode = null;
let displayStream = null;

// Two independent, independently-scrolling panels. Lines are still keyed by
// the server's segmentId (not just "append to the last line") so that two
// sentences mid-translation at once can't interleave their text into one
// line. The in-progress original (before its segmentId is known) lives
// under the "pending" key and gets re-keyed once it finalizes.
const originalLines = new Map();
const translationLines = new Map();

startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);

async function start() {
  startBtn.disabled = true;
  setStatus("Proszę wybierz karte z dzwiekiem w oknie przegladarki...");

  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
  } catch (err) {
    setStatus(`Nie udalo sie uzyskac dostepu do audio: ${err.message}`, true);
    startBtn.disabled = false;
    return;
  }

  const audioTracks = displayStream.getAudioTracks();
  if (audioTracks.length === 0) {
    setStatus("Wybrane zrodlo nie ma sciezki dzwiekowej. Zaznacz 'Udostepnij dzwiek karty'.", true);
    stopAllTracks();
    startBtn.disabled = false;
    return;
  }
  displayStream.getVideoTracks().forEach((t) => t.stop());

  openSocket();
}

function openSocket() {
  originalLines.clear();
  translationLines.clear();
  originalReelEl.innerHTML = "";
  translationReelEl.innerHTML = "";

  const target = encodeURIComponent(targetLangInput.value.trim() || "pl");
  const source = encodeURIComponent(sourceLangInput.value.trim());
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/stream?target=${target}&source=${source}`);

  ws.onopen = () => {
    setStatus("Polaczono. Uruchamiam przechwytywanie audio...");
    startCapture();
    stopBtn.disabled = false;
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleServerMessage(msg);
  };

  ws.onerror = () => setStatus("Blad polaczenia WebSocket.", true);

  ws.onclose = () => {
    setStatus("Polaczenie zamkniete.");
    stopBtn.disabled = true;
    startBtn.disabled = false;
  };
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case "status":
      setStatus(msg.message);
      break;
    case "error":
      setStatus(msg.message, true);
      break;
    case "transcript_delta": {
      const line = getOrCreateLine(originalLines, originalReelEl, "pending");
      line.el.textContent += msg.text;
      line.el.classList.add("active");
      scrollToBottom(originalReelEl);
      break;
    }
    case "transcript_final": {
      const line = claimLine(originalLines, originalReelEl, msg.segmentId);
      line.el.textContent = msg.text;
      line.el.classList.remove("active");
      pruneOldLines(originalLines);
      scrollToBottom(originalReelEl);
      break;
    }
    case "translation_delta": {
      const line = getOrCreateLine(translationLines, translationReelEl, msg.segmentId);
      line.el.textContent += msg.text;
      line.el.classList.add("active");
      scrollToBottom(translationReelEl);
      break;
    }
    case "translation_final": {
      const line = getOrCreateLine(translationLines, translationReelEl, msg.segmentId);
      line.el.textContent = msg.text;
      line.el.classList.remove("active");
      pruneOldLines(translationLines);
      scrollToBottom(translationReelEl);
      break;
    }
  }
}

/** Returns the line for `id` in the given panel, creating (and appending) it if needed. */
function getOrCreateLine(lines, reelEl, id) {
  let line = lines.get(id);
  if (!line) {
    const el = document.createElement("div");
    el.className = "line";
    reelEl.appendChild(el);
    line = { el };
    lines.set(id, line);
  }
  return line;
}

/** Moves the in-progress "pending" original line (if any) to its real segmentId once the server assigns one. */
function claimLine(lines, reelEl, segmentId) {
  const pending = lines.get("pending");
  if (pending) {
    lines.delete("pending");
    lines.set(segmentId, pending);
    return pending;
  }
  return getOrCreateLine(lines, reelEl, segmentId);
}

function pruneOldLines(lines) {
  while (lines.size > MAX_LINES_KEPT) {
    const oldestId = lines.keys().next().value;
    lines.get(oldestId).el.remove();
    lines.delete(oldestId);
  }
}

function scrollToBottom(reelEl) {
  reelEl.scrollTop = reelEl.scrollHeight;
}

function startCapture() {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioContext.createMediaStreamSource(displayStream);

  const inputChannels = sourceNode.channelCount || 1;
  processorNode = audioContext.createScriptProcessor(4096, inputChannels, 1);

  const ratio = audioContext.sampleRate / TARGET_SAMPLE_RATE;

  processorNode.onaudioprocess = (event) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const input = event.inputBuffer;
    const channelCount = input.numberOfChannels;
    const length = input.length;

    // Downmix do mono.
    const mono = new Float32Array(length);
    for (let ch = 0; ch < channelCount; ch++) {
      const data = input.getChannelData(ch);
      for (let i = 0; i < length; i++) mono[i] += data[i] / channelCount;
    }

    // Prosty downsampling (nearest-neighbor) do 16kHz.
    const outLength = Math.floor(mono.length / ratio);
    const pcm16 = new Int16Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const sample = mono[Math.floor(i * ratio)] || 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      pcm16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }

    ws.send(JSON.stringify({ type: "audio_chunk", audio: arrayBufferToBase64(pcm16.buffer) }));
  };

  sourceNode.connect(processorNode);
  processorNode.connect(audioContext.destination);
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function stop() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
    ws.close();
  }
  stopAllTracks();
  if (processorNode) processorNode.disconnect();
  if (sourceNode) sourceNode.disconnect();
  if (audioContext) audioContext.close();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus("Zatrzymano.");
}

function stopAllTracks() {
  if (displayStream) {
    displayStream.getTracks().forEach((t) => t.stop());
    displayStream = null;
  }
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}
