import { test } from "node:test";
import assert from "node:assert/strict";
import { pickResults, reconcilePicks, outputText, searchResultsOf, relayBase } from "../src/ai.js";
import relay from "../relay/perplexity-relay.js";

const r = (u) => ({ title: `T ${u}`, url: `https://x.test/${u}`, snippet: `S ${u}` });

test("results are taken in order, skipping saved and repeated links", () => {
  const picks = pickResults([r("a"), r("a"), r("b"), r("c")], { count: 3, known: new Set(["https://x.test/b/"]) });
  assert.deepEqual(picks.map((p) => p.url), ["https://x.test/a", "https://x.test/c"]);
});

test("picks with links the search never returned are dropped, and the gap is filled from results", () => {
  const results = [r("a"), r("b"), r("c")];
  const picks = [
    { title: "A", url: "https://x.test/a/", why: "fits", tags: ["Scrum"], minutes: 9 },
    { title: "Made up", url: "https://nowhere.test/z", why: "?", tags: [], minutes: 3 },
  ];
  const out = reconcilePicks(picks, results, { count: 2 });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { title: "A", url: "https://x.test/a", why: "fits", tags: ["scrum"], minutes: 9 });
  assert.equal(out[1].url, "https://x.test/b");
  assert.equal(out[1].why, "S b");
});

test("answer text and search results are read from the output items", () => {
  const data = { output: [
    { type: "search_results", queries: ["q"], results: [r("a")] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"picks":' }, { type: "output_text", text: "[]}" }] },
    { type: "search_results", queries: ["q2"], results: [r("b")] },
  ] };
  assert.equal(outputText(data), '{"picks":[]}');
  assert.deepEqual(searchResultsOf(data).map((x) => x.url), ["https://x.test/a", "https://x.test/b"]);
});

test("relay address is cleaned up", () => {
  assert.equal(relayBase("edition-relay.me.workers.dev/"), "https://edition-relay.me.workers.dev");
  assert.equal(relayBase(" https://a.test/p// "), "https://a.test/p");
  assert.equal(relayBase(""), "");
});

test("relay: forwards only Edition's POST /v1/agent with the key, and adds CORS", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url, init }); return new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json", "retry-after": "7" } }); };
  const origin = "https://grahamdeno.github.io";
  const pre = await relay.fetch(new Request("https://w.test/v1/agent", { method: "OPTIONS", headers: { origin } }));
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), origin);
  const ok = await relay.fetch(new Request("https://w.test/v1/agent", { method: "POST", headers: { origin, authorization: "Bearer k", "content-type": "application/json" }, body: '{"preset":"fast"}' }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("retry-after"), "7");
  assert.equal(seen[0].url, "https://api.perplexity.ai/v1/agent");
  assert.equal(seen[0].init.headers.authorization, "Bearer k");
  assert.equal(seen[0].init.body, '{"preset":"fast"}');
  const other = await relay.fetch(new Request("https://w.test/v1/agent", { method: "POST", headers: { origin: "https://evil.test", authorization: "Bearer k" }, body: "{}" }));
  assert.equal(other.status, 403);
  const path = await relay.fetch(new Request("https://w.test/search", { method: "POST", headers: { origin, authorization: "Bearer k" }, body: "{}" }));
  assert.equal(path.status, 404);
  const nokey = await relay.fetch(new Request("https://w.test/v1/agent", { method: "POST", headers: { origin }, body: "{}" }));
  assert.equal(nokey.status, 401);
  assert.equal(seen.length, 1);
});

/* ---- Tag jobs, against a stubbed API ---- */
import { enrich, retag, tagItems, vocabLine } from "../src/ai.js";

function stubApi(reply) {
  const store = { "edition.apiKey": "sk-test" };
  globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify(reply) }] }) };
  };
  return sent;
}
const promptOf = (body) => {
  const c = body.messages[0].content;
  return typeof c === "string" ? c : c.filter((p) => p.type === "text").map((p) => p.text).join("\n");
};

test("enrich shows the model your tags and asks it to reuse them", async () => {
  const sent = stubApi({ title: "T", summary: "S", tags: ["Scrum", "AI"], minutes: 5, intent: "read", points: [], transcript: "", quote: null });
  const out = await enrich({ kind: "link", url: "https://a.test/x", title: "x" }, null, { vocab: ["scrum", "leadership"] });
  assert.deepEqual(out.tags, ["scrum", "ai"]);
  assert.match(promptOf(sent[0]), /Tags already in use: scrum, leadership\. Reuse one/);
});

test("with no tags yet, no vocabulary line is sent", () => {
  assert.equal(vocabLine([]), "");
});

test("retag returns tags only", async () => {
  const sent = stubApi({ tags: ["Product", "roadmaps", "x", "y"] });
  assert.deepEqual(await retag({ kind: "note", text: "Roadmap review notes" }, null, { vocab: ["product"] }), ["product", "roadmaps", "x"]);
  assert.match(promptOf(sent[0]), /Tags already in use: product/);
  assert.equal(sent[0].max_tokens, 200);
});

test("untagged picks are tagged in one call, by index, ignoring bad rows", async () => {
  const sent = stubApi({ tags: [{ i: 0, tags: ["AI"] }, { i: 1, tags: ["scrum", "teams"] }, { i: 9, tags: ["nope"] }, null] });
  const out = await tagItems([{ title: "A", url: "https://a.test" }, { title: "B", why: "Because", url: "https://b.test" }], { vocab: ["ai"] });
  assert.deepEqual(out, { 0: ["ai"], 1: ["scrum", "teams"] });
  assert.equal(sent.length, 1);
  assert.match(promptOf(sent[0]), /1 \| B \| Because \| https:\/\/b\.test/);
});

test("enrich asks for a card face that names what you'd be doing, with your context", async () => {
  const sent = stubApi({ title: "T", summary: "S", tags: [], minutes: 20, intent: "read", points: [], transcript: "", quote: null, hook: "“A 20-minute read on six-week cycles”" });
  const out = await enrich({ kind: "link", url: "https://a.test/x" }, null, { context: { around: ["Roadmap notes"], finished: ["Shape Up"] } });
  assert.equal(out.hook, "A 20-minute read on six-week cycles");
  const p = promptOf(sent[0]);
  assert.match(p, /Saved around the same time:\n- Roadmap notes/);
  assert.match(p, /Recently finished:\n- Shape Up/);
  assert.match(p, /a read, something to watch, something to listen to/);
});

test("a card face can be written later from what's already known, in one small call", async () => {
  const { hook } = await import("../src/ai.js");
  const sent = stubApi({ hook: "A talk to watch on retros that teams actually use" });
  const h = await hook({ kind: "video", title: "Retros", intent: "watch", tags: ["agile"] }, { context: { around: [], finished: [] } });
  assert.equal(h, "A talk to watch on retros that teams actually use");
  assert.match(promptOf(sent[0]), /Saved for: watch/);
  assert.equal(sent[0].max_tokens, 200);
  assert.equal(typeof sent[0].messages[0].content, "string"); // no file upload
});
