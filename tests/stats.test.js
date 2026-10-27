import { test } from "node:test";
import assert from "node:assert/strict";
import { track, trackError, reportDue, reportSent, setStatsOn } from "../src/stats.js";

function mem() { const m = {}; return { m, getItem: (k) => m[k] ?? null, setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } }; }
const day1 = new Date(2026, 9, 27, 9).getTime(), day2 = new Date(2026, 9, 28, 7).getTime(), day4 = new Date(2026, 9, 30, 7).getTime();

test("counts stay on the phone until the day is over, then go as one report", () => {
  const storage = mem();
  track("open", { storage, now: day1 }); track("save", { storage, now: day1 }); track("save", { storage, now: day1 });
  trackError("Calendar (iPhone)", { storage, now: day1 });
  assert.equal(reportDue({ storage, now: day1 }), null);
  const r = reportDue({ storage, now: day2, version: "4.22.0", platform: "ios" });
  assert.equal(r.day, "2026-10-27");
  assert.equal(r.first, "2026-10-27");
  assert.deepEqual(r.counts, { open: 1, save: 2 });
  assert.deepEqual(r.errors, { calendar_iphone: 1 });
  assert.match(r.install, /^[a-z0-9]{8,20}$/);
  assert.equal(r.platform, "ios");
  reportSent({ storage });
  assert.equal(reportDue({ storage, now: day2 }), null);
});

test("an unsent day isn't overwritten by later ones; quiet days send nothing", () => {
  const storage = mem();
  track("open", { storage, now: day1 });
  track("open", { storage, now: day2 }); // day1 is now waiting
  const r = reportDue({ storage, now: day4 });
  assert.equal(r.day, "2026-10-27");
  reportSent({ storage });
  assert.equal(reportDue({ storage, now: day4 }), null); // day2's tally was dropped; nothing from day 3
});

test("turned off: nothing counted, nothing kept, bad names ignored", () => {
  const storage = mem();
  track("open", { storage, now: day1 });
  setStatsOn(false, storage);
  track("save", { storage, now: day1 });
  assert.equal(storage.m["edition.stats"], undefined);
  assert.equal(reportDue({ storage, now: day2 }), null);
  setStatsOn(true, storage);
  track("Bad Name!", { storage, now: day1 });
  assert.equal(storage.m["edition.stats"], undefined);
});

import relay, { cleanReport, addReport, retention } from "../relay/perplexity-relay.js";

test("relay keeps only counts it expects", () => {
  const r = cleanReport({ install: "abc123def456", day: "2026-10-28", first: "2026-10-27", version: "4.22.0<script>", platform: "ios",
    counts: { save: 3, "Bad Key": 2, open: -1, huge: 1e9, title: "a secret" }, errors: { calendar: 1 }, extra: "x" });
  assert.deepEqual(r, { install: "abc123def456", day: "2026-10-28", first: "2026-10-27", version: "4.22.0", platform: "ios", counts: { save: 3 }, errors: { calendar: 1 } });
  assert.equal(cleanReport({ install: "x", day: "2026-10-28", first: "2026-10-27" }), null);
  assert.equal(cleanReport({ install: "abc123def456", day: "2026-10-27", first: "2026-10-28" }), null);
});

test("day totals and retention by start day", () => {
  const r = (install, day, first) => ({ install, day, first, version: "1", platform: "web", counts: { open: 1 }, errors: {} });
  const days = {};
  days["2026-10-20"] = [r("aaaaaaaa", "2026-10-20", "2026-10-20"), r("bbbbbbbb", "2026-10-20", "2026-10-20")].reduce((d, x) => addReport(d, x), null);
  days["2026-10-21"] = addReport(null, r("aaaaaaaa", "2026-10-21", "2026-10-20"));
  days["2026-10-27"] = addReport(null, r("bbbbbbbb", "2026-10-27", "2026-10-20"));
  assert.equal(days["2026-10-20"].new, 2);
  assert.deepEqual(retention(days).find((x) => x.day === "2026-10-20"), { day: "2026-10-20", new: 2, d1: 50, d7: 50, d30: null });
});

test("relay counts each install once a day", async () => {
  const m = new Map();
  const kv = { get: async (k, t) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, v); } };
  const send = () => relay.fetch(new Request("https://w.test/stats/report", { method: "POST", headers: { origin: "https://shoebox.tangomike.app" },
    body: JSON.stringify({ install: "abc123def456", day: "2026-10-27", first: "2026-10-27", version: "4.22.0", platform: "web", counts: { save: 2 } }) }), { SHOEBOX: kv });
  assert.equal((await send()).status, 200);
  assert.equal((await (await send()).json()).dup, true);
  assert.deepEqual(JSON.parse(m.get("st:2026-10-27")).counts, { save: 2 });
  const read = await relay.fetch(new Request("https://w.test/stats", { headers: { origin: "https://shoebox.tangomike.app" } }), { SHOEBOX: kv });
  assert.equal(read.status, 403);
});
