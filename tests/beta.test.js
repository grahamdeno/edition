import { test } from "node:test";
import assert from "node:assert/strict";
import relay, { cleanBeta, readBetaVerdict, betaPost } from "../relay/perplexity-relay.js";

function memKv() {
  const m = new Map();
  return {
    m,
    get: async (k, t) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)) : m.get(k)) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
  };
}

const good = {
  name: "Alex Rivera", email: "Alex@Example.com", iphone: "Yes",
  places: ["Texts to myself", "Open browser tabs", "Made up"], back: "A few things",
  story: "A long article on sleep I texted myself in March.", often: "Every day",
  feedback: "Yes, a short note every week or two", heard: "LinkedIn",
};

test("a beta request is cleaned: known choices only, email lowercased, missing answers named", () => {
  const r = cleanBeta(good);
  assert.equal(r.email, "alex@example.com");
  assert.deepEqual(r.places, ["Texts to myself", "Open browser tabs"]);
  assert.match(cleanBeta({ ...good, email: "nope" }), /Apple ID/);
  assert.match(cleanBeta({ ...good, iphone: "Maybe" }), /iPhone/);
  assert.match(cleanBeta({ ...good, often: "" }), /each question/);
});

test("Claude's verdict is read and kept in bounds", () => {
  assert.deepEqual(readBetaVerdict('Sure: {"call":"invite","fit":7,"why":"Saves a lot — rarely returns.","watch":""}'), { call: "invite", fit: 5, why: "Saves a lot, rarely returns.", watch: "" });
  assert.equal(readBetaVerdict('{"call":"yes","fit":3}'), null);
  assert.equal(readBetaVerdict("no json"), null);
});

test("the post leads with the suggestion", () => {
  const p = betaPost(cleanBeta(good), { call: "maybe", fit: 3, why: "Fair fit.", watch: "Ask about email." });
  assert.equal(p.subject, "Beta request: Alex Rivera, Maybe (3 of 5)");
  assert.match(p.text, /^Suggestion: Maybe, fit 3 of 5\. Fair fit\.\nWatch for: Ask about email\./);
  assert.match(betaPost(cleanBeta(good), null).subject, /Not screened$/);
});

test("POST /beta screens with Claude, posts to the owner's inbox once, and keeps name and email from the AI", async () => {
  const kv = memKv();
  const env = { SHOEBOX: kv, ANTHROPIC_API_KEY: "sk" };
  const origin = "https://inmyshoebox.com";
  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, opts) => { sent = JSON.parse(opts.body); return new Response(JSON.stringify({ content: [{ type: "text", text: '{"call":"invite","fit":4,"why":"Saves in many places, rarely returns.","watch":""}' }], usage: { input_tokens: 800, output_tokens: 60 } }), { status: 200 }); };
  const post = (b, ip = "1.1.1.1") => relay.fetch(new Request("https://w.test/beta", { method: "POST", headers: { origin, "cf-connecting-ip": ip, "content-type": "application/json" }, body: JSON.stringify(b) }), env);
  try {
    const res = await post(good);
    assert.equal(res.status, 200);
    assert.doesNotMatch(sent.messages[0].content, /Alex|example\.com/);
    const mails = [...kv.m.keys()].filter((k) => k.startsWith("m:"));
    assert.equal(mails.length, 1);
    const mail = JSON.parse(kv.m.get(mails[0]));
    assert.equal(mail.subject, "Beta request: Alex Rivera, Invite (4 of 5)");
    assert.ok(Number(kv.m.get(`aiq:all:${new Date().toISOString().slice(0, 10)}`)) > 0);
    // Asking again doesn't make a second post.
    assert.equal((await post(good, "2.2.2.2")).status, 200);
    assert.equal([...kv.m.keys()].filter((k) => k.startsWith("m:")).length, 1);
    // The bot field is accepted quietly and dropped.
    assert.equal((await post({ ...good, email: "bot@x.test", website: "spam" }, "3.3.3.3")).status, 200);
    assert.equal([...kv.m.keys()].filter((k) => k.startsWith("m:")).length, 1);
    assert.equal((await post({ ...good, email: "" }, "4.4.4.4")).status, 400);
    // Three a day from one network.
    for (const e of ["a@x.test", "b@x.test"]) await post({ ...good, email: e }, "5.5.5.5");
    await post({ ...good, email: "c@x.test" }, "5.5.5.5");
    assert.equal((await post({ ...good, email: "d@x.test" }, "5.5.5.5")).status, 429);
  } finally { globalThis.fetch = realFetch; }
});

test("POST /beta without AI still posts the request, marked not screened", async () => {
  const kv = memKv();
  const res = await relay.fetch(new Request("https://w.test/beta", { method: "POST", headers: { origin: "https://inmyshoebox.com" }, body: JSON.stringify(good) }), { SHOEBOX: kv });
  assert.equal(res.status, 200);
  const mail = JSON.parse(kv.m.get([...kv.m.keys()].find((k) => k.startsWith("m:"))));
  assert.match(mail.subject, /Not screened$/);
});
