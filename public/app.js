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
const notebookBtn = document.getElementById("notebookBtn");
const powtorkaBtn = document.getElementById("powtorkaBtn");
const mojaNaukaBtn = document.getElementById("mojaNaukaBtn");
const backToStartBtn = document.getElementById("backToStartBtn");
const returnCard = document.getElementById("returnCard");
const spotifyHint = document.getElementById("spotifyHint");

const TARGET_SAMPLE_RATE = 24000; // GA Realtime API requires >= 24000 Hz
const MAX_ROWS_KEPT = 50; // prune old rows so a long session doesn't grow the DOM forever

let ws = null;
let audioContext = null;
let processorNode = null;
let sourceNode = null;
let displayStream = null;
let currentSessionId = null; // from the server's "ready" message — lets a saved phrase point back to its audio clip
// Sent right before the server closes the socket (daily limit hit, missing
// API key, etc). ws.onclose fires moments later and used to unconditionally
// overwrite the status bar with a generic "connection closed" - burying the
// one message that actually explained what happened.
let lastErrorMessage = null;

// Counts currently-playing saved clips. While capture is live (Start still
// active), getDisplayMedia is capturing THIS tab's audio output - including
// our own clip <audio> elements - so replaying a saved clip would otherwise
// get picked up as new incoming speech and re-transcribed/re-translated by
// the same session that's still listening (confirmed in testing: the exact
// saved sentence looping through the transcript several times in a row,
// once per playback). A counter, not a boolean, so overlapping playback
// (unlikely in this UI, but cheap to get right) can't under-count back to
// zero while another clip is still going.
let activeClipPlaybacks = 0;

function wireClipAudio(audioEl) {
  audioEl.addEventListener("play", () => {
    activeClipPlaybacks++;
  });
  const release = () => {
    activeClipPlaybacks = Math.max(0, activeClipPlaybacks - 1);
  };
  audioEl.addEventListener("pause", release);
  audioEl.addEventListener("ended", release);
}

// Rows are keyed by the server's segmentId so a translation always lands in
// the same row as its original sentence (and both share one scrollbar, so
// they can never drift out of sync). The in-progress sentence (before its
// segmentId is known) lives under the "pending" key and gets re-keyed once
// it finalizes.
const rows = new Map();

let selectedPlatform = null;
// The currently loaded source's identity, for auto-recording "Moja nauka"
// history on the next saved phrase - never a user-facing action, just
// metadata riding along with whatever gets saved anyway (see saveToNotebook).
let currentContent = null;

// YouTube captions-sync mode: when the video has official/auto captions,
// we switch over to them and shut down live ASR (no more transcription
// lag/mishearing) and instead reveal pre-translated segments as ytPlayer's
// own playback clock reaches each one's start time. Live listening always
// starts first regardless (see loadSource) - switching away from it is
// strictly a bonus once we know captions exist, not a precondition.
let captionsActive = false;
let captionSegments = [];
let captionRevealIndex = 0;
let captionsPollTimer = null;

// Plain "Start" (no source loaded through the picker above) is the manual
// two-tab flow: the user already has the audio playing in some other tab,
// so the normal picker — not a preference for this tab — is what they need.
startBtn.addEventListener("click", () => start({ preferCurrentTab: false }));
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
    // Spotify's free embed only plays a 30s preview unless the viewer is
    // logged into Premium inside the widget itself - nothing DIUBI's code
    // can change, so the only honest fix is telling people upfront instead
    // of letting it cut off mid-sentence with no explanation.
    spotifyHint.classList.toggle("visible", selectedPlatform === "spotify");
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

  // Guards against a stale captions poll timer (from a previously loaded
  // video) running against whatever gets loaded next - reachable via
  // Moja nauka's Kontynuuj while a source is already active, not just via
  // the empty picker.
  stopCaptionsPlayback();
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
    // Title fills in once the player reports it (setupYouTubePlayer's
    // onReady) - not available yet at this point.
    currentContent = {
      contentId: videoId,
      source: "youtube",
      url,
      title: "",
      thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
    };
    // Fire-and-forget: loading the YouTube API script is async, and must not
    // be awaited here — same reasoning as the captions check below.
    setupYouTubePlayer(videoId, url);
    // Also fire-and-forget: whether this video has official captions decides
    // which path we end up on, but that check takes a moment (a network
    // round trip), and getDisplayMedia below needs THIS click's gesture
    // right now - it won't still count as "triggered by a click" once an
    // await has happened. So live listening always starts immediately, the
    // same as before captions-sync mode existed; beginYouTubeCaptionsCheck
    // silently cancels it and switches over if captions turn out to be
    // available a moment later. See startCaptionsPlayback.
    beginYouTubeCaptionsCheck(videoId);
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
    // No way to pull Spotify's real episode title from the plain embed
    // widget without their Web API (OAuth) - "Spotify" is an honest
    // placeholder for v1, not a bug to chase down right now.
    const spotifyMatch = url.match(/open\.spotify\.com\/(?:intl-\w+\/)?(episode|show|track)\/([a-zA-Z0-9]+)/);
    currentContent = spotifyMatch
      ? { contentId: `spotify:${spotifyMatch[2]}`, source: "spotify", url, title: "Spotify", thumbnail: "" }
      : null;
  }

  // Still synchronous within this click handler (see note above).
  start();
}

