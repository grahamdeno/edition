import { test } from "node:test";
import assert from "node:assert/strict";
import { SAMPLE_EMAILS, gradeEmailPost, longestCopy } from "../src/aicheck.js";
import { emailPreview, plainSubject } from "../src/model.js";

const byId = (id) => SAMPLE_EMAILS.find((e) => e.id === id);

test("the sample emails are complete and made up", () => {
  assert.ok(SAMPLE_EMAILS.length >= 15);
  for (const e of SAMPLE_EMAILS) {
    assert.ok(e.id && e.subject && e.text, e.id);
    for (const u of e.links) assert.ok(/\.example\//.test(u), `${e.id}: links stay on .example`);
    if (e.expect?.link) assert.ok(e.links.includes(e.expect.link), `${e.id}: expected link is one of its links`);
  }
});

test("a good post passes", () => {
  const flight = { headline: "Flight to Denver confirmed for Nov 14", body: "Skyway SK 2291 leaves Wilmington at 6:05 AM and lands in Denver at 10:40 AM. Check-in opens 24 hours before.",
    items: [{ date: "2026-11-14", text: "Departs ILM 6:05 AM" }, { date: null, text: "Confirmation HX7Q2P" }], link: null, why: "Keep this for the trip" };
  assert.deepEqual(gradeEmailPost(byId("flight"), flight), []);
  const news = { headline: "A sluggish starter is why sourdough comes out flat", body: "Feed the starter twice a day for three days and bake when it has doubled. A 12 to 16 hour fridge proof adds lift.",
    items: [], link: "https://weeklyfix.example/c/AbC123?utm_source=email&utm_medium=newsletter", why: "" };
  assert.deepEqual(gradeEmailPost(byId("newsletter"), news), []);
});

test("the rules catch a pasted email, clutter, made-up numbers and a wrong link", () => {
  const flight = byId("flight");
  const pasted = { headline: "Your trip confirmation", body: "Thank you for choosing Skyway. Your trip is confirmed. Confirmation #: HX7Q2P Flight SK 2291 Sat, Nov 14 departs ILM 6:05 AM arrives DEN", items: [], why: "x" };
  assert.ok(gradeEmailPost(flight, pasted).some((p) => /pastes the email/.test(p)));
  assert.ok(gradeEmailPost(flight, pasted, { hard: true }).length, "pasting is bad enough to throw out");
  const greet = { headline: "Fwd: trip", body: "Hello Graham, your flight is booked. Unsubscribe", items: [], why: "x" };
  const g = gradeEmailPost(flight, greet);
  assert.ok(g.includes("starts with a greeting") && g.includes("keeps a footer line") && g.includes("headline keeps Fwd:/Re:"));
  const made = { headline: "Flight to Denver on Nov 15", body: "Gate 22 opens at 5 AM.", items: [], why: "x" };
  assert.ok(gradeEmailPost(flight, made).some((p) => /states 15/.test(p)));
  const news = byId("newsletter");
  const wrong = { headline: "Fixing flat sourdough", body: "Feed the starter twice a day.", items: [], link: "https://weeklyfix.example/u/xyz" };
  assert.ok(gradeEmailPost(news, wrong).includes("picks the wrong link"));
  assert.ok(gradeEmailPost(news, { ...wrong, link: "https://evil.example/x" }).includes("invents a link"));
  assert.deepEqual(gradeEmailPost(news, wrong, { hard: true }), [], "a wrong link alone doesn't throw a post out");
});

test("copy length counts words in a row", () => {
  assert.equal(longestCopy("one two three four five", "x two three four y"), 3);
  assert.equal(longestCopy("", "a"), 0);
});

test("without AI, every sample still makes a clean post: no headers, footers, signatures or raw links", () => {
  for (const e of SAMPLE_EMAILS) {
    const body = emailPreview(e.text, 280), title = plainSubject(e.subject);
    assert.ok(!/^\s*(fwd?|fw|re)\s*:/i.test(title), `${e.id}: title "${title}"`);
    assert.ok(!/\b(forwarded message|original message)\b|^(from|to|subject|date|sent):/im.test(body), `${e.id}: headers in "${body}"`);
    assert.ok(!/\bunsubscribe\b|\bview (this email )?in (your )?browser\b/i.test(body), `${e.id}: footer in "${body}"`);
    assert.ok(!/\bsent from my iphone\b/i.test(body), `${e.id}: signature in "${body}"`);
    assert.ok(!/^(hi|hello|hey|dear)\b/i.test(body), `${e.id}: greeting in "${body}"`);
  }
});

test("every module the app loads is in the offline list", async () => {
  const { readFileSync } = await import("node:fs");
  const sw = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  const seen = new Set(), todo = ["app.js"];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+"\.\/([\w-]+\.js)"/g)) todo.push(m[1]);
  }
  for (const f of seen) assert.ok(sw.includes(`"src/${f}"`), `sw.js is missing src/${f}`);
});
