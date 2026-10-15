import { test } from "node:test";
import assert from "node:assert/strict";
import { topicColor, topicOf, coverSvg, TOPIC_COLORS } from "../src/visuals.js";
import relay, { parseMeta } from "../relay/perplexity-relay.js";

test("a topic always gets the same colour, from the palette", () => {
  const a = topicColor({ tags: ["roadmaps"] }), b = topicColor({ tags: ["Roadmaps", "x"] });
  assert.equal(a, b);
  assert.ok(TOPIC_COLORS.includes(a));
  assert.equal(topicOf({ kind: "quote" }), "words");
});

test("drawn covers are the same each time for the same item", () => {
  const it = { id: "x1", tags: ["ai"] };
  assert.equal(coverSvg(it), coverSvg(it));
  assert.match(coverSvg(it), new RegExp(topicColor(it)));
});

test("preview reads Open Graph tags and makes the image address absolute", () => {
  const html = `<html><head><title>Fallback &amp; title</title>
    <meta property="og:image" content="/img/cover.jpg">
    <meta content="Real title" property="og:title">
    <meta name="description" content="What it&#39;s about"></head>`;
  assert.deepEqual(parseMeta(html, "https://site.test/a/b"), {
    image: "https://site.test/img/cover.jpg", title: "Real title", description: "What it's about", site: null,
  });
  assert.equal(parseMeta("<title>Only &amp; this</title>", "https://x.test").title, "Only & this");
  assert.equal(parseMeta("<meta property='og:image' content='javascript:alert(1)'>", "https://x.test").image, null);
});

test("relay preview: fetches public pages for Edition only", async () => {
  globalThis.fetch = async (url) => new Response(`<head><meta property="og:image" content="https://cdn.test/p.png"><meta property="og:title" content="T"></head>`, { status: 200, headers: { "content-type": "text/html" } });
  const origin = "https://grahamdeno.github.io";
  const ok = await relay.fetch(new Request("https://w.test/preview?url=" + encodeURIComponent("https://news.test/story"), { headers: { origin } }));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { image: "https://cdn.test/p.png", title: "T", description: null, site: null });
  const local = await relay.fetch(new Request("https://w.test/preview?url=" + encodeURIComponent("http://192.168.1.2/"), { headers: { origin } }));
  assert.equal(local.status, 400);
  const other = await relay.fetch(new Request("https://w.test/preview?url=https://a.test", { headers: { origin: "https://evil.test" } }));
  assert.equal(other.status, 403);
});