function collapseSourcePicker() {
  // Free up vertical space now that the player is up — the picker/input row,
  // title subtitle, and later the hint text no longer need to be on screen.
  document.querySelector(".source-bar").style.display = "none";
  sourceInputRow.style.display = "none";
  spotifyHint.style.display = "none";
  returnCard.classList.remove("visible");
  document.body.classList.add("compact");
}

backToStartBtn.addEventListener("click", resetToStart);

/** Undoes collapseSourcePicker() and everything loadSource()/start() set up
 * — the only way out of a loaded source before this (short of refreshing
 * the page), which became a real problem once "Kontynuuj" in Moja nauka
 * gave people a reason to land on a source they then want to back out of. */
function resetToStart() {
  stop();
  stopCaptionsPlayback();
  stopAllTracks();
  if (ytPlayer && typeof ytPlayer.destroy === "function") ytPlayer.destroy();
  ytPlayer = null;
  playerIframe = null;
  playerPlatform = null;
  captureReady = false;
  currentSessionId = null;
  currentContent = null;
  selectedPlatform = null;

  playerWrap.innerHTML = "";
  playerWrap.className = "player-wrap";
  sourceUrlInput.value = "";
  sourceBtns.forEach((b) => b.classList.remove("selected"));
  sourceInputRow.classList.remove("visible");
  spotifyHint.classList.remove("visible");

  document.querySelector(".source-bar").style.display = "";
  sourceInputRow.style.display = "";
  spotifyHint.style.display = "";
  document.body.classList.remove("compact");

  rows.clear();
  reelEl.innerHTML = "";
  setStatus("");
  initReturnCard();
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
        const data = ytPlayer.getVideoData?.();
        if (data?.title && currentContent?.contentId === videoId) currentContent.title = data.title;
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
  // An embed that can't play here can't report a playback clock either, so
  // captions-sync mode (which reveals segments by polling that clock) has
  // nothing to sync to - same live-ASR-via-external-tab fallback as before,
  // regardless of whether this video happened to have captions.
  stopCaptionsPlayback();
  if (code === 101 || code === 150) {
    showEmbedBlockedFallback(originalUrl);
  } else if (code === 100) {
    setStatus("Ten film nie istnieje albo jest prywatny.", true);
  } else {
    setStatus("Nie udalo sie zaladowac filmu z YouTube.", true);
  }
}

// ---------------------------------------------------------------------------
// YouTube captions-sync mode: when captionsActive, live ASR has been shut
// down (see startCaptionsPlayback) - the whole video's captions were
// fetched and translated up front (see beginYouTubeCaptionsCheck), and this
// just reveals them in step with ytPlayer's own playback position. Entirely
// automatic either way: live listening starts the instant a YouTube source
// loads (same as before captions-sync mode existed), and silently gets
// swapped for captions-sync a moment later if this check finds any -
// nothing for the user to click in either case.
// ---------------------------------------------------------------------------

async function beginYouTubeCaptionsCheck(videoId) {
  const target = targetLangInput.value.trim() || "pl";

  let data;
  try {
    const res = await fetch(
      `/api/youtube-captions?videoId=${encodeURIComponent(videoId)}&targetLang=${encodeURIComponent(target)}`
    );
    data = await res.json();
  } catch {
    data = { available: false };
  }

  // Stale guard: the user may have backed out (resetToStart) or loaded a
  // different source while this was in flight.
  if (currentContent?.contentId !== videoId) return;

  if (data.available && Array.isArray(data.segments) && data.segments.length > 0) {
    startCaptionsPlayback(data.segments);
  } else if (!lastErrorMessage) {
    // Informational, not an error - most videos don't have captions, this
    // is the expected path, not something broken. Live listening is
    // already running (started synchronously back in loadSource) - nothing
    // left to do here but explain why. Skipped if live listening itself
    // already reported a real problem (daily limit, missing API key etc.)
    // - that message matters more and shouldn't get overwritten by this one.
    setStatus("Ten film nie ma napisow YouTube - korzystamy z nasluchu na zywo. Reakcja moze byc lekko opozniona.");
  }
}

