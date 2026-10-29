import { test } from "node:test";
import assert from "node:assert/strict";
import relay, { storyKey, readPicks, STORY_TOPICS } from "../relay/perplexity-relay.js";

function fakeKv() {
  const m = new Map();
  return { m, async get(k, t) { const v = m.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; } };
}
const reply = (picks) => ({ content: [{ type: "text", text: "Here you go:\n```json\n" + JSON.stringify({ picks }) + "\n```" }], usage: { input_tokens: 20000, output_tokens: 800, server_tool_use: { web_search_requests: 3 } } });
const PICKS = [
  { title: "Probe reaches Europa", url: "https://www.nasa.gov/europa", why: "First close pass.", tags: ["Space", "NASA!"], minutes: 5 },
  { title: "Not a link", url: "javascript:alert(1)", why: "x" },
];

test("topics and places are checked", () => {
  assert.equal(storyKey("Science").id, "science");
  assert.equal(storyKey("local", "Wilmington, NC").id, "local:wilmington, nc");
  assert.equal(storyKey("local", "<script>").id, "local:script");
  assert.equal(storyKey("local", ""), null);
  assert.equal(storyKey("crypto"), null);
  assert.equal(Object.keys(STORY_TOPICS).length, 9);
});

test("picks are read safely", () => {
  const p = readPicks(reply(PICKS));
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].tags, ["space", "nasa"]);
});

test("a topic is searched once a day and shared; local news counts against the asker", async () => {
  const env = { SHOEBOX: fakeKv(), ANTHROPIC_API_KEY: "k", AI_ATTEST: "off" };
  let searches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { searches++; return new Response(JSON.stringify(reply(PICKS)), { status: 200 }); };
  try {
    const origin = "https://inmyshoebox.com";
    const reg = await (await relay.fetch(new Request("https://r.test/ai/register", { method: "POST", headers: { origin, "cf-connecting-ip": "1.2.3.4" } }), env)).json();
    const h = { origin, "x-shoebox-device": reg.device, "x-shoebox-token": reg.token, "cf-connecting-ip": "1.2.3.4", "content-type": "application/json" };
    const ask = async (body) => { const r = await relay.fetch(new Request("https://r.test/ai/stories", { method: "POST", headers: h, body: JSON.stringify(body) }), env); return [r.status, JSON.parse((await r.text()).trim())]; };
    const [s1, first] = await ask({ topic: "science" });
    assert.equal(s1, 200);
    assert.equal(first.picks.length, 1);
    assert.equal(first.shared, false);
    const [, second] = await ask({ topic: "science" });
    assert.equal(second.shared, true);
    assert.equal(searches, 1, "one search for everyone");
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(await env.SHOEBOX.get(`aiq:${reg.device}:${today.slice(0, 7)}`), null, "shared topics don't use the asker's allowance");
    assert.ok(+await env.SHOEBOX.get(`aiq:all:${today}`) > 0);
    await ask({ topic: "local", place: "Wilmington" });
    assert.ok(+await env.SHOEBOX.get(`aiq:${reg.device}:${today.slice(0, 7)}`) > 0, "local does");
    const [s4] = await ask({ topic: "astrology" });
    assert.equal(s4, 400);
    // While a search is running, others are told to come back.
    await env.SHOEBOX.put(`tsl:${today}:world`, "1");
    const [s5, pending] = await ask({ topic: "world" });
    assert.equal(s5, 202);
    assert.equal(pending.pending, true);
  } finally { globalThis.fetch = realFetch; }
});
