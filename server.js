require("dotenv").config();

const crypto = require("node:crypto");
const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const { listPhrases, addPhrase, deletePhrase } = require("./store");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_TARGET_LANG = process.env.TARGET_LANG || "pl";
const DEFAULT_SOURCE_LANG = process.env.SOURCE_LANG || ""; // empty = auto-detect
const TRANSLATION_MODEL = process.env.TRANSLATION_MODEL || "gpt-4o-mini";
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-4o-transcribe";
const TARGET_SAMPLE_RATE = 24000; // GA API requires >= 24000; must match public/app.js
const PORT = process.env.PORT || 3000;

// TEMPORARY, for the [USAGE] cost measurement only — public pricing as of
// this writing (not re-verified against the official OpenAI cennik from
// this environment, since openai.com/platform.openai.com are blocked here).
// Update these two $/1M rates if OpenAI changes pricing; the session summary
// below computes an exact dollar figure from them + the real token counts.
const PRICING_USD_PER_1M = {
  asrAudioIn: 6.0, // gpt-4o-transcribe, audio input tokens
  asrTextOut: 10.0, // gpt-4o-transcribe, transcript output tokens
  translateIn: 0.15, // gpt-4o-mini, input tokens
  translateOut: 0.6, // gpt-4o-mini, output tokens
};

const app = express();
app.use(express.static("public"));
app.use(express.json());

// The Chrome extension's content script calls these endpoints from whatever
// page it's injected into (YouTube, Spotify, ...) — a different origin than
// this backend, so it needs CORS even though the web app itself (same
// origin) doesn't. Scoped to /api/* only; the WebSocket stream and static
// files don't go through this.
app.use("/api", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.post("/api/explain", async (req, res) => {
  const { phrase, contextSentence, sourceLang, targetLang } = req.body || {};
  if (!phrase || typeof phrase !== "string" || !phrase.trim()) {
    return res.status(400).json({ error: "Brak frazy do wyjasnienia." });
  }
  try {
    const explanation = await explainPhrase(
      phrase.trim(),
      contextSentence || "",
      sourceLang || "",
      targetLang || DEFAULT_TARGET_LANG
    );
    res.json(explanation);
  } catch (err) {
    console.error("[explain] error:", err.message);
    res.status(502).json({ error: "Nie udalo sie wygenerowac wyjasnienia. Sprobuj ponownie." });
  }
});

app.get("/api/phrases", (req, res) => {
  const userId = req.query.userId;
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "Brak userId." });
  }
  res.json(listPhrases(userId));
});

app.post("/api/phrases", (req, res) => {
  const {
    userId,
    phrase,
    sourceLang,
    translation,
    targetLang,
    contextSentence,
    meaning,
    example,
    pronunciation,
    sourceLabel,
    sourceUrl,
  } = req.body || {};
  if (!userId || !phrase || !translation) {
    return res.status(400).json({ error: "Brak wymaganych pol (userId, phrase, translation)." });
  }
  const saved = addPhrase({
    id: crypto.randomUUID(),
    userId,
    phrase,
    sourceLang: sourceLang || "",
    translation,
    targetLang: targetLang || DEFAULT_TARGET_LANG,
    contextSentence: contextSentence || "",
    meaning: meaning || "",
    example: example || "",
    pronunciation: pronunciation || "",
    sourceLabel: sourceLabel || "",
    sourceUrl: sourceUrl || "",
    capturedAt: Date.now(),
  });
  res.status(201).json(saved);
});

app.delete("/api/phrases/:id", (req, res) => {
  const userId = req.query.userId;
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "Brak userId." });
  }
  const ok = deletePhrase(userId, req.params.id);
  if (!ok) return res.status(404).json({ error: "Nie znaleziono." });
  res.status(204).end();
});

/**
 * One-shot (non-streaming) explanation of a word/phrase the user picked out
 * of a transcript line: its translation, what it means in THAT sentence
 * (not a generic dictionary definition), a fresh example, and pronunciation.
 * JSON mode guarantees a parseable response instead of free-form prose.
 */
