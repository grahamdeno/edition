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

const KEY_STORE = "edition.apiKey"; // older versions: the reader's own key (used only until the relay has one)
const MODEL_STORE = "edition.model";
const PPLX_STORE = "edition.perplexityKey";
const RELAY_STORE = "edition.perplexityRelay";
const CONSENT_STORE = "edition.aiConsent";
const DEVICE_STORE = "edition.aiDevice";
const TOKEN_STORE = "edition.aiToken";

/** Shoebox's own relay. A relay address saved by an older version still wins. */
export const DEFAULT_RELAY = "https://shoebox-api.tangomike.app";

export const settings = {
  key: () => safeGet(KEY_STORE),
  setKey: (k) => safeSet(KEY_STORE, k),
  model: () => safeGet(MODEL_STORE) || DEFAULT_MODEL,
  setModel: (m) => safeSet(MODEL_STORE, m),
  /** AI is on once the reader has agreed to send their saves to Anthropic. */
  enabled: () => safeGet(CONSENT_STORE) === "1",
  consented: () => safeGet(CONSENT_STORE) === "1",
  asked: () => safeGet(CONSENT_STORE) !== "",
  setConsent: (on) => safeSet(CONSENT_STORE, on ? "1" : "0"),
  pplxKey: () => safeGet(PPLX_STORE),
  setPplxKey: (k) => safeSet(PPLX_STORE, k),
  pplxEnabled: () => false, // top stories now come through Claude's web search
  relay: () => safeGet(RELAY_STORE) || DEFAULT_RELAY,
  setRelay: (u) => safeSet(RELAY_STORE, u),
  canDiscover: () => safeGet(CONSENT_STORE) === "1",
  device: () => safeGet(DEVICE_STORE),
};

/**
 * Older versions asked for an Anthropic key. Someone who set one already
 * chose to use AI, so that counts as agreeing; the key itself is kept only
 * until the relay answers with its own.
 */
export function migrateAiSettings() {
  if (!safeGet(CONSENT_STORE) && safeGet(KEY_STORE)) safeSet(CONSENT_STORE, "1");
  if (safeGet(PPLX_STORE)) safeSet(PPLX_STORE, "");
}

function safeGet(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } }
function safeSet(k, v) {
  try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* storage blocked */ }
}

export class AiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function call({ content, system, maxTokens = 600, tools, model = null }) {
  if (!settings.consented()) throw new AiError("AI is off. Turn it on in Settings › AI.");
  const body = {
    model: model || settings.model(),
    max_tokens: maxTokens,
    messages: [{ role: "user", content }],
  };
  if (system) body.system = system;
  if (tools) body.tools = tools;
  try {
    const data = await viaRelay(body);
    if (settings.key()) settings.setKey(""); // the relay works: no reason to keep a key on the phone
    return data;
  } catch (e) {
    // A relay without AI yet (older copy, or no key set there): fall back to a key from an older version.
    if (settings.key() && (e.status === 404 || e.status === 503)) return direct(body, settings.key());
    throw e;
  }
}

async function register(base) {
  const res = await fetch(`${base}/ai/register`, { method: "POST" }).catch(() => null);
  if (!res) throw new AiError("Couldn't reach Shoebox's AI. Check your connection.", 0);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.device) throw new AiError(data?.error?.message || `Couldn't start AI (${res.status}).`, res.status);
  safeSet(DEVICE_STORE, data.device);
  safeSet(TOKEN_STORE, data.token);
}