function startCaptionsPlayback(segments) {
  // Live listening started automatically the instant this source loaded
  // (preserving the click's gesture for getDisplayMedia, in case captions
  // turned out to be unavailable) - now that captions ARE available, shut
  // it down rather than run both at once.
  stop();
  captionsActive = true;
  captionSegments = segments;
  captionRevealIndex = 0;
  rows.clear();
  reelEl.innerHTML = "";
  // Live ASR and captions-sync are mutually exclusive for one loaded source
  // - disabled rather than left clickable to avoid both running at once.
  startBtn.disabled = true;
  setStatus("Napisy YouTube znalezione - tekst zsynchronizowany z filmem, bez nasluchu audio.");

  waitForYtPlayerThenPlay();
  captionsPollTimer = setInterval(pollCaptionPlayback, 250);
}

function waitForYtPlayerThenPlay() {
  if (!captionsActive) return;
  if (ytPlayer && typeof ytPlayer.playVideo === "function") {
    ytPlayer.playVideo();
    return;
  }
  setTimeout(waitForYtPlayerThenPlay, 150);
}

function pollCaptionPlayback() {
  if (!captionsActive || !ytPlayer || typeof ytPlayer.getCurrentTime !== "function") return;
  const t = ytPlayer.getCurrentTime();
  while (captionRevealIndex < captionSegments.length && captionSegments[captionRevealIndex].start <= t) {
    revealCaptionSegment(captionSegments[captionRevealIndex], captionRevealIndex);
    captionRevealIndex++;
  }
}

function revealCaptionSegment(segment, index) {
  // Plain numeric id, same as the live-ASR path's segmentId - the reel
  // click handler does Number(cell.dataset.segmentId), so this has to stay
  // a number too, not a prefixed string.
  const row = getOrCreateRow(index);
  renderClickableWords(row.originalCell, segment.text);
  row.originalCell.dataset.segmentId = index;
  row.translationCell.textContent = segment.translation;
  scrollToBottom();
  pruneOldRows();
}

