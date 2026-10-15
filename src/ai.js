/*
 * Anthropic API client. Called straight from the browser with the reader's
 * own key, which is kept in this device's localStorage and sent nowhere else.
 *
 * Three jobs:
 *   enrich    read one new item (text, link, photo or PDF) and return a
 *             title, a one-line "why it might matter", tags, minutes, what
 *             it was saved for, key points, text in a photo, and whether a
 *             note is really a quote
 *   rank      score the queue 0..100 using what the reader finished and let go
 *   discover  search the web for a few new things this reader would want
 *             (Perplexity's Agent API through the reader's relay when its key is set,
 *             else Claude's web search)
 * Plus two small tag jobs: tagItems (suggestions that arrived untagged) and
 * retag (fresh tags for one item, on request). Every tag job is shown the
 * reader's own tags and asked to reuse them before coining new ones.
 */

import { topTags } from "./model.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
export const DEFAULT_MODEL = "claude-haiku-5-5";
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_EDGE = 1568;

const KEY_STORE = "edition.apiKey";
const MODEL_STORE = "edition.model";
const PPLX_STORE = "edition.perplexityKey";
const RELAY_STORE = "edition.perplexityRelay";

export const settings = {
  key: () => safeGet(KEY_STORE),
  setKey: (k) => safeSet(KEY_STORE, k),
  model: () => safeGet(MODEL_STORE) || DEFAULT_MODEL,
  setModel: (m) => safeSet(MODEL_STORE, m),
  enabled: () => Boolean(safeGet(KEY_STORE)),
  pplxKey: () => safeGet(PPLX_STORE),
  setPplxKey: (k) => safeSet(PPLX_STORE, k),
  pplxEnabled: () => Boolean(safeGet(PPLX_STORE)),
  relay: () => safeGet(RELAY_STORE),
  setRelay: (u) => safeSet(RELAY_STORE, u),
  /** Discovery works with either key: Perplexity when set, Claude's web search otherwise. */
  canDiscover: () => Boolean(safeGet(PPLX_STORE) || safeGet(KEY_STORE)),
};

function safeGet(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } }
function safeSet(k, v) {
  try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* storage blocked */ }
}

export class AiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function call({ content, system, maxTokens = 600, tools }) {
  const key = settings.key();
  if (!key) throw new AiError("No API key set.");
  const body = {
    model: settings.model(),
    max_tokens: maxTokens,
    messages: [{ role: "user", content }],
  };
  if (system) body.system = system;
  if (tools) body.tools = tools;
  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": API_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AiError("Couldn't reach the API. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Request failed (${res.status}).`;
    throw new AiError(res.status === 401 ? "The API key was rejected." : msg, res.status);
  }
  return data;
}

