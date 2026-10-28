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
  const store = { "edition.aiConsent": "1", "edition.aiDevice": "dev1", "edition.aiToken": "tok" };
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
  assert.match(p, /5 to 8 words, never more than 50 characters/);
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

test("card faces are trimmed: no quotes, no full stop, never long", async () => {
  const { hook } = await import("../src/ai.js");
  stubApi({ hook: "“A read on six-week cycles.”" });
  assert.equal(await hook({ kind: "link", title: "x" }), "A read on six-week cycles");
  stubApi({ hook: "x".repeat(120) });
  assert.ok((await hook({ kind: "link", title: "x" })).length <= 70);
});

test("pickPicture shows the candidates as images and keeps a valid index with its alt text", async () => {
  const { pickPicture } = await import("../src/ai.js");
  const sent = stubApi({ index: 1, alt: "A trail along the dunes at sunrise" });
  const out = await pickPicture({ title: "Coastal trails" }, [{ src: "https://a.test/1.jpg" }, { src: "https://a.test/2.jpg" }]);
  assert.deepEqual(out, { index: 1, alt: "A trail along the dunes at sunrise", focus: null });
  const parts = sent[0].messages[0].content;
  assert.deepEqual(parts.filter((p) => p.type === "image").map((p) => p.source.url), ["https://a.test/1.jpg", "https://a.test/2.jpg"]);
  stubApi({ index: 7, alt: "x" });
  assert.deepEqual(await pickPicture({}, [{ src: "https://a.test/1.jpg" }]), { index: -1, alt: "", focus: null });
  assert.deepEqual(await pickPicture({}, []), { index: -1, alt: "", focus: null });
});

test("enrich returns alt text without an 'image of' lead-in", async () => {
  stubApi({ title: "T", summary: "S", tags: [], minutes: 1, intent: "idea", points: [], transcript: "", quote: null, alt: "Photo of a whiteboard with sticky notes" });
  const out = await enrich({ kind: "note", text: "x" }, null);
  assert.equal(out.alt, "A whiteboard with sticky notes");
});

test("a card face that comes back as plain text, not JSON, is still used", async () => {
  const { hook } = await import("../src/ai.js");
  const store = { "edition.aiConsent": "1", "edition.aiDevice": "dev1", "edition.aiToken": "tok" };
  globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "A short read on coastal trails" }] }) });
  assert.equal(await hook({ kind: "link", title: "Trails" }), "A short read on coastal trails");
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "Sorry, I can't tell what this item is about from what you've given me here." }] }) });
  assert.equal(await hook({ kind: "link", title: "x" }), ""); // nothing usable: a quiet miss, not a problem
});

test("an unreachable API is reported with status 0, so the app stops and retries later", async () => {
  const { hook } = await import("../src/ai.js");
  globalThis.fetch = async () => { throw new TypeError("Load failed"); };
  await assert.rejects(() => hook({ kind: "link", title: "x" }), (e) => e.status === 0 && /Couldn't reach/.test(e.message));
});

import { pplxDate, storySearchTool, isRecent, storyBrief, NOT_NEWS } from "../src/ai.js";

test("pplxDate formats MM/DD/YYYY", () => {
  assert.equal(pplxDate(new Date(2026, 9, 5).getTime()), "10/05/2026");
});

test("story search is held to recent news and denies chatter and blocked sites", () => {
  const now = new Date(2026, 9, 26, 12).getTime();
  const t = storySearchTool({ blocked: ["spam.example"], now });
  assert.equal(t.type, "web_search");
  assert.equal(t.filters.search_after_date_filter, "10/23/2026");
  assert.ok(t.filters.search_domain_filter.length <= 20);
  assert.ok(t.filters.search_domain_filter.includes("-spam.example"));
  assert.ok(t.filters.search_domain_filter.every((d) => d.startsWith("-")));
  assert.ok(NOT_NEWS.includes("reddit.com"));
});

test("isRecent drops dated results outside the window, keeps undated ones", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  assert.equal(isRecent({ date: "2026-10-25" }, now), true);
  assert.equal(isRecent({ date: "2026-09-01" }, now), false);
  assert.equal(isRecent({}, now), true);
});

test("storyBrief asks for top stories in their areas", () => {
  const b = storyBrief({ kept: [{ title: "Scrum at scale", tags: ["agile"] }], dropped: [], tags: { agile: 3 } }, { count: 3 });
  assert.match(b, /top stories of the last 3 days/);
  assert.match(b, /Scrum at scale/);
});

