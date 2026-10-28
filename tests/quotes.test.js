import { test } from "node:test";
import assert from "node:assert/strict";
import relay, { quoteKey, readQuotes, quotePrompt } from "../relay/perplexity-relay.js";

function fakeKv() {
  const m = new Map();
  return { m, async get(k, t) { const v = m.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; } };
}
const QUOTES = [
  { q: "We suffer more often in imagination than in reality.", who: "Seneca", src: "Letters to Lucilius, 13", url: "https://en.wikiquote.org/wiki/Seneca_the_Younger" },
  { q: "A made-up line nobody can find.", who: "Seneca", src: "Letters", url: "https://example.com/not-searched" },
  { q: "No source given.", who: "Seneca", src: "", url: "https://en.wikiquote.org/wiki/Seneca_the_Younger" },
];
const reply = (quotes) => ({
  content: [
    { type: "server_tool_use", name: "web_search" },
    { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://en.wikiquote.org/wiki/Seneca_the_Younger", title: "Seneca" }] },
    { type: "text", text: "```json\n" + JSON.stringify({ quotes }) + "\n```" },
  ],
  usage: { input_tokens: 8000, output_tokens: 400, server_tool_use: { web_search_requests: 2 } },
});

test("a source is cleaned to a name and key", () => {
  assert.deepEqual(quoteKey("  Marcus   Aurelius "), { id: "marcus aurelius", name: "Marcus Aurelius" });
  assert.doesNotMatch(quoteKey("<b>Rumi</b>").name, /[<>/]/);
  assert.equal(quoteKey("C. S. Lewis").name, "C. S. Lewis");
  assert.equal(quoteKey(""), null);
  assert.equal(quoteKey("x"), null);
});

test("only quotes whose page was in the search results, with a source, are kept", () => {
  const q = readQuotes(reply(QUOTES));
  assert.equal(q.length, 1);
  assert.equal(q[0].who, "Seneca");
  assert.match(quotePrompt("faith"), /King James Version or the World English Bible/);
  assert.match(quotePrompt("Seneca", ["We suffer more"]), /Not these, shown recently: We suffer more/);
});

test("quotes are found once a day per source and shared; the next day avoids repeats", async () => {
  const env = { SHOEBOX: fakeKv(), ANTHROPIC_API_KEY: "k", AI_ATTEST: "off" };
  let calls = 0, lastPrompt = "";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls++; lastPrompt = JSON.parse(init.body).messages[0].content; return new Response(JSON.stringify(reply(QUOTES)), { status: 200 }); };
  try {
    const origin = "https://inmyshoebox.com";
    const reg = await (await relay.fetch(new Request("https://r.test/ai/register", { method: "POST", headers: { origin, "cf-connecting-ip": "1.2.3.4" } }), env)).json();
    const h = { origin, "x-shoebox-device": reg.device, "x-shoebox-token": reg.token, "cf-connecting-ip": "1.2.3.4", "content-type": "application/json" };
    const ask = async (body) => { const r = await relay.fetch(new Request("https://r.test/ai/quotes", { method: "POST", headers: h, body: JSON.stringify(body) }), env); return [r.status, JSON.parse((await r.text()).trim())]; };
    const [s1, a] = await ask({ from: "Seneca" });
    assert.equal(s1, 200);
    assert.equal(a.quotes.length, 1);
    assert.equal(a.shared, false);
    const [, b] = await ask({ from: "  seneca " });
    assert.equal(b.shared, true);
    assert.equal(calls, 1, "one search per source a day");
    const today = new Date().toISOString().slice(0, 10);
    await env.SHOEBOX.delete(`qt:${today}:seneca`);
    await ask({ from: "Seneca" });
    assert.match(lastPrompt, /Not these, shown recently: We suffer more often/);
    const [s4] = await ask({ from: "" });
    assert.equal(s4, 400);
  } finally { globalThis.fetch = realFetch; }
});
