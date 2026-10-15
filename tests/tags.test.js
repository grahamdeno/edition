import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STATUS, normTag, resolveTag, canonTags, tagVocab, tagStats, renameTag, addAlias, releaseTags,
  renameInSuggestProfile, localTags,
} from "../src/model.js";

test("tags are cleaned the same way everywhere", () => {
  assert.equal(normTag("  #Agile_Methods "), "agile methods");
  assert.deepEqual(canonTags(["AI", "ai", " Scrum", ""]), ["ai", "scrum"]);
});

test("aliases follow renames and merges, and a deleted tag drops out", () => {
  const a = { agile: "scrum", "agile methods": "agile", junk: "" };
  assert.equal(resolveTag("Agile Methods", a), "scrum");
  assert.deepEqual(canonTags(["agile", "scrum", "junk", "ai"], a), ["scrum", "ai"]);
  assert.equal(resolveTag("x", { x: "y", y: "x" }), "x"); // a loop stops instead of hanging
});

test("the vocabulary is most used first", () => {
  const items = [{ tags: ["ai", "scrum"] }, { tags: ["AI"] }, { tags: ["leadership"] }];
  assert.deepEqual(tagVocab(items), ["ai", "leadership", "scrum"]);
});

test("renaming merges into a tag already in use without duplicates", () => {
  const items = [{ id: "1", tags: ["agile", "scrum"] }, { id: "2", tags: ["agile"] }, { id: "3", tags: ["ai"] }];
  const out = renameTag(items, "agile", "scrum");
  assert.deepEqual(out.map((i) => [i.id, i.tags]), [["1", ["scrum"]], ["2", ["scrum"]]]);
  assert.deepEqual(renameTag(items, "agile", "").map((i) => i.tags), [["scrum"], []]);
  assert.deepEqual(renameTag(items, "agile", "agile"), []);
});

test("aliases stay consistent across chained merges, and typing a tag brings it back", () => {
  let a = addAlias({}, "agile methods", "agile");
  a = addAlias(a, "agile", "scrum");
  assert.deepEqual(a, { "agile methods": "scrum", agile: "scrum" });
  a = addAlias(a, "scrum", "agile"); // reversing a merge
  assert.equal(resolveTag("scrum", a), "agile");
  assert.equal(resolveTag("agile", a), "agile");
  assert.deepEqual(releaseTags({ junk: "", agile: "scrum" }, ["Junk"]), { agile: "scrum" });
});

test("what suggestions learned moves with the tag", () => {
  const p = renameInSuggestProfile({ topics: { agile: -1.5, scrum: 1 }, deeper: { agile: 1 } }, "agile", "scrum");
  assert.deepEqual(p.topics, { scrum: -0.5 });
  assert.deepEqual(p.deeper, { scrum: 1 });
  assert.deepEqual(renameInSuggestProfile({ topics: { agile: 2 } }, "agile", "").topics, {});
});

test("tag stats carry counts and the verdict score", () => {
  const items = [
    { status: STATUS.DONE, kind: "link", tags: ["ai"] },
    { status: STATUS.ARCHIVED, kind: "link", tags: ["ai", "crypto"] },
    { status: STATUS.QUEUED, kind: "link", tags: ["ai"] },
  ];
  assert.deepEqual(tagStats(items), [{ tag: "ai", count: 3, score: 0 }, { tag: "crypto", count: 1, score: -1 }]);
});

test("untagged suggestions borrow your own tags from their words", () => {
  const vocab = ["scrum", "product management", "ai", "c++"];
  assert.deepEqual(localTags("Why Scrum teams stall: notes on product management", vocab), ["scrum", "product management"]);
  assert.deepEqual(localTags("Faith and doubt", vocab), []);
  assert.deepEqual(localTags("Modern C++ in practice", vocab), ["c++"]);
});