import { describe as describeItem, OWN_WORDS_RULE } from "../src/ai.js";

test("tagging sees their note, reason and replies, and puts their use first", () => {
  const lines = describeItem({ kind: "link", url: "https://x.test/pottery", title: "Pottery class", why: "", text: "Good date idea for us",
    replies: [{ text: "Book for her birthday" }] }).join("\n");
  assert.match(lines, /Their note about it: Good date idea/);
  assert.match(lines, /Book for her birthday/);
  assert.doesNotMatch(lines, /^Text:/m);
  assert.match(describeItem({ kind: "photo", note: "gift idea" }).join("\n"), /Their note about it: gift idea/);
  assert.match(OWN_WORDS_RULE, /date idea/);
});

import { unwrapLink } from "../src/ai.js";
test("Outlook Safe Links unwrap to the real address", () => {
  const safe = "https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fmyrtlegrovemiddle.givebacks.com%2Fshop%2Fitems%2F0b1c061aa483cd&data=05%7C02&reserved=0";
  assert.equal(unwrapLink(safe), "https://myrtlegrovemiddle.givebacks.com/shop/items/0b1c061aa483cd");
  assert.equal(unwrapLink("https://example.com/a"), "https://example.com/a");
  assert.equal(unwrapLink("not a link"), "not a link");
});

/* ---- AI proxy ---- */
import { aiCost, checkAiBody } from "../relay/perplexity-relay.js";
import { migrateAiSettings, settings as aiSettings, DEFAULT_RELAY } from "../src/ai.js";

function memKv() {
  const m = new Map();
  return { m, get: async (k, t) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, v); } };
}

test("AI cost is counted in hundredths of a cent, searches included", () => {
  assert.equal(aiCost("claude-haiku-5-5", { input_tokens: 3000, output_tokens: 600 }), 6);
  assert.equal(aiCost("claude-haiku-5-5", { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 2 } }), 200);
  assert.equal(aiCost("claude-sonnet-5-5", { input_tokens: 1e6, output_tokens: 0 }), 20000);
});

test("the proxy only takes the app's own kind of request", () => {
  const ok = { model: "claude-haiku-5-5", max_tokens: 600, messages: [{ role: "user", content: "hi" }] };
  assert.equal(checkAiBody(ok), "");
  assert.match(checkAiBody({ ...ok, model: "claude-opus-5-5" }), /model/);
  assert.match(checkAiBody({ ...ok, max_tokens: 64000 }), /max_tokens/);
  assert.match(checkAiBody({ ...ok, tools: [{ type: "bash_20250124", name: "bash" }] }), /tool/);
  assert.equal(checkAiBody({ ...ok, tools: [{ type: "web_search_20250305", name: "web_search" }] }), "");
  assert.match(checkAiBody({ ...ok, stream: true }), /Streaming/);
});

test("proxy: register, call with the relay's key, charge the budget, stop at the limit", async () => {
  const kv = memKv();
  const env = { SHOEBOX: kv, ANTHROPIC_API_KEY: "sk-relay", AI_DEVICE_DAILY_CENTS: "0.1" };
  const origin = "https://shoebox.tangomike.app";
  const reg = await relay.fetch(new Request("https://w.test/ai/register", { method: "POST", headers: { origin } }), env);
  const { device, token } = await reg.json();
  assert.ok(device && token);
  const realFetch = globalThis.fetch;
  let upstreamKey;
  globalThis.fetch = async (url, opts) => { upstreamKey = opts.headers["x-api-key"]; return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10000, output_tokens: 0 } }), { status: 200 }); };
  const body = JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
  const call = (tok = token) => relay.fetch(new Request("https://w.test/ai/messages", { method: "POST", headers: { origin, "x-shoebox-device": device, "x-shoebox-token": tok }, body }), env);
  try {
    assert.equal((await call("wrong")).status, 401);
    const first = await call();
    assert.equal(first.status, 200);
    assert.equal(upstreamKey, "sk-relay");
    assert.equal((await first.json()).content[0].text, "ok");
    // 10,000 input tokens on Haiku = 10 hundredths of a cent = the whole 0.1 cent allowance.
    const second = await call();
    assert.equal(second.status, 429);
    env.AI_OWNER_DEVICES = device;
    assert.equal((await call()).status, 200);
  } finally { globalThis.fetch = realFetch; }
});

