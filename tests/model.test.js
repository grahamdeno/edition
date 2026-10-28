import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VERDICT, STATUS, KIND, MAX_SKIPS, isFaded, dayKey, findUrl, kindOfFile, draftFromText, draftFromFile,
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

test("deferring too often fades an item but never lets it go", () => {
  let it = make(draftFromText("x"), { status: STATUS.QUEUED });
  for (let i = 0; i < MAX_SKIPS - 1; i++) it = applyVerdict(it, VERDICT.LATER, { stage: "edition", now: NOW });
  assert.equal(isFaded(it, NOW), false);
  it = applyVerdict(it, VERDICT.LATER, { stage: "edition", now: NOW });
  assert.equal(it.status, STATUS.QUEUED, "still in the queue");
  assert.equal(isFaded(it, NOW), true, "but faded");
  const back = restore(it, NOW);
  assert.equal(isFaded(back, NOW), false);
  assert.equal(back.skips, 0);
});

test("three weeks untouched fades an item; faded items stay out of editions", () => {
  const old = make(draftFromText("old"), { status: STATUS.QUEUED, queuedAt: NOW - 22 * DAY, created: NOW - 22 * DAY });
  const fresh = make(draftFromText("fresh"), { status: STATUS.QUEUED, queuedAt: NOW - 2 * DAY, created: NOW - 2 * DAY });
  assert.equal(isFaded(old, NOW), true);
  assert.equal(isFaded(fresh, NOW), false);
  const ed = buildEdition([old, fresh], null, { now: NOW });
  assert.deepEqual(ed.ids, [fresh.id]);
  assert.equal(old.status, STATUS.QUEUED, "nothing is let go automatically");
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

/* ---- Capture detection ---- */
import { detectText, parseQuote, youtubeId, describeDraft } from "../src/model.js";

test("YouTube links become videos with a thumbnail", () => {
  for (const u of ["https://www.youtube.com/watch?v=UF8uR6Z6KLc", "https://youtu.be/UF8uR6Z6KLc?t=30", "https://youtube.com/shorts/UF8uR6Z6KLc", "https://m.youtube.com/watch?feature=share&v=UF8uR6Z6KLc"]) {
    assert.equal(youtubeId(u), "UF8uR6Z6KLc", u);
  }
  const [d] = detectText("https://youtu.be/UF8uR6Z6KLc");
  assert.equal(d.kind, KIND.VIDEO);
  assert.equal(d.imageUrl, "https://i.ytimg.com/vi/UF8uR6Z6KLc/hqdefault.jpg");
  assert.equal(describeDraft(d), "YouTube video");
});

test("image links become photos", () => {
  const [d] = detectText("https://example.com/whiteboard.jpg");
  assert.equal(d.kind, KIND.PHOTO);
  assert.equal(d.imageUrl, "https://example.com/whiteboard.jpg");
});

test("a list of links becomes one item per link", () => {
  const out = detectText("https://a.com/one\nhttps://youtu.be/UF8uR6Z6KLc\n- https://b.com/two");
  assert.deepEqual(out.map((d) => d.kind), [KIND.LINK, KIND.VIDEO, KIND.LINK]);
});

test("quotes are recognised with their author", () => {
  assert.deepEqual(parseQuote("“Plans are worthless, but planning is everything.” — Dwight D. Eisenhower"),
    { text: "Plans are worthless, but planning is everything.", author: "Dwight D. Eisenhower" });
  assert.deepEqual(parseQuote("How we spend our days is how we spend our lives.\n— Annie Dillard"),
    { text: "How we spend our days is how we spend our lives.", author: "Annie Dillard" });
  assert.deepEqual(parseQuote("\"Simplicity is prerequisite for reliability.\""), { text: "Simplicity is prerequisite for reliability.", author: "" });
  assert.equal(detectText("Waste no more time arguing what a good man should be. Be one. - Marcus Aurelius")[0].kind, KIND.QUOTE);
});

test("to-dos and plain notes are not mistaken for quotes", () => {
  assert.equal(parseQuote("Call the plumber about the leak - Tuesday"), null);
  assert.equal(parseQuote("Finish the PI objectives draft. - Friday"), null);
  assert.equal(detectText("Ask about the sprint review format before Thursday")[0].kind, KIND.NOTE);
});

import { fitToTime, circling, fading } from "../src/model.js";

test("fitToTime keeps order and skips what doesn't fit", () => {
  const p = [{ minutes: 8 }, { minutes: 25 }, { minutes: 1 }, { minutes: 2 }];
  assert.deepEqual(fitToTime(p, 10).map((x) => x.minutes), [8, 1]);
  assert.equal(fitToTime(p, 0).length, 4);
});

test("circling finds repeated themes and marks rising ones", () => {
  const items = [
    { status: STATUS.QUEUED, tags: ["AI"], created: NOW },
    { status: STATUS.DONE, tags: ["ai"], created: NOW },
    { status: STATUS.QUEUED, tags: ["guitar"], created: NOW - 40 * DAY },
    { status: STATUS.ARCHIVED, tags: ["guitar"], created: NOW },
    { status: STATUS.QUEUED, tags: ["once"], created: NOW },
  ];
  const c = circling(items, { now: NOW });
  assert.equal(c.length, 1);
  assert.equal(c[0].tag, "ai");
  assert.equal(c[0].rising, true);
});

test("tideline lists faded items first, then those about to fade", () => {
  const items = [
    { id: "a", status: STATUS.QUEUED, queuedAt: NOW - 18 * DAY },
    { id: "b", status: STATUS.QUEUED, queuedAt: NOW - 2 * DAY },
    { id: "c", status: STATUS.QUEUED, queuedAt: NOW - 30 * DAY },
    { id: "e", status: STATUS.QUEUED, queuedAt: NOW - 25 * DAY },
    { id: "f", status: STATUS.QUEUED, queuedAt: NOW - DAY, fadedAt: NOW },
    { id: "d", status: STATUS.DONE, queuedAt: NOW - 90 * DAY },
  ];
  const t = fading(items, { ids: ["c"] }, { now: NOW });
  assert.deepEqual(t.map((x) => x.item.id), ["e", "f", "a"], "b has two weeks left, c is in the edition");
  assert.equal(t[0].faded, true);
  assert.equal(t[2].left, 3);
});

/* ---- Timeline helpers (Shoebox) ---- */
import { friendlyWhen, usablePicture, interestProfile as profileOf } from "../src/model.js";

test("friendlyWhen says when, the way a person would", () => {
  const now = new Date(2026, 9, 26, 14, 0).getTime(); // Monday 26 Oct 2026, 2pm
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime();
  assert.equal(friendlyWhen(now - 30000, now), "just now");
  assert.equal(friendlyWhen(now - 20 * 60000, now), "20 minutes ago");
  assert.equal(friendlyWhen(at(26, 8), now), "this morning");
  assert.equal(friendlyWhen(at(26, 3), now), "early this morning");
  assert.equal(friendlyWhen(at(25, 9), now), "yesterday morning");
  assert.equal(friendlyWhen(at(25, 21), now), "last night");
  assert.equal(friendlyWhen(at(22, 15), now), "Thursday afternoon");
  assert.equal(friendlyWhen(at(16, 10), now), "last Friday");
  assert.equal(friendlyWhen(at(5, 10), now), "3 weeks ago");
  assert.equal(friendlyWhen(new Date(2026, 2, 3).getTime(), now), "in March");
  assert.equal(friendlyWhen(new Date(2025, 6, 3).getTime(), now), "last July");
  assert.equal(friendlyWhen(new Date(2023, 6, 3).getTime(), now), "in July 2023");
});

test("usablePicture keeps real photos and drops small, strip or skyscraper images", () => {
  assert.equal(usablePicture({ w: 1200, h: 800 }), true);
  assert.equal(usablePicture({ w: 1080, h: 1350 }), true);
  assert.equal(usablePicture({ w: 400, h: 300 }), false);
  assert.equal(usablePicture({ w: 1600, h: 200 }), false);
  assert.equal(usablePicture({ w: 600, h: 1600 }), false);
  assert.equal(usablePicture({}), false);
});

test("loving something counts toward what you like, even before a verdict", () => {
  const p = profileOf([{ kind: "photo", status: "queued", tags: ["coast"], loved: 1 }, { kind: "link", status: "queued", tags: ["tax"] }]);
  assert.equal(p.tags.coast, 0.5);
  assert.equal(p.tags.tax, undefined);
});

import { discoveryItems, interestProfile as ip2, topTags as tt2, STATUS as S2 } from "../src/model.js";
test("finished school posts don't shape top stories", () => {
  const items = [
    { id: "a", status: S2.DONE, tags: ["agile"], doneAt: 2, created: 1 },
    { id: "b", status: S2.DONE, tags: ["band", "school"], doneAt: 3, created: 1, school: { name: "Myrtle Grove Middle" } },
  ];
  const p = ip2(discoveryItems(items));
  assert.deepEqual(tt2(p), ["agile"]);
  assert.deepEqual(p.kept.map((i) => i.id), ["a"]);
});

import { schoolToday, buildEdition as be2 } from "../src/model.js";
test("school posts show daily until done, soonest first, and never take one of the six", () => {
  const now = new Date(2026, 9, 27, 9).getTime();
  const items = [
    { id: "s1", status: S2.INBOX, created: 1, school: { date: "2026-10-29" }, tags: [] },
    { id: "s2", status: S2.QUEUED, created: 2, school: { date: null }, tags: [] },
    { id: "s3", status: S2.DONE, created: 3, school: { date: "2026-10-28" }, tags: [] },
    { id: "s4", status: S2.INBOX, created: 4, school: { date: "2026-10-26" }, tags: [] }, // yesterday: gone
    { id: "s5", status: S2.INBOX, created: 5, school: { date: "2026-10-27" }, tags: [] },
    { id: "q1", status: S2.QUEUED, created: now - 1000, tags: ["agile"] },
  ];
  assert.deepEqual(schoolToday(items, now).map((i) => i.id), ["s5", "s1", "s2"]);
  assert.deepEqual(be2(items, null, { now }).ids, ["q1"]);
});

import { senderName, plainEntities } from "../src/model.js";
import { htmlToText } from "../relay/perplexity-relay.js";

test("senders read like names; bare addresses become the site", () => {
  assert.equal(senderName("Myrtle Grove Middle", "news@nhcs.net"), "Myrtle Grove Middle");
  assert.equal(senderName("noreply@psu650nc.mg.infinitecampus.com", ""), "infinitecampus.com");
  assert.equal(senderName("", "Alerts <alerts@mail.bbc.co.uk>"), "bbc.co.uk");
  assert.equal(senderName("", ""), "Email");
});

test("HTML codes left in mail text are turned back into characters", () => {
  assert.equal(plainEntities("Dear&#160; Graham &amp; family&#x2019;s"), "Dear  Graham & family’s");
  assert.equal(htmlToText("<p>Dear&#160;Graham &amp;#160;</p>"), "Dear Graham");
});

test("a shared link with its page title on the next line is a link, titled", () => {
  const [d] = detectText("https://coolhunting.com/buy/star-child-special-edition-by-claire-a-nivola/\nStar Child: Special Edition by Claire A Nivola - COOL HUNTING®");
  assert.equal(d.kind, KIND.LINK);
  assert.equal(d.title, "Star Child: Special Edition by Claire A Nivola - COOL HUNTING®");
  assert.equal(detectText("Two paragraphs of my own thinking about this.\n\nhttps://a.com/x\nand more")[0].kind, KIND.NOTE);
});

test("an email is cut to what its sender wrote: no forward headers, footers, replies or tracking links (4.64.0)", async () => {
  const { cleanEmail, emailPreview } = await import("../src/model.js");
  const fwd = "---------- Forwarded message ---------\nFrom: Delta <x@delta.com>\nDate: Mon, Oct 27\nSubject: Your trip\nTo: me@x.com\n\nYour flight to Denver is confirmed. Manage trip (https://t.delta.com/ls/click?upn=abc123)\nDepart Nov 14 at 7:05 AM.\n\nYou are receiving this because you booked.\nUnsubscribe\n© 2026 Delta Air Lines";
  assert.equal(cleanEmail(fwd), "Your flight to Denver is confirmed. Manage trip\nDepart Nov 14 at 7:05 AM.");
  const apple = "Begin forwarded message:\n\nFrom: Coach\nSubject: Practice\nDate: today\nTo: me\n\nPractice moves to 5 PM Thursday.\n\nSent from my iPhone";
  assert.equal(cleanEmail(apple), "Practice moves to 5 PM Thursday.");
  const reply = "Sounds good, see you then.\n\nOn Mon, Oct 27, 2026 at 9:00 AM Ann <a@x.com> wrote:\n> Lunch Friday?";
  assert.equal(cleanEmail(reply), "Sounds good, see you then.");
  assert.equal(cleanEmail("Thanks!\n--\nGraham D.\n555-1234"), "Thanks!");
  const long = "First sentence here. " + "word ".repeat(80);
  assert.ok(emailPreview(long, 100).length <= 101);
});
