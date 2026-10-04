const fs = require("fs");
const path = require("path");

// Same flat-JSON-file approach as store.js, and the same reasoning: at
// tester scale this is simpler than standing up a real database, and it's
// meant to stop someone from accidentally burning through OpenAI credits,
// not to survive a redeploy with perfect accuracy (a reset counter on
// redeploy just means someone gets a few extra free minutes, not a real
// problem). Keyed by day so there's nothing to "reset" - a new date is a
// fresh empty bucket.
const DATA_DIR = path.join(__dirname, "data");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");

function todayKey() {
  return new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USAGE_FILE)) fs.writeFileSync(USAGE_FILE, "{}");
}

function readAll() {
  ensureStore();
  return JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
}

function writeAll(data) {
  fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2));
}

/** Minutes used today by `userId`, and across everyone combined. */
function getUsageMinutes(userId) {
  const all = readAll();
  const today = all[todayKey()] || { global: 0, users: {} };
  return {
    userMinutes: (today.users[userId] || 0) / 60000,
    globalMinutes: today.global / 60000,
  };
}

/** Adds `ms` more listening time to today's tally for `userId` (and the
 * combined total), returning the updated totals in minutes. */
function addUsageMs(userId, ms) {
  if (!(ms > 0)) return getUsageMinutes(userId);
  const all = readAll();
  const key = todayKey();
  if (!all[key]) all[key] = { global: 0, users: {} };
  all[key].users[userId] = (all[key].users[userId] || 0) + ms;
  all[key].global += ms;
  writeAll(all);
  return {
    userMinutes: all[key].users[userId] / 60000,
    globalMinutes: all[key].global / 60000,
  };
}

module.exports = { getUsageMinutes, addUsageMs };