test("proxy says plainly when the relay has no key yet", async () => {
  const res = await relay.fetch(new Request("https://w.test/ai/register", { method: "POST", headers: { origin: "https://shoebox.tangomike.app" } }), { SHOEBOX: memKv() });
  assert.equal(res.status, 503);
});

test("an older Anthropic key counts as having agreed to AI; Perplexity keys are dropped", () => {
  const store = { "edition.apiKey": "sk-old", "edition.perplexityKey": "pplx" };
  globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
  migrateAiSettings();
  assert.equal(aiSettings.enabled(), true);
  assert.equal(store["edition.perplexityKey"], undefined);
  assert.equal(aiSettings.relay(), DEFAULT_RELAY);
});

test("the app falls back to an older key while the relay has no AI, then drops the key once it does", async () => {
  const { hook } = await import("../src/ai.js");
  const store = { "edition.aiConsent": "1", "edition.apiKey": "sk-old", "edition.aiDevice": "d", "edition.aiToken": "t" };
  globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
  const reply = { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "A note" }] }) };
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(url); return /\/ai\/messages/.test(url) ? { ok: false, status: 503, json: async () => ({ error: { message: "AI isn't set up on the relay yet." } }) } : reply; };
  assert.equal(await hook({ kind: "link", title: "x" }), "A note");
  assert.match(urls[1], /api\.anthropic\.com/);
  assert.equal(store["edition.apiKey"], "sk-old");
  globalThis.fetch = async () => reply;
  await hook({ kind: "link", title: "x" });
  assert.equal(store["edition.apiKey"], undefined);
});

/* ---- Study deck and names that stay on the phone ---- */
import { maskNames, unmaskName, studyQuestions, schoolPicture, CHILD_TOKEN } from "../src/ai.js";

test("children's names are swapped out before AI and put back after", () => {
  assert.equal(maskNames("Gunner is in 8th grade; GUNNER plays band. Gunnersen is someone else.", ["Gunner"]), "your child is in 8th grade; your child plays band. Gunnersen is someone else.");
  assert.equal(maskNames("Ava and Max", ["Ava", "Max"]), "your child and your child");
  assert.equal(unmaskName(`${CHILD_TOKEN}, those lights are yours Thursday`, "Gunner"), "Gunner, those lights are yours Thursday");
  assert.equal(unmaskName(`${CHILD_TOKEN}, those lights are yours Thursday`, ""), "Those lights are yours Thursday");
});

test("the picture prompt never carries a child's name", async () => {
  const sent = stubApi({ index: 0, overlay: `${CHILD_TOKEN}, those lights are yours`, alt: "A stage" });
  const r = await schoolPicture({ headline: "Band concert", body: "Thursday at 7", child: CHILD_TOKEN, candidates: [{ src: "https://img.test/a.jpg" }] });
  const text = JSON.stringify(sent[0]);
  assert.ok(text.includes(CHILD_TOKEN));
  assert.ok(!/Gunner/.test(text));
  assert.equal(r.overlay, `${CHILD_TOKEN}, those lights are yours`);
});

test("study deck: any topic uses the everyday model; CPMAI keeps its exam prompt", async () => {
  const q = { questions: [{ topic: "t", q: "Which?", options: ["a", "b", "c", "d"], answer: [1], why: "because" }] };
  let sent = stubApi(q);
  const out = await studyQuestions({ topic: "Spanish verbs", count: 1 });
  assert.equal(out[0].answer[0], 1);
  assert.match(promptOf(sent[0]), /practice questions on: Spanish verbs/);
  assert.equal(sent[0].model, "claude-haiku-5-5");
  sent = stubApi(q);
  await studyQuestions({ topic: "PMI-CPMAI", count: 1 });
  assert.match(promptOf(sent[0]), /PMI-CPMAI/);
  assert.equal(sent[0].model, "claude-sonnet-5-5");
  assert.deepEqual(await studyQuestions({ topic: "  " }), []);
});

