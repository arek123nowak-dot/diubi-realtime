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
const spotifyHint = document.getElementById("spotifyHint");

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
  spotifyHint.style.display = "none";
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
  openExplainCard(phrase, cell.textContent);
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

async function openExplainCard(phrase, contextSentence) {
  const overlay = openModal(`
    <h2>${escapeHtml(phrase)}</h2>
    <p class="phrase-src">${escapeHtml(contextSentence)}</p>
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
      await saveToNotebook(phrase, contextSentence, data);
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

function showSavedPhraseCard(p) {
  const overlay = openModal(`
    <h2>${escapeHtml(p.phrase)}</h2>
    <p class="phrase-src">${escapeHtml(p.contextSentence)}</p>
    ${explainFieldsHtml(p)}
    <div class="modal-actions"><button class="btn-close">Zamknij</button></div>
  `);
  overlay.querySelector(".btn-close").addEventListener("click", () => overlay.remove());
}

async function saveToNotebook(phrase, contextSentence, explainData) {
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
      meaning: explainData.meaning,
      example: explainData.example,
      pronunciation: explainData.pronunciation,
      sourceLabel,
      sourceUrl,
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
