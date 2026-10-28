/*
 * Shoebox model (formerly Edition). Pure functions only: no DOM, no storage, no network.
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
  ASIDE: "aside",       // set aside until a date; comes back as new that morning
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
    // Suggestions: a yes counts more; a no is handled by the suggestion profile, not here.
    if (it.suggested && it.status === STATUS.ARCHIVED) continue;
    if (it.status === STATUS.DONE) w = it.readNow || it.suggested ? 1.5 : 1;
    else if (it.status === STATUS.ARCHIVED && !it.washedOut) w = -1;
    else if (it.status === STATUS.ARCHIVED && it.washedOut) w = -0.5;
    // Loving something counts toward what you like, whatever its verdict.
    if (it.loved && !(it.suggested && it.status === STATUS.ARCHIVED)) w += 0.5;
    if (!w) continue;
    for (const t of it.tags || []) bump(tags, t.toLowerCase(), w);
    bump(kinds, it.kind, w);
  }
  // A book marked done means "I've read it", not "I read it today": books are listed apart, with no date implied.
  const kept = items.filter((i) => i.status === STATUS.DONE && !i.book).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  const books = items.filter((i) => i.status === STATUS.DONE && i.book).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  const dropped = items.filter((i) => i.status === STATUS.ARCHIVED).sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
  return { tags, kinds, kept, dropped, books };
}

/**
 * What top stories learn from: your own saves, not school newsletter posts.
 * Finishing a school post means you read the notice, not that you want more
 * reading like it.
 */
export function discoveryItems(items) {
  return items.filter((i) => !i.school);
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
  // School posts have their own place on Today and never take one of the six.
  const queued = items.filter((i) => i.status === STATUS.QUEUED && !i.school && !isFaded(i, now));
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
    .filter((i) => i.status === STATUS.QUEUED && !i.school && !inEdition.has(i.id))
    .map((i) => {
      const days = Math.floor((now - touchedAt(i)) / DAY);
      const faded = isFaded(i, now);
      return { item: i, days, left: faded ? 0 : Math.max(0, FADE_DAYS - days), faded };
    })
    .filter((e) => e.faded || e.left <= within)
    .sort((a, b) => Number(b.faded) - Number(a.faded) || a.left - b.left || b.days - a.days)
    .slice(0, limit);
}

/* ---- Suggestions: what the AI suggests, and what your answers teach it ----
 * A suggestion is an item Find something new brought in (suggested: true).
 * Your verdicts on suggestions train a separate, durable suggestion profile,
 * so "not for me" on an AI pick never pulls down your own saves.
 */

export const SUGGESTIONS_PER_DAY = 2;
export const WHY_NOT = Object.freeze({
  TOPIC: "topic",   // Not my topic: lower these topics for suggestions
  KNOWN: "known",   // Already know this: no penalty; go deeper next time
  LONG: "long",     // Too long: lean to shorter pieces
  SITE: "site",     // Don't trust this site: never suggest from it again
});
export const WHY_NOT_LABEL = {
  topic: "Not my topic", known: "Already know this", long: "Too long", site: "Don't trust this site",
};

export function emptySuggestProfile() {
  return { topics: {}, deeper: {}, blocked: [], shorter: 0, updatedAt: 0 };
}

/**
 * Fold one verdict on a suggestion into the profile. Keep and Done count more
 * than they would on your own saves: a yes to something you didn't pick is a
 * strong signal. A plain Let go with no reason is a mild no on its topics.
 */
