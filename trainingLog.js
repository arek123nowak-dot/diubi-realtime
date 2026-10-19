const fs = require("fs");
const path = require("path");

// Same flat-JSON-file, day-keyed approach as usage.js. Tracks Trening
// attempts separately from the phrase records themselves (store.js) -
// a phrase's own trainingStats answers "is this one mastered", this
// answers "how did today's session go", which needs per-attempt history
// a single phrase field can't hold cheaply.
const DATA_DIR = path.join(__dirname, "data");
const TRAINING_LOG_FILE = path.join(DATA_DIR, "trainingLog.json");

function todayKey() {
  return new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(TRAINING_LOG_FILE)) fs.writeFileSync(TRAINING_LOG_FILE, "{}");
}

function readAll() {
  ensureStore();
  return JSON.parse(fs.readFileSync(TRAINING_LOG_FILE, "utf8"));
}

function writeAll(data) {
  fs.writeFileSync(TRAINING_LOG_FILE, JSON.stringify(data, null, 2));
}

/** Records one answered Trening question for today's tally. */
function logAttempt(userId, correct) {
  const all = readAll();
  const key = todayKey();
  if (!all[key]) all[key] = {};
  if (!all[key][userId]) all[key][userId] = { attempts: 0, correct: 0 };
  all[key][userId].attempts += 1;
  if (correct) all[key][userId].correct += 1;
  writeAll(all);
}

/** Today's {attempts, correct} for `userId` - zeros if nothing logged yet. */
function getTodayStats(userId) {
  const all = readAll();
  const today = all[todayKey()] || {};
  return today[userId] || { attempts: 0, correct: 0 };
}

module.exports = { logAttempt, getTodayStats };
