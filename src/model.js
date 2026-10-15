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
  PHOTO: "photo",
  PDF: "pdf",
  TEXT: "text",   // a plain-text or markdown file
  VIDEO: "video",
  AUDIO: "audio",
  FILE: "file",   // anything else: docx, pages, keynote, zip...
});

export const EDITION_SIZE = 6;
export const MAX_SKIPS = 8;          // deferrals in an edition before an item washes out
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

/**
 * Turn whatever was dropped in (text, a link, a file) into a draft item.
 * Text that is mostly a URL becomes a link; anything else is a note.
 */
export function draftFromText(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const url = findUrl(text);
  const rest = url ? text.replace(url, "").trim() : text;
  if (url && rest.length < 40) {
    return { kind: KIND.LINK, url, title: rest || titleFromUrl(url), text: rest || undefined };
  }
  return { kind: KIND.NOTE, text, url: url || undefined, title: firstLine(text) };
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
    fileName: draft.fileName,
    mime: draft.mime,
    size: draft.size,
    blobId: draft.blobId,
    summary: draft.summary || "",
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
        if (next.skips >= MAX_SKIPS) {
          next.status = STATUS.ARCHIVED;
          next.archivedAt = now;
          next.washedOut = true;
        }
      }
      break;
    default:
      throw new Error(`Unknown verdict: ${verdict}`);
  }
  return next;
}

/** Put a let-go or done item back in the queue. */
export function restore(item, now = Date.now()) {
  return { ...item, status: STATUS.QUEUED, skips: 0, washedOut: false, queuedAt: now };
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
  const queued = items.filter((i) => i.status === STATUS.QUEUED);
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
