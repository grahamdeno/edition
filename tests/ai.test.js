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