export function learnFromSuggestion(profile, item, verdict, whyNot = null, now = Date.now()) {
  const p = {
    ...emptySuggestProfile(), ...profile,
    topics: { ...(profile?.topics || {}) }, deeper: { ...(profile?.deeper || {}) }, blocked: [...(profile?.blocked || [])],
  };
  const tags = (item.tags || []).map((t) => String(t).toLowerCase()).filter(Boolean);
  const bump = (map, by) => tags.forEach((t) => { map[t] = Math.round(((map[t] || 0) + by) * 10) / 10; if (map[t] === 0) delete map[t]; });
  if (verdict === VERDICT.DONE || verdict === VERDICT.READ_NOW) bump(p.topics, 1.5);
  else if (verdict === VERDICT.LATER) bump(p.topics, 1);
  else if (verdict === VERDICT.LET_GO) {
    if (whyNot === WHY_NOT.TOPIC) bump(p.topics, -1.5);
    else if (whyNot === WHY_NOT.KNOWN) bump(p.deeper, 1);
    else if (whyNot === WHY_NOT.LONG) p.shorter = Math.min(5, (p.shorter || 0) + 1);
    else if (whyNot === WHY_NOT.SITE) { const h = hostOf(item.url); if (h && !p.blocked.includes(h)) p.blocked.push(h); }
    else bump(p.topics, -0.5);
  }
  p.updatedAt = now;
  return p;
}

/** The longest piece worth suggesting, in minutes (null: no limit yet). */
export function suggestMaxMinutes(profile) {
  const s = profile?.shorter || 0;
  return s <= 0 ? null : Math.max(5, 30 - s * 5);
}

/** The profile as instructions for whoever does the searching. */
export function suggestionGuide(profile) {
  const p = { ...emptySuggestProfile(), ...profile };
  const sorted = (map, sign) => Object.entries(map).filter(([, v]) => sign * v > 0).sort((a, b) => sign * (b[1] - a[1])).map(([t]) => t);
  const welcome = sorted(p.topics, 1).slice(0, 8), avoid = sorted(p.topics, -1).slice(0, 10), deeper = sorted(p.deeper, 1).slice(0, 6);
  const max = suggestMaxMinutes(p);
  return [
    welcome.length && `Topics they welcomed from past suggestions: ${welcome.join(", ")}.`,
    avoid.length && `Topics they turned down; avoid them: ${avoid.join(", ")}.`,
    deeper.length && `They already know the basics of: ${deeper.join(", ")}. Only suggest advanced or unusual pieces on these.`,
    max && `Keep it short: nothing over about ${max} minutes to read or watch.`,
    p.blocked.length && `Never suggest anything from: ${p.blocked.join(", ")}.`,
  ].filter(Boolean).join("\n");
}

/** Drop picks from blocked sites and, with a length limit, ones clearly too long. */
export function screenSuggestions(picks, profile) {
  const blocked = new Set(profile?.blocked || []);
  const max = suggestMaxMinutes(profile);
  return picks.filter((p) => !blocked.has(hostOf(p.url)) && !(max && p.minutes && p.minutes > max * 1.5));
}

/* ---- Tags: one vocabulary, kept tidy ----
 * Tags are what Shoebox learns from, so "agile" and "agile methods" counting
 * as two interests dilutes everything. The AI is shown the tags already in
 * use and reuses them; renames and merges made in Settings are kept as
 * aliases, so a merged tag never comes back; a deleted tag maps to "".
 */

export const MAX_TAGS = 6;

/** One tag, cleaned: lowercase, no #, single spaces, at most 32 characters. */
export function normTag(t) {
  return String(t ?? "").toLowerCase().trim().replace(/^#+/, "").replace(/[\s_]+/g, " ").trim().slice(0, 32).trim();
}

/** Follow aliases to the tag in use now ("" means deleted). Stops on a loop. */
export function resolveTag(tag, aliases = {}) {
  let t = normTag(tag);
  const seen = new Set();
  while (aliases && Object.prototype.hasOwnProperty.call(aliases, t) && !seen.has(t)) {
    seen.add(t);
    t = normTag(aliases[t]);
    if (!t) return "";
  }
  return t;
}

/** Clean, resolve and de-duplicate a list of tags. */
export function canonTags(tags, aliases = {}, max = MAX_TAGS) {
  const out = [];
  for (const raw of tags || []) {
    const t = resolveTag(raw, aliases);
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, max);
}

/** Tags in use, most used first: the vocabulary the AI is asked to reuse. */
export function tagVocab(items, n = 40) {
  const c = new Map();
  for (const i of items) for (const raw of i.tags || []) {
    const t = normTag(raw);
    if (t) c.set(t, (c.get(t) || 0) + 1);
  }
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([t]) => t);
}

