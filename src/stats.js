/*
 * Anonymous usage stats: counts only, once a day.
 *
 * Each install keeps a tally for the day on the phone (how many saves,
 * verdicts, finished editions, which kinds of problem came up). The first
 * time Shoebox opens on a new day, yesterday's tally goes to the relay as
 * one small report, with a random install number that is used for nothing
 * else (not the AI one) and the day this install started. No titles, links,
 * text or error messages ever leave the phone. Turn it off in Settings › Help.
 */

const KEY = "edition.stats", OFF = "edition.statsOff";
const NAME = /^[a-z][a-z0-9_]{0,31}$/;

const today = (now = Date.now()) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 20);

function load(storage) {
  try { return JSON.parse(storage.getItem(KEY) || "null"); } catch { return null; }
}
function save(storage, s) {
  try { storage.setItem(KEY, JSON.stringify(s)); } catch { /* full or blocked */ }
}

export function statsOn(storage = localStorage) {
  try { return storage.getItem(OFF) !== "1"; } catch { return false; }
}
export function setStatsOn(on, storage = localStorage) {
  try { if (on) storage.removeItem(OFF); else { storage.setItem(OFF, "1"); storage.removeItem(KEY); } } catch { /* blocked */ }
}

/** The tally for today. A finished day becomes the report waiting to go (only the oldest unsent one is kept). */
function current(storage, now) {
  const day = today(now);
  let s = load(storage);
  if (!s || !s.install) s = { install: randomId(), first: day, day, counts: {}, errors: {} };
  if (s.day !== day) {
    const had = Object.keys(s.counts || {}).length + Object.keys(s.errors || {}).length;
    if (!s.pending && had) s.pending = { day: s.day, counts: s.counts, errors: s.errors };
    s.day = day; s.counts = {}; s.errors = {};
  }
  return s;
}

/** Count one thing that happened. Names are short words like "save" or "verdict_done". */
export function track(name, { storage = localStorage, now = Date.now() } = {}) {
  if (!statsOn(storage) || !NAME.test(name)) return;
  const s = current(storage, now);
  s.counts[name] = (s.counts[name] || 0) + 1;
  save(storage, s);
}

/** Count a kind of problem by where it happened ("calendar", "enrich"): never its message. */
export function trackError(where, { storage = localStorage, now = Date.now() } = {}) {
  if (!statsOn(storage)) return;
  const k = String(where || "other").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32) || "other";
  const s = current(storage, now);
  s.errors[k] = (s.errors[k] || 0) + 1;
  save(storage, s);
}

/** Yesterday's (or an older day's) report, if one is ready to send. */
export function reportDue({ storage = localStorage, now = Date.now(), version = "", platform = "web" } = {}) {
  if (!statsOn(storage)) return null;
  const s = current(storage, now);
  save(storage, s);
  if (!s.pending) return null;
  return { install: s.install, first: s.first, day: s.pending.day, version, platform, counts: s.pending.counts, errors: s.pending.errors };
}

export function reportSent({ storage = localStorage } = {}) {
  const s = load(storage);
  if (s) { delete s.pending; save(storage, s); }
}

/** Send what's due to the relay. Quiet: stats never get in the way. */
export async function sendReport(relay, opts = {}) {
  const r = reportDue(opts);
  if (!r || !relay) return false;
  try {
    const res = await fetch(`${relay}/stats/report`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r) });
    if (res.ok || res.status === 400) { reportSent(opts); return res.ok; }
  } catch { /* try again next open */ }
  return false;
}