function stopCaptionsPlayback() {
  captionsActive = false;
  captionSegments = [];
  captionRevealIndex = 0;
  if (captionsPollTimer) {
    clearInterval(captionsPollTimer);
    captionsPollTimer = null;
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
    start({ preferCurrentTab: false });
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

async function start(options = {}) {
  const { preferCurrentTab = true } = options;
  captureReady = false;
  startBtn.disabled = true;

  // getDisplayMedia's own permission is still live (Stop no longer releases
  // it, see stop() below) — reuse it instead of re-prompting. Chrome has no
  // "remember this" option for tab/screen capture (unlike mic/camera) by
  // design, so the ONLY way to avoid re-prompting on every Start is to never
  // let the grant lapse in the first place.
  const liveTrack = displayStream?.getAudioTracks()[0];
  if (liveTrack && liveTrack.readyState === "live") {
    setStatus("Wznawiam nasluch (bez ponownego okna wyboru karty)...");
    openSocket();
    return;
  }

  setStatus(
    preferCurrentTab
      ? 'To okno przegladarki prosi o zgode, nie nasza apka — wybierz "Ta karta" i zaznacz dzwiek.'
      : "Wybierz w oknie przegladarki karte z filmem, ktora wlasnie sie otworzyla, i zaznacz dzwiek."
  );

  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      // Chrome-only: without this, the calling tab itself is excluded from
      // the share picker. Good when we want OUR tab (the embedded player);
      // wrong for the "open in a new tab" fallback below, where the tab we
      // actually want is the one that just opened, not this one.
      preferCurrentTab,
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
  // If the user revokes sharing from Chrome's own UI (the "Stop sharing"
  // bar) rather than DIUBI's Stop button, the grant is really gone — forget
  // the stream so the next Start correctly re-prompts instead of trying to
  // reuse a dead track.
  audioTracks[0].addEventListener("ended", () => {
    if (displayStream && displayStream.getAudioTracks()[0] === audioTracks[0]) displayStream = null;
  });

  openSocket();
}

function openSocket() {
  rows.clear();
  reelEl.innerHTML = "";
  lastErrorMessage = null;

  // Source language is always auto-detected server-side — the user only
  // ever picks the target language they want to read.
  const target = encodeURIComponent(targetLangInput.value.trim() || "pl");
  const user = encodeURIComponent(getUserId());
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/stream?target=${target}&user=${user}`);

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
    // Don't bury a just-shown reason (daily limit hit, missing API key...)
    // under a generic "connection closed" the moment the server closes the
    // socket right after sending it.
    if (!lastErrorMessage) setStatus("Polaczenie zamkniete.");
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
      currentSessionId = msg.sessionId || null;
      playEmbeddedSource();
      break;
    case "error":
      lastErrorMessage = msg.message;
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
      renderClickableWords(row.originalCell, msg.text);
      row.originalCell.classList.remove("active");
      // Lets a click on any word in this row find its way back to the
      // audio clip the server captured for this exact sentence.
      row.originalCell.dataset.segmentId = msg.segmentId;
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
      // Marked on the specific row that failed (after the server already
      // retried) rather than only a generic status-bar message, so it's
      // obvious which line is missing its translation instead of that row
      // just sitting blank with no explanation.
      const row = getOrCreateRow(msg.segmentId);
      row.translationCell.textContent = "Nie udalo sie przetlumaczyc tej linii.";
      row.translationCell.classList.remove("active");
      row.translationCell.classList.add("failed");
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
    // See activeClipPlaybacks above - tab capture would otherwise hear our
    // own clip playback and feed it right back in as new speech.
    if (!ws || ws.readyState !== WebSocket.OPEN || activeClipPlaybacks > 0) return;

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
  // Deliberately NOT stopAllTracks() here — tearing down the capture would
  // force a fresh getDisplayMedia() picker on the next Start (Chrome never
  // lets a page "remember" a tab/screen-capture grant the way it can for
  // mic/camera). Only disconnecting the audio processing graph keeps the
  // grant alive so Start can resume instantly. Chrome's own "sharing this
  // tab" indicator stays visible while stopped as a result — expected and
  // correct, same as any other screen-share tool while paused, not stopped.
  if (processorNode) processorNode.disconnect();
  if (sourceNode) sourceNode.disconnect();
  if (audioContext) audioContext.close();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus("Zatrzymano. Kliknij Start, by wznowic bez ponownego wyboru karty.");
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

// ---------------------------------------------------------------------------
// Word/phrase lookup: select text in the original-language column -> a
// floating "Wyjasnij" button appears -> opens a card with the phrase's
// meaning IN THAT CONTEXT (not a generic dictionary definition), an example,
// and pronunciation, with a button to save it into the user's notebook.
// This is the first slice of turning DIUBI from "a translator" into
// something that helps you actually learn from what you listened to.
// ---------------------------------------------------------------------------

function getUserId() {
  let id = localStorage.getItem("diubi_user_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("diubi_user_id", id);
  }
  return id;
}

function currentSourceMeta() {
  return {
    sourceLabel: selectedPlatform === "youtube" ? "YouTube" : selectedPlatform === "spotify" ? "Spotify" : "",
    sourceUrl: sourceUrlInput.value.trim(),
  };
}

/** Splits `text` into individual clickable word spans (whitespace kept as
 * plain text nodes between them), replacing `cell`'s content. Used instead
 * of a plain textContent assignment so each word can show a hover highlight
 * + "Wyjasnij" hint and respond to a click on its own — a text-selection
 * based picker turned out to not be obvious ("you have to drag-select the
 * EXACT text"), and on top of that didn't work at all inside the extension's
 * overlay (host pages like YouTube commonly suppress text selection
 * globally so dragging the video seek bar etc. doesn't accidentally select
 * page text, which blocked ours too since the event is page-wide). Hover +
 * click sidesteps both problems entirely — it never touches the Selection
 * API. */
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
  document.body.appendChild(badge);
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
  const segmentId = cell.dataset.segmentId ? Number(cell.dataset.segmentId) : null;
  // Already sitting right there in the row's other column — the live
  // translation pipeline already produced it, no reason to ask the AI to
  // translate the sentence a second time just for this card.
  const sentenceTranslation = cell.parentElement.querySelector(".cell.translation")?.textContent || "";
  // Captions-sync mode has no live audio to clip - the segment's own known
  // start time becomes the fallback "jump to this moment" link instead.
  const sourceTimestampSec =
    captionsActive && captionSegments[segmentId] ? captionSegments[segmentId].start : null;
  openExplainCard(phrase, cell.textContent, segmentId, sentenceTranslation, sourceTimestampSec);
});

function openModal(innerHtml) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal-card">${innerHtml}</div>`;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
  return overlay;
}

async function openExplainCard(phrase, contextSentence, segmentId, sentenceTranslation, sourceTimestampSec) {
  const overlay = openModal(`
    <h2>${escapeHtml(phrase)}</h2>
    <p class="phrase-src">${escapeHtml(contextSentence)}</p>
    ${phraseSrcTranslationHtml(sentenceTranslation)}
    <p class="loading">Szukam wyjasnienia...</p>
  `);

  let data;
  try {
    const res = await fetch("/api/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phrase,
        contextSentence,
        targetLang: targetLangInput.value.trim() || "pl",
      }),
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
    ${phraseSrcTranslationHtml(sentenceTranslation)}
    ${explainFieldsHtml(data)}
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
      await saveToNotebook(phrase, contextSentence, data, segmentId, sentenceTranslation, sourceTimestampSec);
      rememberBtn.textContent = "⭐ Zapisano";
    } catch {
      rememberBtn.disabled = false;
      rememberBtn.textContent = "⭐ Zapamietaj (sprobuj znowu)";
    }
  });
}