/**
 * Every tag with how many items carry it and what your verdicts say about it
 * (the same score ranking uses). Returns [{ tag, count, score }] most used first.
 */
export function tagStats(items) {
  const profile = interestProfile(items);
  const c = new Map();
  for (const i of items) for (const raw of i.tags || []) {
    const t = normTag(raw);
    if (t) c.set(t, (c.get(t) || 0) + 1);
  }
  return [...c.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count, score: Math.round((profile.tags[tag] || 0) * 10) / 10 }));
}

/**
 * Rename `from` to `to` on every item (a merge when `to` is already in use),
 * or remove it when `to` is "". Returns only the items that changed.
 */
export function renameTag(items, from, to) {
  const f = normTag(from), t = normTag(to);
  if (!f || f === t) return [];
  const out = [];
  for (const i of items) {
    const tags = (i.tags || []).map(normTag);
    if (!tags.includes(f)) continue;
    const next = [];
    for (const x of tags.map((x) => (x === f ? t : x))) if (x && !next.includes(x)) next.push(x);
    out.push({ ...i, tags: next });
  }
  return out;
}

/** Record a rename or delete so future AI tags follow it. Returns new aliases. */
export function addAlias(aliases, from, to) {
  const f = normTag(from), t = normTag(to);
  const next = { ...(aliases || {}) };
  if (!f || f === t) return next;
  delete next[t]; // the target is a tag in use again
  for (const k of Object.keys(next)) if (normTag(next[k]) === f) next[k] = t; // earlier merges into `from` follow it
  next[f] = t;
  return next;
}

/** A tag you type yourself is wanted: drop any alias that would delete or move it. */
export function releaseTags(aliases, tags) {
  const next = { ...(aliases || {}) };
  for (const t of tags || []) delete next[normTag(t)];
  return next;
}

/** Carry what suggestions learned about a tag over to its new name (or drop it). */
export function renameInSuggestProfile(profile, from, to) {
  const f = normTag(from), t = normTag(to);
  const p = { ...emptySuggestProfile(), ...profile, topics: { ...(profile?.topics || {}) }, deeper: { ...(profile?.deeper || {}) } };
  for (const key of ["topics", "deeper"]) {
    const map = p[key];
    if (!(f in map)) continue;
    if (t) map[t] = Math.round(((map[t] || 0) + map[f]) * 10) / 10;
    delete map[f];
    if (t && map[t] === 0) delete map[t];
  }
  return p;
}

/**
 * Tags from your own vocabulary that appear in some text, as whole words.
 * Used when a suggestion arrives untagged and there's no Anthropic key to ask.
 */
