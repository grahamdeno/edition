import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VERDICT, STATUS, WHY_NOT, learnFromSuggestion, suggestionGuide, screenSuggestions, suggestMaxMinutes,
  emptySuggestProfile, interestProfile,
} from "../src/model.js";

const sug = { suggested: true, tags: ["AI", "scrum"], url: "https://www.medium.com/x", minutes: 25 };

test("each reason teaches something different", () => {
  const t = learnFromSuggestion(null, sug, VERDICT.LET_GO, WHY_NOT.TOPIC);
  assert.deepEqual(t.topics, { ai: -1.5, scrum: -1.5 });
  const k = learnFromSuggestion(null, sug, VERDICT.LET_GO, WHY_NOT.KNOWN);
  assert.deepEqual(k.topics, {});
  assert.deepEqual(k.deeper, { ai: 1, scrum: 1 });
  const l = learnFromSuggestion(null, sug, VERDICT.LET_GO, WHY_NOT.LONG);
  assert.equal(l.shorter, 1);
  assert.equal(suggestMaxMinutes(l), 25);
  const s = learnFromSuggestion(null, sug, VERDICT.LET_GO, WHY_NOT.SITE);
  assert.deepEqual(s.blocked, ["medium.com"]);
  const plain = learnFromSuggestion(null, sug, VERDICT.LET_GO);
  assert.deepEqual(plain.topics, { ai: -0.5, scrum: -0.5 });
});

test("a yes to a suggestion counts more than a no", () => {
  const done = learnFromSuggestion(emptySuggestProfile(), sug, VERDICT.DONE);
  assert.equal(done.topics.ai, 1.5);
  const kept = learnFromSuggestion(done, sug, VERDICT.LATER);
  assert.equal(kept.topics.ai, 2.5);
});

test("the guide tells the search what you welcomed, turned down, know, and blocked", () => {
  let p = learnFromSuggestion(null, { tags: ["roadmaps"] }, VERDICT.DONE);
  p = learnFromSuggestion(p, { tags: ["crypto"] }, VERDICT.LET_GO, WHY_NOT.TOPIC);
  p = learnFromSuggestion(p, { tags: ["scrum"] }, VERDICT.LET_GO, WHY_NOT.KNOWN);
  p = learnFromSuggestion(p, { url: "https://spam.test/a" }, VERDICT.LET_GO, WHY_NOT.SITE);
  p = learnFromSuggestion(p, {}, VERDICT.LET_GO, WHY_NOT.LONG);
  const g = suggestionGuide(p);
  assert.match(g, /welcomed.*roadmaps/);
  assert.match(g, /avoid them: crypto/);
  assert.match(g, /basics of: scrum/);
  assert.match(g, /about 25 minutes/);
  assert.match(g, /spam\.test/);
  assert.equal(suggestionGuide(emptySuggestProfile()), "");
});

test("blocked sites and much-too-long picks are screened out", () => {
  const p = { ...emptySuggestProfile(), blocked: ["spam.test"], shorter: 2 };
  const out = screenSuggestions([
    { url: "https://spam.test/a", minutes: 5 },
    { url: "https://ok.test/a", minutes: 60 },
    { url: "https://ok.test/b", minutes: 12 },
  ], p);
  assert.deepEqual(out.map((x) => x.url), ["https://ok.test/b"]);
});

test("letting go of a suggestion doesn't lower your own interests", () => {
  const items = [
    { status: STATUS.ARCHIVED, suggested: true, tags: ["ai"] },
    { status: STATUS.DONE, tags: ["ai"] },
    { status: STATUS.DONE, suggested: true, tags: ["design"] },
  ];
  const prof = interestProfile(items);
  assert.equal(prof.tags.ai, 1);
  assert.equal(prof.tags.design, 1.5);
});
