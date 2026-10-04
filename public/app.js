const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const reelEl = document.getElementById("reel");
const targetLangInput = document.getElementById("targetLang");
const sourceBtns = document.querySelectorAll(".source-btn:not(:disabled)");
const sourceInputRow = document.getElementById("sourceInputRow");
const sourceUrlInput = document.getElementById("sourceUrlInput");
const loadSourceBtn = document.getElementById("loadSourceBtn");
const playerWrap = document.getElementById("playerWrap");

const TARGET_SAMPLE_RATE = 24000; // GA Realtime API requires >= 24000 Hz
const MAX_ROWS_KEPT = 50; // prune old rows so a long session doesn't grow the DOM forever

let ws = null;
let audioContext = null;
let processorNode = null;
let sourceNode = null;
let displayStream = null;

// Rows are keyed by the server's segmentId so a translation always lands in
// the same row as its original sentence (and both share one scrollbar, so
// they can never drift out of sync). The in-progress sentence (before its
// segmentId is known) lives under the "pending" key and gets re-keyed once
// it finalizes.
const rows = new Map();

let selectedPlatform = null;

startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);
loadSourceBtn.addEventListener("click", loadSource);
sourceUrlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadSource();
});
sourceBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedPlatform = btn.dataset.platform;
    sourceBtns.forEach((b) => b.classList.toggle("selected", b === btn));
    sourceInputRow.classList.add("visible");
    sourceUrlInput.placeholder =
      selectedPlatform === "spotify" ? "Wklej link do odcinka Spotify..." : "Wklej link do filmu YouTube...";
    sourceUrlInput.focus();
  });
});

let playerIframe = null; // Spotify's plain iframe
let playerPlatform = null;
let ytPlayer = null; // YT.Player instance, once the YouTube API has loaded
let ytApiPromise = null;
let captureReady = false; // true once the server confirms OpenAI is connected

function loadSource() {
  const url = sourceUrlInput.value.trim();
  if (!url || !selectedPlatform) return;

  collapseSourcePicker();

  if (selectedPlatform === "youtube") {
    const videoId = extractYouTubeId(url);
    if (!videoId) {
      setStatus("Nie rozpoznaje tego linku jako YouTube.", true);
      return;
    }
    playerWrap.innerHTML = '<div id="ytTarget"></div>';
    playerWrap.className = "player-wrap visible ratio-video";
    playerPlatform = "youtube";
    // Fire-and-forget: loading the YouTube API script is async, but it must
    // NOT be awaited before calling start() below, or the click that
    // triggered this handler stops counting as a "user gesture" by the time
    // we get there and getDisplayMedia gets silently rejected.
    setupYouTubePlayer(videoId, url);
  } else {
    const embedSrc = buildSpotifyEmbed(url);
    if (!embedSrc) {
      setStatus("Nie rozpoznaje tego linku jako Spotify.", true);
      return;
    }
    playerWrap.innerHTML = "";
    const iframe = document.createElement("iframe");
    iframe.src = embedSrc;
    iframe.allow = "autoplay; encrypted-media; picture-in-picture";
    iframe.allowFullscreen = true;
    playerWrap.appendChild(iframe);
    playerWrap.className = "player-wrap visible ratio-audio";
    playerIframe = iframe;
    playerPlatform = "spotify";
  }

  // Still synchronous within this click handler (see note above).
  start();
}

function collapseSourcePicker() {
  // Free up vertical space now that the player is up — the picker/input row,
  // title subtitle, and later the hint text no longer need to be on screen.
  document.querySelector(".source-bar").style.display = "none";
  sourceInputRow.style.display = "none";
  document.body.classList.add("compact");
}

function extractYouTubeId(url) {
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function buildSpotifyEmbed(url) {
  const match = url.match(/open\.spotify\.com\/(?:intl-\w+\/)?(episode|show|track)\/([a-zA-Z0-9]+)/);
  return match ? `https://open.spotify.com/embed/${match[1]}/${match[2]}` : null;
}

function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (previous) previous();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);
  });
  return ytApiPromise;
}

async function setupYouTubePlayer(videoId, originalUrl) {
  await loadYouTubeApi();
  ytPlayer = new YT.Player("ytTarget", {
    videoId,
    playerVars: { autoplay: 0, playsinline: 1 },
    events: {
      // If capture was already confirmed ready before the player finished
      // loading, start it now instead of waiting on a "ready" message that
      // already came and went.
      onReady: () => {
        if (captureReady) ytPlayer.playVideo();
      },
      onError: (e) => handleYouTubeError(e.data, originalUrl),
    },
  });
}

/**
 * Error 101/150 both mean "the owner disabled embedding for this video" —
 * the one failure mode we can actually recover from automatically, by
 * sending the user to a real YouTube tab and capturing that instead. No
 * explaining required: one button, one click, done.
 */
function handleYouTubeError(code, originalUrl) {
  if (code === 101 || code === 150) {
    showEmbedBlockedFallback(originalUrl);
  } else if (code === 100) {
    setStatus("Ten film nie istnieje albo jest prywatny.", true);
  } else {
    setStatus("Nie udalo sie zaladowac filmu z YouTube.", true);
  }
}

function showEmbedBlockedFallback(originalUrl) {
  // Whatever capture already started was listening to this (silent) tab —
  // throw it away, the fallback button below starts a correct one.
  stop();

  playerWrap.innerHTML = `
    <div class="embed-blocked">
      <p>Ten film nie pozwala na odtwarzanie tutaj — to ograniczenie ustawione przez autora filmu.</p>
      <button type="button" id="embedFallbackBtn">Otworz w nowej karcie i kontynuuj</button>
    </div>`;
  playerWrap.className = "player-wrap visible ratio-fallback";
  document.getElementById("embedFallbackBtn").addEventListener("click", () => {
    window.open(originalUrl, "_blank");
    start();
  });
}

/** Starts playback once the capture pipeline is confirmed ready, so no audio is missed. */
function playEmbeddedSource() {
  captureReady = true;
  if (playerPlatform === "youtube" && ytPlayer && ytPlayer.playVideo) {
    ytPlayer.playVideo();
  }
  // Spotify's embed needs its own SDK to control playback remotely, so for
  // now it keeps its default behavior (user presses play in the widget).
}

async function start() {
  captureReady = false;
  startBtn.disabled = true;
  setStatus('To okno przegladarki prosi o zgode, nie nasza apka — wybierz "Ta karta" i zaznacz dzwiek.');

  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      // Chrome-only: without this, the calling tab itself is excluded from
      // the share picker, which is exactly the tab we actually want here
      // (the one with the embedded player). Unsupported browsers just
      // ignore the unknown property.
      preferCurrentTab: true,
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
  rows.clear();
  reelEl.innerHTML = "";

  // Source language is always auto-detected server-side — the user only
  // ever picks the target language they want to read.
  const target = encodeURIComponent(targetLangInput.value.trim() || "pl");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/stream?target=${target}`);

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
    case "ready":
      playEmbeddedSource();
      break;
    case "error":
      setStatus(msg.message, true);
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

/** Returns the row for `id`, creating (and appending) it if it doesn't exist yet. */
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

/** Moves the in-progress "pending" row (if any) to its real segmentId once the server assigns one. */
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
  while (rows.size > MAX_ROWS_KEPT) {
    const oldestId = rows.keys().next().value;
    rows.get(oldestId).el.remove();
    rows.delete(oldestId);
  }
}

function scrollToBottom() {
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