async function explainPhrase(phrase, contextSentence, sourceLang, targetLang) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TRANSLATION_MODEL,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            `Jestes nauczycielem jezyka pomagajacym zrozumiec fraze usłyszana w prawdziwej mowie${
              sourceLang ? ` (jezyk: ${sourceLang})` : ""
            }. Odpowiedz WYLACZNIE czystym obiektem JSON (bez markdown, bez komentarzy) z polami: ` +
            `"translation" (krotkie tlumaczenie samej frazy na jezyk ${targetLang}), ` +
            `"meaning" (1-2 zdania w jezyku ${targetLang} wyjasniajace co ta fraza znaczy KONKRETNIE w podanym kontekscie, nie ogolna definicja slownikowa), ` +
            `"example" (jedno NOWE przykladowe zdanie w jezyku oryginalnej frazy, inne niz podany kontekst, uzywajace tej frazy), ` +
            `"pronunciation" (wymowa frazy - IPA jesli to sensowne dla tego jezyka, inaczej prosty zapis fonetyczny; pusty string jesli nie da sie sensownie podac).`,
        },
        {
          role: "user",
          content: `Fraza: "${phrase}"\nZdanie, w ktorym padla: "${contextSentence}"`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(content);
  return {
    phrase,
    translation: parsed.translation || "",
    meaning: parsed.meaning || "",
    example: parsed.example || "",
    pronunciation: parsed.pronunciation || "",
  };
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/stream" });

wss.on("connection", (clientWs, req) => {
  const url = new URL(req.url, "http://localhost");
  const targetLang = url.searchParams.get("target") || DEFAULT_TARGET_LANG;
  const sourceLang = url.searchParams.get("source") || DEFAULT_SOURCE_LANG;

  console.log(`[client] connected (source=${sourceLang || "auto"} target=${targetLang})`);

  if (!OPENAI_API_KEY) {
    sendJson(clientWs, { type: "error", message: "Brak OPENAI_API_KEY na serwerze. Uzupelnij plik .env." });
    clientWs.close();
    return;
  }

  const session = new TranscriptionSession({ clientWs, sourceLang, targetLang });
  session.start();

  clientWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "audio_chunk" && msg.audio) {
      session.sendAudioChunk(msg.audio);
    } else if (msg.type === "stop") {
      session.stop();
    }
  });

  clientWs.on("close", () => {
    console.log("[client] disconnected");
    session.stop();
  });

  clientWs.on("error", (err) => {
    console.error("[client] ws error:", err.message);
  });
});

/**
 * Wraps one end-to-end live session: relays mic audio to OpenAI's realtime
 * transcription endpoint, and fires an incremental translation call for
 * every completed source-language sentence it receives back.
 */
class TranscriptionSession {
  constructor({ clientWs, sourceLang, targetLang }) {
    this.clientWs = clientWs;
    this.sourceLang = sourceLang;
    this.targetLang = targetLang;
    this.upstream = null;
    this.closed = false;
    this.segmentCounter = 0;
    this.upstreamReady = false;
    // Audio the client sends before the OpenAI connection finishes its
    // handshake used to be silently dropped, which lost the first couple
    // seconds of a video that starts autoplaying the instant it's loaded.
    this.pendingAudio = [];
    // Tracks which writing system this session's speech has actually used,
    // so short bursts in an unrelated script (ASR hallucinating on silence
    // or background noise) can be told apart from genuine content — without
    // ever hardcoding an expected language, since the source is auto-detected
    // and could legitimately be anything.
    this.scriptCounts = {};
    // Accumulates transcript text ACROSS committed chunks (not reset per
    // item_id) so a sentence split awkwardly across a forced commit still
    // gets translated whole once it actually completes — see the
    // delta/completed handlers and the force-commit timer below.
    this.textBuffer = "";
    this.textBufferStartedAt = null;
    this.lastDeltaAt = Date.now();
    this.hasUncommittedAudio = false;
    this.forceCommitTimer = null;
    this.idleFlushTimer = null;
    // RMS amplitude of the most recent audio chunk, used to wait for a
    // brief natural dip in volume (a micro-pause between words/syllables)
    // before forcing a commit, instead of cutting at a blind fixed instant
    // that's just as likely to land mid-word.
    this.recentAmplitude = 0;
    this.sinceLastCommitAt = Date.now();
    this.quietSinceMs = null;

    // TEMPORARY cost-measurement instrumentation (see [USAGE] log lines) —
    // lets a short real-world test session convert directly into an actual
    // $/minute figure instead of an estimate. Safe to remove once that
    // measurement is done; doesn't affect any behavior.
    this.startedAt = Date.now();
    this.sentAudioMs = 0;
    this.translationRequests = 0;
    this.usage = { asrAudioInputTokens: 0, asrOutputTokens: 0, translationInputTokens: 0, translationOutputTokens: 0 };
  }