/** All text blocks of a response, joined. */
function textOf(data) {
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

/** Pull the last JSON object or array out of a model reply. */
export function parseJson(text) {
  const candidates = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = candidates ? candidates[1] : String(text);
  const start = Math.min(...["{", "["].map((c) => { const i = src.indexOf(c); return i === -1 ? Infinity : i; }));
  if (start === Infinity) throw new AiError("The reply had no JSON in it.");
  const close = src[start] === "{" ? "}" : "]";
  const end = src.lastIndexOf(close);
  try { return JSON.parse(src.slice(start, end + 1)); } catch { throw new AiError("The reply's JSON was malformed."); }
}

/** Check a key works with a tiny request. */
export async function testKey() {
  await call({ content: "Reply with the word ok.", maxTokens: 5 });
  return true;
}

const ENRICH_SYSTEM =
  "You file things a person saved into Edition, their private reading app. " +
  "Write plainly. No hype, no exclamation marks, no emoji. Reply with JSON only.";

const ENRICH_SHAPE =
  'Return JSON: {"title": string (max 80 chars, plain, no site name unless needed), ' +
  '"summary": string (one sentence, max 140 chars, on why this might be worth their time; for a photo, what it shows and why it might have been kept), ' +
  '"tags": array of 1-3 lowercase topic words, "minutes": integer time to read or watch, ' +
  '"intent": one of "read", "watch", "listen", "reference", "idea", "task" (what the person most likely saved it for), ' +
  '"points": array of 0-3 short key points (only for documents, PDFs, long notes or photos of pages; otherwise []), ' +
  '"transcript": string (for a photo or screenshot with readable text such as a whiteboard, page, slide or sign: that text, cleaned up, max 1500 chars; otherwise ""), ' +
  '"quote": null, or {"text": string, "author": string} when the item is really a quotation worth keeping as one, ' +
  '"hook": string (see Hook)}';

/*
 * The hook is the face-down side of the card: one line that reminds the
 * person what this is. It must say what kind of thing it is to them (a read,
 * a talk to watch, an episode to listen to, a reference, an idea, a task),
 * so the card still tells them what they'd be doing.
 */
const HOOK_RULE =
  "Hook: one line, max 90 characters, for the face of the card in their reading app. " +
  "Say plainly what kind of thing it is to them, using the verb that fits: a read, something to watch, " +
  "something to listen to, a reference, an idea, or something to act on (for example \"A 20-minute read on how Basecamp bets on six-week cycles\" " +
  "or \"A talk to watch on running retros that people actually use\"). Be specific to this item. Mention their context below only when it " +
  "clearly connects. Never claim to know why they saved it. No hype, no exclamation marks, no quotation marks around it.";

/** What else the reader is doing, so a hook can connect to it. */
function contextLines(context) {
  if (!context) return [];
  const list = (a) => (a || []).slice(0, 5).map((t) => `- ${t}`).join("\n");
  return [
    context.around?.length && `Saved around the same time:\n${list(context.around)}`,
    context.finished?.length && `Recently finished:\n${list(context.finished)}`,
  ].filter(Boolean);
}

function cleanHook(h) {
  return clip(String(h || "").replace(/^["'\u201C\u2018]+|["'\u201D\u2019]+$/g, "").replace(/\s+/g, " "), 110);
}

/** The reader's tags, as a prompt line asking the model to reuse them. */
export function vocabLine(vocab) {
  const v = (vocab || []).slice(0, 40);
  return v.length
    ? `Tags already in use: ${v.join(", ")}. Reuse one of these whenever it fits; only coin a new tag when none of them does.`
    : "";
}

function cleanTags(raw, n = 3) {
  return Array.isArray(raw) ? raw.slice(0, n).map((t) => String(t).toLowerCase().trim()).filter(Boolean) : [];
}

const INTENTS = new Set(["read", "watch", "listen", "reference", "idea", "task"]);

/**
 * Enrich one item: title, why it matters, tags, time, what it was saved for,
 * key points, any text in a photo, and whether a note is really a quote.
 * `blob` is the original file for photos, PDFs and text files.
 * Links are judged from the URL and any note; the browser can't fetch the page.
 */
export async function enrich(item, blob, { vocab = [], context = null } = {}) {
  const { parts, item: it } = await contentParts(item, blob);
  parts.push({ type: "text", text: [...describe(it), ...contextLines(context), "", vocabLine(vocab), ENRICH_SHAPE, HOOK_RULE].join("\n") });
  const out = parseJson(textOf(await call({ content: parts, system: ENRICH_SYSTEM, maxTokens: 1200 })));
  const quote = out.quote && typeof out.quote === "object" && out.quote.text ? { text: clip(out.quote.text, 600), author: clip(out.quote.author, 80) } : null;
  return {
    title: clip(out.title, 120) || item.title,
    summary: clip(out.summary, 200),
    tags: cleanTags(out.tags),
    minutes: Number.isFinite(+out.minutes) && +out.minutes > 0 ? Math.round(+out.minutes) : undefined,
    intent: INTENTS.has(out.intent) ? out.intent : undefined,
    points: Array.isArray(out.points) ? out.points.slice(0, 3).map((p) => clip(p, 160)).filter(Boolean) : [],
    transcript: clip(out.transcript, 1500),
    quote,
    hook: cleanHook(out.hook),
  };
}

/**
 * Write just the hook for an item that was read before hooks existed. Uses
 * what Edition already knows about it (no file upload), so it's a small call.
 */
export async function hook(item, { context = null } = {}) {
  const lines = [...describe({ ...item, text: item.text ? String(item.text).slice(0, 3000) : "" }),
    item.intent && `Saved for: ${item.intent}`,
    item.tags?.length && `Tags: ${item.tags.join(", ")}`,
    item.transcript && `Text in the picture: ${String(item.transcript).slice(0, 800)}`,
    ...contextLines(context), "", HOOK_RULE, 'Return JSON: {"hook": string}'].filter(Boolean);
  const out = parseJson(textOf(await call({ content: lines.join("\n"), system: ENRICH_SYSTEM, maxTokens: 200 })));
  return cleanHook(out.hook);
}

/** What the model is shown of an item: the file itself where it can read one. */
async function contentParts(item, blob) {
  const parts = [];
  if (item.kind === "photo" && blob) {
    const img = await imageForModel(blob);
    if (img) parts.push({ type: "image", source: { type: "base64", media_type: img.type, data: img.data } });
  } else if (item.kind === "photo" && item.imageUrl) {
    parts.push({ type: "image", source: { type: "url", url: item.imageUrl } });
  } else if (item.kind === "pdf" && blob && blob.size <= MAX_PDF_BYTES) {
    parts.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: await toBase64(blob) } });
  } else if (item.kind === "text" && blob) {
    item = { ...item, text: (await blob.text()).slice(0, 12000) };
  }
  return { parts, item };
}

function describe(item) {
  return [
    `Kind: ${item.kind}${item.videoId ? " (YouTube)" : ""}`,
    item.title && `Current title: ${item.title}`,
    item.author && `Author or channel: ${item.author}`,
    item.url && `URL: ${item.url}`,
    item.fileName && `File name: ${item.fileName}`,
    item.why && `Why they saved it: ${item.why}`,
    item.summary && `Summary: ${item.summary}`,
    item.text && `Text:\n${item.text.slice(0, 12000)}`,
  ].filter(Boolean);
}

/**
 * Fresh tags for one item, on request. Returns 1-3 tags, reusing the
 * reader's own where they fit.
 */
export async function retag(item, blob, { vocab = [] } = {}) {
  const { parts, item: it } = await contentParts(item, blob);
  parts.push({ type: "text", text: [...describe(it), "", vocabLine(vocab),
    'Tag this item for the person who saved it. Return JSON: {"tags": array of 1-3 lowercase topic words}'].filter(Boolean).join("\n") });
  const out = parseJson(textOf(await call({ content: parts, system: ENRICH_SYSTEM, maxTokens: 200 })));
  return cleanTags(out.tags);
}

/**
 * Tag several links at once from their titles, reasons and addresses: one
 * call for every suggestion that arrived without tags. Returns { index: tags }.
 */
export async function tagItems(list, { vocab = [] } = {}) {
  if (!list.length) return {};
  const lines = list.map((p, k) => `${k} | ${p.title || ""} | ${p.why || p.summary || ""} | ${p.url || ""}`).join("\n");
  const prompt =
    `Tag each item for one person's private reading app.\n${vocabLine(vocab)}\n\n` +
    `Items (index | title | why | url):\n${lines}\n\n` +
    `Return JSON: {"tags":[{"i":integer,"tags":[1-3 lowercase topic words]}]}`;
  const out = parseJson(textOf(await call({ content: prompt, system: ENRICH_SYSTEM, maxTokens: 600 })));
  const res = {};
  for (const r of out.tags || []) {
    const i = Math.round(+r?.i);
    if (Number.isInteger(i) && i >= 0 && i < list.length) res[i] = cleanTags(r.tags);
  }
  return res;
}

/**
 * Rank the queue. Returns [{ id, score, why }]. The reader's history is the
 * training signal: what they finished, what they let go, and the tags that
 * keep coming up in each.
 */
export async function rank(queue, profile) {
  if (!queue.length) return [];
  const list = queue.slice(0, 40);
  const kept = profile.kept.slice(0, 12).map((i) => `- ${i.title}${tagStr(i)}`).join("\n") || "(nothing yet)";
  const dropped = profile.dropped.slice(0, 8).map((i) => `- ${i.title}${tagStr(i)}`).join("\n") || "(nothing yet)";
  const items = list.map((i) => `${i.id} | ${i.kind} | ${i.title}${tagStr(i)} | saved ${ageStr(i.created)}${i.skips ? ` | deferred ${i.skips}x` : ""}${i.summary ? ` | ${i.summary}` : ""}`).join("\n");
  const prompt =
    `Rank one person's private reading queue for today's edition.\n\n` +
    `They finished or read right away:\n${kept}\n\nThey let go:\n${dropped}\n\n` +
    `Queue (id | kind | title [tags] | age | notes):\n${items}\n\n` +
    `Score each 0-100 for how much they would want it today. Favour their demonstrated interests, ` +
    `give some weight to things deferred repeatedly (a verdict is overdue), and keep variety across kinds.\n` +
    `Return JSON: {"ranks":[{"id":string,"score":integer,"why":string (max 90 chars, addressed to them, plain)}]}`;
  const out = parseJson(textOf(await call({ content: prompt, maxTokens: 2000 })));
  const ids = new Set(list.map((i) => i.id));
  return (out.ranks || [])
    .filter((r) => ids.has(r.id))
    .map((r) => ({ id: r.id, score: Math.max(0, Math.min(100, Math.round(+r.score || 0))), why: clip(r.why, 120) }));
}

/**
 * Find a few new things worth reading, using the web search tool.
 * Returns [{ title, url, why, tags }].
 */
export async function discover(profile, { count = 3, known = new Set(), guide = "", vocab = [] } = {}) {
  if (settings.pplxEnabled()) return pplxDiscover(profile, { count, known, guide, vocab });
  return claudeDiscover(profile, { count, guide, vocab });
}

const BECAUSE = 'why: one plain sentence, max 120 chars, starting "Because you", naming what they finished or keep saving that this connects to';

async function claudeDiscover(profile, { count = 3, guide = "", vocab = [] } = {}) {
  const interests = topTags(profile, 10);
  const kept = profile.kept.slice(0, 10).map((i) => `- ${i.title}${i.url ? ` (${i.url})` : ""}`).join("\n");
  const dropped = profile.dropped.slice(0, 6).map((i) => `- ${i.title}`).join("\n");
  if (!interests.length && !kept) throw new AiError("Finish or let go of a few items first, so there is something to learn from.");
  const prompt =
    `Find ${count} things this person would want in their private daily reading edition: substantial articles, essays, ` +
    `papers or talks, published in the last year, not news briefs or listicles. Avoid anything they already have.\n\n` +
    `Interests, strongest first: ${interests.join(", ") || "(learn from the list below)"}\n` +
    `Recently finished:\n${kept || "(none)"}\n` +
    `Recently let go (avoid these directions):\n${dropped || "(none)"}\n` +
    `${guide ? `What their answers to past suggestions taught:\n${guide}\n` : ""}` +
    `${vocab.length ? `${vocabLine(vocab)}\n` : ""}\n` +
    `Search, then reply with JSON only: {"picks":[{"title":string,"url":string,"why":string (${BECAUSE}),"tags":[1-3 lowercase words],"minutes":integer}]}`;
  const data = await call({
    content: prompt,
    maxTokens: 2500,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
  });
  const out = parseJson(textOf(data));
  return (out.picks || [])
    .filter((p) => p && /^https?:\/\//.test(p.url || ""))
    .slice(0, count)
    .map((p) => ({
      title: clip(p.title, 120),
      url: p.url,
      why: clip(p.why, 160),
      tags: cleanTags(p.tags),
      minutes: Number.isFinite(+p.minutes) ? Math.round(+p.minutes) : undefined,
    }));
}

/* ---- Perplexity Agent API ----
 * Perplexity refuses calls made straight from a web page (no CORS), so the
 * request goes through the reader's own relay (relay/perplexity-relay.js, a
 * Cloudflare Worker). The key stays on this phone and rides along in the
 * Authorization header; the relay only forwards it.
 */

const PPLX_DIRECT = "https://api.perplexity.ai";
const PPLX_PRESET = "low"; // web search plus a short read of a page or two

export function relayBase(raw = settings.relay()) {
  let s = String(raw || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\//.test(s)) s = `https://${s}`;
  try { const u = new URL(s); return u.origin + u.pathname.replace(/\/+$/, ""); } catch { return ""; }
}

async function pplxAgent(body) {
  const key = settings.pplxKey();
  if (!key) throw new AiError("No Perplexity key set.");
  const base = relayBase();
  const url = `${base || PPLX_DIRECT}/v1/agent`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AiError(base
      ? `Couldn't reach your relay at ${new URL(base).host}. Check the address and that the Worker is deployed.`
      : "Perplexity blocks calls made straight from a web app. Add your relay address in Settings.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || (Array.isArray(data?.detail) ? data.detail.map((d) => d.msg).join("; ") : data?.detail);
    if (res.status === 401) throw new AiError("The Perplexity key was rejected.", 401);
    if (res.status === 403 && base) throw new AiError(msg || "Your relay refused the request (origin not allowed).", 403);
    if (res.status === 429) {
      const wait = res.headers.get("retry-after");
      throw new AiError(`Perplexity is rate limiting. Try again${wait ? ` in ${wait} seconds` : " shortly"}.`, 429);
    }
    throw new AiError(msg ? `Perplexity: ${msg}` : `Perplexity request failed (${res.status}).`, res.status);
  }
  if (data.status === "failed" || data.error) throw new AiError(`Perplexity: ${data.error?.message || "the request failed."}`, res.status);
  return data;
}

/** The answer text: every output_text part of the message items, joined. */
export function outputText(data) {
  return (data.output || [])
    .filter((o) => o.type === "message")
    .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("");
}

/** Every web result the agent saw, in order. */
export function searchResultsOf(data) {
  return (data.output || []).filter((o) => o.type === "search_results").flatMap((o) => o.results || []);
}

/** Check a Perplexity key (and the relay) with the cheapest preset. */
export async function testPplxKey() {
  const data = await pplxAgent({ preset: "fast", input: "Reply with the word ok." });
  if (!outputText(data)) throw new AiError("Perplexity answered, but with no text.");
  return true;
}

/**
 * Take results in order, skipping links already saved or repeated.
 */
export function pickResults(results, { count = 3, known = new Set() } = {}) {
  const seen = new Set([...known].map(normUrl)), picks = [];
  for (const r of results) {
    if (picks.length >= count) break;
    if (!r || !/^https?:\/\//.test(r.url || "") || seen.has(normUrl(r.url))) continue;
    seen.add(normUrl(r.url));
    picks.push(r);
  }
  return picks;
}

function normUrl(u) { return String(u || "").replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase(); }

/**
 * Keep only picks whose link the search actually returned (the model can
 * misremember a URL), then fill any gap from the search results themselves.
 */
export function reconcilePicks(picks, results, { count = 3, known = new Set() } = {}) {
  const real = new Map(results.map((r) => [normUrl(r.url), r]));
  const seen = new Set([...known].map(normUrl)), out = [];
  for (const p of picks || []) {
    if (out.length >= count) break;
    const k = normUrl(p && p.url);
    if (!real.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push({
      title: clip(p.title || real.get(k).title, 120),
      url: real.get(k).url,
      why: clip(p.why, 160),
      tags: Array.isArray(p.tags) ? p.tags.slice(0, 3).map((t) => String(t).toLowerCase().trim()).filter(Boolean) : [],
      minutes: Number.isFinite(+p.minutes) && +p.minutes > 0 ? Math.round(+p.minutes) : undefined,
    });
  }
  for (const r of pickResults(results, { count: count - out.length, known: new Set([...seen]) })) {
    out.push({ title: clip(r.title, 120), url: r.url, why: clip(r.snippet, 160), tags: [], minutes: undefined });
  }
  return out;
}

const PICKS_SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          why: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          minutes: { type: "integer" },
        },
        required: ["title", "url", "why", "tags", "minutes"],
        additionalProperties: false,
      },
    },
  },
  required: ["picks"],
  additionalProperties: false,
};