/** Shared translation/meaning/example/pronunciation block markup, used both
 * for a freshly fetched explanation and for reopening one already saved in
 * the notebook (same look either way, no reason for the saved version to
 * look like a lesser summary of the original card). */
function explainFieldsHtml(data) {
  return `
    <div class="field-label">Tlumaczenie</div>
    <div class="field-value">${escapeHtml(data.translation)}</div>
    ${data.meaning ? `<div class="field-label">Znaczenie w tym zdaniu</div><div class="field-value">${escapeHtml(data.meaning)}</div>` : ""}
    ${data.example ? `<div class="field-label">Przyklad</div><div class="field-value">${escapeHtml(data.example)}</div>` : ""}
    ${data.pronunciation ? `<div class="field-label">Wymowa</div><div class="field-value">${escapeHtml(data.pronunciation)}</div>` : ""}
  `;
}

/** Translation of the WHOLE sentence the phrase came from - distinct from
 * explainFieldsHtml's "Tlumaczenie" (just the clicked word/phrase). Grabbed
 * client-side from the live translation that's already on screen, so this
 * never costs an extra AI call. */
function phraseSrcTranslationHtml(sentenceTranslation) {
  if (!sentenceTranslation) return "";
  return `<p class="phrase-src-translation">${escapeHtml(sentenceTranslation)}</p>`;
}

function clipPlayerHtml(p) {
  if (p.hasClip) {
    return `<div class="field-label">Oryginalny fragment</div><audio class="clip-player" controls preload="none" src="/clips/${p.id}.wav"></audio>`;
  }
  // Captions-sync mode has no live audio to snip a clip from - the exact
  // moment in the source video (known from the caption's own timestamp) is
  // the next best thing: full context, real audio, just one click away
  // instead of none at all.
  if (typeof p.sourceTimestampSec === "number" && p.sourceUrl) {
    const sec = Math.max(0, Math.floor(p.sourceTimestampSec));
    const sep = p.sourceUrl.includes("?") ? "&" : "?";
    const href = `${p.sourceUrl}${sep}t=${sec}s`;
    const mm = Math.floor(sec / 60);
    const ss = String(sec % 60).padStart(2, "0");
    return (
      `<div class="field-label">Moment w filmie</div>` +
      `<a class="clip-timestamp-link" href="${escapeHtml(href)}" target="_blank" rel="noopener">▶ Otworz w filmie (${mm}:${ss})</a>`
    );
  }
  return "";
}

/** Any <audio> this card renders needs to stop the live capture pipeline
 * from picking its playback back up as new incoming speech - otherwise
 * replaying a saved clip gets re-transcribed and re-translated by the same
 * session that's still listening (confirmed in testing: the exact saved
 * sentence looping through the transcript several times in a row, once per
 * playback). See activeClipPlaybacks / startCapture(). */
function wireClipAudioElements(container) {
  container.querySelectorAll("audio").forEach(wireClipAudio);
}

function showSavedPhraseCard(p) {
  const overlay = openModal(`
    <h2>${escapeHtml(p.phrase)}</h2>
    <p class="phrase-src">${escapeHtml(p.contextSentence)}</p>
    ${phraseSrcTranslationHtml(p.sentenceTranslation)}
    ${clipPlayerHtml(p)}
    ${explainFieldsHtml(p)}
    <div class="modal-actions"><button class="btn-close">Zamknij</button></div>
  `);
  overlay.querySelector(".btn-close").addEventListener("click", () => overlay.remove());
  wireClipAudioElements(overlay);
}

