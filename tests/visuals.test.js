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
    image: "https://site.test/img/cover.jpg", imageW: null, imageH: null, imageAlt: null, twitterImage: null,
    title: "Real title", description: "What it's about", site: null,
  });
  assert.equal(parseMeta("<title>Only &amp; this</title>", "https://x.test").title, "Only & this");
  assert.equal(parseMeta("<meta property='og:image' content='javascript:alert(1)'>", "https://x.test").image, null);
});

test("relay preview: fetches public pages for Edition only", async () => {
  globalThis.fetch = async (url) => new Response(`<head><meta property="og:image" content="https://cdn.test/p.png"><meta property="og:title" content="T"></head>`, { status: 200, headers: { "content-type": "text/html" } });
  const origin = "https://grahamdeno.github.io";
  const ok = await relay.fetch(new Request("https://w.test/preview?url=" + encodeURIComponent("https://news.test/story"), { headers: { origin } }));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { image: "https://cdn.test/p.png", title: "T", description: null, site: null,
    images: [{ src: "https://cdn.test/p.png", w: null, h: null, alt: null, from: "preview" }] });
  const local = await relay.fetch(new Request("https://w.test/preview?url=" + encodeURIComponent("http://192.168.1.2/"), { headers: { origin } }));
  assert.equal(local.status, 400);
  const other = await relay.fetch(new Request("https://w.test/preview?url=https://a.test", { headers: { origin: "https://evil.test" } }));
  assert.equal(other.status, 403);
});

import { pageText, pickPhotos } from "../relay/perplexity-relay.js";

test("page text keeps the article and drops menus, scripts and footers", () => {
  const t = pageText(`<body><nav><p>Home About Contact and other menu items here</p></nav><main><article><h2>Why cycles</h2>
    <p>Six weeks is long enough to build something meaningful and short enough to feel the deadline.</p>
    <script>var x = 1</script><p>Teams shape work before betting on it, which keeps scope honest &amp; clear.</p></article></main>
    <footer><p>Copyright notice that is long enough to be a paragraph</p></footer></body>`);
  assert.equal(t, "Why cycles\n\nSix weeks is long enough to build something meaningful and short enough to feel the deadline.\n\nTeams shape work before betting on it, which keeps scope honest & clear.");
});

test("photo picks: big enough, upright first, credited", () => {
  const out = pickPhotos([
    { url: "https://x/wide.jpg", width: 2000, height: 1000, creator: "A", provider: "flickr", license: "by", license_version: "2.0", foreign_landing_url: "https://f/1" },
    { url: "https://x/tiny.jpg", width: 200, height: 300 },
    { url: "https://x/huge.jpg", thumbnail: "https://t/huge", width: 6000, height: 8000, creator: "B", license: "cc0" },
  ]);
  assert.deepEqual(out.map((p) => p.src), ["https://t/huge", "https://x/wide.jpg"]);
  assert.equal(out[0].license, "CC0");
  assert.equal(out[1].credit, "A · flickr");
  assert.equal(out[1].license, "CC BY 2.0");
});

test("relay photo search goes to Openverse and returns picks", async () => {
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(String(url)); return new Response(JSON.stringify({ results: [{ url: "https://x/a.jpg", width: 1200, height: 1600, creator: "C", license: "by" }] }), { status: 200, headers: { "content-type": "application/json" } }); };
  const res = await relay.fetch(new Request("https://w.test/photo?q=stack%20of%20books", { headers: { origin: "https://grahamdeno.github.io" } }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).photos[0].src, "https://x/a.jpg");
  assert.match(seen[0], /^https:\/\/api\.openverse\.org\/v1\/images\/\?q=stack%20of%20books/);
});

import { articleImage } from "../relay/perplexity-relay.js";

test("article image: first large photo, not icons, logos, ads or pixels", () => {
  const html = `<body><header><img src="/logo.png" width="400"></header><article>
    <img src="/img/author-avatar.jpg" class="avatar">
    <img src="/pixel.gif" width="1" height="1">
    <img src="/icons/share.png" width="24" height="24">
    <img src="data:image/png;base64,AAAA">
    <img src="/ads/banner-300.jpg" width="300">
    <img data-src="/img/lazy.jpg" src="/img/placeholder.jpg" srcset="/img/hero-800.jpg 800w, /img/hero-1600.jpg 1600w" alt="Harbor at dawn">
    <img src="/img/second.jpg"></article></body>`;
  assert.equal(articleImage(html, "https://site.test/story"), "https://site.test/img/hero-1600.jpg");
  assert.equal(articleImage(`<main><img src="photo.jpg" width="1200"></main>`, "https://a.test/x/"), "https://a.test/x/photo.jpg");
  assert.equal(articleImage(`<body><img src="/logo.svg"><img src="/i.png" width="16"></body>`, "https://a.test"), null);
});

test("relay preview falls back to the article's image when there's no preview picture", async () => {
  globalThis.fetch = async () => new Response(`<html><head><title>T</title></head><body><article><p>Text.</p><img src="/photos/lead.jpg" width="1200" height="800"></article></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  const res = await relay.fetch(new Request("https://w.test/preview?url=" + encodeURIComponent("https://news.test/a"), { headers: { origin: "https://grahamdeno.github.io" } }));
  assert.equal((await res.json()).image, "https://news.test/photos/lead.jpg");
});

import { pageImages, parseMeta as meta2 } from "../relay/perplexity-relay.js";

test("page images: preview picture first, then the article's photos, no logos or repeats", () => {
  const html = `<head><meta property="og:image" content="/a.jpg"><meta property="og:image:width" content="1200">
    <meta name="twitter:image" content="/a.jpg"></head><body><article>
    <img src="/site-logo.png" width="600"><img src="/c.jpg" width="800" alt="Trail at dawn">
    <img srcset="/d-400.jpg 400w, /d-1600.jpg 1600w"><img src="/tiny.jpg" width="120"><img src="/c.jpg"></article></body>`;
  const base = "https://ex.test/p";
  const out = pageImages(html, base, meta2(html, base));
  assert.deepEqual(out.map((o) => o.src), ["https://ex.test/a.jpg", "https://ex.test/c.jpg", "https://ex.test/d-1600.jpg"]);
  assert.equal(out[0].w, 1200);
  assert.equal(out[0].from, "preview");
  assert.equal(out[1].alt, "Trail at dawn");
});

import { tintInks } from "../src/visuals.js";
test("tintInks accepts only a plain hex colour", () => {
  assert.deepEqual(tintInks("#AA3322"), { t: "#aa3322" });
  assert.equal(tintInks("red"), null);
  assert.equal(tintInks(undefined), null);
});