test("a newsletter's attachments go to Claude as a document and a picture, and posts say which file they came from", async () => {
  const { schoolPosts } = await import("../src/ai.js");
  const sent = stubApi({ school: "MGMS", posts: [{ headline: "Band concert", body: "Thursday 7 PM.", date: "2026-10-29", tags: ["band"], photo_query: "band concert", source: "Flyer.pdf" }, { headline: "No school", body: "Tuesday.", tags: [], source: "email" }] });
  const out = await schoolPosts({ text: "See the flyer.", about: "8th grade band", files: [{ name: "Flyer.pdf", type: "application/pdf", data: "JVBERg==" }, { name: "poster.jpg", type: "image/jpeg", data: "/9j/" }] });
  const content = sent[0].messages[0].content;
  assert.equal(content[0].type, "document");
  assert.equal(content[0].source.media_type, "application/pdf");
  assert.equal(content[1].type, "image");
  assert.match(content[2].text, /2 attachments \(Flyer\.pdf, poster\.jpg\)/);
  assert.equal(out.posts[0].source, "Flyer.pdf");
  assert.equal(out.posts[1].source, "");
});

test("school posts come back labeled Action, Decision or Info", async () => {
  const { schoolPosts } = await import("../src/ai.js");
  const sent = stubApi({ school: "MGMS", posts: [
    { type: "action", headline: "Permission slip due Friday", body: "Sign and return.", tags: [] },
    { type: "decision", headline: "Yearbook orders open", body: "$35 until Nov 15.", tags: [] },
    { type: "info", headline: "Picture day recap", body: "Proofs are out.", tags: [] },
    { type: "urgent!", headline: "Odd one", body: "x", tags: [] }] });
  const out = await schoolPosts({ text: "newsletter", about: "8th grade" });
  assert.deepEqual(out.posts.map((p) => p.type), ["action", "decision", "info", "info"]);
  assert.match(promptOf(sent[0]), /"type": "action" \| "decision" \| "info"/);
});

test("proxy: a web-search call keeps the line open, then sends Claude's answer (or the error) in the body", async () => {
  const kv = memKv();
  const env = { SHOEBOX: kv, ANTHROPIC_API_KEY: "sk-relay" };
  const origin = "https://shoebox.tangomike.app";
  const { device, token } = await (await relay.fetch(new Request("https://w.test/ai/register", { method: "POST", headers: { origin } }), env)).json();
  const realFetch = globalThis.fetch;
  const body = JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 10, messages: [{ role: "user", content: "news" }], tools: [{ type: "web_search_20250305", name: "web_search" }] });
  const call = () => relay.fetch(new Request("https://w.test/ai/messages", { method: "POST", headers: { origin, "x-shoebox-device": device, "x-shoebox-token": token }, body }), env);
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ type: "text", text: "stories" }], usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200 });
    const ok = await call();
    assert.equal(ok.status, 200);
    const text = await ok.text();
    assert.match(text, /^\s+\{/);
    assert.equal(JSON.parse(text).content[0].text, "stories");
    globalThis.fetch = async () => new Response(JSON.stringify({ type: "error", error: { message: "overloaded" } }), { status: 529 });
    const bad = JSON.parse(await (await call()).text());
    assert.equal(bad.status, 529);
    assert.equal(bad.error.message, "overloaded");
  } finally { globalThis.fetch = realFetch; }
});

test("the app treats an error inside a streamed answer as an error", async () => {
  const { hook } = await import("../src/ai.js");
  const store = { "edition.aiConsent": "1", "edition.aiDevice": "d", "edition.aiToken": "t" };
  globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ error: { message: "overloaded" }, status: 529 }) });
  await assert.rejects(() => hook({ kind: "link", title: "x" }), (e) => e.status === 529 && /overloaded/.test(e.message));
});

test("the relay answers its own crashes with CORS, so the app can say what went wrong", async () => {
  const res = await relay.fetch(new Request("https://w.test/ai/register", { method: "POST", headers: { origin: "https://shoebox.tangomike.app" } }),
    { SHOEBOX: { get: async () => { throw new Error("KV down"); } }, ANTHROPIC_API_KEY: "k" });
  assert.equal(res.status, 500);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://shoebox.tangomike.app");
  assert.match((await res.json()).error.message, /KV down/);
});

import { nameIn, maskNames, CHILD_TOKEN } from "../src/ai.js";

test("school posts carry the child's name, which never goes to the AI", () => {
  assert.equal(maskNames("Gunner has band Thursday", ["Gunner"], CHILD_TOKEN), "{child} has band Thursday");
  assert.equal(nameIn("{child}'s concert is Thursday", "Gunner"), "Gunner's concert is Thursday");
  assert.equal(nameIn("{child}'s concert is Thursday", ""), "Your child's concert is Thursday");
});