async function saveToNotebook(phrase, contextSentence, explainData, segmentId, sentenceTranslation, sourceTimestampSec) {
  const { sourceLabel, sourceUrl } = currentSourceMeta();
  const res = await fetch("/api/phrases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: getUserId(),
      phrase,
      translation: explainData.translation,
      targetLang: targetLangInput.value.trim() || "pl",
      contextSentence,
      sentenceTranslation: sentenceTranslation || "",
      meaning: explainData.meaning,
      example: explainData.example,
      pronunciation: explainData.pronunciation,
      sourceLabel,
      sourceUrl,
      sessionId: currentSessionId,
      segmentId,
      contentId: currentContent?.contentId || "",
      contentSource: currentContent?.source || "",
      contentUrl: currentContent?.url || "",
      contentTitle: currentContent?.title || "",
      contentThumbnail: currentContent?.thumbnail || "",
      sourceTimestampSec: typeof sourceTimestampSec === "number" ? sourceTimestampSec : null,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Moj pamietnik: everything saved via "Zapamietaj", newest first.
// ---------------------------------------------------------------------------

notebookBtn.addEventListener("click", openNotebook);

async function openNotebook() {
  const overlay = openModal(`<h2>📖 Moj pamietnik</h2><p class="loading">Wczytuje...</p>`);
  const card = overlay.querySelector(".modal-card");

  let phrases;
  try {
    const res = await fetch(`/api/phrases?userId=${encodeURIComponent(getUserId())}`);
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
      <div class="notebook-item" data-id="${p.id}" tabindex="0">
        <button class="np-delete" title="Usun">✕</button>
        <div class="np-phrase">${escapeHtml(p.phrase)}</div>
        <div class="np-translation">${escapeHtml(p.translation)}</div>
        ${p.contextSentence ? `<div class="np-context">"${escapeHtml(p.contextSentence)}"</div>` : ""}
        <div class="np-meta">${[p.hasClip ? "🎧" : null, p.sourceLabel, formatDate(p.capturedAt)].filter(Boolean).join(" · ")}</div>
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
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const item = btn.closest(".notebook-item");
      const id = item.dataset.id;
      btn.disabled = true;
      try {
        const res = await fetch(`/api/phrases/${id}?userId=${encodeURIComponent(getUserId())}`, { method: "DELETE" });
        if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
        item.remove();
      } catch {
        btn.disabled = false;
      }
    });
  });
  card.querySelectorAll(".notebook-item").forEach((item) => {
    item.addEventListener("click", () => {
      const p = phrases.find((ph) => ph.id === item.dataset.id);
      if (p) showSavedPhraseCard(p);
    });
  });
}

function formatDate(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString("pl-PL", { day: "numeric", month: "short" });
}

/** "dzisiaj" / "wczoraj" / "X dni temu" instead of a bare date - this view is
 * about picking up where you left off, so how recently matters more than
 * the exact calendar date. */
function formatRelativeDate(ms) {
  if (!ms) return "";
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return "dzisiaj";
  if (days === 1) return "wczoraj";
  if (days < 7) return `${days} dni temu`;
  return formatDate(ms);
}

// ---------------------------------------------------------------------------
// Moja nauka: automatic "recently learned from" history - one entry per
// source, auto-recorded whenever a phrase gets saved from it (see
// saveToNotebook/currentContent), never a dedicated "add to history" action.
// Just a way back in, not a tracker: no watch progress, no streaks.
// ---------------------------------------------------------------------------

mojaNaukaBtn.addEventListener("click", openMojaNauka);