export function localTags(text, vocab, max = 3) {
  const s = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9+#.\- ]+/g, " ")} `;
  const out = [];
  for (const t of vocab || []) {
    if (out.length >= max) break;
    const words = normTag(t).replace(/[^a-z0-9+#.\- ]+/g, " ").trim();
    if (words && s.includes(` ${words} `) && !out.includes(normTag(t))) out.push(normTag(t));
  }
  return out;
}

/* ---- Books ----
 * A photo of a book is a book you want to read. Marking it done means you
 * have read it, at some point; not necessarily recently.
 */
export const BOOK_SITTING_MINUTES = 30; // what a book "costs" in an edition: one sitting

/** "Title by Author", or just the title. */
export function bookLabel(book) {
  if (!book || !book.title) return "";
  return book.author ? `${book.title} by ${book.author}` : book.title;
}

/** Turn a photo into a book: its title, author and a sitting's worth of time. Keeps edits you made. */
export function asBook(item, book) {
  const b = { title: String(book.title || "").trim().slice(0, 140), author: String(book.author || "").trim().slice(0, 80) || undefined };
  if (!b.title) return item;
  return {
    ...item,
    book: b,
    title: item.editedAt ? item.title : b.title,
    author: item.editedAt && item.author ? item.author : b.author,
    intent: "read",
    minutes: BOOK_SITTING_MINUTES,
  };
}

/* ---- Timeline helpers ---- */

/**
 * When something was saved, the way a person would say it: "just now",
 * "this morning", "yesterday", "Tuesday", "last Tuesday", "3 weeks ago",
 * "in March", "last year". Local time.
 */
export function friendlyWhen(ts, now = Date.now()) {
  if (!ts) return "a while ago";
  const t = new Date(ts), n = new Date(now);
  const mins = Math.floor((now - ts) / 60000);
  if (mins < 2) return "just now";
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(n) - startOf(t)) / DAY);
  const hour = t.getHours();
  const part = hour < 5 ? "last night" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const wd = t.toLocaleDateString("en-US", { weekday: "long" });
  if (days <= 0) {
    if (mins < 60) return `${mins} minutes ago`;
    return part === "last night" ? "early this morning" : part === "evening" ? "this evening" : `this ${part}`;
  }
  if (days === 1) return part === "evening" || part === "last night" ? "last night" : `yesterday ${part}`;
  if (days < 7) return `${wd} ${part === "last night" ? "night" : part}`;
  if (days < 14) return `last ${wd}`;
  if (days < 35) return `${Math.floor(days / 7)} weeks ago`;
  const month = t.toLocaleDateString("en-US", { month: "long" });
  if (t.getFullYear() === n.getFullYear()) return `in ${month}`;
  if (t.getFullYear() === n.getFullYear() - 1) return `last ${month}`;
  return `in ${month} ${t.getFullYear()}`;
}

/**
 * Is a picture worth showing on a post? Wide enough to fill a phone's width
 * without looking soft, and not a banner strip or a skyscraper ad.
 */
export function usablePicture({ w, h } = {}, { minWidth = 600 } = {}) {
  if (!w || !h) return false;
  const ratio = w / h;
  return w >= minWidth && h >= 300 && ratio >= 0.5 && ratio <= 2.4;
}


/* ---- Set aside until a date ----
 * An item set aside is out of sight: not new, not in the queue, not in
 * Today. On its date it comes back as new, at the top of Today.
 */

/** Local midnight of the day a timestamp falls on. */
export function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }

/** "2026-11-03" from a date field, as local midnight; null when empty or invalid. */
export function fromDateInput(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ""));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** Local midnight as "2026-11-03", for a date field. */
export function toDateInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Quick choices: tomorrow, the weekend, next week, next month. Never today or a duplicate day. */
export function asideChoices(now = Date.now()) {
  const day = startOfDay(now), d = new Date(day), dow = d.getDay();
  const at = (n) => { const x = new Date(day); x.setDate(x.getDate() + n); return x.getTime(); };
  const sat = (6 - dow + 7) % 7 || 7, mon = (8 - dow) % 7 || 7;
  const month = new Date(day); month.setMonth(month.getMonth() + 1);
  const list = [
    { label: "Tomorrow", until: at(1) },
    { label: dow === 6 ? "Next weekend" : "This weekend", until: at(sat) },
    { label: "Next week", until: at(mon) },
    { label: "In a month", until: month.getTime() },
  ];
  const seen = new Set();
  return list.filter((c) => !seen.has(c.until) && seen.add(c.until));
}

export function setAside(item, until, now = Date.now()) {
  const next = { ...item, status: STATUS.ASIDE, until: startOfDay(until), asideAt: now, asideFrom: item.status === STATUS.ASIDE ? item.asideFrom : item.status };
  next.history = [...(item.history || []), { v: "aside", at: now, until: next.until }];
  delete next.deferredAt;
  delete next.fadedAt;
  return next;
}

/** Items whose day has come, back as new. Returns only the ones that changed. */
export function wakeAside(items, now = Date.now()) {
  return items.filter((i) => i.status === STATUS.ASIDE && (i.until || 0) <= now).map((i) => {
    const next = { ...i, status: STATUS.INBOX, backAt: i.until || now };
    delete next.until;
    return next;
  });
}

