import { test } from "node:test";
import assert from "node:assert/strict";
import { pickResults, discoveryQueries } from "../src/ai.js";

const r = (u) => ({ title: u, url: `https://x.test/${u}`, snippet: "s" });

test("picks take turns across queries and skip saved links", () => {
  const results = [[r("a1"), r("a2")], [r("b1"), r("b2")], [r("c1")]];
  const picks = pickResults(results, ["qa", "qb", "qc"], { count: 4, known: new Set(["https://x.test/b1"]) });
  assert.deepEqual(picks.map((p) => p.title), ["a1", "c1", "a2", "b2"]);
  assert.equal(picks[0].query, "qa");
});

test("a single flat result list works too, and duplicates are dropped", () => {
  const picks = pickResults([r("a"), r("a"), r("b")], ["q"], { count: 3 });
  assert.deepEqual(picks.map((p) => p.title), ["a", "b"]);
});

test("queries come from the strongest tags, else from finished titles", () => {
  const withTags = { kept: [{ title: "T" }], dropped: [], tags: { scrum: 3, ai: 1 } };
  assert.match(discoveryQueries(withTags)[0], /scrum/);
  const noTags = { kept: [{ title: "Deep work" }], dropped: [], tags: {} };
  assert.deepEqual(discoveryQueries(noTags), ['articles like "Deep work"']);
});