async function openMojaNauka() {
  const overlay = openModal(`<h2>📚 Moja nauka</h2><p class="loading">Wczytuje...</p>`);
  const card = overlay.querySelector(".modal-card");

  let items;
  try {
    const res = await fetch(`/api/content?userId=${encodeURIComponent(getUserId())}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    items = await res.json();
  } catch (err) {
    card.innerHTML = `<h2>📚 Moja nauka</h2><p class="error-text">Nie udalo sie wczytac: ${escapeHtml(err.message)}</p><div class="modal-actions"><button class="btn-close">Zamknij</button></div>`;
    card.querySelector(".btn-close").addEventListener("click", () => overlay.remove());
    return;
  }

  renderMojaNauka(card, items);
}

function renderMojaNauka(card, items) {
  if (items.length === 0) {
    card.innerHTML = `
      <h2>📚 Moja nauka</h2>
      <p class="notebook-empty">Jeszcze nic tu nie masz. Wroc tutaj, gdy zapiszesz pierwsza fraze z jakiegos zrodla.</p>
      <div class="modal-actions"><button class="btn-close">Zamknij</button></div>
    `;
    card.querySelector(".btn-close").addEventListener("click", () => card.closest(".modal-overlay").remove());
    return;
  }

  const itemsHtml = items
    .map(
      (it, i) => `
      <div class="content-item" data-index="${i}">
        ${it.thumbnail ? `<img class="ci-thumb" src="${escapeHtml(it.thumbnail)}" alt="" />` : `<div class="ci-thumb"></div>`}
        <div class="ci-info">
          <div class="ci-title">${escapeHtml(it.title || (it.source === "spotify" ? "Spotify" : "YouTube"))}</div>
          <div class="ci-meta">Ostatnio: ${formatRelativeDate(it.lastOpenedAt)} · ${it.savedPhrasesCount} zapisanych ${it.savedPhrasesCount === 1 ? "zwrotu" : "zwrotow"}</div>
        </div>
        <button class="ci-continue">▶ Kontynuuj</button>
      </div>`
    )
    .join("");

  card.innerHTML = `
    <h2>📚 Moja nauka</h2>
    <div class="content-list">${itemsHtml}</div>
    <div class="modal-actions"><button class="btn-close">Zamknij</button></div>
  `;
  card.querySelector(".btn-close").addEventListener("click", () => card.closest(".modal-overlay").remove());
  card.querySelectorAll(".ci-continue").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = items[Number(btn.closest(".content-item").dataset.index)];
      card.closest(".modal-overlay").remove();
      continueContent(item);
    });
  });
}

/** Resumes a past source through the same loadSource() path a fresh link
 * paste would take - not a separate "resume" code path that could drift out
 * of sync with the real one. */
function continueContent(item) {
  if (!item.url) return;
  selectedPlatform = item.source;
  sourceUrlInput.value = item.url;
  loadSource();
}

// ---------------------------------------------------------------------------
// "Wroc do nauki": the landing state, not a button you have to think to
// click. If there's history, the most recent source is the first thing
// shown - before the empty source picker - with a one-click way back in AND
// a one-click way to test what actually stuck. This is the proactive half
// of Moja nauka; the modal (above) is the full list for anything older than
// "yesterday".
// ---------------------------------------------------------------------------

async function initReturnCard() {
  let items;
  try {
    const res = await fetch(`/api/content?userId=${encodeURIComponent(getUserId())}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    items = await res.json();
  } catch {
    return; // Silent - this is a convenience shortcut, not critical path; the normal picker is still right there.
  }
  if (!items || items.length === 0) return;

  const item = items[0];
  returnCard.innerHTML = `
    ${item.thumbnail ? `<img class="rc-thumb" src="${escapeHtml(item.thumbnail)}" alt="" />` : `<div class="rc-thumb"></div>`}
    <div class="rc-info">
      <div class="rc-label">Wroc do nauki</div>
      <div class="rc-title">${escapeHtml(item.title || (item.source === "spotify" ? "Spotify" : "YouTube"))}</div>
      <div class="rc-meta">Ostatnio: ${formatRelativeDate(item.lastOpenedAt)} · ${item.savedPhrasesCount} zapisanych ${item.savedPhrasesCount === 1 ? "zwrotu" : "zwrotow"}</div>
    </div>
    <div class="rc-actions">
      <button class="rc-continue">▶ Kontynuuj</button>
      <button class="rc-review">🔁 Sprawdz, co pamietasz</button>
    </div>
  `;
  returnCard.classList.add("visible");
  returnCard.querySelector(".rc-continue").addEventListener("click", () => continueContent(item));
  returnCard.querySelector(".rc-review").addEventListener("click", () => openReview({ contentId: item.contentId }));
}

initReturnCard();

// ---------------------------------------------------------------------------
// Powtorka: active recall, not a passive list. The phrase comes up first,
// alone - you try to recall it yourself, THEN (optionally) hear the real
// audio it came from, THEN see the answer. Recall-before-reveal is the
// whole point; showing the translation immediately would just be re-reading
// the notebook with extra steps.
// ---------------------------------------------------------------------------

let reviewQueue = [];
let reviewIndex = 0;

powtorkaBtn.addEventListener("click", openReview);

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function openReview(options = {}) {
  const { contentId } = options;
  const overlay = openModal(`<h2>🔁 Powtórka</h2><p class="loading">Wczytuje...</p>`);
  const card = overlay.querySelector(".modal-card");

  let phrases;
  try {
    const res = await fetch(`/api/phrases?userId=${encodeURIComponent(getUserId())}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    phrases = await res.json();
  } catch (err) {
    card.innerHTML = `<h2>🔁 Powtórka</h2><p class="error-text">Nie udalo sie wczytac: ${escapeHtml(err.message)}</p><div class="modal-actions"><button class="btn-close">Zamknij</button></div>`;
    card.querySelector(".btn-close").addEventListener("click", () => overlay.remove());
    return;
  }

  // Scoped to one source (from the "Wroc do nauki" card) when asked - but
  // fall back to the full set rather than show an empty review if nothing
  // in that scope has a contentId yet (phrases saved before this field
  // existed).
  if (contentId) {
    const scoped = phrases.filter((p) => p.contentId === contentId);
    if (scoped.length > 0) phrases = scoped;
  }

  if (phrases.length === 0) {
    card.innerHTML = `
      <h2>🔁 Powtórka</h2>
      <p class="notebook-empty">Jeszcze nic nie masz w pamietniku. Zaznacz slowo w transkrypcji i kliknij ⭐ Zapamietaj.</p>
      <div class="modal-actions"><button class="btn-close">Zamknij</button></div>
    `;
    card.querySelector(".btn-close").addEventListener("click", () => overlay.remove());
    return;
  }

  reviewQueue = shuffle(phrases);
  reviewIndex = 0;
  renderReviewPrompt(card);
}

/** Backward navigation across the whole saved set — without this, Powtorka
 * was one-way (forward-only via "Nastepna"), no way back to a phrase you
 * just saw. Forward movement already exists per-screen (Nastepna on the
 * answer side, skip-ahead below on the question side) with its own label/
 * meaning there, so this only adds Prev to avoid two differently-wired
 * "Nastepna" buttons stacked on the same card. Always lands back on the
 * question side, not mid-answer. */
function reviewNavHtml() {
  return `
    <div class="review-nav">
      <button class="btn-secondary btn-review-prev" ${reviewIndex === 0 ? "disabled" : ""}>← Poprzednia</button>
    </div>
  `;
}

function wireReviewNav(card) {
  card.querySelector(".btn-review-prev")?.addEventListener("click", () => {
    if (reviewIndex > 0) {
      reviewIndex--;
      renderReviewPrompt(card);
    }
  });
}

function renderReviewPrompt(card) {
  const p = reviewQueue[reviewIndex];
  card.innerHTML = `
    <h2>🔁 Powtórka <span class="review-progress">${reviewIndex + 1} / ${reviewQueue.length}</span></h2>
    ${reviewNavHtml()}
    <p class="review-prompt">Co znaczy:</p>
    <p class="review-phrase">${escapeHtml(p.phrase)}</p>
    <p class="review-hint">Przypomnij sobie znaczenie, zanim sprawdzisz odpowiedz.</p>
    <div class="modal-actions">
      ${p.hasClip ? `<button class="btn-secondary btn-play-clip">▶ Posluchaj fragmentu</button>` : ""}
      <button class="btn-remember btn-reveal">Pokaz odpowiedz</button>
      ${
        reviewIndex + 1 < reviewQueue.length
          ? `<button class="btn-secondary btn-review-skip">Pomin →</button>`
          : ""
      }
    </div>
  `;
  wireReviewNav(card);
  card.querySelector(".btn-review-skip")?.addEventListener("click", () => {
    reviewIndex++;
    renderReviewPrompt(card);
  });

  if (p.hasClip) {
    card.querySelector(".btn-play-clip").addEventListener("click", (e) => {
      let audio = card.querySelector("audio.review-audio");
      if (!audio) {
        audio = document.createElement("audio");
        audio.className = "review-audio clip-player";
        audio.controls = true;
        audio.src = `/clips/${p.id}.wav`;
        wireClipAudio(audio);
        e.currentTarget.insertAdjacentElement("afterend", audio);
      }
      audio.play();
    });
  }

  card.querySelector(".btn-reveal").addEventListener("click", () => renderReviewAnswer(card));
}

function renderReviewAnswer(card) {
  const p = reviewQueue[reviewIndex];
  const hasNext = reviewIndex + 1 < reviewQueue.length;
  card.innerHTML = `
    <h2>🔁 Powtórka <span class="review-progress">${reviewIndex + 1} / ${reviewQueue.length}</span></h2>
    ${reviewNavHtml()}
    <p class="review-prompt">Co znaczy:</p>
    <p class="review-phrase">${escapeHtml(p.phrase)}</p>
    ${p.contextSentence ? `<p class="phrase-src">${escapeHtml(p.contextSentence)}</p>` : ""}
    ${phraseSrcTranslationHtml(p.sentenceTranslation)}
    ${clipPlayerHtml(p)}
    ${explainFieldsHtml(p)}
    <div class="modal-actions">
      <button class="btn-remember btn-review-next">${hasNext ? "Nastepna →" : "Zakoncz powtorke"}</button>
      <button class="btn-close">Zamknij</button>
    </div>
  `;
  card.querySelector(".btn-close").addEventListener("click", () => card.closest(".modal-overlay").remove());
  card.querySelector(".btn-review-next").addEventListener("click", () => {
    if (hasNext) {
      reviewIndex++;
      renderReviewPrompt(card);
    } else {
      card.closest(".modal-overlay").remove();
    }
  });
  wireReviewNav(card);
  wireClipAudioElements(card);
}