  start() {
    // GA Realtime API (post 2026-05-12): ?intent=transcription still selects
    // a transcription-only session, but the OpenAI-Beta header is gone and
    // ?model= must be omitted here (it forces a full voice-agent session,
    // which then rejects a transcription-type session.update). The model
    // for transcription belongs in session.audio.input.transcription.model.
    const upstream = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
    });
    this.upstream = upstream;

    upstream.on("open", () => {
      console.log("[openai] transcription session open");
      upstream.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: TARGET_SAMPLE_RATE },
                transcription: {
                  model: TRANSCRIBE_MODEL,
                  ...(this.sourceLang ? { language: this.sourceLang } : {}),
                },
                noise_reduction: { type: "near_field" },
                // Automatic server_vad and our own forced periodic commits
                // (see the timer below) turned out not to coexist cleanly —
                // a manual commit landing anywhere near when VAD auto-commits
                // reliably hit an already-empty buffer and errored, in
                // practice far more often than a rare race (confirmed in
                // testing: a sustained error loop, not an occasional one).
                // Disabling VAD and driving 100% of the chunking ourselves
                // (via recentAmplitude, same mechanism as before) removes the
                // two mechanisms fighting over the same buffer.
                turn_detection: null,
              },
            },
          },
        })
      );

      this.upstreamReady = true;
      for (const audio of this.pendingAudio) {
        upstream.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
      }
      console.log(`[openai] flushed ${this.pendingAudio.length} buffered audio chunk(s)`);
      this.pendingAudio = [];

      sendJson(this.clientWs, { type: "status", message: "polaczono z ASR" });
      sendJson(this.clientWs, { type: "ready" });

      // With turn_detection disabled above, this is now the ONLY thing
      // deciding when audio gets committed for transcription — our own
      // minimal VAD, built on the same recentAmplitude (RMS) reading
      // computed per chunk in sendAudioChunk:
      //   - commits on a genuine pause (quiet for QUIET_HOLD_MS), same idea
      //     as OpenAI's silence_duration_ms, so natural sentence breaks
      //     still produce natural commit points
      //   - otherwise commits anyway once a chunk has run MAX_CHUNK_MS, so
      //     continuous/fast speech with no real pause still gets
      //     transcribed regularly instead of piling up for 15-20+ seconds
      //   - never commits before MIN_CHUNK_MS, so a brief pause right after
      //     the previous commit doesn't immediately trigger another
      //     near-empty one
      const MIN_CHUNK_MS = 600;
      const MAX_CHUNK_MS = 6000;
      const QUIET_AMPLITUDE = 500; // out of 32767 (Int16 full scale)
      const QUIET_HOLD_MS = 450; // matches the old server_vad silence_duration_ms

      this.forceCommitTimer = setInterval(() => {
        if (!this.hasUncommittedAudio || !this.upstreamReady || this.upstream?.readyState !== WebSocket.OPEN) return;

        const now = Date.now();
        const elapsed = now - this.sinceLastCommitAt;
        if (elapsed < MIN_CHUNK_MS) return;

        if (this.recentAmplitude < QUIET_AMPLITUDE) {
          if (!this.quietSinceMs) this.quietSinceMs = now;
        } else {
          this.quietSinceMs = null;
        }
        const quietElapsed = this.quietSinceMs ? now - this.quietSinceMs : 0;

        if (quietElapsed < QUIET_HOLD_MS && elapsed < MAX_CHUNK_MS) return;

        this.upstream.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        this.hasUncommittedAudio = false;
        this.sinceLastCommitAt = now;
        this.quietSinceMs = null;
      }, 200);

      // Safety net, two conditions: (1) the buffer has a dangling fragment
      // and nothing new has arrived in a while — speaker went quiet, stream
      // ended, etc.; (2) deltas KEEP arriving but a sentence boundary never
      // shows up — confirmed in testing: differences in audio quality
      // between capture methods made this common enough on one client that
      // it ran on indefinitely, mashing fragments from separate chunks
      // together with no translation ever firing. Either way, flush rather
      // than hold out for punctuation that isn't coming.
      const MAX_BUFFER_AGE_MS = 8000;
      this.idleFlushTimer = setInterval(() => {
        if (!this.textBuffer) return;
        const idleFor = Date.now() - this.lastDeltaAt;
        const bufferAge = Date.now() - this.textBufferStartedAt;
        if (idleFor > 4000 || bufferAge > MAX_BUFFER_AGE_MS) {
          this.emitSentence(this.textBuffer);
          this.textBuffer = "";
          this.textBufferStartedAt = null;
        }
      }, 2000);
    });

    upstream.on("message", (raw) => {
      console.log("[openai] event:", raw.toString());
      this.handleUpstreamEvent(raw);
    });

    upstream.on("error", (err) => {
      console.error("[openai] ws error:", err.message);
      sendJson(this.clientWs, { type: "error", message: `Blad ASR: ${err.message}` });
    });

    upstream.on("close", (code, reason) => {
      console.log(`[openai] transcription session closed (${code}) ${reason}`);
    });
  }

  handleUpstreamEvent(raw) {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // TEMPORARY: OpenAI includes a `usage` object on some events once a
    // transcription item completes — surfacing it here (whatever shape it
    // turns out to have) means a single real test session gives us the
    // actual token counts to price against, instead of the estimate in the
    // cost audit. Grep server logs for "[USAGE]" after a test run.
    if (event.usage) {
      console.log(`[USAGE][${event.type}]`, JSON.stringify(event.usage));
      this.usage.asrAudioInputTokens += event.usage.input_token_details?.audio_tokens || 0;
      this.usage.asrOutputTokens += event.usage.output_tokens || 0;
    }

    switch (event.type) {
      case "conversation.item.input_audio_transcription.delta": {
        sendJson(this.clientWs, { type: "transcript_delta", text: event.delta || "" });
        this.lastDeltaAt = Date.now();

        // Accumulated ACROSS committed chunks on purpose: a forced 5s
        // commit (see the timer above) can land mid-sentence, and we'd
        // rather wait for the words still to come than translate a
        // fragment. Only a run of sentence-ending punctuation actually
        // drains the buffer.
        if (!this.textBuffer) this.textBufferStartedAt = Date.now();
        this.textBuffer += event.delta || "";
        const { sentences, remainder } = splitCompleteSentences(this.textBuffer);
        for (const sentence of sentences) {
          this.emitSentence(sentence);
        }
        this.textBuffer = remainder;
        if (!this.textBuffer) this.textBufferStartedAt = null;
        break;
      }

      case "conversation.item.input_audio_transcription.completed":
        // No per-item flush here anymore — a completed turn (natural VAD
        // end OR a forced periodic commit) doesn't mean the current
        // sentence is actually finished. The idle-flush timer is what
        // eventually sends a trailing fragment if nothing follows it.
        break;

      case "input_audio_buffer.committed":
        this.hasUncommittedAudio = false;
        this.sinceLastCommitAt = Date.now();
        break;

      case "error":
        if (event.error?.code === "input_audio_buffer_commit_empty") {
          // Benign race: our forced-commit timer and OpenAI's own VAD both
          // decided to commit around the same moment, and VAD's commit won
          // — the buffer genuinely has nothing left. Not a real problem,
          // just means our tracking thought there was still audio pending;
          // clear it so the timer doesn't immediately retry the same thing.
          this.hasUncommittedAudio = false;
          break;
        }
        console.error("[openai] error event:", JSON.stringify(event));
        sendJson(this.clientWs, {
          type: "error",
          message: event.error?.message || "Nieznany blad OpenAI Realtime API",
        });
        break;

      default:
        // Inne typy eventow (np. sygnaly VAD) na razie ignorujemy.
        break;
    }
  }

  /** Filters and forwards one sentence-sized chunk of transcript, same checks as before, just now called once per sentence instead of once per whole VAD turn. */
  emitSentence(text) {
    const trimmed = text.trim();
    // Single-character transcripts are almost always ASR noise from a
    // spurious VAD-triggered segment (silence, breath, background hum).
    if (trimmed.length > 1 && !this.isScriptOutlier(trimmed)) {
      const segmentId = ++this.segmentCounter;
      sendJson(this.clientWs, { type: "transcript_final", text: trimmed, segmentId });
      this.translate(trimmed, segmentId);
    }
  }

  /**
   * True if `text` is a short burst in a writing system this session hasn't
   * actually been using — almost always the transcribe model hallucinating
   * over silence/noise/music rather than real speech. Longer stretches in a
   * different script are let through (a genuine switch to another language
   * doesn't look like a two-word hallucination), and nothing is flagged
   * until a dominant script has clearly established itself from real
   * segments, so this never hardcodes an expected source language.
   */
  isScriptOutlier(text) {
    const script = detectScript(text);
    const total = Object.values(this.scriptCounts).reduce((sum, n) => sum + n, 0);

    if (total >= 3) {
      const [dominantScript, dominantCount] = Object.entries(this.scriptCounts).sort((a, b) => b[1] - a[1])[0];
      if (dominantCount / total >= 0.7 && script !== dominantScript && text.length < 20) {
        console.log(`[filter] dropped script-outlier segment (${script} vs dominant ${dominantScript}): "${text}"`);
        return true;
      }
    }

    this.scriptCounts[script] = (this.scriptCounts[script] || 0) + 1;
    return false;
  }

  sendAudioChunk(base64Audio) {
    this.recentAmplitude = pcm16RmsAmplitude(base64Audio);

    // True silence (paused video, muted tab, nothing playing) is never
    // forwarded to the transcribe model at all. ASR models are well known
    // to hallucinate text over pure silence — with OpenAI's own server_vad
    // disabled (see start(), above), nothing else recognizes "this isn't
    // speech" anymore, so this is now the only thing standing between a
    // quiet tab and a stream of garbage transcripts. Comfortably below
    // QUIET_AMPLITUDE (which only needs to catch a brief pause between
    // words), so real speech — including quiet speech — still goes through.
    const SILENCE_THRESHOLD = 150;
    if (this.recentAmplitude < SILENCE_THRESHOLD) return;

    // TEMPORARY: total real speech audio actually forwarded to the ASR
    // model (silence already excluded above) — the other half of the
    // [USAGE] measurement, since OpenAI's own usage counters are priced per
    // audio token, not per second, and we want the $/minute conversion.
    const audioBytes = Buffer.from(base64Audio, "base64").length;
    this.sentAudioMs += (audioBytes / 2 / TARGET_SAMPLE_RATE) * 1000;

    if (this.upstreamReady && this.upstream?.readyState === WebSocket.OPEN) {
      this.upstream.send(
        JSON.stringify({ type: "input_audio_buffer.append", audio: base64Audio })
      );
      this.hasUncommittedAudio = true;
    } else if (!this.closed && this.pendingAudio.length < 300) {
      // Capped so a stuck/never-opening upstream connection can't grow this
      // unbounded; 300 chunks is roughly a minute of buffered audio.
      this.pendingAudio.push(base64Audio);
    }
  }

  async translate(sourceText, segmentId, attempt = 1) {
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY_MS = [500, 1500]; // before attempt 2 and attempt 3

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: TRANSLATION_MODEL,
          stream: true,
          // TEMPORARY: streaming responses omit token usage unless asked for
          // explicitly — this is the other half of the [USAGE] cost
          // measurement (text side; audio side is logged in
          // handleUpstreamEvent/sendAudioChunk above).
          stream_options: { include_usage: true },
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: `Jestes tlumaczem napisow na zywo. Przetlumacz podane zdanie${
                this.sourceLang ? ` z jezyka ${this.sourceLang}` : ""
              } na jezyk docelowy: ${this.targetLang}. Odpowiedz WYLACZNIE tlumaczeniem, bez cudzyslowow i komentarzy.`,
            },
            { role: "user", content: sourceText },
          ],
        }),
      });

      if (!response.ok || !response.body) {
        const errText = await response.text().catch(() => "");
        const err = new Error(`HTTP ${response.status}: ${errText}`);
        err.retryable = response.status === 429 || response.status >= 500;
        throw err;
      }

      let translated = "";
      for await (const chunk of sseLines(response.body)) {
        if (chunk === "[DONE]") break;
        try {
          const parsed = JSON.parse(chunk);
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) {
            translated += token;
            sendJson(this.clientWs, { type: "translation_delta", text: token, segmentId });
          }
          if (parsed.usage) {
            console.log(`[USAGE][translation]`, JSON.stringify(parsed.usage));
            this.usage.translationInputTokens += parsed.usage.prompt_tokens || 0;
            this.usage.translationOutputTokens += parsed.usage.completion_tokens || 0;
          }
        } catch {
          // pomijamy niepelne/nieparsowalne fragmenty SSE
        }
      }

      this.translationRequests++;
      sendJson(this.clientWs, { type: "translation_final", text: translated, segmentId });
    } catch (err) {
      // Network-level failures (fetch throwing outright, e.g. a dropped
      // connection) and rate-limit/server errors are almost always transient
      // — a blind retry fixes most of them. A real client-side problem
      // (bad API key, malformed request) is marked non-retryable above and
      // fails immediately instead of retrying something that can't succeed.
      const retryable = err.retryable !== false;
      if (retryable && attempt < MAX_ATTEMPTS) {
        console.warn(`[translate] attempt ${attempt} failed (${err.message}), retrying...`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS[attempt - 1]));
        return this.translate(sourceText, segmentId, attempt + 1);
      }

      console.error("[translate] error:", err.message);
      // Scoped to this segment (not a generic status-bar message) so the
      // client can mark exactly the one row that failed, instead of
      // leaving that row's translation blank forever while an unrelated
      // banner flashes somewhere else on screen.
      sendJson(this.clientWs, { type: "translation_error", segmentId, message: err.message });
    }
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.forceCommitTimer);
    clearInterval(this.idleFlushTimer);
    if (this.upstream && this.upstream.readyState === WebSocket.OPEN) {
      this.upstream.close();
    }

    // TEMPORARY: wall-clock session length next to actual audio forwarded
    // and translation request count — paired with the [USAGE] token counts
    // logged above, this is everything needed to compute a real $/minute
    // figure from one test session.
    const sessionSec = (Date.now() - this.startedAt) / 1000;
    const costUSD =
      (this.usage.asrAudioInputTokens / 1e6) * PRICING_USD_PER_1M.asrAudioIn +
      (this.usage.asrOutputTokens / 1e6) * PRICING_USD_PER_1M.asrTextOut +
      (this.usage.translationInputTokens / 1e6) * PRICING_USD_PER_1M.translateIn +
      (this.usage.translationOutputTokens / 1e6) * PRICING_USD_PER_1M.translateOut;
    const costPerMinuteUSD = sessionSec > 0 ? costUSD / (sessionSec / 60) : 0;
    console.log(
      `[USAGE SUMMARY] session=${sessionSec.toFixed(1)}s audioSentToASR=${(this.sentAudioMs / 1000).toFixed(
        1
      )}s translationRequests=${this.translationRequests} segments=${this.segmentCounter} ` +
        `tokens(asrAudioIn=${this.usage.asrAudioInputTokens},asrOut=${this.usage.asrOutputTokens},` +
        `translateIn=${this.usage.translationInputTokens},translateOut=${this.usage.translationOutputTokens}) ` +
        `estimatedCostUSD=${costUSD.toFixed(5)} costPerMinuteUSD=${costPerMinuteUSD.toFixed(5)}`
    );
  }
}

