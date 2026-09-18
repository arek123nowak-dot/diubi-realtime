const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const originalEl = document.getElementById("original");
const translationEl = document.getElementById("translation");
const sourceLangInput = document.getElementById("sourceLang");
const targetLangInput = document.getElementById("targetLang");

const TARGET_SAMPLE_RATE = 16000;

let ws = null;
let audioContext = null;
let processorNode = null;
let sourceNode = null;
let displayStream = null;
let liveOriginalLine = null;
let liveTranslationLine = null;

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
    case "transcript_delta":
      liveOriginalLine = liveOriginalLine || appendLine(originalEl, "", true);
      liveOriginalLine.textContent += msg.text;
      break;
    case "transcript_final":
      if (liveOriginalLine) {
        liveOriginalLine.textContent = msg.text;
        liveOriginalLine.classList.remove("live");
        liveOriginalLine = null;
      } else {
        appendLine(originalEl, msg.text, false);
      }
      scrollToBottom(originalEl);
      break;
    case "translation_delta":
      liveTranslationLine = liveTranslationLine || appendLine(translationEl, "", true);
      liveTranslationLine.textContent += msg.text;
      scrollToBottom(translationEl);
      break;
    case "translation_final":
      if (liveTranslationLine) {
        liveTranslationLine.textContent = msg.text;
        liveTranslationLine.classList.remove("live");
        liveTranslationLine = null;
      } else {
        appendLine(translationEl, msg.text, false);
      }
      scrollToBottom(translationEl);
      break;
  }
}

function appendLine(container, text, live) {
  const div = document.createElement("p");
  div.className = "line" + (live ? " live" : "");
  div.textContent = text;
  container.appendChild(div);
  return div;
}

function scrollToBottom(container) {
  container.scrollTop = container.scrollHeight;
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
  liveOriginalLine = null;
  liveTranslationLine = null;
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
