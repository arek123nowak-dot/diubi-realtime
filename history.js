const fs = require("fs");
const path = require("path");

// Same flat-JSON-file pattern as store.js/usage.js. One record per
// (userId, contentId) - "Moja nauka" / recently-learned-from history,
// updated automatically whenever a phrase gets saved from some source
// (see server.js's POST /api/phrases), never through a dedicated action.
// Deliberately minimal per the product decision behind this: no watch
// history, no completion tracking, no accounts - just "what did I last
// learn from, and how much have I saved from it."
const DATA_DIR = path.join(__dirname, "data");
const HISTORY_FILE = path.join(DATA_DIR, "content.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, "{}");
}

function readAll() {
  ensureStore();
  return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
}

function writeAll(data) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
}

function listContent(userId) {
  const all = readAll();
  return Object.values(all[userId] || {}).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

/** Creates or refreshes one content record for `userId`, bumping its saved-
 * phrase count. Later fields (title/thumbnail) fill in gaps rather than
 * overwrite with blanks, in case a later save for the same content arrives
 * with less metadata than the first one did. */
function upsertContent(userId, { contentId, source, url, title, thumbnail }) {
  if (!contentId) return;
  const all = readAll();
  if (!all[userId]) all[userId] = {};
  const existing = all[userId][contentId];
  all[userId][contentId] = {
    contentId,
    source: source || existing?.source || "",
    url: url || existing?.url || "",
    title: title || existing?.title || "",
    thumbnail: thumbnail || existing?.thumbnail || "",
    lastOpenedAt: Date.now(),
    savedPhrasesCount: (existing?.savedPhrasesCount || 0) + 1,
  };
  writeAll(all);
}

module.exports = { listContent, upsertContent };