async function viaRelay(body, retried = false) {
  const base = relayBase();
  if (!safeGet(DEVICE_STORE) || !safeGet(TOKEN_STORE)) await register(base);
  let res;
  try {
    res = await fetch(`${base}/ai/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shoebox-device": safeGet(DEVICE_STORE), "x-shoebox-token": safeGet(TOKEN_STORE) },
      body: JSON.stringify(body),
    });
  } catch {
    // Status 0: the request never got an answer (offline, or the app was closed mid-call).
    throw new AiError("Couldn't reach Shoebox's AI. Check your connection.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data?.error?.code === "register" && !retried) {
    safeSet(DEVICE_STORE, ""); safeSet(TOKEN_STORE, "");
    return viaRelay(body, true);
  }
  if (!res.ok) throw new AiError(data?.error?.message || `AI request failed (${res.status}).`, res.status);
  // Long calls (web search) arrive as a stream that always starts 200; a failure is in the body.
  if (data && data.error && !data.content) throw new AiError(data.error.message || "AI request failed.", data.status || 502);
  return data;
}

async function direct(body, key) {
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
    throw new AiError("Couldn't reach the API. Check your connection.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Request failed (${res.status}).`;
    throw new AiError(res.status === 401 ? "The API key was rejected." : msg, res.status);
  }
  return data;
}

/** The relay's anonymous usage stats; only owner installs may read them. */
export async function ownerStats() {
  const res = await fetch(`${relayBase()}/stats`, { headers: { "x-shoebox-device": safeGet(DEVICE_STORE), "x-shoebox-token": safeGet(TOKEN_STORE) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AiError(data?.error?.message || `Couldn't read stats (${res.status}).`, res.status);
  return data;
}

/** Today's AI spend for this install, from the relay. */
export async function usage() {
  const res = await fetch(`${relayBase()}/ai/usage`, { headers: { "x-shoebox-device": safeGet(DEVICE_STORE), "x-shoebox-token": safeGet(TOKEN_STORE) } });
  if (!res.ok) throw new AiError(`Couldn't read usage (${res.status}).`, res.status);
  return res.json();
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
  "You file things a person saved into Shoebox, their private app for what they mean to come back to. " +
  "Write plainly. No hype, no exclamation marks, no emoji. Reply with JSON only.";

/* Where a picture's subject is, so a crop keeps it in view. */
const FOCUS_SHAPE = 'null, or {"x": integer 0-100, "y": integer 0-100} (the point a crop must keep in view: the main subject; ' +
  'for a person, between the eyes; 0,0 is the top left)';

/**
 * Their own words say what a save is for, and tags follow that use first.
 * A pottery class noted as a date idea is a date idea before it is pottery.
 */
export const OWN_WORDS_RULE =
  "their own words (why they saved it, their note, their later thoughts) come first: " +
  "when those say what it is for, such as a date idea, a gift for someone, a trip or a work project, " +
  "the first tag names that use, and the subject comes after";

const ENRICH_SHAPE =
  'Return JSON: {"title": string (max 80 chars, plain, no site name unless needed), ' +
  '"summary": string (one sentence, max 140 chars, on why this might be worth their time; for a photo, what it shows and why it might have been kept), ' +
  '"tags": array of 1-3 lowercase topic words (' + OWN_WORDS_RULE + '), "minutes": integer time to read or watch, ' +
  '"intent": one of "read", "watch", "listen", "reference", "idea", "task" (what the person most likely saved it for), ' +
  '"points": array of 0-4 short key points (for articles, web pages and documents whose text you have, PDFs, long notes or photos of pages; otherwise []), ' +
  '"extended": string (only when you have the text of an article, web page or document: a fuller summary in 2 or 3 short paragraphs, 120 to 220 words in all, ' +
  'covering its argument, its key facts and what it concludes, plainly, separated by a blank line; otherwise ""), ' +
  '"photo_query": string (2 to 4 concrete words naming a photograph that would represent this well, something a camera could take: ' +
  'objects, places, scenes; no text, logos or people\'s names; e.g. "whiteboard sticky notes", "mountain road dawn", "stack of books"), ' +
  '"transcript": string (for a photo or screenshot with readable text such as a whiteboard, page, slide or sign: that text, cleaned up, max 1500 chars; otherwise ""), ' +
  '"quote": null, or {"text": string, "author": string} when the item is really a quotation worth keeping as one, ' +
  '"alt": string (only when you were shown a picture: one plain sentence describing it for someone who cannot see it, max 140 chars, ' +
  'no "image of" or "photo of"; otherwise ""), ' +
  '"focus": (only when you were shown a picture) ' + FOCUS_SHAPE + ', ' +
  '"hook": string (see Hook), ' +
  '"book": null, or {"title": string, "author": string} when the photo is mainly of a book (its cover, spine, or the book in hand): ' +
  'read the title and author from it; a person photographs a book because they want to read it}';

/*
 * The hook is the face-down side of the card: one line that reminds the
 * person what this is. It must say what kind of thing it is to them (a read,
 * a talk to watch, an episode to listen to, a reference, an idea, a task),
 * so the card still tells them what they'd be doing.
 */
/** Bump when the hook instructions change, so older lines are rewritten once. */
export const HOOK_VERSION = 2;

const HOOK_RULE =
  "Hook: a short line for the face of the card, 5 to 8 words, never more than 50 characters. " +
  "Start from what kind of thing it is, using the verb that fits: a read, something to watch, " +
  "something to listen to, a reference, an idea, or something to act on. Then the topic in a few plain words. " +
  "Examples: \"A short read on six-week cycles\", \"A talk to watch on retros\", \"An idea for sprint reviews\". " +
  "General is fine; brevity matters more than detail. Skip their context unless it fits in those few words. " +
  "Never claim to know why they saved it. No hype, no exclamation marks, no quotation marks, no full stop.";

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
  return clip(String(h || "").replace(/^["'\u201C\u2018]+|["'\u201D\u2019]+$/g, "").replace(/\s+/g, " ").replace(/\.$/, ""), 70);
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
 * Links are judged from their page's text when the relay could read it,
 * else from the URL and any note.
 */
export async function enrich(item, blob, { vocab = [], context = null } = {}) {
  const { parts, item: it } = await contentParts(item, blob);
  parts.push({ type: "text", text: [...describe(it), ...contextLines(context), "", vocabLine(vocab), ENRICH_SHAPE, HOOK_RULE].join("\n") });
  const out = parseJson(textOf(await call({ content: parts, system: ENRICH_SYSTEM, maxTokens: 2000 })));
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
    book: out.book && typeof out.book === "object" && out.book.title ? { title: clip(out.book.title, 140), author: clip(out.book.author, 80) } : null,
    extended: clip(out.extended, 1800),
    photoQuery: clip(String(out.photo_query || "").replace(/["']/g, ""), 60),
    focus: cleanFocus(out.focus),
    alt: clip(capFirst(String(out.alt || "").replace(/^(an? )?(image|photo|picture) of /i, "")), 160),
  };
}

/**
 * Pick the picture that best represents a saved link, from the candidates
 * its page offered, and describe it for screen readers. A small call of its
 * own, so a picture that can't be fetched never costs the item its summary.
 * Returns { index, alt }; index is -1 when none of them suits.
 */
export async function pickPicture(item, candidates) {
  const list = (candidates || []).slice(0, 4);
  if (!list.length) return { index: -1, alt: "", focus: null };
  const parts = list.map((c) => ({ type: "image", source: { type: "url", url: c.src } }));
  parts.push({ type: "text", text: [
    `These are the ${list.length} pictures found on a page someone saved, numbered 0 to ${list.length - 1} in the order shown.`,
    item.title && `Page title: ${item.title}`,
    item.summary && `Summary: ${item.summary}`,
    item.why && `Why they saved it: ${item.why}`,
    "Pick the one that best represents the page as a photo on a card: a real photograph or illustration of the subject. " +
    "Avoid logos, screenshots of text, charts, ads, author headshots and stock icons. If none suits, use -1.",
    'Return JSON: {"index": integer, "alt": string (one plain sentence describing the chosen picture for someone who can\'t see it, max 140 chars; "" when index is -1), ' +
    `"focus": ${FOCUS_SHAPE} for the chosen picture}`,
  ].filter(Boolean).join("\n") });
  const out = parseJson(textOf(await call({ content: parts, system: ENRICH_SYSTEM, maxTokens: 200 })));
  const index = Number.isInteger(+out.index) && +out.index >= 0 && +out.index < list.length ? +out.index : -1;
  return { index, alt: index >= 0 ? clip(out.alt, 160) : "", focus: index >= 0 ? cleanFocus(out.focus) : null };
}

export function cleanFocus(f) {
  if (!f || typeof f !== "object") return null;
  const x = Math.round(+f.x), y = Math.round(+f.y);
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 100 && y >= 0 && y <= 100 ? { x, y } : null;
}

/** One picture, by address: where is its subject? A small call of its own. */
export async function focusPoint(src) {
  const parts = [{ type: "image", source: { type: "url", url: src } },
    { type: "text", text: `This picture is cropped to fit cards of different shapes. Return JSON: {"focus": ${FOCUS_SHAPE}}` }];
  const out = parseJson(textOf(await call({ content: parts, system: ENRICH_SYSTEM, maxTokens: 100 })));
  return cleanFocus(out.focus);
}

/** Books they've read, as a prompt line: an interest signal with no date implied. */
function booksLine(profile) {
  const b = (profile.books || []).slice(0, 12).map((i) => i.book ? `${i.book.title}${i.book.author ? ` by ${i.book.author}` : ""}` : i.title);
  return b.length ? `Books they've read (at some point, not necessarily recently): ${b.join("; ")}\n` : "";
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
  const text = textOf(await call({ content: lines.join("\n"), system: ENRICH_SYSTEM, maxTokens: 200 }));
  try {
    return cleanHook(parseJson(text).hook);
  } catch (e) {
    // The model sometimes answers with just the line, no JSON. A short single line is the hook itself.
    const line = String(text).trim().split("\n").filter(Boolean)[0] || "";
    if (line && line.length <= 70 && !/[{}]/.test(line)) return cleanHook(line);
    return ""; // nothing usable this time: counts as a try, not a problem

  }
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

export function describe(item) {
  return [
    `Kind: ${item.kind}${item.videoId ? " (YouTube)" : ""}`,
    item.title && `Current title: ${item.title}`,
    item.author && `Author or channel: ${item.author}`,
    item.url && `URL: ${item.url}`,
    item.fileName && `File name: ${item.fileName}`,
    item.why && `Why they saved it, in their words: ${item.why}`,
    item.note && `Their note about it: ${String(item.note).slice(0, 2000)}`,
    item.kind === "link" && item.text && `Their note about it: ${String(item.text).slice(0, 2000)}`,
    item.replies?.length && `Their later thoughts on it:\n${item.replies.slice(-6).map((r) => `- ${String(r.text).slice(0, 300)}`).join("\n")}`,
    item.summary && `Summary: ${item.summary}`,
    item.kind !== "link" && item.text && `Text:\n${item.text.slice(0, 12000)}`,
    item.pageText && `Text of the page:\n${String(item.pageText).slice(0, 12000)}`,
  ].filter(Boolean);
}

/**
 * Fresh tags for one item, on request. Returns 1-3 tags, reusing the
 * reader's own where they fit.
 */
export async function retag(item, blob, { vocab = [] } = {}) {
  const { parts, item: it } = await contentParts(item, blob);
  parts.push({ type: "text", text: [...describe(it), "", vocabLine(vocab),
    `Tag this item for the person who saved it. Tag it by what it means to them, not only by what it is: ${OWN_WORDS_RULE}.`,
    'Return JSON: {"tags": array of 1-3 lowercase topic words}'].filter(Boolean).join("\n") });
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
    `They finished or read right away:\n${kept}\n\n${booksLine(profile)}They let go:\n${dropped}\n\n` +
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
 * Today's top stories for this person: the biggest stories of the last few
 * days in the areas they care about, from established outlets.
 * Returns [{ title, url, why, tags, minutes }], most prominent first.
 */
export async function discover(profile, { count = 3, known = new Set(), guide = "", vocab = [], blocked = [] } = {}) {
  return claudeDiscover(profile, { count, guide, vocab, blocked });
}

export const STORY_DAYS = 3; // how far back a top story may go
const WHY_STORY = "why: one plain sentence, max 120 chars: what happened and why it matters to them. No hype";

/** Sites that aggregate, host chatter or sell, never the original story. */
export const NOT_NEWS = ["reddit.com", "quora.com", "pinterest.com", "x.com", "twitter.com", "facebook.com",
  "instagram.com", "tiktok.com", "linkedin.com", "news.google.com", "msn.com", "yahoo.com", "amazon.com"];

/** The brief both search engines get: what counts as a top story. */
export function storyBrief(profile, { count = 3, guide = "", vocab = [], now = Date.now() } = {}) {
  const interests = topTags(profile, 8);
  const kept = profile.kept.slice(0, 10).map((i) => `- ${i.title}${tagStr(i)}`).join("\n");
  const dropped = profile.dropped.slice(0, 6).map((i) => `- ${i.title}`).join("\n");
  const today = new Date(now).toDateString();
  return (
    `Today is ${today}. Find the ${count} top stories of the last ${STORY_DAYS} days for this person: ` +
    `the most important, most-covered news in the areas they follow, the way a good front page would lead with it.\n` +
    `- One story each: no two picks about the same event.\n` +
    `- Link the original reporting from an established outlet or the primary source (the company, agency or paper), ` +
    `not an aggregator, a forum or a rewrite.\n` +
    `- Skip opinion columns, listicles, how-to guides, product pages, press-release reposts and anything older than ${STORY_DAYS} days.\n` +
    `- Order by how big the story is, biggest first.\n\n` +
    `Areas they follow, strongest first: ${interests.join(", ") || "(learn from the list below)"}\n` +
    `What they finished recently:\n${kept || "(none)"}\n` + booksLine(profile) +
    `What they let go (avoid these directions):\n${dropped || "(none)"}\n` +
    `${guide ? `What their answers to past suggestions taught:\n${guide}\n` : ""}` +
    `${vocab.length ? `${vocabLine(vocab)}\n` : ""}`
  );
}

function needsHistory(profile) {
  if (!topTags(profile, 1).length && !profile.kept.length && !(profile.books || []).length)
    throw new AiError("Finish or let go of a few items first, so there is something to learn from.");
}

async function claudeDiscover(profile, { count = 3, guide = "", vocab = [], blocked = [] } = {}) {
  needsHistory(profile);
  const prompt = storyBrief(profile, { count, guide, vocab }) +
    `\nSearch, then reply with JSON only: {"picks":[{"title":string,"url":string,"why":string (${WHY_STORY}),"tags":[1-3 lowercase words],"minutes":integer}]}`;
  const data = await call({
    content: prompt,
    maxTokens: 2500,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5, blocked_domains: [...new Set([...NOT_NEWS, ...blocked])].slice(0, 40) }],
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

/** MM/DD/YYYY, the date format Perplexity's search filters take. */
export function pplxDate(ts) {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

/** The web search tool, held to recent news from real outlets. At most 20 domains. */
export function storySearchTool({ blocked = [], now = Date.now() } = {}) {
  const deny = [...new Set([...blocked, ...NOT_NEWS])].slice(0, 20).map((d) => `-${d}`);
  return {
    type: "web_search",
    max_results: 20,
    filters: { search_after_date_filter: pplxDate(now - STORY_DAYS * 86400000), search_domain_filter: deny },
  };
}

async function pplxDiscover(profile, { count = 3, known = new Set(), guide = "", vocab = [], blocked = [] } = {}) {
  needsHistory(profile);
  const input = storyBrief(profile, { count, guide, vocab }) +
    `Already saved (skip): ${[...known].slice(0, 30).join(" ") || "(none)"}\n\n` +
    `For each pick: the headline, the exact URL from your search results, ${WHY_STORY}, ` +
    `1-3 lowercase topic tags, and minutes to read.`;
  const body = {
    preset: PPLX_PRESET,
    instructions: "You are the front-page editor for one person's private news app. Pick the stories that matter most today. Write plainly.",
    input,
    tools: [storySearchTool({ blocked })],
    response_format: { type: "json_schema", json_schema: { name: "picks", schema: PICKS_SCHEMA, strict: true } },
  };
  let data;
  try { data = await pplxAgent(body); } catch (e) {
    // If Perplexity won't take the filtered search with this preset, ask again without the filters.
    if (e.status !== 400 && e.status !== 422) throw e;
    const { tools, ...plain } = body;
    data = await pplxAgent(plain);
  }
  const results = searchResultsOf(data).filter((r) => isRecent(r));
  let picks = [];
  try { picks = parseJson(outputText(data)).picks || []; } catch { /* use the raw results below */ }
  const out = reconcilePicks(picks, results, { count, known });
  if (!out.length) throw new AiError("Perplexity didn't turn up any new top stories. Try again later.");
  return out;
}

/** A result with a known date older than the window is not a top story. */
export function isRecent(r, now = Date.now()) {
  const t = Date.parse(r && (r.date || r.last_updated) || "");
  return !Number.isFinite(t) || now - t <= (STORY_DAYS + 1) * 86400000;
}

function tagStr(i) { return i.tags && i.tags.length ? ` [${i.tags.join(", ")}]` : ""; }
function ageStr(ts) { const d = Math.floor((Date.now() - ts) / 86400000); return d <= 0 ? "today" : `${d}d ago`; }
function capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
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

/* ---- School newsletter ----
 * Not a summary: every piece of the newsletter that matters for one child
 * becomes its own short, catchy post from the school, with its details kept.
 */
export async function schoolPosts({ text, about, school = "", today = new Date(), files = [], named = false }) {
  const docs = (files || []).slice(0, 6);
  const prompt = [
    `Today is ${today.toDateString()}. This is a school newsletter${school ? ` from ${school}` : ""}.`,
    docs.length ? `It came by email with ${docs.length} attachment${docs.length === 1 ? "" : "s"} (${docs.map((f) => f.name).join(", ")}), shown above: read every page and picture of them as part of the newsletter. Flyers, calendars and forms often hold the dates and to-dos.` : null,
    `The parent cares about one child: ${about}`,
    named ? `That child is written ${CHILD_TOKEN}. Whenever a post is about them, refer to them as ${CHILD_TOKEN}, exactly like that with the braces (e.g. "${CHILD_TOKEN}'s band concert is Thursday at 7"), never "your child" and never a made-up name.` : null,
    "",
    "Go through it piece by piece. Keep each piece that matters for that child: their grade, their activities and teams, and whole-school dates, deadlines, closings and requests that affect them.",
    "Leave out other grades, other sports and clubs, staff news, fundraising pitches and general filler.",
    "Leave out anything whose date has already passed.",
    "If it's a calendar covering many weeks or the whole year: keep each date in the next 8 weeks that affects this child (no school, early release, holidays and breaks, report cards, conferences, testing, events for their grade). After that, keep only the big ones: breaks, holidays and the last day of school.",
    "Do not summarise or merge: each kept piece becomes its own post, with its specifics (what, when, where, what to bring or do, who to contact, links) kept.",
    "",
    "Return JSON: {",
    '"school": string (the school\'s short name, e.g. "Myrtle Grove Middle"),',
    '"posts": array of up to 16 {',
    '  "type": "action" | "decision" | "info" (action: the family has to do something, like sign, pay, bring, register or show up; decision: they have a choice to make, like whether to sign up, attend or buy; info: good to know, nothing to do),',
    '  "headline": string (a catchy line a parent would stop scrolling for, max 70 chars; specific, no clickbait, no emoji),',
    '  "body": string (1 to 3 short sentences, max 300 chars, written like a lively school social post: the details of this one piece; at most one exclamation mark; no emoji, no hashtags),',
    '  "date": "YYYY-MM-DD" or null (the day it happens or is due),',
    '  "tags": array of 1-2 lowercase topic words,',
    '  "photo_query": string (2 to 4 concrete words naming a photograph that would suit this post, something a camera could take: e.g. "middle school band concert", "youth lacrosse game", "school bus morning"; no names, no text),',
    '  "source": string (the attachment\'s file name if this piece came from an attachment, else "email")',
    "} in the newsletter's order",
    "}",
    'If nothing in it matters for this child, return {"school": string, "posts": []}.',
    "",
    "Newsletter:",
    String(text || "").slice(0, 30000) || "(no text: everything is in the attachments)",
  ].filter((l) => l !== null).join("\n");
  const content = docs.length
    ? [...docs.map((f) => (f.type === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data }, title: f.name }
        : { type: "image", source: { type: "base64", media_type: f.type, data: f.data } })), { type: "text", text: prompt }]
    : prompt;
  const out = parseJson(textOf(await call({ content, system: ENRICH_SYSTEM, maxTokens: 3500 })));
  const posts = (Array.isArray(out.posts) ? out.posts : []).slice(0, 16).map((p) => ({
    headline: clip(p?.headline, 90),
    body: clip(p?.body, 340),
    date: /^\d{4}-\d{2}-\d{2}$/.test(p?.date || "") ? p.date : null,
    tags: cleanTags(p?.tags),
    query: clip(String(p?.photo_query || "").replace(/["']/g, ""), 60),
    type: ["action", "decision", "info"].includes(p?.type) ? p.type : "info",
    source: p?.source && p.source !== "email" && docs.some((f) => f.name === p.source) ? p.source : "",
  })).filter((p) => p.headline || p.body);
  return { school: clip(out.school, 60), posts };
}

/**
 * Children's names stay on the phone: before anything goes to AI, each name
 * the parent gave is swapped for a stand-in, and put back on the device.
 */
export const CHILD_TOKEN = "{child}";
export function maskNames(text, names = [], stand = "your child") {
  let out = String(text || "");
  for (const n of names.map((x) => String(x || "").trim()).filter((x) => x.length > 1)) {
    out = out.replace(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), stand);
  }
  return out;
}
/** Put the child's name back where the AI wrote {child} (and "{child}'s"); "your child" when no name is set. */
export function nameIn(text, name) {
  const s = String(text || "").replace(/\{child\}/gi, name || "your child");
  return s.replace(/^your child/, "Your child");
}
export function unmaskName(text, name) {
  const s = String(text || "");
  if (!name) return s.replace(/\{child\},?\s*/gi, "").replace(/^./, (c) => c.toUpperCase());
  return s.replace(/\{child\}/gi, name);
}

/**
 * A picture for one school post, and a line that fits what's in it, shown
 * large over the photo. The child is only ever "{child}" here; the app puts
 * the name in. Returns { index, overlay, alt }.
 */
export async function schoolPicture({ headline, body, child, candidates }) {
  const list = (candidates || []).slice(0, 5);
  if (!list.length) return { index: -1, overlay: "", alt: "" };
  const parts = list.map((c) => ({ type: "image", source: { type: "url", url: c.src } }));
  parts.push({ type: "text", text: [
    `These are ${list.length} candidate photos, numbered 0 to ${list.length - 1} in the order shown, for a post from a school to a parent.`,
    `Post headline: ${headline}`, `Post: ${body}`,
    child ? `The parent's child is referred to as ${CHILD_TOKEN}: write it exactly like that, braces included, never a made-up name.` : "The post is for a parent.",
    "Pick the photo that best fits the post: a real photograph of the activity or place. Avoid logos, flyers full of text, clip art and photos where a face is the main subject.",
    child
      ? `Then write the overlay: one short line, max 48 characters, that starts with ${CHILD_TOKEN} and plays on what is visible in the chosen photo as it relates to the post ` +
        `(e.g. for a photo of a lit stage and a concert: "${CHILD_TOKEN}, those lights are yours Thursday"). Warm and specific, no emoji, no hashtags.`
      : `Then write the overlay: one short line, max 48 characters, that plays on what is visible in the chosen photo as it relates to the post ` +
        `(e.g. for a photo of a lit stage and a concert: "Those lights are yours Thursday"). Warm and specific, no emoji, no hashtags.`,
    'Return JSON: {"index": integer (-1 if none fits), "overlay": string, "alt": string (one plain sentence describing the chosen photo, max 140 chars)}',
  ].join("\n") });
  const out = parseJson(textOf(await call({ content: parts, system: ENRICH_SYSTEM, maxTokens: 250 })));
  const index = Number.isInteger(+out.index) && +out.index >= 0 && +out.index < list.length ? +out.index : -1;
  return { index, overlay: index >= 0 ? clip(out.overlay, 60) : "", alt: index >= 0 ? clip(out.alt, 160) : "" };
}

/** Outlook Safe Links and similar wrappers, unwrapped to the real address. */
export function unwrapLink(raw) {
  let s = String(raw || "").trim();
  for (let k = 0; k < 3; k++) {
    let u;
    try { u = new URL(s); } catch { return s; }
    const inner = /safelinks\.protection\.outlook\.com$/i.test(u.hostname) ? u.searchParams.get("url")
      : /^(www\.)?google\.[a-z.]+$/i.test(u.hostname) && u.pathname === "/url" ? u.searchParams.get("q") || u.searchParams.get("url")
      : /urldefense\.com$/i.test(u.hostname) ? (u.pathname.match(/__(https?:\/\/.+?)__/) || [])[1]
      : null;
    if (!inner) return s;
    s = inner;
  }
  return s;
}

/* ---- CPMAI practice ----
 * A few exam-style questions a day for the PMI-CPMAI certification, across
 * the six CPMAI phases and the course's core ideas. Single answer or
 * "choose two"; each with why the answer is right.
 */
/**
 * Study deck: a few practice questions a day on any topic the reader picks.
 * CPMAI keeps its own exam-shaped prompt; anything else gets a general one.
 */
export async function studyQuestions({ topic, count = 3, seed = 0, recent = [] } = {}) {
  const t = clip(String(topic || "").trim(), 80);
  if (!t) return [];
  if (/cpmai/i.test(t)) return cpmaiQuestions({ count, seed, recent });
  const prompt = [
    `Write ${count} multiple-choice practice questions on: ${t}.`,
    "Aim for someone studying it seriously: test understanding and application, not trivia. One best answer each, with plausible wrong options.",
    "Only include facts you are confident are correct and current. Vary the sub-topics.",
    "Make one of them a choose-two question.",
    `Today's variety number is ${seed}; use it to pick different sub-topics than other days.`,
    recent.length ? `Don't repeat these recent questions: ${recent.slice(0, 12).join(" | ")}` : "",
    "",
    'Return JSON: {"questions": [{"topic": string (short), "q": string (max 320 chars), "options": array of 4 or 5 strings (max 140 chars each), "answer": array of the correct option indexes (one, or two for choose-two), "why": string (max 300 chars: why the answer is right)}]}',
  ].filter(Boolean).join("\n");
  const out = parseJson(textOf(await call({ content: prompt, system: "You write accurate practice questions. Reply with JSON only.", maxTokens: 2000 })));
  return cleanQuestions(out, count);
}

function cleanQuestions(out, count) {
  return (out.questions || []).slice(0, count).map((x) => {
    const options = (Array.isArray(x.options) ? x.options : []).slice(0, 5).map((o) => clip(o, 160)).filter(Boolean);
    const answer = (Array.isArray(x.answer) ? x.answer : [x.answer]).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < options.length);
    return { topic: clip(x.topic, 60), q: clip(x.q, 360), options, answer: [...new Set(answer)], why: clip(x.why, 340) };
  }).filter((x) => x.q && x.options.length >= 3 && x.answer.length);
}

/** Exam questions need to be right more than they need to be cheap. */
export const QUIZ_MODEL = "claude-sonnet-5-5";

export const CPMAI_TOPICS = [
  "why AI projects fail and how CPMAI addresses it", "the seven patterns of AI", "AI vs. automation fit", "the five-layer trustworthy AI framework",
  "adapting agile for data-centric projects", "Phase I Business Understanding: AI Go/No-Go (business, data, technology feasibility)",
  "Phase I: ROI timing and the proof-of-concept trap vs. pilot/MVP", "the DIKUW pyramid", "probabilistic vs. deterministic systems",
  "Phase II Data Understanding: data sources, quality, quantity, the four Vs", "Phase III Data Preparation: cleansing, labeling, augmentation, feature engineering",
  "Phase IV Model Development: algorithm and approach selection, pretrained vs. foundation models, transfer learning",
  "Phase V Model Evaluation: metrics, overfitting, bias, explainability", "Phase VI Model Operationalization: deployment, monitoring, model drift, iteration",
  "generative AI risks: hallucination, IP, prompt injection, private-data leakage", "AI team roles: business, data science, data engineering, operationalization",
];

export async function cpmaiQuestions({ count = 3, seed = 0, recent = [] } = {}) {
  const topics = [0, 1, 2].map((k) => CPMAI_TOPICS[(seed * 3 + k * 5) % CPMAI_TOPICS.length]);
  const prompt = [
    `Write ${count} practice questions for the PMI Certified Professional in Managing AI (PMI-CPMAI) exam, in the style of the real exam: scenario-based, one best answer, plausible distractors.`,
    `Cover these topics, one question each: ${topics.join("; ")}.`,
    "Use the CPMAI methodology's own terms and its six phases (Business Understanding, Data Understanding, Data Preparation, Model Development, Model Evaluation, Model Operationalization).",
    "Make one of them a choose-two question.",
    recent.length ? `Don't repeat these recent questions: ${recent.slice(0, 12).join(" | ")}` : "",
    "",
    'Return JSON: {"questions": [{"topic": string (short), "q": string (max 320 chars), "options": array of 4 or 5 strings (max 140 chars each), "answer": array of the correct option indexes (one, or two for choose-two), "why": string (max 300 chars: why the answer is right and the best distractor is wrong)}]}',
  ].filter(Boolean).join("\n");
  const out = parseJson(textOf(await call({ content: prompt, system: "You write accurate certification practice questions. Reply with JSON only.", maxTokens: 2500, model: QUIZ_MODEL })));
  return cleanQuestions(out, count);
}

/**
 * The day's shared top stories for one topic chip ("science"), or local news
 * for a place. Found once a day on the relay for everyone who follows the
 * topic, so it costs nothing extra per person. While someone else's search
 * is running, the relay says to come back; this waits and asks again.
 */
export async function topicStories(topic, { place = "" } = {}, retried = false) {
  if (!settings.consented()) throw new AiError("AI is off. Turn it on in Settings › AI.");
  const base = relayBase();
  if (!safeGet(DEVICE_STORE) || !safeGet(TOKEN_STORE)) await register(base);
  for (let tries = 0; tries < 4; tries++) {
    let res;
    try {
      res = await fetch(`${base}/ai/stories`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-shoebox-device": safeGet(DEVICE_STORE), "x-shoebox-token": safeGet(TOKEN_STORE) },
        body: JSON.stringify({ topic, place }),
      });
    } catch { throw new AiError("Couldn't reach Shoebox's AI. Check your connection.", 0); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data?.error?.code === "register" && !retried) {
      safeSet(DEVICE_STORE, ""); safeSet(TOKEN_STORE, "");
      return topicStories(topic, { place }, true);
    }
    if (res.status === 202) { await new Promise((r) => setTimeout(r, Math.min(30, data.retry || 20) * 1000)); continue; }
    if (!res.ok || data.error) throw new AiError(data?.error?.message || `Top stories failed (${res.status}).`, data.status || res.status);
    return data.picks || [];
  }
  return [];
}

/** This install's AI sign-up headers (empty when it hasn't signed up), for owner-only relay calls. */
export function ownerHeaders() {
  const d = safeGet(DEVICE_STORE), t = safeGet(TOKEN_STORE);
  return d && t ? { "x-shoebox-device": d, "x-shoebox-token": t } : {};
}

/** Live cameras near a place, found by AI on the relay once a week per town and checked before they're offered. */
export async function findCams(place, retried = false) {
  if (!settings.consented()) throw new AiError("This uses AI. Turn it on in Settings › AI.");
  const base = relayBase();
  if (!safeGet(DEVICE_STORE) || !safeGet(TOKEN_STORE)) await register(base);
  for (let tries = 0; tries < 5; tries++) {
    let res;
    try {
      res = await fetch(`${base}/ai/cams`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-shoebox-device": safeGet(DEVICE_STORE), "x-shoebox-token": safeGet(TOKEN_STORE) },
        body: JSON.stringify({ place }),
      });
    } catch { throw new AiError("Couldn't reach Shoebox's AI. Check your connection.", 0); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data?.error?.code === "register" && !retried) { safeSet(DEVICE_STORE, ""); safeSet(TOKEN_STORE, ""); return findCams(place, true); }
    if (res.status === 202) { await new Promise((r) => setTimeout(r, Math.min(30, data.retry || 20) * 1000)); continue; }
    if (!res.ok || data.error) throw new AiError(data?.error?.message || `Camera search failed (${res.status}).`, data.status || res.status);
    return data.cams || [];
  }
  return [];
}
