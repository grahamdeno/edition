/*
 * Edition model. Pure functions only: no DOM, no storage, no network.
 * Everything that decides what an item is, what a verdict does, and what
 * goes into today's edition lives here so it can be tested in Node.
 */

export const VERDICT = Object.freeze({
  LET_GO: "let-go",
  LATER: "later",
  DONE: "done",
  READ_NOW: "read-now",
});

export const STATUS = Object.freeze({
  INBOX: "inbox",       // captured, waiting for triage
  QUEUED: "queued",     // kept for later; eligible for an edition
  DONE: "done",
  ARCHIVED: "archived", // let go, or washed out after too many deferrals
});

export const KIND = Object.freeze({
  LINK: "link",
  NOTE: "note",
  QUOTE: "quote", // a line worth keeping, with who said it
  PHOTO: "photo",
  PDF: "pdf",
  TEXT: "text",   // a plain-text or markdown file
  VIDEO: "video",
  AUDIO: "audio",
  FILE: "file",   // anything else: docx, pages, keynote, zip...
});

export const EDITION_SIZE = 6;
export const MAX_SKIPS = 8;          // deferrals in an edition before an item fades
export const FADE_DAYS = 21;         // untouched this long, an item fades and waits for a verdict
export const MAX_SUGGESTIONS = 1;    // AI-discovered items allowed per edition

const DAY = 86400000;
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/i;

/** Local calendar day, so the edition turns over at the reader's midnight. */
export function dayKey(now = Date.now()) {
  const d = new Date(now);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** First URL in a string, with trailing punctuation trimmed. */
export function findUrl(text) {
  const m = String(text || "").match(URL_RE);
  return m ? m[0].replace(/[).,;:!?\]]+$/, "") : "";
}

