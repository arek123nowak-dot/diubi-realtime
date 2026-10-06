const fs = require("fs");
const path = require("path");

// Same flat-JSON-file pattern as store.js/usage.js. One record per
// (userId, contentId) - the user's content library: what they've engaged
// with across sources, updated automatically whenever a phrase gets saved
// from something (see server.js's POST /api/phrases), never through a
// dedicated action. Deliberately minimal for now - no watch progress, no
// completion tracking, no accounts - just "what did I last learn from, and
// how much have I saved from it." Named (and kept separate from store.js's
// phrases) as `content`, not `history`, on purpose: this is meant to grow
// into the user's library of the world they're exploring with DIUBI, not a
// log of pages visited.
const DATA_DIR = path.join(__dirname, "data");
const CONTENT_FILE = path.join(DATA_DIR, "content.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONTENT_FILE)) fs.writeFileSync(CONTENT_FILE, "{}");
}

function readAll() {
  ensureStore();
  return JSON.parse(fs.readFileSync(CONTENT_FILE, "utf8"));
}

function writeAll(data) {
  fs.writeFileSync(CONTENT_FILE, JSON.stringify(data, null, 2));
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
