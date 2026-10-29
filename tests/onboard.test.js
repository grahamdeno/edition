import { test } from "node:test";
import assert from "node:assert/strict";
import { TOPICS, followTopics, followedTopics, withFollows, makeCoach, shareStep, FOLLOW_WEIGHT } from "../src/onboard.js";

const memStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };

test("nine topic chips, none of them local", () => {
  assert.equal(TOPICS.length, 9);
  assert.ok(!TOPICS.includes("Local"));
});

test("followTopics adds chosen topics without lowering learned ones", () => {
  const s = followTopics({ topics: { tech: 5, sports: -1 }, blocked: [] }, ["Tech", "Science", "Sports"]);
  assert.equal(s.topics.tech, 5);
  assert.equal(s.topics.science, FOLLOW_WEIGHT);
  assert.equal(s.topics.sports, FOLLOW_WEIGHT);
  assert.deepEqual(s.blocked, []);
  assert.deepEqual(followedTopics(s), ["Tech", "Science", "Sports"]);
  const again = followTopics(s, ["Tech"]);
  assert.equal(again.topics.science, undefined, "un-picked chip is dropped");
  assert.equal(again.topics.tech, 5, "learned weight stays");
});

test("withFollows gives a new person something to search for", () => {
  const p = withFollows({ tags: {}, kept: [], dropped: [] }, { topics: { science: 3, local: 3, history: -1 } });
  assert.equal(p.tags.science, 3);
  assert.equal(p.tags.history, undefined);
  assert.equal(p.tags.local, undefined, "a retired local topic adds nothing");
  const q = withFollows({ tags: { science: 2 } }, { topics: { science: 3, local: 3 } });
  assert.equal(q.tags.science, 5);
  assert.equal(Object.keys(q.tags).length, 1);
});

test("coach marks: once each, one per session", () => {
  const store = memStore();
  const c = makeCoach(store);
  assert.ok(c.can("dbl"));
  assert.ok(c.take("dbl"));
  assert.ok(!c.can("stories"), "second tip waits for the next session");
  assert.ok(!c.take("stories"));
  const next = makeCoach(store);
  assert.ok(!next.can("dbl"), "never twice");
  assert.ok(next.can("stories"));
  next.see("stories");
  assert.ok(!next.can("stories"), "using the feature first skips its tip");
  next.reset();
  assert.ok(next.can("dbl"));
});

test("share step by platform", () => {
  assert.equal(shareStep({ native: true }), "share");
  assert.equal(shareStep({ native: true, shared: true }), "pin");
  assert.equal(shareStep({ native: true, shared: true, pinned: true }), "");
  assert.equal(shareStep({ native: false, standalone: false }), "home");
  assert.equal(shareStep({ standalone: true, saves: 0 }), "first");
  assert.equal(shareStep({ standalone: true, saves: 2 }), "");
  assert.equal(shareStep({ native: true, dismissed: true }), "");
});

import { pickTip, tipDone, DAY_TIPS } from "../src/onboard.js";

test("day tips: none on day 1, one a day after, skipping what's in use", () => {
  assert.equal(pickTip({ today: "2026-10-27", startDay: "2026-10-27" }).key, "");
  assert.equal(pickTip({ today: "2026-10-28", startDay: "" }).key, "", "people who skipped onboarding before it existed get none");
  let r = pickTip({ today: "2026-10-28", startDay: "2026-10-27", used: new Set(["email", "song"]) });
  assert.equal(r.key, "more");
  const same = pickTip({ today: "2026-10-28", startDay: "2026-10-27", log: r.log });
  assert.equal(same.key, "more", "same tip all day");
  assert.equal(pickTip({ today: "2026-10-28", startDay: "2026-10-27", log: tipDone(r.log, "more") }).key, "", "dismissed: gone for today");
  r = pickTip({ today: "2026-10-29", startDay: "2026-10-27", used: new Set(["email", "song"]), log: r.log });
  assert.equal(r.key, "newsletters", "yesterday's tip is done");
  const all = { done: Object.fromEntries(DAY_TIPS.map((k) => [k, 1])), day: "2026-11-01", key: "backup" };
  assert.equal(pickTip({ today: "2026-11-02", startDay: "2026-10-27", log: all }).key, "", "after the week, nothing");
});

test("coach forget lets one tip show again", () => {
  const store = memStore();
  const c = makeCoach(store);
  c.take("dbl");
  c.forget("dbl");
  assert.ok(!c.seen("dbl"));
});

import { mixStories, followOrder } from "../src/onboard.js";

test("shared stories mix one from each topic, strongest first, tagged by topic", () => {
  const lists = [
    { topic: "science", picks: [{ url: "a", tags: ["space"] }, { url: "b" }, { url: "c" }] },
    { topic: "health", picks: [{ url: "a" }, { url: "d" }] },
    { topic: "tech", picks: [] },
  ];
  const out = mixStories(lists, 3, new Set(["c"]));
  assert.deepEqual(out.map((p) => p.url), ["a", "d", "b"]);
  assert.deepEqual(out[0].tags, ["science", "space"]);
  assert.deepEqual(out[1].tags, ["health"]);
  assert.deepEqual(followOrder({ topics: { tech: 3, science: 4.5, rust: 9, sports: -1 } }), ["science", "tech"]);
});
