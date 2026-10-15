import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VERDICT, STATUS, KIND, MAX_SKIPS, dayKey, findUrl, kindOfFile, draftFromText, draftFromFile,
  createItem, applyVerdict, interestProfile, localScore, score, buildEdition, editionView,
  migrateLegacy, titleFromUrl, restore,
} from "../src/model.js";

const NOW = new Date(2026, 9, 14, 9, 0).getTime();
const DAY = 86400000;
let n = 0;
const make = (draft, extra = {}) => ({ ...createItem(draft, { id: "t" + n++, now: NOW - 10 * DAY }), ...extra });

test("findUrl trims trailing punctuation", () => {
  assert.equal(findUrl("see https://example.com/a-b)."), "https://example.com/a-b");
  assert.equal(findUrl("no link here"), "");
});

test("a bare link becomes a link; prose with a link stays a note", () => {
  const link = draftFromText("https://example.com/platform-team-design");
  assert.equal(link.kind, KIND.LINK);
  assert.equal(link.title, "Platform team design");
  const note = draftFromText("Ask about PI objectives before Thursday, and reread https://example.com/x when there is time to think it through");
  assert.equal(note.kind, KIND.NOTE);
  assert.equal(note.url, "https://example.com/x");
  assert.equal(draftFromText("   "), null);
});

test("file kinds", () => {
  assert.equal(kindOfFile("image/heic", "IMG_1.HEIC"), KIND.PHOTO);
  assert.equal(kindOfFile("", "report.PDF"), KIND.PDF);
  assert.equal(kindOfFile("text/markdown", "notes.md"), KIND.TEXT);
  assert.equal(kindOfFile("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx"), KIND.FILE);
  assert.equal(draftFromFile({ name: "q3_roadmap-final.pdf", type: "application/pdf", size: 10 }).title, "q3 roadmap final");
});

test("titleFromUrl falls back to host", () => {
  assert.equal(titleFromUrl("https://www.example.com/"), "example.com");
  assert.equal(titleFromUrl("not a url"), "not a url");
});

test("new items start in the inbox", () => {
  assert.equal(make(draftFromText("hello")).status, STATUS.INBOX);
});

test("inbox verdicts", () => {
  const it = make(draftFromText("hello"));
  assert.equal(applyVerdict(it, VERDICT.LET_GO, { now: NOW }).status, STATUS.ARCHIVED);
  assert.equal(applyVerdict(it, VERDICT.LATER, { now: NOW }).status, STATUS.QUEUED);
  assert.equal(applyVerdict(it, VERDICT.DONE, { now: NOW }).status, STATUS.DONE);
  const rn = applyVerdict(it, VERDICT.READ_NOW, { now: NOW });
  assert.equal(rn.status, STATUS.DONE);
  assert.equal(rn.readNow, true);
  assert.equal(rn.history.length, 1);
  assert.throws(() => applyVerdict(it, "maybe"));
});

test("deferring in an edition counts skips and washes out", () => {
  let it = make(draftFromText("x"), { status: STATUS.QUEUED });
  for (let i = 0; i < MAX_SKIPS - 1; i++) it = applyVerdict(it, VERDICT.LATER, { stage: "edition", now: NOW });
  assert.equal(it.status, STATUS.QUEUED);
  it = applyVerdict(it, VERDICT.LATER, { stage: "edition", now: NOW });
  assert.equal(it.status, STATUS.ARCHIVED);
  assert.equal(it.washedOut, true);
  assert.equal(restore(it, NOW).status, STATUS.QUEUED);
});

test("interest profile learns from verdicts", () => {
  const items = [
    make(draftFromText("a"), { tags: ["ai"], status: STATUS.DONE, readNow: true }),
    make(draftFromText("b"), { tags: ["ai"], status: STATUS.DONE }),
    make(draftFromText("c"), { tags: ["crypto"], status: STATUS.ARCHIVED }),
  ];
  const p = interestProfile(items);
  assert.equal(p.tags.ai, 2.5);
  assert.equal(p.tags.crypto, -1);
  const liked = make(draftFromText("d"), { tags: ["AI"], status: STATUS.QUEUED });
  const disliked = make(draftFromText("e"), { tags: ["crypto"], status: STATUS.QUEUED });
  assert.ok(localScore(liked, p, NOW) > localScore(disliked, p, NOW));
});

test("AI score blends with local score", () => {
  const p = interestProfile([]);
  const a = make(draftFromText("a"), { status: STATUS.QUEUED, ai: { score: 95 } });
  const b = make(draftFromText("b"), { status: STATUS.QUEUED, ai: { score: 5 } });
  assert.ok(score(a, p, NOW) > score(b, p, NOW));
});

test("edition is finite, stable for the day, and caps suggestions", () => {
  const items = [];
  for (let i = 0; i < 10; i++) items.push(make(draftFromText("q" + i), { status: STATUS.QUEUED, ai: { score: 50 + i } }));
  items.push(make(draftFromText("s1"), { status: STATUS.QUEUED, suggested: true, ai: { score: 100 } }));
  items.push(make(draftFromText("s2"), { status: STATUS.QUEUED, suggested: true, ai: { score: 99 } }));
  items.push(make(draftFromText("inbox"), { ai: { score: 100 } }));
  const ed = buildEdition(items, null, { now: NOW });
  assert.equal(ed.ids.length, 6);
  assert.equal(ed.date, dayKey(NOW));
  const byId = new Map(items.map((i) => [i.id, i]));
  assert.equal(ed.ids.filter((id) => byId.get(id).suggested).length, 1);
  assert.ok(ed.ids.every((id) => byId.get(id).status === STATUS.QUEUED));
  assert.equal(buildEdition(items, ed, { now: NOW + 3600000 }), ed, "same day keeps the same edition");
  assert.notEqual(buildEdition(items, ed, { now: NOW + DAY }), ed, "next day builds a new one");
});

test("edition view tracks progress", () => {
  const items = [0, 1, 2].map((i) => make(draftFromText("q" + i), { status: STATUS.QUEUED }));
  const ed = buildEdition(items, null, { now: NOW });
  const first = items.find((i) => i.id === ed.ids[0]);
  const updated = items.map((i) => (i === first ? applyVerdict(i, VERDICT.DONE, { stage: "edition", now: NOW }) : i));
  const v = editionView(updated, ed);
  assert.equal(v.total, 3);
  assert.equal(v.settled, 1);
  assert.equal(v.open.length, 2);
  const deferred = updated.map((i) => (i.id === ed.ids[1] ? applyVerdict(i, VERDICT.LATER, { stage: "edition", now: NOW }) : i));
  assert.equal(editionView(deferred, ed).open.length, 1, "deferred items leave today's edition");
});

test("legacy items migrate into the queue", () => {
  const m = migrateLegacy({ id: "i1", type: "thought", title: "T", text: "x", status: "active", created: NOW });
  assert.equal(m.kind, KIND.NOTE);
  assert.equal(m.status, STATUS.QUEUED);
  assert.equal(m.id, "legacy-i1");
});

test("dayKey uses the local calendar day", () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 30).getTime()), "2026-01-05");
});
