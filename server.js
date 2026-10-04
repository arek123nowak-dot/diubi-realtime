require("dotenv").config();

const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_TARGET_LANG = process.env.TARGET_LANG || "pl";
const DEFAULT_SOURCE_LANG = process.env.SOURCE_LANG || ""; // empty = auto-detect
const TRANSLATION_MODEL = process.env.TRANSLATION_MODEL || "gpt-4o-mini";
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-4o-transcribe";
const TARGET_SAMPLE_RATE = 24000; // GA API requires >= 24000; must match public/app.js
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static("public"));

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
    // Per-item_id accumulator for sentence-boundary splitting — see the
    // delta/completed handlers below.
    this.deltaBuffers = new Map();
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
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  // VAD only controls how audio gets chunked for transcription
                  // in this session type — this is the main lever for how
                  // long speech sits unprocessed before anything happens.
                  // Pulled back down from 700ms now that the script-outlier
                  // and 1-char filters catch more of the resulting noise, so
                  // this can prioritize responsiveness again.
                  silence_duration_ms: 450,
                },
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

    switch (event.type) {
      case "conversation.item.input_audio_transcription.delta": {
        sendJson(this.clientWs, { type: "transcript_delta", text: event.delta || "" });

        // Translating only once the VAD turn ends means a fast talker with
        // no 700ms pause produces one giant backlog, translated all at once
        // long after it was actually said. Splitting off each complete
        // sentence as soon as it appears mid-turn keeps translation pace
        // with speech instead of batching a whole paragraph at a time.
        const itemId = event.item_id;
        const buffered = (this.deltaBuffers.get(itemId) || "") + (event.delta || "");
        const { sentences, remainder } = splitCompleteSentences(buffered);
        for (const sentence of sentences) {
          this.emitSentence(sentence);
        }
        this.deltaBuffers.set(itemId, remainder);
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const itemId = event.item_id;
        const remainder = (this.deltaBuffers.get(itemId) || "").trim();
        this.deltaBuffers.delete(itemId);
        // Whatever's left over wasn't followed by sentence-ending
        // punctuation+space before the turn ended (e.g. it trailed off, or
        // the whole turn was just a short interjection) — flush it as-is.
        if (remainder) this.emitSentence(remainder);
        break;
      }

      case "error":
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
    if (this.upstreamReady && this.upstream?.readyState === WebSocket.OPEN) {
      this.upstream.send(
        JSON.stringify({ type: "input_audio_buffer.append", audio: base64Audio })
      );
    } else if (!this.closed && this.pendingAudio.length < 300) {
      // Capped so a stuck/never-opening upstream connection can't grow this
      // unbounded; 300 chunks is roughly a minute of buffered audio.
      this.pendingAudio.push(base64Audio);
    }
  }

  async translate(sourceText, segmentId) {
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
        throw new Error(`HTTP ${response.status}: ${errText}`);
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
        } catch {
          // pomijamy niepelne/nieparsowalne fragmenty SSE
        }
      }

      sendJson(this.clientWs, { type: "translation_final", text: translated, segmentId });
    } catch (err) {
      console.error("[translate] error:", err.message);
      sendJson(this.clientWs, { type: "error", message: `Blad tlumaczenia: ${err.message}` });
    }
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    if (this.upstream && this.upstream.readyState === WebSocket.OPEN) {
      this.upstream.close();
    }
  }
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