/** Kind of a file from its MIME type and name. */
export function kindOfFile(mime = "", name = "") {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (mime.startsWith("image/") || ["heic", "heif", "jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return KIND.PHOTO;
  if (mime === "application/pdf" || ext === "pdf") return KIND.PDF;
  if (mime.startsWith("video/")) return KIND.VIDEO;
  if (mime.startsWith("audio/")) return KIND.AUDIO;
  if (mime.startsWith("text/") || ["txt", "md", "markdown", "csv", "json"].includes(ext)) return KIND.TEXT;
  return KIND.FILE;
}

const YT_RE = /(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i;
const IMAGE_URL_RE = /\.(?:jpe?g|png|gif|webp|avif|heic)(?:[?#].*)?$/i;
const VIDEO_URL_RE = /\.(?:mp4|mov|m4v|webm)(?:[?#].*)?$/i;
const QUOTE_MARKS = "\"'\u201C\u201D\u2018\u2019\u00AB\u00BB";

/** YouTube video id from any of its URL shapes, or "". */
export function youtubeId(url) {
  const m = String(url || "").match(YT_RE);
  return m ? m[1] : "";
}

/** Still image for a YouTube video; needs no API key. */
export function youtubeThumb(id) {
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : "";
}

/** Draft for a single URL: YouTube becomes video, image URLs become photos, the rest are links. */
export function draftFromUrl(url, note = "") {
  const yt = youtubeId(url);
  if (yt) {
    return { kind: KIND.VIDEO, url, videoId: yt, imageUrl: youtubeThumb(yt), title: note || "YouTube video", text: note || undefined };
  }
  if (IMAGE_URL_RE.test(url)) return { kind: KIND.PHOTO, url, imageUrl: url, title: note || titleFromUrl(url), text: note || undefined };
  if (VIDEO_URL_RE.test(url)) return { kind: KIND.VIDEO, url, title: note || titleFromUrl(url), text: note || undefined };
  return { kind: KIND.LINK, url, title: note || titleFromUrl(url), text: note || undefined };
}

/**
 * A quote: wrapped in quote marks, or a short passage ending in an
 * attribution ("... - Seneca", or the name alone on the last line).
 * Returns { text, author } or null.
 */
export function parseQuote(raw) {
  const text = String(raw || "").trim();
  if (!text || text.length > 600 || findUrl(text)) return null;
  const q = `[${QUOTE_MARKS}]`;
  const wrapped = text.match(new RegExp(`^${q}([\\s\\S]+?)${q}[\\s,]*(?:(?:[-\u2013\u2014~]+|\\n)\\s*(.+))?$`));
  if (wrapped) {
    const author = cleanAuthor(wrapped[2]);
    if (wrapped[2] && !author) return null;
    return { text: wrapped[1].trim(), author };
  }
  const dashed = text.match(/^([\s\S]{12,}?)(\s*\n\s*|\s*)([-\u2013\u2014~]{1,2})\s*([^\n]{2,60})$/);
  if (dashed) {
    const body = dashed[1].trim();
    // A plain hyphen after a sentence fragment is usually a to-do ("call Sam - Tuesday"),
    // so it needs a finished sentence; an em dash, en dash or line break is enough on its own.
    const strong = /\n/.test(dashed[2]) || dashed[3] !== "-";
    const sentence = /[.!?\u201D"']$/.test(body) && body.split(/\s+/).length >= 4;
    const author = cleanAuthor(dashed[4]);
    if (author && (strong || sentence)) return { text: stripQuotes(body), author };
  }
  return null;
}

const NOT_AUTHORS = /^(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?|today|tomorrow|tonight|jan(?:uary)?|feb(?:ruary)?|march|mar|april|apr|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|asap|eod|tbd)\b/i;

function cleanAuthor(s) {
  const a = String(s || "").trim().replace(/[.;]+$/, "");
  if (!a) return "";
  const words = a.split(/\s+/);
  // A name or a short source, capitalized, not a sentence.
  if (words.length > 7 || !/^[A-Z\u00C0-\u024F]/.test(a)) return "";
  if (NOT_AUTHORS.test(a)) return "";
  return a;
}
function stripQuotes(s) {
  return s.trim().replace(new RegExp(`^[${QUOTE_MARKS}]+|[${QUOTE_MARKS}]+$`, "g"), "").trim();
}

/**
 * Work out what was dropped in, so the person never has to say. One paste
 * can hold several things: a list of links becomes one item per link.
 * Returns an array of drafts (empty when there is nothing).
 */
export function detectText(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const urls = text.match(new RegExp(URL_RE.source, "gi")) || [];
  // Only links, one per line or separated by spaces: one item each.
  if (urls.length > 1) {
    const leftover = urls.reduce((t, u) => t.replace(u, ""), text).replace(/[\s,;\-\u2022*]+/g, "");
    if (!leftover) return urls.map((u) => draftFromUrl(u.replace(/[).,;:!?\]]+$/, "")));
  }
  const url = findUrl(text);
  const rest = url ? text.replace(url, "").trim() : text;
  if (url && rest.length < 40) return [draftFromUrl(url, rest)];
  const quote = parseQuote(text);
  if (quote) {
    return [{ kind: KIND.QUOTE, text: quote.text, author: quote.author || undefined, title: firstLine(quote.text) }];
  }
  return [{ kind: KIND.NOTE, text, url: url || undefined, title: firstLine(text) }];
}

/** First draft of `detectText`; kept for callers that expect one item. */
export function draftFromText(raw) {
  return detectText(raw)[0] || null;
}

/** A short plain description of what the app thinks something is, for the capture screen. */
export function describeDraft(d) {
  if (!d) return "";
  switch (d.kind) {
    case KIND.VIDEO: return d.videoId ? "YouTube video" : "Video link";
    case KIND.PHOTO: return d.imageUrl && !d.blobId && d.url ? "Image link" : "Photo";
    case KIND.LINK: return `Link · ${hostOf(d.url)}`;
    case KIND.QUOTE: return d.author ? `Quote · ${d.author}` : "Quote";
    case KIND.NOTE: {
      const words = (d.text || "").split(/\s+/).filter(Boolean).length;
      return `Note · ${words} word${words === 1 ? "" : "s"}`;
    }
    case KIND.PDF: return "PDF";
    case KIND.TEXT: return "Text file";
    case KIND.AUDIO: return "Audio";
    default: return "File";
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

export function draftFromFile({ name = "", type = "", size = 0 }) {
  return {
    kind: kindOfFile(type, name),
    fileName: name || undefined,
    mime: type || undefined,
    size,
    title: stripExt(name) || "Untitled file",
  };
}

export function titleFromUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const slug = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "")
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[-_+]+/g, " ")
      .trim();
    return slug && !/^\d+$/.test(slug) ? capitalize(slug) : host;
  } catch {
    return url;
  }
}

function firstLine(text) {
  const line = text.split(/\n/)[0].trim();
  return line.length > 90 ? line.slice(0, 87).trimEnd() + "…" : line;
}
function stripExt(name) {
  return String(name).replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[-_]+/g, " ").trim();
}
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Rough reading time when the AI has not estimated one. */
export function estimateMinutes(item) {
  if (item.minutes) return item.minutes;
  switch (item.kind) {
    case KIND.NOTE: return Math.max(1, Math.round((item.text || "").split(/\s+/).length / 220));
    case KIND.QUOTE: return 1;
    case KIND.PHOTO: return 1;
    case KIND.LINK: return 6;
    case KIND.PDF: return 15;
    case KIND.VIDEO: return 10;
    default: return 5;
  }
}

export function createItem(draft, { id, now = Date.now(), source = "drop" } = {}) {
  return {
    id,
    kind: draft.kind,
    title: (draft.title || "Untitled").slice(0, 140),
    text: draft.text,
    url: draft.url,
    author: draft.author,
    videoId: draft.videoId,
    imageUrl: draft.imageUrl,
    points: draft.points,
    fileName: draft.fileName,
    mime: draft.mime,
    size: draft.size,
    blobId: draft.blobId,
    summary: draft.summary || "",
    why: draft.why || "",           // the reader's own reason, in their words
    tags: draft.tags || [],
    minutes: draft.minutes,
    source,
    suggested: source === "ai",
    status: STATUS.INBOX,
    created: now,
    skips: 0,
    history: [],
    ai: null,
  };
}

/**
 * Apply a verdict. `stage` is where it was given: the inbox (first triage)
 * or the edition (a resurfaced item). Later means different things in each:
 * in the inbox it keeps the item; in an edition it defers it, and deferring
 * too often lets it wash out.
 */
export function applyVerdict(item, verdict, { stage = "inbox", now = Date.now() } = {}) {
  const next = { ...item, history: [...(item.history || []), { v: verdict, at: now, stage }] };
  switch (verdict) {
    case VERDICT.LET_GO:
      next.status = STATUS.ARCHIVED;
      next.archivedAt = now;
      break;
    case VERDICT.DONE:
      next.status = STATUS.DONE;
      next.doneAt = now;
      break;
    case VERDICT.READ_NOW:
      next.status = STATUS.DONE;
      next.doneAt = now;
      next.readNow = true;
      break;
    case VERDICT.LATER:
      if (stage === "inbox") {
        next.status = STATUS.QUEUED;
        next.queuedAt = now;
      } else {
        next.skips = (item.skips || 0) + 1;
        next.deferredAt = now;
        // Deferred too often: it fades and waits for your verdict. Nothing is let go automatically.
        if (next.skips >= MAX_SKIPS) next.fadedAt = now;
      }
      break;
    default:
      throw new Error(`Unknown verdict: ${verdict}`);
  }
  return next;
}

/** Put a let-go or done item back in the queue. */
export function restore(item, now = Date.now()) {
  const next = { ...item, status: STATUS.QUEUED, skips: 0, washedOut: false, queuedAt: now };
  delete next.fadedAt;
  delete next.deferredAt;
  return next;
}

/** The last time you gave this item any attention: saved, kept, deferred or restored. */
export function touchedAt(item) {
  return Math.max(item.queuedAt || 0, item.deferredAt || 0, item.created || 0);
}

/** A queued item fades after FADE_DAYS untouched, or after MAX_SKIPS deferrals. It stays until you decide. */
export function isFaded(item, now = Date.now()) {
  if (item.status !== STATUS.QUEUED) return false;
  return Boolean(item.fadedAt) || now - touchedAt(item) >= FADE_DAYS * DAY;
}

/**
 * What the reader's own verdicts say they like. Tags and kinds of things
 * they finished count up; things they let go count down. This is the
 * learning signal used locally and handed to the AI for ranking.
 */
export function interestProfile(items) {
  const tags = {};
  const kinds = {};
  const bump = (map, key, by) => { if (key) map[key] = (map[key] || 0) + by; };
  for (const it of items) {
    let w = 0;
    if (it.status === STATUS.DONE) w = it.readNow ? 1.5 : 1;
    else if (it.status === STATUS.ARCHIVED && !it.washedOut) w = -1;
    else if (it.status === STATUS.ARCHIVED && it.washedOut) w = -0.5;
    if (!w) continue;
    for (const t of it.tags || []) bump(tags, t.toLowerCase(), w);
    bump(kinds, it.kind, w);
  }
  const kept = items.filter((i) => i.status === STATUS.DONE).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  const dropped = items.filter((i) => i.status === STATUS.ARCHIVED).sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
  return { tags, kinds, kept, dropped };
}

export function topTags(profile, n = 8) {
  return Object.entries(profile.tags)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([t]) => t);
}

/**
 * Local score, 0..1. Older and more-deferred items rise (the things you
 * keep avoiding are worth a verdict); tags you tend to finish rise too.
 */
export function localScore(item, profile, now = Date.now()) {
  const ageDays = Math.max(0, (now - (item.queuedAt || item.created)) / DAY);
  const age = Math.min(1, ageDays / 21);
  const skip = Math.min(1, (item.skips || 0) / 4);
  const tagSum = (item.tags || []).reduce((s, t) => s + (profile.tags[t.toLowerCase()] || 0), 0);
  const affinity = 0.5 + Math.max(-0.5, Math.min(0.5, (tagSum + (profile.kinds[item.kind] || 0) * 0.3) / 6));
  return 0.35 * age + 0.25 * skip + 0.4 * affinity;
}

/** Blend the AI's 0..100 score with the local score when one exists. */
export function score(item, profile, now = Date.now()) {
  const local = localScore(item, profile, now);
  const ai = item.ai && typeof item.ai.score === "number" ? item.ai.score / 100 : null;
  return ai === null ? local : 0.6 * ai + 0.4 * local;
}

/**
 * Today's edition: a fixed, finite set chosen once per day so it does not
 * reshuffle while you read it. Returns { date, ids }.
 */
export function buildEdition(items, previous, { now = Date.now(), size = EDITION_SIZE } = {}) {
  const today = dayKey(now);
  if (previous && previous.date === today && previous.ids && previous.ids.length) return previous;
  const profile = interestProfile(items);
  // Faded items wait in the Tideline for a verdict; they don't come back on their own.
  const queued = items.filter((i) => i.status === STATUS.QUEUED && !isFaded(i, now));
  const ranked = queued
    .map((i) => ({ i, s: score(i, profile, now) }))
    .sort((a, b) => b.s - a.s || a.i.created - b.i.created);
  const picked = [];
  let suggestions = 0;
  for (const { i } of ranked) {
    if (picked.length >= size) break;
    if (i.suggested) {
      if (suggestions >= MAX_SUGGESTIONS) continue;
      suggestions++;
    }
    picked.push(i.id);
  }
  return { date: today, ids: picked };
}

/** Pages of today's edition, in order, with progress. */
export function editionView(items, edition) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const pages = (edition?.ids || []).map((id) => byId.get(id)).filter(Boolean);
  const open = pages.filter((p) => p.status === STATUS.QUEUED && !deferredToday(p, edition.date));
  const settled = pages.length - open.length;
  return { pages, open, settled, total: pages.length };
}

function deferredToday(item, date) {
  return item.deferredAt ? dayKey(item.deferredAt) === date : false;
}

export function counts(items) {
  const c = { inbox: 0, queued: 0, done: 0, archived: 0 };
  for (const i of items) c[i.status] = (c[i.status] || 0) + 1;
  return c;
}

/** Convert an item from the first localStorage version of the app. */
export function migrateLegacy(old) {
  const kindMap = { link: KIND.LINK, article: KIND.LINK, video: KIND.VIDEO, doc: KIND.FILE, thought: KIND.NOTE, note: KIND.NOTE, photo: KIND.PHOTO };
  const statusMap = { active: STATUS.QUEUED, done: STATUS.DONE, archived: STATUS.ARCHIVED };
  return {
    id: "legacy-" + old.id,
    kind: kindMap[old.type] || (old.url ? KIND.LINK : KIND.NOTE),
    title: old.title || "Untitled",
    text: old.text,
    url: old.url,
    fileName: old.fileName,
    mime: old.mime,
    summary: old.summary || "",
    tags: old.tags || [],
    minutes: old.minutes,
    source: "legacy",
    suggested: false,
    status: statusMap[old.status] || STATUS.QUEUED,
    created: old.created || Date.now(),
    queuedAt: old.created,
    doneAt: old.doneAt,
    skips: old.skips || 0,
    history: [],
    ai: null,
  };
}

/*
 * Front-page helpers: what fits the time you have (Shelf), the themes you keep
 * coming back to (Constellation), and the queue items that have waited longest
 * (Tideline). All pure, so they are tested with the rest of the model.
 */

/** Pages, in order, that fit within `minutes`. Skips any page too long to fit. */
export function fitToTime(pages, minutes) {
  if (!minutes) return pages;
  const out = [];
  let used = 0;
  for (const p of pages) {
    const m = estimateMinutes(p);
    if (used + m <= minutes) { out.push(p); used += m; }
  }
  return out;
}

/**
 * Themes you keep circling: tags across your queue and recent saves, weighted
 * up by what you finish. Returns [{ tag, count, rising }] largest first.
 */
export function circling(items, { now = Date.now(), limit = 5 } = {}) {
  const counts = new Map();
  const recent = new Map();
  for (const i of items) {
    if (i.status === STATUS.ARCHIVED) continue;
    const w = i.status === STATUS.DONE ? 1.5 : 1;
    for (const raw of i.tags || []) {
      const t = String(raw).toLowerCase();
      counts.set(t, (counts.get(t) || 0) + w);
      if (now - (i.created || 0) < 14 * DAY) recent.set(t, (recent.get(t) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag, c]) => ({ tag, count: Math.round(c), rising: (recent.get(tag) || 0) >= 2 }));
}

/**
 * The Tideline: queue items outside today's edition, by how close they are to
 * fading. Faded ones come first and wait for a verdict; then those with a week
 * or less left. Returns [{ item, days, left, faded }].
 */
export function fading(items, edition, { now = Date.now(), limit = 5, within = 7 } = {}) {
  const inEdition = new Set(edition?.ids || []);
  return items
    .filter((i) => i.status === STATUS.QUEUED && !inEdition.has(i.id))
    .map((i) => {
      const days = Math.floor((now - touchedAt(i)) / DAY);
      const faded = isFaded(i, now);
      return { item: i, days, left: faded ? 0 : Math.max(0, FADE_DAYS - days), faded };
    })
    .filter((e) => e.faded || e.left <= within)
    .sort((a, b) => Number(b.faded) - Number(a.faded) || a.left - b.left || b.days - a.days)
    .slice(0, limit);
}