async function pplxDiscover(profile, { count = 3, known = new Set(), guide = "", vocab = [] } = {}) {
  const interests = topTags(profile, 8);
  const kept = profile.kept.slice(0, 10).map((i) => `- ${i.title}${tagStr(i)}`).join("\n");
  const dropped = profile.dropped.slice(0, 6).map((i) => `- ${i.title}`).join("\n");
  if (!interests.length && !kept) throw new AiError("Finish or let go of a few items first, so there is something to learn from.");
  const input =
    `Search the web for ${count} articles, essays or talks this person would want in their private daily reading. ` +
    `Favour pieces that are popular and widely shared right now, published in the last month or two, and substantial: ` +
    `no news briefs, listicles or product pages.\n\n` +
    `Interests, strongest first: ${interests.join(", ") || "(learn from the list below)"}\n` +
    `Recently finished:\n${kept || "(none)"}\n` +
    `Recently let go (avoid these directions):\n${dropped || "(none)"}\n` +
    `Already saved (skip): ${[...known].slice(0, 30).join(" ") || "(none)"}\n` +
    `${guide ? `What their answers to past suggestions taught:\n${guide}\n` : ""}` +
    `${vocab.length ? `${vocabLine(vocab)}\n` : ""}\n` +
    `For each pick: the title, the exact URL from your search results, ${BECAUSE}, ` +
    `1-3 lowercase topic tags, and minutes to read or watch.`;
  const data = await pplxAgent({
    preset: PPLX_PRESET,
    instructions: "You find reading for one person's private reading app. Write plainly. No hype.",
    input,
    response_format: { type: "json_schema", json_schema: { name: "picks", schema: PICKS_SCHEMA, strict: true } },
  });
  const results = searchResultsOf(data);
  let picks = [];
  try { picks = parseJson(outputText(data)).picks || []; } catch { /* use the raw results below */ }
  const out = reconcilePicks(picks, results, { count, known });
  if (!out.length) throw new AiError("Perplexity didn't turn up anything new. Try again later.");
  return out;
}

function tagStr(i) { return i.tags && i.tags.length ? ` [${i.tags.join(", ")}]` : ""; }
function ageStr(ts) { const d = Math.floor((Date.now() - ts) / 86400000); return d <= 0 ? "today" : `${d}d ago`; }
function clip(s, n) { s = String(s || "").trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; }

async function toBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Downscale a photo to the size the model reads best, as JPEG. */
async function imageForModel(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    const out = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    return out ? { type: "image/jpeg", data: await toBase64(out) } : null;
  } catch {
    return null; // a format this browser can't decode
  }
}
