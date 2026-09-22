require("dotenv").config();

const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_TARGET_LANG = process.env.TARGET_LANG || "pl";
const DEFAULT_SOURCE_LANG = process.env.SOURCE_LANG || ""; // empty = auto-detect
const TRANSLATION_MODEL = process.env.TRANSLATION_MODEL || "gpt-4o-mini";
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-4o-transcribe";
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-realtime-1.5";
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
  }

  start() {
    // GA Realtime API (post 2026-05-12): no OpenAI-Beta header, no ?intent=
    // query param, and audio config now nests under session.audio.input.
    const upstream = new WebSocket(`wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`, {
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
                format: "pcm16",
                transcription: {
                  model: TRANSCRIBE_MODEL,
                  ...(this.sourceLang ? { language: this.sourceLang } : {}),
                },
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 500,
                },
              },
            },
          },
        })
      );
      sendJson(this.clientWs, { type: "status", message: "polaczono z ASR" });
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
      case "conversation.item.input_audio_transcription.delta":
        sendJson(this.clientWs, { type: "transcript_delta", text: event.delta || "" });
        break;

      case "conversation.item.input_audio_transcription.completed": {
        const text = (event.transcript || "").trim();
        if (text) {
          sendJson(this.clientWs, { type: "transcript_final", text });
          this.translate(text);
        }
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

  sendAudioChunk(base64Audio) {
    if (this.upstream?.readyState === WebSocket.OPEN) {
      this.upstream.send(
        JSON.stringify({ type: "input_audio_buffer.append", audio: base64Audio })
      );
    }
  }

  async translate(sourceText) {
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
            sendJson(this.clientWs, { type: "translation_delta", text: token });
          }
        } catch {
          // pomijamy niepelne/nieparsowalne fragmenty SSE
        }
      }

      sendJson(this.clientWs, { type: "translation_final", text: translated, source: sourceText });
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

/** Iterates an SSE (text/event-stream) body, yielding each `data:` payload. */
async function* sseLines(body) {
  let buffer = "";
  for await (const chunk of body) {
    buffer += chunk.toString("utf8");
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
