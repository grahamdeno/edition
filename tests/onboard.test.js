import { test } from "node:test";
import assert from "node:assert/strict";
import { TOPICS, followTopics, followedTopics, withFollows, makeCoach, shareStep, FOLLOW_WEIGHT } from "../src/onboard.js";

const memStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };

test("ten topic chips", () => {
  assert.equal(TOPICS.length, 10);
  assert.ok(TOPICS.includes("Local"));
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
  const p = withFollows({ tags: {}, kept: [], dropped: [] }, { topics: { science: 3, local: 3, history: -1 } }, { place: "Wilmington" });
  assert.equal(p.tags.science, 3);
  assert.equal(p.tags["local news in Wilmington"], 3);
  assert.equal(p.tags.history, undefined);
  assert.equal(p.tags.local, undefined);
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
