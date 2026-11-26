const fs = require("fs");
const path = require("path");

// Same flat-JSON-file approach as store.js/usage.js, for the same reason:
// at tester scale this is simpler than a real database, and the anonymous
// userId is already the only identity we have - see server.js's /api/
// preferences routes and public/landing.html's onboarding flow.
const DATA_DIR = path.join(__dirname, "data");
const PREFERENCES_FILE = path.join(DATA_DIR, "preferences.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PREFERENCES_FILE)) fs.writeFileSync(PREFERENCES_FILE, "[]");
}

function readAll() {
  ensureStore();
  return JSON.parse(fs.readFileSync(PREFERENCES_FILE, "utf8"));
}

function writeAll(records) {
  fs.writeFileSync(PREFERENCES_FILE, JSON.stringify(records, null, 2));
}

function getPreferences(userId) {
  return readAll().find((p) => p.userId === userId) || null;
}

/** Merges `patch` into userId's record (creating it on first call) - never
 * overwrites the whole thing, so a partial save from one onboarding step
 * can't erase fields an earlier step already saved. */
function savePreferences(userId, patch) {
  const all = readAll();
  const idx = all.findIndex((p) => p.userId === userId);
  if (idx === -1) {
    const created = { userId, ...patch };
    all.push(created);
    writeAll(all);
    return created;
  }
  all[idx] = { ...all[idx], ...patch };
  writeAll(all);
  return all[idx];
}

module.exports = { getPreferences, savePreferences };
