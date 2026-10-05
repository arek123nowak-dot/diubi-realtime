const fs = require("fs");
const path = require("path");

const CLIPS_DIR = path.join(__dirname, "data", "clips");

function ensureDir() {
  if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });
}

/** Wraps raw PCM16 mono samples in a minimal WAV header — no encoding
 * library needed, WAV is just a 44-byte header in front of the same bytes
 * we already have. */
function pcm16ToWav(pcmBuffer, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/** Saves a raw PCM16 clip as `<id>.wav` under data/clips/. These are short
 * (a few seconds) personal-study snippets of audio that was already
 * streaming through this server for the listener's own live transcription
 * session — not a download/cache of the source platform's media file. */
function saveClip(id, pcmBuffer, sampleRate) {
  ensureDir();
  const wav = pcm16ToWav(pcmBuffer, sampleRate);
  fs.writeFileSync(path.join(CLIPS_DIR, `${id}.wav`), wav);
}

function deleteClip(id) {
  const file = path.join(CLIPS_DIR, `${id}.wav`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = { CLIPS_DIR, saveClip, deleteClip };
