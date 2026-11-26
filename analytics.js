const fs = require("fs");
const path = require("path");

// Same flat-JSON-file approach as usage.js/store.js - our own, minimal,
// privacy-respecting event log (no external analytics provider). Only
// ever appends: {event, userId, ts, props}. Never put transcript text,
// recordings or other content in `props` - see the allow-list below,
// which is the only thing standing between this file and becoming a
// dumping ground for arbitrary client data.
const DATA_DIR = path.join(__dirname, "data");
const ANALYTICS_FILE = path.join(DATA_DIR, "analytics.json");

// Deliberately narrow - exactly the onboarding/engagement events the
// product spec calls for, nothing else. An unlisted event name is
// rejected outright (see server.js's POST /api/analytics/event), so a
// compromised or careless caller can't turn this into a general logger.
const ALLOWED_EVENTS = new Set([
  "onboarding_started",
  "onboarding_step_completed",
  "onboarding_step_skipped",
  "onboarding_completed",
  "language_selected",
  "interests_selected",
  "goal_selected",
  "first_content_started",
  "first_content_completed",
  "permission_requested",
  "permission_granted",
  "permission_denied",
]);

// Keeps a stray caller from writing an ever-growing props blob - this is
// supposed to carry a handful of short fields (a step id, a language
// name), never free text.
const MAX_PROPS_JSON_LENGTH = 2000;

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ANALYTICS_FILE)) fs.writeFileSync(ANALYTICS_FILE, "[]");
}

function readAll() {
  ensureStore();
  return JSON.parse(fs.readFileSync(ANALYTICS_FILE, "utf8"));
}

function writeAll(events) {
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(events, null, 2));
}

/** Validates and appends one event; returns null (caller should respond
 * 400) if `event` isn't on the allow-list or `props` is too large/not a
 * plain object. */
function logEvent(event, userId, props) {
  if (!ALLOWED_EVENTS.has(event)) return null;
  const safeProps = props && typeof props === "object" && !Array.isArray(props) ? props : {};
  if (JSON.stringify(safeProps).length > MAX_PROPS_JSON_LENGTH) return null;

  const entry = { event, userId, ts: Date.now(), props: safeProps };
  const all = readAll();
  all.push(entry);
  writeAll(all);
  return entry;
}

module.exports = { logEvent, ALLOWED_EVENTS };
