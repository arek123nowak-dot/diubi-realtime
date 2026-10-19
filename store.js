const fs = require("fs");
const path = require("path");

// Flat JSON file, not a real database — at the scale of a handful of
// testers this is simpler and more portable than standing up SQLite/Postgres
// for a first vertical slice. The cost audit already flagged Postgres as
// the natural upgrade for whenever the backend gets a public deployment;
// this file format (one array of plain objects) migrates into a table
// one-to-one when that happens.
const DATA_DIR = path.join(__dirname, "data");
const PHRASES_FILE = path.join(DATA_DIR, "phrases.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PHRASES_FILE)) fs.writeFileSync(PHRASES_FILE, "[]");
}

function readAll() {
  ensureStore();
  return JSON.parse(fs.readFileSync(PHRASES_FILE, "utf8"));
}

function writeAll(phrases) {
  fs.writeFileSync(PHRASES_FILE, JSON.stringify(phrases, null, 2));
}

function listPhrases(userId) {
  return readAll()
    .filter((p) => p.userId === userId)
    .sort((a, b) => b.capturedAt - a.capturedAt);
}

function addPhrase(phrase) {
  const phrases = readAll();
  phrases.push(phrase);
  writeAll(phrases);
  return phrase;
}

function deletePhrase(userId, id) {
  const phrases = readAll();
  const next = phrases.filter((p) => !(p.userId === userId && p.id === id));
  if (next.length === phrases.length) return false;
  writeAll(next);
  return true;
}

/** Merges `patch` into an existing phrase record - used to attach a
 * generated Trening exercise (async, after the phrase itself is already
 * saved and returned to the client) and to update training stats after
 * each attempt, without disturbing any other field. */
function updatePhrase(userId, id, patch) {
  const phrases = readAll();
  const idx = phrases.findIndex((p) => p.userId === userId && p.id === id);
  if (idx === -1) return null;
  phrases[idx] = { ...phrases[idx], ...patch };
  writeAll(phrases);
  return phrases[idx];
}

module.exports = { listPhrases, addPhrase, updatePhrase, deletePhrase };