/** RMS amplitude of a base64-encoded PCM16 chunk, used to find micro-pauses between words. */
function pcm16RmsAmplitude(base64Audio) {
  const buffer = Buffer.from(base64Audio, "base64");
  const samples = buffer.length / 2;
  if (samples === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const sample = buffer.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples);
}

/**
 * Splits off every complete sentence from `text`, keeping only a trailing
 * fragment (not yet followed by punctuation+space, so possibly still
 * mid-word) as the remainder to keep accumulating. Punctuation right at the
 * very end of the buffer is deliberately NOT treated as a split point —
 * more of the same sentence could still be streaming in.
 */
function splitCompleteSentences(text) {
  const boundary = /[.!?]+\s/g;
  let lastEnd = -1;
  let match;
  while ((match = boundary.exec(text))) {
    lastEnd = match.index + match[0].length;
  }
  if (lastEnd === -1) return { sentences: [], remainder: text };

  const complete = text.slice(0, lastEnd);
  const remainder = text.slice(lastEnd);
  const sentences = complete
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { sentences, remainder };
}

const SCRIPT_RANGES = [
  ["cyrillic", /[Ѐ-ӿ]/],
  ["arabic", /[؀-ۿ]/],
  ["hebrew", /[֐-׿]/],
  ["greek", /[Ͱ-Ͽ]/],
  ["devanagari", /[ऀ-ॿ]/],
  ["thai", /[฀-๿]/],
  ["hangul", /[가-힯ᄀ-ᇿ]/],
  ["hiragana_katakana", /[぀-ヿ]/],
  ["cjk", /[㐀-鿿豈-﫿]/],
];

/** Labels the dominant writing system in `text`; defaults to "latin" (covers
 * Spanish/English/German/etc., including accented characters). */
function detectScript(text) {
  for (const [script, pattern] of SCRIPT_RANGES) {
    if (pattern.test(text)) return script;
  }
  return "latin";
}

/** Iterates an SSE (text/event-stream) body, yielding each `data:` payload. */
async function* sseLines(body) {
  let buffer = "";
  for await (const chunk of body) {
    // fetch's response.body yields Uint8Array, not Node Buffer — Uint8Array's
    // own .toString() ignores the "utf8" arg and prints comma-joined byte
    // numbers instead, so every chunk decoded as garbage until wrapped here.
    buffer += Buffer.from(chunk).toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("data:")) {
        yield line.slice(5).trim();
      }
    }
  }
}

function sendJson(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

server.listen(PORT, () => {
  console.log(`DIUBI realtime prototype listening on http://localhost:${PORT}`);
  if (!OPENAI_API_KEY) {
    console.warn("UWAGA: OPENAI_API_KEY nie jest ustawiony (patrz .env.example).");
  }
});