/** Bring a set-aside item back now, as new. */
export function bringBackNow(item, now = Date.now()) {
  const next = { ...item, status: STATUS.INBOX, backAt: now };
  delete next.until;
  return next;
}

/** "Tue, Nov 3" (with the year when it isn't this year). */
export function shortDate(ts, now = Date.now()) {
  const d = new Date(ts);
  const opts = { weekday: "short", month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date(now).getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-US", opts);
}

/**
 * A calendar file for the day it comes back: a short event at 9:00 with an
 * alert, so the phone reminds you outside the app.
 */
export function reminderIcs({ title, why = "", url = "", until, appUrl, now = Date.now(), time = "09:00" }) {
  const pad = (n) => String(n).padStart(2, "0");
  const d = new Date(until);
  const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const s = new Date(now);
  const stamp = `${s.getUTCFullYear()}${pad(s.getUTCMonth() + 1)}${pad(s.getUTCDate())}T${pad(s.getUTCHours())}${pad(s.getUTCMinutes())}${pad(s.getUTCSeconds())}Z`;
  const esc = (v) => String(v || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
  const text = [why, url, `Open Shoebox: ${appUrl}`].filter(Boolean).join("\n");
  const fold = (line) => line.length <= 74 ? line : line.match(/.{1,73}/g).join("\r\n ");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Shoebox//Set aside//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:shoebox-${ymd}-${Math.abs(hashStr(title + url + until))}@shoebox`,
    `DTSTAMP:${stamp}`,
    ...(() => { const [h, m] = (/^\d{2}:\d{2}$/.test(time) ? time : "09:00").split(":").map(Number); const e = h * 60 + m + 15;
      return [`DTSTART:${ymd}T${pad(h)}${pad(m)}00`, `DTEND:${ymd}T${pad(Math.min(23, Math.floor(e / 60)))}${pad(e >= 1440 ? 59 : e % 60)}00`]; })(),
    `SUMMARY:${esc(`Back in Shoebox: ${String(title || "something you set aside").slice(0, 80)}`)}`,
    `DESCRIPTION:${esc(text)}`,
    `URL:${appUrl}`,
    "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:PT0M", `DESCRIPTION:${esc(`Back in Shoebox: ${String(title || "").slice(0, 80)}`)}`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].map(fold).join("\r\n") + "\r\n";
}

function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }


/**
 * School posts on Today: every one not yet done or let go, every day, soonest
 * date first (undated after). One whose date has passed leaves on its own.
 */
export function schoolToday(items, now = Date.now()) {
  const today = dayKey(now);
  return items
    .filter((i) => i.school && (i.status === STATUS.INBOX || i.status === STATUS.QUEUED))
    .filter((i) => !i.school.date || i.school.date >= today)
    .sort((a, b) => (a.school.date || "9999") .localeCompare(b.school.date || "9999") || a.created - b.created);
}

/** A sender as a person reads it: their name, or for a bare address like noreply@mg.infinitecampus.com, the site (infinitecampus.com). */
export function senderName(fromName, from) {
  const n = String(fromName || "").trim();
  if (n && !n.includes("@")) return n;
  const addr = (n || String(from || "")).replace(/^.*</, "").replace(/>.*$/, "").trim();
  const host = addr.split("@")[1] || "";
  const parts = host.toLowerCase().split(".").filter(Boolean);
  if (parts.length < 2) return addr || "Email";
  const two = parts.slice(-2).join(".");
  return /^(co|com|org|net|gov|edu|ac)\.[a-z]{2}$/.test(two) && parts.length > 2 ? parts.slice(-3).join(".") : two;
}
/** Text from mail sometimes arrives with HTML codes still in it (&#160;, &amp;). */
export function plainEntities(t) {
  return String(t || "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; } })
    .replace(/&#(\d{1,7});/g, (m, d) => { try { return String.fromCodePoint(+d); } catch { return m; } }).replace(/\u00a0/g, " ");
}

