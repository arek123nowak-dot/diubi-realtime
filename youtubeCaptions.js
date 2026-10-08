// Fetches YouTube's own caption track for a video - when one exists, it is
// perfectly time-aligned to the video with no transcription lag or ASR
// mis-hearing, which our live audio pipeline can't match. This module only
// fetches/parses (no OpenAI key needed); server.js translates the result.
// No official public API for this exists - it reads the same timedtext
// data a viewer's own "CC" toggle would load, the same technique common
// libraries like yt-dlp use. Fails closed (returns unavailable) on any
// shape it doesn't recognize, so the caller can fall back to live ASR.

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchWatchPageHtml(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching watch page`);
  return res.text();
}

/** Finds `marker` in `html`, then extracts the JSON object literal that
 * starts at the next `{` after it, using a brace-depth scan (quote-aware)
 * rather than a regex - the player response is too large/irregular for a
 * single non-greedy regex to reliably bound. */
function extractJsonAfterMarker(html, marker) {
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return null;
  const start = html.indexOf("{", markerIdx);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

/** Merges YouTube's raw per-cue caption events into sentence-ish chunks -
 * cues as delivered are often just a few words each, too short to be a
 * useful "context sentence" for Zapamietaj/Powtorka. Splits on sentence-
 * ending punctuation or a >1.2s gap (a natural pause), and drops a cue
 * that's just a repeat of the tail of what's already buffered (a known
 * artifact of some auto-caption tracks). */
function mergeCuesToSentences(cues) {
  const sentences = [];
  let buffer = "";
  let bufStart = null;
  let lastEnd = null;
  // Tracked separately from `buffer` (which resets at every sentence
  // boundary) because a repeated cue can land right after a flush, with
  // nothing left in `buffer` for an endsWith() check to catch.
  let lastCueText = "";

  for (const cue of cues) {
    if (!cue.text) continue;
    if (cue.text === lastCueText || buffer.endsWith(cue.text)) {
      lastEnd = cue.end;
      continue;
    }
    lastCueText = cue.text;
    const gapSec = lastEnd !== null ? cue.start - lastEnd : 0;
    if (buffer && gapSec > 1.2) {
      sentences.push({ start: bufStart, end: lastEnd, text: buffer.trim() });
      buffer = "";
    }
    if (!buffer) bufStart = cue.start;
    buffer = buffer ? `${buffer} ${cue.text}` : cue.text;
    lastEnd = cue.end;
    if (/[.!?…]["')\]]?$/.test(cue.text)) {
      sentences.push({ start: bufStart, end: lastEnd, text: buffer.trim() });
      buffer = "";
    }
  }
  if (buffer) sentences.push({ start: bufStart, end: lastEnd, text: buffer.trim() });
  return sentences;
}

/** Logs WHERE this gave up, not just that it did - "available: false" alone
 * gave no way to tell a genuinely caption-less video apart from our own
 * parsing breaking on a video that demonstrably has a transcript (the
 * exact case that showed up in testing: YouTube's own transcript panel had
 * it, we didn't find it). */
function unavailable(videoId, reason, extra) {
  console.log(`[YT CAPTIONS] unavailable videoId=${videoId} reason=${reason}${extra ? " " + extra : ""}`);
  return { available: false };
}

/** Returns { available: false } or { available: true, sourceLang, segments }
 * - never throws; any unexpected shape (no captions, blocked page, parse
 * failure) just means "unavailable", so the caller falls back to live ASR
 * instead of surfacing an error for something that's a normal, common case. */
async function getYouTubeCaptions(videoId) {
  const html = await fetchWatchPageHtml(videoId);
  console.log(`[YT CAPTIONS] videoId=${videoId} fetched watch page, length=${html.length}`);

  const json = extractJsonAfterMarker(html, "ytInitialPlayerResponse");
  if (!json) return unavailable(videoId, "marker-not-found-in-html");

  let playerResponse;
  try {
    playerResponse = JSON.parse(json);
  } catch (err) {
    return unavailable(videoId, "player-response-json-parse-failed", `jsonLength=${json.length} err="${err.message}"`);
  }

  const status = playerResponse?.playabilityStatus?.status;
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return unavailable(
      videoId,
      "no-caption-tracks-in-player-response",
      `playabilityStatus=${status || "?"} hasCaptionsKey=${Boolean(playerResponse?.captions)}`
    );
  }
  console.log(
    `[YT CAPTIONS] videoId=${videoId} found ${tracks.length} track(s): ${tracks
      .map((t) => `${t.languageCode}${t.kind === "asr" ? "(asr)" : ""}`)
      .join(", ")}`
  );

  // A manually-created/uploaded track (kind !== "asr") is generally cleaner
  // than auto-generated ones - prefer it when both exist.
  const track = tracks.find((t) => t.kind !== "asr") || tracks[0];
  if (!track?.baseUrl) return unavailable(videoId, "chosen-track-missing-baseurl");
  const baseUrl = track.baseUrl.startsWith("http") ? track.baseUrl : `https:${track.baseUrl}`;

  const captionRes = await fetch(`${baseUrl}&fmt=json3`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!captionRes.ok) return unavailable(videoId, "caption-track-fetch-failed", `httpStatus=${captionRes.status}`);

  let captionJson;
  try {
    captionJson = await captionRes.json();
  } catch (err) {
    return unavailable(videoId, "caption-track-json-parse-failed", `err="${err.message}"`);
  }

  const rawCues = (captionJson.events || [])
    .filter((e) => Array.isArray(e.segs))
    .map((e) => ({
      start: (e.tStartMs || 0) / 1000,
      end: (e.tStartMs + (e.dDurationMs || 0)) / 1000,
      text: e.segs
        .map((s) => s.utf8 || "")
        .join("")
        .replace(/\n/g, " ")
        .trim(),
    }))
    .filter((c) => c.text);
  console.log(`[YT CAPTIONS] videoId=${videoId} rawEvents=${(captionJson.events || []).length} rawCuesWithText=${rawCues.length}`);

  const segments = mergeCuesToSentences(rawCues);
  if (segments.length === 0) return unavailable(videoId, "no-segments-after-merge", `rawCues=${rawCues.length}`);

  console.log(`[YT CAPTIONS] videoId=${videoId} available=true segments=${segments.length}`);
  return { available: true, sourceLang: track.languageCode || "", segments };
}

module.exports = { getYouTubeCaptions };
