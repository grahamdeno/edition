/*
 * Shoebox app shell (formerly Edition).
 *
 * One screen: a timeline of what you saved, with your own face as the author
 * of every post. Two tabs:
 *   Today      new saves first, then today's six from your queue, then at
 *              most two suggestions, then the finish card. Finite: when it's
 *              cleared, it's done until tomorrow.
 *   All saves  everything you kept, with search and a Fading section.
 * Tapping a post opens it full screen in the reader. Add, Edit, Reply and
 * Settings are sheets.
 *
 * Rendering is plain template strings; every value from an item goes through
 * esc(). Icons come from icons.js only.
 */

import {
  VERDICT, STATUS, KIND, dayKey, applyVerdict, restore, buildEdition, editionView,
  interestProfile, estimateMinutes, counts, migrateLegacy, createItem, EDITION_SIZE,
  detectText, draftFromFile, describeDraft, fading, isFaded, FADE_DAYS, youtubeId, titleFromUrl,
  asBook,
  SUGGESTIONS_PER_DAY, WHY_NOT, WHY_NOT_LABEL, emptySuggestProfile, learnFromSuggestion, suggestionGuide,
  screenSuggestions, suggestMaxMinutes,
  canonTags, tagVocab, tagStats, renameTag, addAlias, releaseTags, renameInSuggestProfile, localTags, normTag, MAX_TAGS,
  friendlyWhen, usablePicture,
} from "./model.js";
import * as db from "./db.js";
import { captureText, captureFile, captureTransfer, readClipboard, captureShares } from "./capture.js";
import { sampleItems, SAMPLES_VERSION } from "./samples.js";
import * as ai from "./ai.js";
import { tick, unlock, soundOn, setSound } from "./feel.js";
import { I, LOGO } from "./icons.js";
import { topicColor, dominantColor, tintInks } from "./visuals.js";
import { problems, noteError as logError, onFirstProblem, clearProblems, formatProblem } from "./problems.js";

export const VERSION = "4.2.0";
const APP = "Shoebox";
const noteError = (e, opts = {}) => logError(e, { ...opts, version: VERSION });

const KIND_LABEL = { link: "Link", note: "Note", quote: "Quote", photo: "Photo", pdf: "PDF", text: "Text", video: "Video", audio: "Audio", file: "File" };
const ALL_FILTERS = [
  { label: "Kept", id: STATUS.QUEUED },
  { label: "New", id: STATUS.INBOX },
  { label: "Loved", id: "loved" },
  { label: "Done", id: STATUS.DONE },
  { label: "Let go", id: STATUS.ARCHIVED },
  { label: "Everything", id: "all" },
];
const PAGE = 30;
const IDLE_MS = 3000;

const state = {
  items: [],
  edition: null,
  tab: "today",
  allFilter: 0,
  allQuery: "",
  allShown: PAGE,
  capText: "",
  capFiles: [],
  capWhy: "",
  capPic: null,      // the picture picker in Add: { url, status, list, choice, ownFile, ownUrl }
  enriching: new Set(),
  reader: null,      // { mode: "single", ids: [id], index: 0, total: 1 }
  recent: new Map(), // verdicts given this session: id -> verdict, so a post keeps its stamp
  suggest: null,     // what your answers to suggestions taught (see model.js)
  tagAliases: {},    // renames, merges and deletes made in Settings > Tags (see model.js)
  avatar: "",        // object URL of your photo, or ""
  wonDay: null,      // the day the finish moment last played
};

const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");
const urls = new Map(); // blob id -> object URL

/* ================= Boot ================= */

/*
 * Size the app to the real screen. On iOS 26, a Home Screen app can be handed
 * a page shorter than the display, which left a band at the bottom and lifted
 * everything. In standalone mode, when the screen is a little taller than the
 * page, use the screen's height. Elsewhere this is just the window height.
 */
const fit = { inner: 0, screen: 0, used: 0, short: false };
function fitScreen() {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const portrait = innerHeight >= innerWidth;
  const screenH = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  const gap = screenH - innerHeight;
  const short = standalone && gap > 0 && gap < 140;
  const h = short ? screenH : innerHeight;
  Object.assign(fit, { inner: innerHeight, screen: screenH, used: h, short });
  document.documentElement.style.setProperty("--app-h", `${h}px`);
  document.documentElement.classList.toggle("short-vp", short);
}
fitScreen();
addEventListener("resize", fitScreen);
addEventListener("orientationchange", () => setTimeout(fitScreen, 300));

async function boot() {
  const migrated = await db.migrateFromLocalStorage(migrateLegacy).catch(() => 0);
  state.items = await db.items.all();
  state.edition = await db.meta.get("edition", null);
  state.suggest = await db.meta.get("suggest", null) || emptySuggestProfile();
  state.tagAliases = await db.meta.get("tagAliases", null) || {};
  state.wonDay = await db.meta.get("wonDay", null);
  await loadAvatar();
  await migratePictures();
  const seeded = await seedSamples();
  await importShares();
  await importFromUrl();
  await ensureEdition();
  bindScreen();
  render();
  if (migrated) toast(`Brought over ${migrated} saved item${migrated === 1 ? "" : "s"} from the old version.`);
  else if (seeded) toast(`Loaded ${seeded} sample items. Remove them in Settings.`);
  hideSplash();
  wireGlobal();
  picturePending();
  enrichPending();
  registerWorker();
}

/** The update bar: its own element, above the + button, so no toast or sheet can clear it. */
function updateBar() {
  if ($("#update-bar")) return;
  const el = document.createElement("div");
  el.id = "update-bar";
  el.className = "update-bar";
  el.setAttribute("role", "status");
  el.innerHTML = `<span>${APP} was updated.</span><button type="button">Reload</button>`;
  $("button", el).addEventListener("click", () => location.reload());
  document.body.appendChild(el);
}

/** Fade the loading screen once the timeline is on screen, after the lid has had time to lift. */
const opened = performance.now();
function hideSplash() {
  const el = $("#splash");
  if (!el) return;
  const wait = reduced() ? 0 : Math.max(0, 900 - (performance.now() - opened));
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 400); }, wait);
}

/* Your photo: the face on every post you wrote. Kept on this phone only. */
async function loadAvatar() {
  const id = await db.meta.get("avatarBlobId", null);
  state.avatar = id ? await blobUrl(id) : "";
}

function avatarHtml(cls = "") {
  return state.avatar
    ? `<img class="av ${cls}" src="${esc(state.avatar)}" alt="">`
    : `<span class="av av-none ${cls}" aria-hidden="true">${I.user}</span>`;
}

/*
 * Updates, as in Scales. When a new release has been saved in the background
 * and takes over, a bar says "Shoebox was updated" with Reload, and it stays
 * until Reload is tapped: other messages never replace it. Coming back to the
 * app checks for a release too, since an installed app that's only resumed
 * never reloads the page.
 */
function registerWorker() {
  if (!("serviceWorker" in navigator)) return;
  const hadWorker = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadWorker) updateBar();
  });
  navigator.serviceWorker.register("sw.js").then((reg) => {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reg?.update?.().catch(() => {});
    });
  }).catch(() => {});
}

/**
 * Samples: loaded on a phone's first launch, and swapped for the new set
 * whenever samples.js changes (unless you removed them in Settings).
 * `force` (Settings › Load samples) always replaces them with a fresh set.
 */
async function seedSamples({ force = false } = {}) {
  const loaded = await db.meta.get("samplesLoaded", false);
  const removed = await db.meta.get("samplesRemoved", false);
  const version = await db.meta.get("samplesVersion", null);
  if (!force && loaded && (removed || version === SAMPLES_VERSION)) return 0;
  // Out with the old samples (and their place in today's edition), in with the current set.
  const old = state.items.filter((i) => i.sample);
  if (old.length) {
    for (const it of old) await db.items.remove(it.id);
    const gone = new Set(old.map((i) => i.id));
    state.items = state.items.filter((i) => !gone.has(i.id));
    if (state.edition) state.edition = { ...state.edition, ids: state.edition.ids.filter((id) => !gone.has(id)) };
  }
  const fresh = sampleItems();
  await db.items.putMany(fresh);
  state.items = [...fresh, ...state.items];
  if (state.edition) await db.meta.set("edition", state.edition);
  await db.meta.set("samplesLoaded", true);
  await db.meta.set("samplesRemoved", false);
  await db.meta.set("samplesVersion", SAMPLES_VERSION);
  return fresh.length;
}

async function removeSamples() {
  const list = state.items.filter((i) => i.sample);
  await removeItems(list);
  await db.meta.set("samplesRemoved", true); // don't bring them back on the next sample update
  if (state.edition) {
    const ids = new Set(list.map((i) => i.id));
    state.edition = { ...state.edition, ids: state.edition.ids.filter((id) => !ids.has(id)) };
    await db.meta.set("edition", state.edition);
  }
  return list.length;
}

/** Today's edition, rebuilt on a new day (ranked by the AI first when a key is set). */
async function ensureEdition({ force = false } = {}) {
  const isNewDay = !state.edition || state.edition.date !== dayKey();
  if ((isNewDay || force) && ai.settings.enabled()) await rankQueue().catch((e) => noteError(e, { quiet: true, where: "rank" }));
  const next = buildEdition(state.items, force ? null : state.edition);
  if (next !== state.edition) {
    state.edition = next;
    await db.meta.set("edition", next);
  }
}

/** Items queued during the day join today's edition while it has room. Pages never reorder. */
function topUpEdition() {
  const today = dayKey();
  const ed = state.edition && state.edition.date === today ? state.edition : { date: today, ids: [] };
  const room = EDITION_SIZE - ed.ids.length;
  if (room <= 0) return;
  const inEdition = new Set(ed.ids);
  const hasSuggestion = ed.ids.some((id) => byId(id)?.suggested);
  // Saves kept today wait for a later day's six, as Keep promises.
  const rest = state.items.filter((i) => !inEdition.has(i.id) && !(hasSuggestion && i.suggested)
    && !(i.queuedAt && dayKey(i.queuedAt) === today && i.created && dayKey(i.created) === today));
  const extra = buildEdition(rest, null, { size: room }).ids;
  if (!extra.length) return;
  state.edition = { date: today, ids: [...ed.ids, ...extra] };
  db.meta.set("edition", state.edition);
}

async function addToEdition(id) {
  const item = byId(id);
  if (item && isFaded(item)) await saveItem(restore(item));
  topUpEdition();
  const ed = state.edition && state.edition.date === dayKey() ? state.edition : { date: dayKey(), ids: [] };
  if (ed.ids.includes(id)) return;
  state.edition = { ...ed, ids: [...ed.ids, id] };
  await db.meta.set("edition", state.edition);
}

async function rankQueue() {
  const queue = state.items.filter((i) => i.status === STATUS.QUEUED);
  if (!queue.length) return;
  const ranks = await withTimeout(ai.rank(queue, interestProfile(state.items)), 20000);
  const now = Date.now();
  const map = new Map(ranks.map((r) => [r.id, r]));
  const changed = [];
  state.items = state.items.map((i) => {
    const r = map.get(i.id);
    if (!r) return i;
    const next = { ...i, ai: { score: r.score, why: r.why, at: now } };
    changed.push(next);
    return next;
  });
  await db.items.putMany(changed);
}
/* ================= Data helpers ================= */

async function saveItem(item) {
  state.items = state.items.some((i) => i.id === item.id)
    ? state.items.map((i) => (i.id === item.id ? item : i))
    : [item, ...state.items];
  await db.items.put(item);
}

async function removeItems(list) {
  for (const it of list) {
    await db.items.remove(it.id);
    if (it.blobId) await db.blobs.remove(it.blobId);
    if (it.thumbId) await db.blobs.remove(it.thumbId);
    if (it.cover && it.cover.blobId) await db.blobs.remove(it.cover.blobId);
  }
  const ids = new Set(list.map((i) => i.id));
  state.items = state.items.filter((i) => !ids.has(i.id));
}

const byId = (id) => state.items.find((i) => i.id === id);

async function blobUrl(id) {
  if (!id) return "";
  if (urls.has(id)) return urls.get(id);
  const blob = await db.blobs.get(id);
  if (!blob) return "";
  const u = URL.createObjectURL(blob);
  urls.set(id, u);
  return u;
}

/** Fill in src/href on elements that point at stored files. */
async function hydrate(root) {
  for (const el of root.querySelectorAll("[data-blob]")) {
    const u = await blobUrl(el.dataset.blob);
    if (!u) continue;
    if (el.tagName === "A") el.href = u;
    else el.src = u;
  }
  for (const el of root.querySelectorAll("[data-textblob]")) {
    const blob = await db.blobs.get(el.dataset.textblob);
    if (blob) el.textContent = (await blob.text()).slice(0, 200000);
  }
}
/* ================= Capture plumbing ================= */

async function afterCapture(list) {
  list = list.filter(Boolean);
  if (!list.length) return;
  list.forEach((it) => { state.items = [it, ...state.items.filter((i) => i.id !== it.id)]; });
  tick(true);
  state.tab = "today";
  render({ top: true });
  picturePending();
  toast(`Saved ${list.length === 1 ? "1 item" : list.length + " items"} to ${APP}.`, {
    action: "Undo",
    onAction: async () => { await removeItems(list); render(); },
  });
  enrichPending();
}

async function importShares() {
  const shares = await db.drainShares().catch(() => []);
  if (!shares.length) return 0;
  const list = await captureShares(shares);
  list.forEach((it) => { state.items = [it, ...state.items]; });
  return list.length;
}

/** ?text= / ?url= / ?title= capture, for bookmarklets and shortcuts. Clears itself. */
async function importFromUrl() {
  const p = new URLSearchParams(location.search);
  let n = p.has("share") ? 1 : 0;
  const text = [p.get("title"), p.get("text"), p.get("url")].filter(Boolean).join(" ").trim();
  if (text) {
    const list = await captureText(text, "link");
    if (list.length) { state.items = [...list, ...state.items]; n += list.length; }
  }
  if ([...p.keys()].length) history.replaceState(null, "", location.pathname);
  return n;
}
/* ================= AI work ================= */

/** Your tags, most used first: what every AI tag job is asked to reuse. */
const vocab = () => tagVocab(state.items);
/** What else is going on around an item, so its card face can connect to it. */
function contextFor(item) {
  const DAY = 86400000;
  const around = state.items
    .filter((i) => i.id !== item.id && !i.suggested && !i.sample && Math.abs((i.created || 0) - (item.created || 0)) < 3 * DAY)
    .sort((a, b) => Math.abs(a.created - item.created) - Math.abs(b.created - item.created))
    .slice(0, 5).map(headline);
  const finished = state.items.filter((i) => i.status === STATUS.DONE && !i.book && i.id !== item.id)
    .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 5).map(headline);
  return { around, finished };
}

/** Tags from the AI, cleaned and run through your renames and merges. */
const tidyTags = (tags) => canonTags(tags, state.tagAliases, 3);


let enrichRunning = false;
async function enrichPending() {
  if (enrichRunning || !ai.settings.enabled()) return;
  enrichRunning = true;
  try {
    for (;;) {
      const relay = Boolean(ai.relayBase());
      // New items; and, once a relay can read pages, links read before it could (for their fuller summary).
      let next = state.items.find((i) => (i.status === STATUS.INBOX || i.status === STATUS.QUEUED) && (
        (!i.enrichedAt && (i.enrichTries || 0) < 2)
        || (relay && i.kind === KIND.LINK && i.url && !i.extended && !i.sample && (i.extTries || 0) < 1)));
      if (!next) break;
      if (relay && next.kind === KIND.LINK && !next.pageText && (next.pageTries || 0) < 2) next = await fetchPage(next);
      state.enriching.add(next.id);
      try {
        const blob = next.blobId && [KIND.PHOTO, KIND.PDF, KIND.TEXT].includes(next.kind) ? await db.blobs.get(next.blobId) : null;
        const out = await ai.enrich(next, blob, { vocab: vocab(), context: contextFor(next) });
        const tags = tidyTags(out.tags);
        const cur = byId(next.id);
        if (cur && cur.enrichedAt) {
          // A page read again: add the fuller summary; leave the rest as you know it.
          await saveItem({ ...cur, extended: out.extended || cur.extended, points: out.points.length ? out.points : cur.points,
            summary: cur.summary || out.summary, extTries: (cur.extTries || 0) + 1 });
        } else if (cur) {
          const upd = {
            ...cur,
            title: cur.editedAt ? cur.title : out.title || cur.title,
            summary: out.summary || cur.summary,
            tags: tags.length ? tags : cur.tags,
            minutes: out.minutes || cur.minutes,
            intent: out.intent || cur.intent,
            points: out.points.length ? out.points : cur.points,
            transcript: out.transcript || cur.transcript,
            hook: out.hook || cur.hook,
            hookV: out.hook ? ai.HOOK_VERSION : cur.hookV,
            extended: out.extended || cur.extended,
            imageAlt: cur.imageAlt || (cur.kind === KIND.PHOTO ? out.alt : "") || undefined,
            extTries: (cur.extTries || 0) + 1,
            enrichedAt: Date.now(),
          };
          // A photo of a book is a book you want to read.
          if (out.book && cur.kind === KIND.PHOTO) Object.assign(upd, asBook(upd, out.book), { hook: "A book you want to read", hookV: ai.HOOK_VERSION });
          // A note that turns out to be a quotation is filed as one.
          if (out.quote && cur.kind === KIND.NOTE) {
            upd.kind = KIND.QUOTE;
            upd.text = out.quote.text;
            upd.author = out.quote.author || cur.author;
          }
          await saveItem(upd);
        }
      } catch (e) {
        noteError(e, { quiet: true, where: `enrich ${next.kind}` });
        const cur = byId(next.id);
        // Count the try on whichever pass failed, so no item is picked again straight away.
        if (cur) await saveItem(cur.enrichedAt ? { ...cur, extTries: (cur.extTries || 0) + 1 } : { ...cur, enrichTries: (cur.enrichTries || 0) + 1 });
        if (e.status === 401 || e.message === "No API key set.") { toast(e.message); break; }
        // Busy, rate-limited or unreachable: stop here and try again on the next pass, rather than failing item after item.
        if (e.status === 429 || e.status === 529 || e.status === 0) break;
      } finally {
        state.enriching.delete(next.id);
        if (state.reader && state.reader.ids[state.reader.index] === next.id) renderStory();
        refreshPost(next.id);
      }
      picturePending(); // a link just read can now have its picture chosen
    }
    await backfillHooks();
  } finally {
    enrichRunning = false;
  }
}

/*
 * Items read before card faces existed get one now: a small call each. Your
 * own reason always wins, so those are skipped. The line shows on posts you
 * didn't write a reason for.
 */
const needsHook = (i) => i.enrichedAt && (!i.hook || (i.hookV || 1) < ai.HOOK_VERSION) && !i.why && !i.suggested && (i.hookTries || 0) < 2
  && (i.status === STATUS.INBOX || i.status === STATUS.QUEUED);
async function backfillHooks() {
  for (;;) {
    if (!ai.settings.enabled()) return;
    const order = [...todayIds(), ...state.items.map((i) => i.id)];
    const next = order.map(byId).find((i) => i && needsHook(i));
    if (!next) return;
    try {
      const line = await ai.hook(next, { context: contextFor(next) });
      const cur = byId(next.id);
      if (cur) await saveItem(line ? { ...cur, hook: line, hookV: ai.HOOK_VERSION, hookTries: 0 } : { ...cur, hookTries: (cur.hookTries || 0) + 1 });
    } catch (e) {
      noteError(e, { quiet: true, where: "card face" });
      const cur = byId(next.id);
      if (cur) await saveItem({ ...cur, hookTries: (cur.hookTries || 0) + 1 });
      if (e.status === 401 || e.status === 429 || e.status === 529 || e.status === 0) return;
    }
    refreshPost(next.id);
  }
}

async function findNew(statusEl) {
  const set = (msg, err) => { if (statusEl) { statusEl.textContent = msg; statusEl.classList.toggle("err", !!err); } };
  if (!ai.settings.canDiscover()) { set("Add a Perplexity or Anthropic key in Settings first.", true); return 0; }
  set(ai.settings.pplxEnabled() ? "Searching Perplexity for something worth your time…" : "Searching for something worth your time…");
  try {
    const known = new Set(state.items.map((i) => i.url).filter(Boolean));
    const picks = await ai.discover(interestProfile(state.items), { known, guide: suggestionGuide(state.suggest), vocab: vocab() });
    const fresh = await tagPicks(screenSuggestions(picks.filter((p) => !known.has(p.url)), state.suggest));
    for (const p of fresh) {
      const item = createItem(
        { kind: KIND.LINK, url: p.url, title: p.title, summary: p.why, tags: p.tags, minutes: p.minutes },
        { id: db.newId(), source: "ai" },
      );
      item.suggestReason = p.why;
      item.enrichedAt = Date.now();
      await saveItem(item);
    }
    set(fresh.length ? `${fresh.length} suggestion${fresh.length === 1 ? "" : "s"} found. They come after your own saves, two a day.` : "Nothing new turned up. Try again later.");
    if (fresh.length) picturePending();
    return fresh.length;
  } catch (e) {
    noteError(e, { quiet: true, where: ai.settings.pplxEnabled() ? "discover (Perplexity)" : "discover (Claude)" });
    set(e.message || "Search failed.", true);
    return 0;
  }
}

/*
 * Every suggestion should carry tags, or your verdict on it teaches nothing.
 * Untagged picks (a Perplexity result used as is) are tagged in one call
 * when there's an Anthropic key; otherwise they borrow your own tags from
 * their words. Either way, tags go through your renames and merges.
 */
async function tagPicks(picks) {
  const v = vocab();
  const bare = picks.map((p, k) => (tidyTags(p.tags).length ? -1 : k)).filter((k) => k >= 0);
  let got = {};
  if (bare.length && ai.settings.enabled()) {
    try {
      const res = await ai.tagItems(bare.map((k) => picks[k]), { vocab: v });
      bare.forEach((k, j) => { if (res[j]) got[k] = res[j]; });
    } catch (e) { noteError(e, { quiet: true, where: "tag suggestions" }); }
  }
  return picks.map((p, k) => {
    let tags = tidyTags(got[k] || p.tags);
    if (!tags.length) tags = tidyTags(localTags(`${p.title} ${p.why || ""}`, v));
    return { ...p, tags };
  });
}
/* ================= Pictures ================= */

/** What to show as a headline: a quote or note shows its own words. */
function headline(item) {
  if ((item.kind === KIND.QUOTE || item.kind === KIND.NOTE) && item.text) {
    const t = item.text.trim();
    return item.kind === KIND.QUOTE ? `“${t.length > 140 ? t.slice(0, 137) + "…" : t}”` : t.length > 140 ? t.slice(0, 137) + "…" : t;
  }
  return item.title;
}

/** The picture a card shows, or null for a drawn cover. */
function pictureOf(item) {
  if (!item || item.coverOff) return null;
  const c = item.cover;
  if (c && c.pinned && (c.blobId || c.src)) return c.blobId ? { blobId: c.blobId, from: "mine" } : { src: c.src, from: c.from, credit: c.credit, license: c.license, link: c.link };
  if (item.kind === KIND.PHOTO && item.blobId) return { blobId: item.thumbId || item.blobId, from: "own" };
  if (item.imageUrl) return { src: item.imageUrl, from: item.kind === KIND.LINK ? "page" : "own" };
  // An older version's found stock photo shows only if you chose it yourself.
  if (c && c.blobId) return { blobId: c.blobId, from: "mine" };
  return null;
}

/** Credit line for a found photo, as its licence asks. */
function creditLine(pic) {
  if (!pic || pic.from !== "search") return "";
  return ["Photo", pic.credit, pic.license].filter(Boolean).join(" · ");
}

/** Read a link's page through the relay: its pictures, real title, and text for the summary. */
async function fetchPage(item) {
  const base = ai.relayBase();
  if (!base || item.kind !== KIND.LINK || !item.url) return item;
  let data = null;
  try {
    const res = await withTimeout(fetch(`${base}/preview?text=1&url=${encodeURIComponent(item.url)}`), 15000);
    if (res.ok) data = await res.json();
  } catch (e) {
    noteError(e, { quiet: true, where: "page" });
  }
  const cur = byId(item.id);
  if (!cur) return item;
  const upd = { ...cur, pageTries: (cur.pageTries || 0) + 1 };
  const cands = data ? candidatesOf(data) : [];
  if (cands.length && !cur.imageCands) upd.imageCands = cands;
  if (data && data.title && !cur.editedAt && (cur.title === titleFromUrl(cur.url) || !cur.enrichedAt)) upd.title = data.title.slice(0, 140);
  if (data && data.description && !cur.summary) upd.summary = data.description.slice(0, 200);
  if (data && data.site && !cur.site) upd.site = String(data.site).slice(0, 60);
  if (data && data.text) upd.pageText = String(data.text).slice(0, 15000);
  if (data && (data.image || data.title || data.text)) upd.pageTries = 2; // got what there is
  await saveItem(upd);
  return upd;
}

/** The relay's picture list, or (from an older relay) its single preview picture. */
function candidatesOf(data) {
  const list = Array.isArray(data.images) && data.images.length ? data.images : data.image ? [{ src: data.image }] : [];
  return list.filter((c) => c && /^https?:\/\//.test(c.src || "")).slice(0, 8)
    .map((c) => ({ src: c.src, w: c.w || null, h: c.h || null, alt: c.alt || null }));
}

/**
 * Load each candidate and keep the ones that are real photos: wide enough,
 * not too long or thin, and actually loadable. Measured sizes replace the
 * page's claims. Runs in parallel; a picture that hangs is dropped.
 */
async function usableImages(cands, { timeout = 8000 } = {}) {
  const one = (c) => new Promise((resolve) => {
    const img = new Image();
    const done = (ok) => { clearTimeout(t); img.onload = img.onerror = null; resolve(ok ? { ...c, w: img.naturalWidth, h: img.naturalHeight } : null); };
    const t = setTimeout(() => done(false), timeout);
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.referrerPolicy = "no-referrer";
    img.src = c.src;
  });
  const out = await Promise.all((cands || []).map(one));
  return out.filter((c) => c && usablePicture(c));
}

/**
 * Settle a link's picture once its page has been read: keep only usable
 * candidates, then let the AI pick the one that best represents it (and
 * describe it), else take the first. Your own choice is never overridden.
 */
async function settlePicture(item) {
  const cur0 = byId(item.id);
  if (!cur0) return;
  const usable = await usableImages(cur0.imageCands || []);
  let pick = usable.length ? 0 : -1, alt = "";
  if (usable.length && ai.settings.enabled() && (cur0.enrichedAt || (cur0.enrichTries || 0) >= 2)) {
    try {
      const r = await withTimeout(ai.pickPicture(cur0, usable), 20000);
      pick = r.index; alt = r.alt;
    } catch (e) { noteError(e, { quiet: true, where: "pick picture" }); }
  }
  const cur = byId(item.id);
  if (!cur) return;
  const upd = { ...cur, imageCands: usable, picSettled: Date.now() };
  if (!cur.picPicked && !cur.coverOff) {
    upd.imageUrl = pick >= 0 ? usable[pick].src : undefined;
    upd.imageAlt = pick >= 0 ? alt || usable[pick].alt || cur.imageAlt || undefined : cur.imageAlt;
    upd.tint = undefined;
  }
  await saveItem(upd);
  refreshPost(item.id);
}

let pictureRunning = false;
async function picturePending() {
  if (pictureRunning) return;
  pictureRunning = true;
  try {
    for (;;) {
      const relay = Boolean(ai.relayBase());
      const open = (i) => i.status === STATUS.INBOX || i.status === STATUS.QUEUED;
      // A link whose page hasn't been read yet.
      const unread = relay && state.items.find((i) => open(i) && i.kind === KIND.LINK && i.url && !i.imageCands && (i.pageTries || 0) < 2);
      if (unread) { await fetchPage(unread); refreshPost(unread.id); continue; }
      // A link with candidates still to settle: wait for its summary first when the AI is on, so the pick has context.
      const aiOn = ai.settings.enabled();
      const unsettled = state.items.find((i) => open(i) && i.imageCands && !i.picSettled
        && (!aiOn || i.enrichedAt || (i.enrichTries || 0) >= 2));
      if (unsettled) { await settlePicture(unsettled); continue; }
      break;
    }
  } finally {
    pictureRunning = false;
  }
}

/** Read a picture's main colour once, keep it on the item, and tint its post. */
async function tintFrom(item, src) {
  if (!src || item.tint) return;
  const color = await dominantColor(src);
  if (!color) return;
  const cur = byId(item.id);
  if (!cur) return;
  await saveItem({ ...cur, tint: color });
  const el = document.getElementById("p-" + item.id);
  if (el) applyTint(el, color);
}

function applyTint(el, color) {
  const t = tintInks(color);
  if (!t) return;
  el.classList.add("tinted");
  el.style.setProperty("--t", t.t);
}

/* ================= Timeline =================
 * Today: your new saves, then today's six, then at most two suggestions,
 * then the finish card. All saves: search and filters over everything.
 * Posts are written by you (your face, your reasons) or, for suggestions,
 * by Shoebox. Verdicts sit on every post: Later (Keep, for a new save),
 * Done, Let go. Love and Reply are kept on the item.
 */

/** What's on Today, in order. */
function todaySections() {
  topUpEdition();
  const isNew = (i) => i.status === STATUS.INBOX || state.recent.get(i.id)?.stage === "inbox";
  const fresh = state.items.filter((i) => !i.suggested && isNew(i)).sort((a, b) => b.created - a.created);
  const freshIds = new Set(fresh.map((i) => i.id));
  const v = editionView(state.items, state.edition);
  const six = v.pages.filter((p) => !freshIds.has(p.id));
  const sixIds = new Set(six.map((p) => p.id));
  const sugg = state.items.filter((i) => i.suggested && !sixIds.has(i.id) && isNew(i))
    .sort((a, b) => a.created - b.created).slice(0, SUGGESTIONS_PER_DAY);
  return { fresh, six, sugg, edition: v };
}

function todayIds() {
  const s = todaySections();
  return [...s.fresh, ...s.six, ...s.sugg].map((i) => i.id);
}

/** Is a post on Today still waiting for a verdict? */
function isOpen(item) {
  if (state.recent.has(item.id)) return false;
  if (item.status === STATUS.INBOX) return true;
  if (item.status !== STATUS.QUEUED) return false;
  return !(item.deferredAt && dayKey(item.deferredAt) === dayKey());
}

/** How a settled post is marked: from this session's verdicts, else from its state. */
function settledAs(item) {
  const r = state.recent.get(item.id);
  if (r) return r.verdict;
  if (item.status === STATUS.DONE) return VERDICT.DONE;
  if (item.status === STATUS.ARCHIVED) return VERDICT.LET_GO;
  if (item.status === STATUS.QUEUED && item.deferredAt && dayKey(item.deferredAt) === dayKey()) return VERDICT.LATER;
  return null;
}

function leftToday() {
  const s = todaySections();
  return [...s.fresh, ...s.six].filter(isOpen).length;
}

/** Render the whole screen. Keeps your place unless `top` asks to go back up. */
function render({ top = false } = {}) {
  const prev = $("#tl");
  const scroll = prev && !top ? prev.scrollTop : 0;
  const left = leftToday();
  app.innerHTML = `<div class="tl" id="tl">
    <header class="top">
      <div class="bar">
        <h1 class="mark"><span class="logo" aria-hidden="true">${LOGO}</span><span class="word">${APP}</span></h1>
        <span class="count" id="count" aria-live="polite">${left ? `${left} left today` : "Done for today"}</span>
        <button class="icon-btn" type="button" data-act="settings" aria-label="Settings">${I.settings}</button>
      </div>
      <div class="tabs" role="tablist" aria-label="Show">
        <button class="tab" role="tab" id="tab-today" type="button" data-tab="today" aria-selected="${state.tab === "today"}" aria-controls="panel" tabindex="${state.tab === "today" ? 0 : -1}">Today</button>
        <button class="tab" role="tab" id="tab-all" type="button" data-tab="all" aria-selected="${state.tab === "all"}" aria-controls="panel" tabindex="${state.tab === "all" ? 0 : -1}">All saves</button>
      </div>
    </header>
    <main id="panel" role="tabpanel" aria-labelledby="tab-${state.tab}">
      <button class="composer" type="button" data-act="add">${avatarHtml()}<span class="ph">Save a link, photo or thought</span><span class="pill">Add</span></button>
      ${state.tab === "today" ? todayHtml() : allHtml()}
    </main>
  </div>
  <button class="fab" type="button" data-act="add" aria-label="Save something">${I.plus}</button>`;
  const tl = $("#tl");
  tl.scrollTop = scroll;
  hydrate(tl);
  bindTimeline(tl);
  tintVisible(tl);
}

/** Replace one post in place (a summary or picture arrived), without disturbing the page. */
function refreshPost(id) {
  const el = document.getElementById("p-" + id);
  const item = byId(id);
  if (!el || !item || $(".sheet-wrap")) return;
  const compact = el.classList.contains("compact");
  const tmp = document.createElement("div");
  tmp.innerHTML = postHtml(item, { compact });
  const next = tmp.firstElementChild;
  if (!next) return;
  el.replaceWith(next);
  hydrate(next);
  tintVisible(next.parentElement || next);
}

function sectionHead(title, note = "") {
  return `<h2 class="sep"><span>${esc(title)}</span>${note ? `<span class="sep-note">${esc(note)}</span>` : ""}</h2>`;
}

function todayHtml() {
  const s = todaySections();
  let h = "";
  if (s.fresh.length) h += sectionHead("New", `${s.fresh.filter(isOpen).length || "All"} to sort`) + s.fresh.map((i) => postHtml(i)).join("");
  if (s.six.length) h += sectionHead("Today's six", `${s.six.filter(isOpen).length} of ${s.six.length} left`) + s.six.map((i) => postHtml(i)).join("");
  if (s.sugg.length) h += sectionHead("From outside your saves") + s.sugg.map((i) => postHtml(i)).join("");
  return h + endHtml(s);
}

/** The end of Today: what's left, or the finish moment once it's all cleared. */
function endHtml(s) {
  const all = [...s.fresh, ...s.six];
  const open = all.filter(isOpen).length;
  const c = counts(state.items);
  const more = `${c.queued ? `<button class="btn" type="button" data-act="one-more">Read one more</button>` : ""}
    ${ai.settings.canDiscover() ? `<button class="btn" type="button" data-act="discover">Find something new</button>` : ""}`;
  if (!state.items.length) {
    return `<section class="end"><h2>Your shoebox is empty.</h2>
      <p>Save a link, a photo, a thought or a file, and say why if you like. It comes back here.</p>
      <button class="btn primary" type="button" data-act="add">Save something</button></section>`;
  }
  if (!all.length) {
    return `<section class="end"><h2>Nothing for today.</h2>
      <p>Nothing new came in and your queue is empty. Save something, or find something new.</p>
      <div class="end-acts">${more}</div><p class="st" id="end-st" role="status"></p></section>`;
  }
  if (open) {
    return `<section class="end quiet"><h2>${open} to go.</h2><p>Clear them and today is done.</p></section>`;
  }
  const tally = { done: 0, later: 0, go: 0 };
  for (const i of all) {
    const v = settledAs(i);
    if (v === VERDICT.DONE || v === VERDICT.READ_NOW) tally.done++;
    else if (v === VERDICT.LET_GO) tally.go++;
    else tally.later++;
  }
  const first = state.wonDay !== dayKey();
  if (first) { state.wonDay = dayKey(); db.meta.set("wonDay", state.wonDay); }
  return `<section class="end win ${first ? "first" : ""}" aria-label="Today is done">
    <h2>You cleared today.</h2>
    <p>Nothing more until tomorrow morning.</p>
    <div class="collage" aria-hidden="true">${all.slice(0, 6).map((i, k) => `<div class="tile" style="--k:${k}">${tileHtml(i)}</div>`).join("")}</div>
    <div class="tally"><div><b>${tally.done}</b>done</div><div><b>${tally.later}</b>later</div><div><b>${tally.go}</b>let go</div></div>
    <div class="end-acts">${more}</div><p class="st" id="end-st" role="status"></p>
  </section>`;
}

function tileHtml(item) {
  const pic = pictureOf(item);
  if (pic && pic.blobId) return `<img alt="" data-blob="${esc(pic.blobId)}">`;
  if (pic && pic.src) return `<img alt="" referrerpolicy="no-referrer" src="${esc(pic.src)}" onerror="this.remove()">`;
  const words = item.kind === KIND.QUOTE ? `“${firstWords(item.text || item.title, 5)}”` : firstWords(headline(item), 6);
  return `<span class="tw" style="--c:${topicColor(item)}">${esc(words)}</span>`;
}

function firstWords(s, n) {
  const w = String(s || "").replace(/^[“"]|[”"]$/g, "").split(/\s+/).filter(Boolean);
  return w.slice(0, n).join(" ") + (w.length > n ? "…" : "");
}

function allHtml() {
  const f = ALL_FILTERS[state.allFilter];
  const q = state.allQuery.trim().toLowerCase();
  const match = (i) => !q || [i.title, i.text, i.url, i.summary, i.fileName, i.author, i.transcript, i.why, i.site,
    ...(i.points || []), ...(i.tags || []), ...(i.replies || []).map((r) => r.text)].some((s) => s && String(s).toLowerCase().includes(q));
  const rows = state.items
    .filter((i) => f.id === "all" || (f.id === "loved" ? i.loved : i.status === f.id))
    .filter(match)
    .sort((a, b) => (b.loved && f.id === "loved" ? b.loved - (a.loved || 0) : 0) || (b.doneAt || b.archivedAt || b.created) - (a.doneAt || a.archivedAt || a.created));
  const waiting = !q && (f.id === STATUS.QUEUED || f.id === "all") ? fading(state.items, state.edition, { limit: 8 }) : [];
  const shown = rows.slice(0, state.allShown);
  return `<div class="find-wrap">${I.search}<label class="sr-only" for="all-q">Search everything you saved</label>
      <input class="find" id="all-q" type="search" placeholder="Search everything you saved" value="${esc(state.allQuery)}" enterkeyhint="search" autocomplete="off"></div>
    <div class="chips" role="group" aria-label="Show">
      ${ALL_FILTERS.map((x, i) => `<button class="chip" type="button" data-filter="${i}" aria-pressed="${state.allFilter === i}">${x.label}</button>`).join("")}
    </div>
    ${waiting.length ? `${sectionHead("Fading", `Untouched ${FADE_DAYS / 7} weeks fades`)}<div class="tide">${tideHtml(waiting)}</div>` : ""}
    ${sectionHead(f.id === "all" ? "Everything" : f.label, `${rows.length} item${rows.length === 1 ? "" : "s"}`)}
    ${shown.length ? shown.map((i) => postHtml(i, { compact: true })).join("") : `<p class="empty">${q ? "Nothing matches." : "Nothing here yet."}</p>`}
    ${rows.length > shown.length ? `<button class="btn more" type="button" data-act="show-more">Show ${Math.min(PAGE, rows.length - shown.length)} more</button>` : ""}`;
}

/** Fading rows: faded saves wait for Keep or Let go; ones close to fading offer Read today. */
function tideHtml(waiting) {
  return waiting.map(({ item, left, faded }) => `<div class="tide-row ${faded ? "faded" : ""}">
    <button class="txt" type="button" data-open="${esc(item.id)}"><span class="t">${esc(headline(item))}</span>
      <span class="s">${faded ? "Faded. Your call." : `Fades in ${left} day${left === 1 ? "" : "s"}`}</span></button>
    ${faded
      ? `<button class="btn sm" type="button" data-letgo="${esc(item.id)}">Let go</button><button class="btn sm primary" type="button" data-keep="${esc(item.id)}">Keep</button>`
      : `<button class="btn sm" type="button" data-rescue="${esc(item.id)}">Read today</button>`}</div>`).join("");
}

/* ---- A post ---- */

/** Who wrote it and when, in plain words. */
function byline(item) {
  if (item.suggested) return { who: APP, when: friendlyWhen(item.created) };
  return { who: "You", when: friendlyWhen(item.created) };
}

function postHtml(item, { compact = false } = {}) {
  const words = item.kind === KIND.QUOTE || item.kind === KIND.NOTE;
  const settled = state.tab === "today" ? settledAs(item) : null;
  const open = state.tab === "today" ? isOpen(item) : item.status === STATUS.INBOX || item.status === STATUS.QUEUED;
  const b = byline(item);
  const tag = item.loved ? `<span class="tag love">${I.heartFill}<span>Loved</span></span>`
    : item.suggested ? `<span class="tag">Suggested</span>`
    : isFaded(item) ? `<span class="tag fade">Faded</span>`
    : state.tab === "all" && item.status !== STATUS.QUEUED ? `<span class="tag">${{ inbox: "New", done: "Done", archived: "Let go" }[item.status] || ""}</span>` : "";
  // The words at the top: your reason, else Shoebox's line about it (marked as a guess), else nothing.
  let say = "";
  if (item.suggested) say = `<p class="body">${esc(item.suggestReason || item.summary || "Picked from what you finish.")}</p>`;
  else if (item.kind === KIND.NOTE) say = `<p class="say">${esc(item.text || item.title)}</p>`;
  else if (item.why) say = `<p class="say">${esc(item.why)}</p>`;
  else if (item.hook && !words) say = `<p class="guess"><span class="sr-only">${APP}'s guess: </span>${esc(item.hook)}</p>`;
  const why = item.why && item.kind === KIND.NOTE ? `<p class="why-line"><span>Why you kept it</span>${esc(item.why)}</p>` : "";
  const quote = item.kind === KIND.QUOTE ? `<figure class="quote ${String(item.text || "").length > 160 ? "long" : ""}"><blockquote>“${esc(item.text || item.title)}”</blockquote>${item.author ? `<figcaption>${esc(item.author)}</figcaption>` : ""}</figure>${item.why ? `<p class="why-line"><span>Why you kept it</span>${esc(item.why)}</p>` : ""}` : "";
  const points = !compact && item.points && item.points.length && [KIND.LINK, KIND.PDF, KIND.TEXT].includes(item.kind)
    ? `<div class="quick"><h3>Quick read</h3><ul>${item.points.slice(0, 3).map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>` : "";
  const busy = state.enriching.has(item.id) ? `<p class="busy" role="status">Reading it…</p>` : "";
  const replies = repliesHtml(item, compact);
  const tintStyle = item.tint && tintInks(item.tint) ? ` style="--t:${esc(tintInks(item.tint).t)}"` : "";
  return `<article class="post${compact ? " compact" : ""}${settled ? " settled" : ""}${item.tint ? " tinted" : ""}" id="p-${esc(item.id)}" data-id="${esc(item.id)}"${tintStyle}
      aria-label="${esc(b.who)}, ${esc(b.when)}${item.title && !words ? ": " + esc(item.title) : ""}">
    <div class="rail">${item.suggested ? `<span class="av av-sb" aria-hidden="true">${LOGO}</span>` : avatarHtml()}${replies ? '<span class="line" aria-hidden="true"></span>' : ""}</div>
    <div class="main">
      <div class="meta"><span class="who">${esc(b.who)},</span> <span class="when">${esc(b.when)}</span>${tag}<button class="act icon more" type="button" data-edit="${esc(item.id)}" aria-label="Edit">${I.menu}</button></div>
      ${say}${quote}${why}
      ${mediaHtml(item, compact)}
      ${busy}${points}
    </div>
    <div class="acts-row">${settled ? stampHtml(item, settled) : actionsHtml(item, open)}</div>
  </article>${replies}`;
}

function stampHtml(item, v) {
  const label = v === VERDICT.DONE || v === VERDICT.READ_NOW ? doneLabel(item) === "Done" ? "Done" : "Read it"
    : v === VERDICT.LET_GO ? (item.suggested ? "Not for me" : "Let go") : item.status === STATUS.QUEUED && state.recent.get(item.id)?.stage === "inbox" ? "Kept" : "Back tomorrow";
  const cls = v === VERDICT.DONE || v === VERDICT.READ_NOW ? "done" : v === VERDICT.LET_GO ? "go" : "later";
  return `<span class="stamp ${cls}">${cls === "done" ? I.done : cls === "go" ? I.letGo : I.later}${esc(label)}</span>
    ${state.recent.has(item.id) ? `<button class="undo" type="button" data-undo="${esc(item.id)}">Undo</button>` : ""}`;
}

function actionsHtml(item, open) {
  const love = `<button class="act icon" type="button" data-love="${esc(item.id)}" aria-pressed="${!!item.loved}" aria-label="Love">${item.loved ? I.heartFill : I.heart}</button>`;
  const reply = item.suggested ? "" : `<button class="act icon" type="button" data-reply="${esc(item.id)}" aria-label="Reply to yourself${item.replies?.length ? `, ${item.replies.length} so far` : ""}">${I.reply}${item.replies?.length ? `<span class="n" aria-hidden="true">${item.replies.length}</span>` : ""}</button>`;
  if (!open) {
    const requeue = item.status === STATUS.DONE || item.status === STATUS.ARCHIVED
      ? `<button class="act" type="button" data-requeue="${esc(item.id)}">${I.requeue}<span>Bring back</span></button>` : "";
    return `<div class="acts">${love}${reply}<span class="grow"></span>${requeue}</div>`;
  }
  const keep = item.status === STATUS.INBOX || isFaded(item);
  return `<div class="acts">${love}${reply}<span class="grow"></span>
    <button class="act" type="button" data-v="${VERDICT.LATER}" data-id="${esc(item.id)}">${keep ? I.keep : I.later}<span>${keep ? "Keep" : "Later"}</span></button>
    <button class="act" type="button" data-v="${VERDICT.LET_GO}" data-id="${esc(item.id)}">${I.letGo}<span>${item.suggested ? "Not for me" : "Let go"}</span></button>
    <button class="act done" type="button" data-v="${VERDICT.DONE}" data-id="${esc(item.id)}">${I.done}<span>${esc(doneLabel(item))}</span></button>
  </div>`;
}

function repliesHtml(item, compact) {
  const list = item.replies || [];
  if (!list.length) return "";
  const shown = compact ? list.slice(-1) : list.slice(-3);
  return `<div class="replies" data-for="${esc(item.id)}">${list.length > shown.length ? `<button class="more-replies" type="button" data-open="${esc(item.id)}">${list.length - shown.length} earlier repl${list.length - shown.length === 1 ? "y" : "ies"}</button>` : ""}
    ${shown.map((r) => `<div class="reply"><div class="rail">${avatarHtml("sm")}</div><div class="main">
      <div class="meta"><span class="who">You,</span> <span class="when">${esc(friendlyWhen(r.at))}</span></div>
      <p class="say">${esc(r.text)}</p></div></div>`).join("")}</div>`;
}

/** The picture or file part of a post. Photos run edge to edge; links get a card. */
function mediaHtml(item, compact) {
  const pic = pictureOf(item);
  const alt = esc(item.imageAlt || (item.kind === KIND.PHOTO ? item.title : ""));
  const imgTag = (cls = "") => pic.blobId
    ? `<img class="${cls}" alt="${alt}" data-blob="${esc(pic.blobId)}">`
    : `<img class="${cls}" alt="${alt}" src="${esc(pic.src)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.closest('.pic')?.remove()">`;
  const openBtn = (inner, label) => `<button class="open" type="button" data-open="${esc(item.id)}" aria-label="${esc(label)}">${inner}</button>`;
  switch (item.kind) {
    case KIND.PHOTO:
      if (!pic) return "";
      return `<div class="pic bleed${compact ? " small" : ""}" data-dbl="${esc(item.id)}">${openBtn(imgTag(), `Open ${item.book ? "book" : "photo"}`)}<span class="burst" aria-hidden="true">${I.heartFill}</span>
        ${item.book ? `<span class="badge-on">${esc(bookLine(item))}</span>` : ""}</div>`;
    case KIND.VIDEO:
      return `<div class="card">${pic ? `<div class="pic wide">${openBtn(imgTag() + `<span class="play" aria-hidden="true">${I.play}</span>`, `Open video: ${item.title}`)}</div>` : ""}
        ${openBtn(`<span class="lk"><span class="site">${esc(siteLine(item))}</span><span class="ttl">${esc(item.title)}</span></span>`, `Open ${item.title}`)}</div>`;
    case KIND.LINK:
      return `<div class="card">${pic ? `<div class="pic wide">${openBtn(imgTag(), `Open ${item.title}`)}</div>` : ""}
        ${openBtn(`${pic ? "" : `<span class="fav" style="--c:${topicColor(item)}" aria-hidden="true">${esc((item.site || host(item.url) || "?").charAt(0).toUpperCase())}</span>`}<span class="lk"><span class="site">${esc(siteLine(item))}</span><span class="ttl">${esc(item.title)}</span></span>`, `Open ${item.title}`)}</div>`;
    case KIND.QUOTE:
    case KIND.NOTE:
      return "";
    default: {
      const name = item.fileName || item.title;
      return `<div class="card file">${openBtn(`<span class="ext" style="--c:${topicColor(item)}">${esc(ext(item.fileName))}</span><span class="lk"><span class="ttl">${esc(item.title)}</span><span class="site">${esc([KIND_LABEL[item.kind], item.size ? size(item.size) : "", `${estimateMinutes(item)} min`].filter(Boolean).join(" · "))}</span></span>`, `Open ${name}`)}</div>`;
    }
  }
}

function siteLine(item) {
  return [item.site || host(item.url) || (item.kind === KIND.VIDEO ? "Video" : ""), `${estimateMinutes(item)} min`].filter(Boolean).join(" · ");
}
function bookLine(item) { return item.book ? `A book to read${item.book.author ? ` · ${item.book.author}` : ""}` : ""; }

/** Tint posts whose picture has a colour, once each picture has loaded. */
function tintVisible(root) {
  root.querySelectorAll(".post").forEach((el) => {
    const item = byId(el.dataset.id);
    if (!item || item.tint) return;
    const img = el.querySelector(".pic img");
    if (!img) return;
    const go = () => tintFrom(item, img.currentSrc || img.src);
    if (img.complete && img.naturalWidth) go(); else img.addEventListener("load", go, { once: true });
  });
}

/* ---- What a tap does ---- */

/* Taps anywhere on the screen go through one listener, set once at start. */
function bindScreen() {
  app.addEventListener("click", onTimelineClick);
  // Double-tap a photo to love it.
  let lastTap = { id: "", at: 0 };
  app.addEventListener("pointerup", (e) => {
    const box = e.target.closest("[data-dbl]");
    if (!box) return;
    const now = Date.now();
    if (lastTap.id === box.dataset.dbl && now - lastTap.at < 320) {
      lastTap = { id: "", at: 0 };
      dblLoved = now;
      setLove(box.dataset.dbl, true);
    } else lastTap = { id: box.dataset.dbl, at: now };
  });
}

/* What each render needs wired: the search box and arrow keys on the tabs. */
function bindTimeline(tl) {
  const q = $("#all-q", tl);
  if (q) q.addEventListener("input", () => {
    state.allQuery = q.value; state.allShown = PAGE;
    clearTimeout(q._t);
    q._t = setTimeout(() => { render(); const n = $("#all-q"); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 250);
  });
  $(".tabs", tl).addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    selectTab(state.tab === "today" ? "all" : "today");
  });
}

let dblLoved = 0;
async function onTimelineClick(e) {
  const t = e.target;
  const hit = (sel) => t.closest(sel);
  let b;
  if ((b = hit("[data-tab]"))) { selectTab(b.dataset.tab); return; }
  if ((b = hit("[data-act]"))) { runAct(b.dataset.act, b); return; }
  if ((b = hit("[data-filter]"))) { state.allFilter = +b.dataset.filter; state.allShown = PAGE; render({ top: false }); return; }
  if ((b = hit("[data-v]"))) { timelineVerdict(b.dataset.id, b.dataset.v); return; }
  if ((b = hit("[data-undo]"))) { undoRecent(b.dataset.undo); return; }
  if ((b = hit("[data-love]"))) { const it = byId(b.dataset.love); if (it) setLove(it.id, !it.loved); return; }
  if ((b = hit("[data-reply]"))) { openReply(b.dataset.reply); return; }
  if ((b = hit("[data-edit]"))) { openEdit(b.dataset.edit); return; }
  if ((b = hit("[data-requeue]"))) { const it = byId(b.dataset.requeue); if (it) { await saveItem(restore(it)); render(); toast("Back in your queue."); } return; }
  if ((b = hit("[data-rescue]"))) { await addToEdition(b.dataset.rescue); tick(true); state.tab = "today"; render({ top: true }); toast("Added to today."); return; }
  if ((b = hit("[data-keep]"))) {
    const before = byId(b.dataset.keep);
    await saveItem(restore(before)); tick(true); render();
    toast("Kept. Back in your queue for three more weeks.", { action: "Undo", onAction: async () => { await saveItem(before); render(); } });
    return;
  }
  if ((b = hit("[data-letgo]"))) {
    const before = byId(b.dataset.letgo);
    await saveItem(applyVerdict(before, VERDICT.LET_GO, { stage: "edition" })); tick(true); render();
    toast("Let go.", { action: "Undo", onAction: async () => { await saveItem(before); render(); } });
    return;
  }
  if ((b = hit("[data-open]"))) {
    if (Date.now() - dblLoved < 400) return; // the second tap of a double-tap loves; it doesn't open
    const id = b.dataset.open;
    // Wait a beat on photos, so a double-tap can claim the tap first.
    if (b.closest("[data-dbl]")) { setTimeout(() => { if (Date.now() - dblLoved > 400) openStories("single", id); }, 330); return; }
    openStories("single", id);
  }
}

function selectTab(tab) {
  if (state.tab === tab) return;
  state.tab = tab;
  render({ top: true });
  $(`#tab-${tab}`)?.focus();
}

function runAct(act, btn) {
  if (act === "add") openAdd();
  else if (act === "settings") openSettings();
  else if (act === "show-more") { state.allShown += PAGE; render(); }
  else if (act === "one-more") oneMore();
  else if (act === "discover") {
    btn.disabled = true;
    findNew($("#end-st")).then((n) => { btn.disabled = false; if (n) render(); });
  }
}

async function oneMore() {
  const ids = new Set(state.edition?.ids || []);
  const extra = buildEdition(state.items.filter((i) => !ids.has(i.id)), null, { size: 1 });
  if (!extra.ids.length) { toast("Your queue is empty."); return; }
  await addToEdition(extra.ids[0]);
  render();
  document.getElementById("p-" + extra.ids[0])?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "center" });
}

/** A verdict from the timeline. The post stays, stamped, with Undo; Today's count and end card follow. */
async function timelineVerdict(id, verdict) {
  const before = byId(id);
  if (!before) return;
  const wasLeft = leftToday();
  const rec = await recordVerdict(before, verdict);
  if (!rec) return;
  state.recent.set(id, { verdict, stage: rec.stage, undo: rec.undo });
  render();
  const nowLeft = leftToday();
  const words = {
    [VERDICT.LET_GO]: rec.whyNot ? `Let go. ${{ topic: "Fewer like it.", known: "Deeper ones next time.", long: "Shorter ones next time.", site: "That site is blocked." }[rec.whyNot]}` : "Let go.",
    [VERDICT.LATER]: rec.stage === "inbox" ? "Kept. It'll come back in a later day's six." : rec.after.fadedAt ? "Moved later eight times. It's waiting under Fading." : "Back tomorrow.",
    [VERDICT.DONE]: doneToast(before),
  };
  if (wasLeft > 0 && nowLeft === 0 && state.tab === "today") {
    buzz([12, 60, 18]);
    $(".end.win")?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "center" });
    toast("You cleared today.", { action: "Undo", onAction: () => undoRecent(id) });
  } else {
    buzz(8);
    toast(words[verdict], { action: "Undo", onAction: () => undoRecent(id) });
  }
}

async function undoRecent(id) {
  const r = state.recent.get(id);
  if (!r) return;
  await r.undo();
  state.recent.delete(id);
  render();
  document.querySelector(`#p-${CSS.escape(id)} [data-v="${r.verdict}"]`)?.focus();
  live("Undone");
}

async function setLove(id, on) {
  const cur = byId(id);
  if (!cur) return;
  await saveItem({ ...cur, loved: on ? Date.now() : undefined });
  refreshPost(id);
  if (on) {
    const burst = document.querySelector(`#p-${CSS.escape(id)} .burst`);
    if (burst && !reduced()) { burst.classList.remove("go"); void burst.offsetWidth; burst.classList.add("go"); }
    buzz(10);
    tick();
  }
  live(on ? "Loved" : "Love removed");
}

/* Replies: notes to yourself under a post, kept on the item and searchable. */
function openReply(id) {
  const item = byId(id);
  if (!item) return;
  const wrap = sheet(`
    <div class="sheet-head"><h2>Reply to yourself</h2><button class="x" type="button" data-close aria-label="Close">${I.close}</button></div>
    <p class="note">${esc(headline(item))}</p>
    <div class="field"><label for="reply-in">What did this make you think?</label>
      <textarea id="reply-in" rows="3" maxlength="600"></textarea></div>
    <span class="st" id="reply-st" role="status"></span>
    <button class="btn primary" type="button" id="reply-go">Post reply</button>`, { label: "Reply to yourself" });
  const input = $("#reply-in", wrap);
  const post = async () => {
    const text = input.value.trim();
    if (!text) { const st = $("#reply-st", wrap); st.textContent = "Write something first."; st.classList.add("err"); input.focus(); return; }
    const cur = byId(id);
    if (!cur) { closeSheet(); toast("That item was deleted."); return; }
    await saveItem({ ...cur, replies: [...(cur.replies || []), { id: db.newId(), text: text.slice(0, 600), at: Date.now() }] });
    closeSheet();
    render();
    tick(true);
    toast("Reply added.");
  };
  $("#reply-go", wrap).addEventListener("click", post);
  input.addEventListener("input", () => { const st = $("#reply-st", wrap); st.textContent = ""; st.classList.remove("err"); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) post(); });
  input.focus();
}

function buzz(pattern) { try { navigator.vibrate && navigator.vibrate(pattern); } catch { /* not supported */ } }
function reduced() { return matchMedia("(prefers-reduced-motion: reduce)").matches; }
function live(msg) {
  let el = $("#live");
  if (!el) { el = document.createElement("div"); el.id = "live"; el.className = "sr-only"; el.setAttribute("aria-live", "polite"); document.body.appendChild(el); }
  el.textContent = "";
  setTimeout(() => { el.textContent = msg; }, 30);
}

/* ================= Reader (stories) ================= */

let lastOpener = null;
function openStories(mode, startId) {
  lastOpener = document.activeElement;
  let ids;
  if (mode === "inbox") ids = state.items.filter((i) => i.status === STATUS.INBOX).sort((a, b) => a.created - b.created).map((i) => i.id);
  else if (mode === "edition") ids = editionView(state.items, state.edition).open.map((i) => i.id);
  else ids = [startId];
  if (!ids.length) { toast(mode === "inbox" ? "Nothing new to sort." : "Nothing to read."); return; }
  const index = Math.max(0, startId ? ids.indexOf(startId) : 0);
  state.reader = { mode, ids, index, total: ids.length };
  $(".reader")?.remove();
  const el = document.createElement("div");
  el.className = "reader";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "Reading");
  el.innerHTML = `<div class="reader-inner">
    <div class="segs" id="segs" aria-hidden="true"></div>
    <div class="reader-top" id="reader-top">
      <button class="x" type="button" data-close aria-label="Close">${I.close}</button>
      <span class="where" id="where"></span><span class="left" id="time-left"></span>
      <button class="x" type="button" id="reader-edit" aria-label="Edit">${I.edit}</button>
    </div>
    <span class="stamp" id="stamp" aria-hidden="true"></span>
    <article class="story" id="story"></article>
    <div class="verdicts" id="verdicts" role="group" aria-label="Verdict"></div>
  </div>`;
  document.body.appendChild(el);
  el.querySelector("[data-close]").addEventListener("click", closeReader);
  $("#reader-edit", el).addEventListener("click", () => { const r = state.reader; const id = r && r.ids[r.index]; if (id) openEdit(id); });
  bindStoryGestures(el);
  bindPull({ scroller: $("#story", el), target: $("#story", el), host: $(".reader-inner", el), label: "Release to go back", onBack: closeReader });
  el.addEventListener("pointerdown", wakeReader, true);
  renderStory();
  wakeReader();
  $("#app")?.setAttribute("inert", "");
  el.querySelector("[data-close]")?.focus();
}

function closeReader() {
  $(".reader")?.remove();
  $("#app")?.removeAttribute("inert");
  state.reader = null;
  clearTimeout(readerTimer);
  render();
  if (lastOpener && document.contains(lastOpener)) lastOpener.focus();
}

let readerTimer = 0;
function wakeReader() {
  const el = $(".reader");
  if (!el) return;
  el.classList.remove("asleep");
  clearTimeout(readerTimer);
  readerTimer = setTimeout(() => $(".reader")?.classList.add("asleep"), IDLE_MS);
}

function renderStory() {
  const r = state.reader;
  const el = $(".reader");
  if (!r || !el) return;
  const story = $("#story", el), verdicts = $("#verdicts", el);
  $("#segs", el).innerHTML = r.mode === "single" ? "" : Array.from({ length: r.total }, (_, i) => `<span class="${i < r.total - r.ids.length + r.index + 1 ? "on" : ""}"></span>`).join("");
  story.style.transform = ""; story.style.opacity = "";
  const id = r.ids[r.index];
  const item = id && byId(id);
  if (!item) {
    $("#where", el).textContent = "";
    $("#time-left", el).textContent = "";
    story.innerHTML = `<div class="end">
      <h1>${r.mode === "inbox" ? "All sorted." : "You're done."}</h1>
      <p class="summary">${r.mode === "inbox" ? "Everything new has a verdict. What you kept will come back in an edition." : "That's today's edition. The next one is set tomorrow morning."}</p>
      <button class="btn primary" type="button" data-end>Back</button></div>`;
    verdicts.innerHTML = "";
    $("#reader-edit", el).hidden = true;
    $("[data-end]", story).addEventListener("click", closeReader);
    return;
  }
  $("#reader-edit", el).hidden = false;
  $("#where", el).textContent = item.book ? feedMeta(item) : [KIND_LABEL[item.kind], item.url ? host(item.url) : ""].filter(Boolean).join(" · ");
  story.innerHTML = storyBody(item);
  story.scrollTop = 0;
  hydrate(story);
  updateTimeLeft(item);

  const open = item.status === STATUS.QUEUED || item.status === STATUS.INBOX;
  const b = (v, label, icon, primary) => `<button type="button" class="${primary ? "primary" : ""}" data-v="${v}">${icon}<span>${label}</span></button>`;
  if (open) {
    const keep = item.status === STATUS.INBOX || isFaded(item);
    verdicts.innerHTML = b(VERDICT.LET_GO, "Let go", I.letGo) + b(VERDICT.LATER, keep ? "Keep" : "Later", keep ? I.keep : I.later) + b(VERDICT.DONE, item.book ? "Read it" : "Done", I.done, true);
  } else {
    verdicts.innerHTML = `<button type="button" data-requeue>${I.requeue}<span>Requeue</span></button><button type="button" class="primary" data-close>${I.done}<span>Close</span></button>`;
  }
  verdicts.querySelectorAll("[data-v]").forEach((x) => x.addEventListener("click", () => storyVerdict(item.id, x.dataset.v)));
  $("[data-requeue]", verdicts)?.addEventListener("click", async () => { await saveItem(restore(item)); toast("Back in the queue.", { high: true }); renderStory(); });
  $("[data-close]", verdicts)?.addEventListener("click", closeReader);
}

function storyBody(item) {
  let content = "";
  switch (item.kind) {
    case KIND.NOTE: content = `<div class="prose">${esc(item.text || item.title)}</div>`; break;
    case KIND.QUOTE: {
      const t = item.text || item.title;
      content = `<blockquote class="quote ${t.length > 180 ? "long" : ""}">“${esc(t)}”</blockquote>${item.author ? `<p class="cite">${esc(item.author)}</p>` : ""}`;
      break;
    }
    case KIND.LINK: content = imgFull(item) + (item.text ? `<div class="prose">${esc(item.text)}</div>` : ""); break;
    case KIND.PHOTO: content = imgFull(item); break;
    case KIND.VIDEO: content = item.videoId
      ? `<div class="yt"><iframe title="${esc(item.title)}" src="https://www.youtube-nocookie.com/embed/${esc(item.videoId)}?playsinline=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`
      : item.blobId ? `<div class="media"><video controls playsinline data-blob="${esc(item.blobId)}"></video></div>` : ""; break;
    case KIND.AUDIO: content = `<audio controls data-blob="${esc(item.blobId)}"></audio>`; break;
    case KIND.TEXT: content = `<div class="prose" data-textblob="${esc(item.blobId)}">Loading…</div>`; break;
    case KIND.PDF: content = `<iframe class="doc" title="${esc(item.title)}" data-blob="${esc(item.blobId)}"></iframe>`; break;
    default: content = `<div class="file-tag"><span class="ext">${esc(ext(item.fileName))}</span><span class="name">${esc(item.fileName || "")}${item.size ? " · " + size(item.size) : ""}</span></div>`;
  }
  const words = item.kind === KIND.QUOTE || item.kind === KIND.NOTE;
  const busy = state.enriching.has(item.id);
  const source = item.blobId && ![KIND.PHOTO, KIND.TEXT].includes(item.kind)
    ? `<a class="source" data-blob="${esc(item.blobId)}" href="#" target="_blank" rel="noopener">${I.open}<span>Open the file</span><span class="host">${esc(item.fileName || "")}</span></a>`
    : item.url ? `<a class="source" href="${esc(item.url)}" target="_blank" rel="noopener">${I.open}<span>${item.videoId ? "Watch on YouTube" : "Read the original"}</span><span class="host">${esc(host(item.url))}</span></a>` : "";
  return `${words ? "" : `<h1>${esc(item.title)}</h1>`}
    ${item.book && item.book.author ? `<p class="cite">by ${esc(item.book.author)}</p>` : ""}
    ${content}
    ${busy ? '<p class="summary accent">Reading it…</p>' : item.extended
      ? `<div class="extended"><span class="label">Summary</span>${item.extended.split(/\n\s*\n/).map((para) => `<p>${esc(para.trim())}</p>`).join("")}</div>`
      : item.summary ? `<p class="summary">${esc(item.summary)}</p>` : ""}
    ${item.points && item.points.length ? `<ul class="points">${item.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
    ${item.transcript ? `<span class="label">Text in the image</span><div class="prose">${esc(item.transcript)}</div>` : ""}
    ${item.note ? `<div class="prose mine-note">${esc(item.note)}</div>` : ""}
    ${item.replies && item.replies.length ? `<div class="story-replies"><span class="label">Your replies</span>${item.replies.map((r) => `<p><span class="when">${esc(friendlyWhen(r.at))}</span>${esc(r.text)}</p>`).join("")}</div>` : ""}
    ${source}
    ${item.ai && item.ai.why ? `<p class="why-line"><b>Why today</b>${esc(item.ai.why)}</p>` : ""}`;
}

function imgFull(item) {
  const gone = `onerror="this.closest('.media')?.remove()"`;
  const pic = item.kind === KIND.PHOTO && item.blobId && !item.cover?.pinned ? { blobId: item.blobId } : pictureOf(item);
  if (!pic) return "";
  const credit = creditLine(pic);
  const alt = esc(item.imageAlt || item.title);
  const img = pic.blobId ? `<img alt="${alt}" ${gone} data-blob="${esc(pic.blobId)}">` : `<img alt="${alt}" ${gone} referrerpolicy="no-referrer" src="${esc(pic.src)}">`;
  return `<div class="media">${img}</div>${credit ? `<p class="credit">${pic.link ? `<a href="${esc(pic.link)}" target="_blank" rel="noopener">${esc(credit)}</a>` : esc(credit)}</p>` : ""}`;
}

function updateTimeLeft(item) {
  const story = $("#story"), left = $("#time-left");
  if (!story || !left) return;
  const total = estimateMinutes(item) * 60;
  const max = story.scrollHeight - story.clientHeight;
  const p = max > 4 ? story.scrollTop / max : 0;
  const s = Math.round(total * (1 - p));
  left.textContent = s >= 60 ? `${Math.ceil(s / 60)} min left` : s > 0 ? "Under a minute" : "";
}

/*
 * Record a verdict. On a suggestion, Let go first asks "Not for me" with an
 * optional reason, and every verdict on a suggestion trains the suggestion
 * profile. Returns null if you backed out, else { after, undo } where undo
 * puts back the item and what was learned.
 */
/** What a verdict changes on an item, and so all that Undo puts back. */
const VERDICT_FIELDS = ["status", "queuedAt", "doneAt", "archivedAt", "deferredAt", "skips", "fadedAt", "washedOut", "readNow", "history", "whyNot"];

async function recordVerdict(before, verdict) {
  let whyNot = null;
  if (verdict === VERDICT.LET_GO && before.suggested) {
    whyNot = await askWhyNot(before);
    if (whyNot === undefined) return null;
  }
  const stage = before.status === STATUS.INBOX ? "inbox" : "edition";
  // Keeping a faded item resets its clock instead of counting another deferral.
  const after = verdict === VERDICT.LATER && isFaded(before) ? restore(before) : applyVerdict(before, verdict, { stage });
  if (whyNot) after.whyNot = whyNot;
  await saveItem(after);
  const prevSuggest = state.suggest;
  let learned = null;
  if (before.suggested) {
    learned = state.suggest = learnFromSuggestion(state.suggest, before, verdict, whyNot);
    await db.meta.set("suggest", state.suggest);
  }
  tick(true);
  return {
    after, stage, whyNot,
    // Undo puts back only what the verdict changed, onto the item as it is now, so a reply,
    // love, edit or summary added since is kept. What a suggestion taught is taken back only
    // if nothing has changed the suggestion profile since.
    undo: async () => {
      const cur = byId(before.id) || after;
      const back = { ...cur };
      for (const f of VERDICT_FIELDS) { if (f in before) back[f] = before[f]; else delete back[f]; }
      await saveItem(back);
      if (learned && state.suggest === learned) { state.suggest = prevSuggest; await db.meta.set("suggest", prevSuggest); }
    },
  };
}

/** "Not for me": one tap says why, or let it go without a reason. Resolves undefined if closed. */
function askWhyNot(item) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    const host = item.url ? item.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] : "";
    const wrap = sheet(`
      <div class="sheet-head"><h2>Not for me</h2><button class="x" type="button" data-close aria-label="Close">${I.close}</button></div>
      <p class="note">${esc(headline(item))}. Say why and future suggestions change. It's optional.</p>
      <div class="why-not">
        <button class="btn" type="button" data-why="${WHY_NOT.TOPIC}"><b>${WHY_NOT_LABEL.topic}</b><span>Fewer suggestions on ${esc((item.tags || []).slice(0, 2).join(" and ") || "this topic")}</span></button>
        <button class="btn" type="button" data-why="${WHY_NOT.KNOWN}"><b>${WHY_NOT_LABEL.known}</b><span>Only deeper pieces on this from now on</span></button>
        <button class="btn" type="button" data-why="${WHY_NOT.LONG}"><b>${WHY_NOT_LABEL.long}</b><span>Lean toward shorter pieces</span></button>
        ${host ? `<button class="btn" type="button" data-why="${WHY_NOT.SITE}"><b>${WHY_NOT_LABEL.site}</b><span>Never suggest from ${esc(host)}</span></button>` : ""}
      </div>
      <button class="btn ghost" type="button" data-why="">Just let it go</button>`, { label: "Not for me" });
    wrap._onClose = () => finish(undefined);
    wrap.querySelectorAll("[data-why]").forEach((b) => b.addEventListener("click", () => {
      finish(b.dataset.why || null);
      closeSheet();
    }));
  });
}

async function storyVerdict(id, verdict) {
  $(".reader")?.remove();
  $("#app")?.removeAttribute("inert");
  state.reader = null;
  clearTimeout(readerTimer);
  await timelineVerdict(id, verdict);
  document.querySelector(`#p-${CSS.escape(id)} .undo, #p-${CSS.escape(id)} .act`)?.focus();
}

/** Swipe left or right for the next or previous item, without a verdict. */
function bindStoryGestures(el) {
  const story = $("#story", el);
  let x0 = 0, y0 = 0, dx = 0, dy = 0, active = false, horizontal = false;
  story.addEventListener("pointerdown", (e) => {
    if (e.target.closest("a, button, video, audio, iframe, input")) return;
    active = true; horizontal = false; x0 = e.clientX; y0 = e.clientY; dx = dy = 0;
  });
  story.addEventListener("pointermove", (e) => {
    if (!active) return;
    dx = e.clientX - x0; dy = e.clientY - y0;
    if (!horizontal) {
      if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.6) { horizontal = true; story.setPointerCapture(e.pointerId); story.classList.add("dragging"); }
      else return;
    }
    story.style.transform = `translateX(${dx * 0.6}px)`;
  });
  const end = () => {
    if (!active) return;
    active = false;
    story.classList.remove("dragging");
    if (!horizontal) return;
    const r = state.reader;
    const step = dx < -70 ? 1 : dx > 70 ? -1 : 0;
    if (r && step && r.index + step >= 0 && r.index + step < r.ids.length) {
      r.index += step;
      story.style.opacity = "0";
      story.style.transform = `translateX(${step > 0 ? -40 : 40}px)`;
      setTimeout(renderStory, 120);
    } else {
      story.style.transform = "";
    }
  };
  story.addEventListener("pointerup", end);
  story.addEventListener("pointercancel", () => { active = false; story.classList.remove("dragging"); story.style.transform = ""; });
  story.addEventListener("scroll", () => {
    const id = state.reader?.ids[state.reader.index];
    if (id) updateTimeLeft(byId(id));
    wakeReader();
  }, { passive: true });
  el.addEventListener("keydown", (e) => {
    const r = state.reader;
    if (!r) return;
    if (e.key === "ArrowRight" && r.index < r.ids.length - 1) { r.index++; renderStory(); }
    if (e.key === "ArrowLeft" && r.index > 0) { r.index--; renderStory(); }
  });
}
function feedMeta(item) {
  if (item.book) return ["Book", item.book.author ? `by ${item.book.author}` : ""].filter(Boolean).join(" · ");
  return [KIND_LABEL[item.kind] || "Item", `${estimateMinutes(item)} min`, item.url ? host(item.url) : item.author || ""].filter(Boolean).join(" · ");
}

/** What Done is called for this item: for a book, it means you've read it (whenever that was). */
const doneLabel = (item) => (item && item.book ? "I've read it" : "Done");
const doneToast = (item) => (item && item.book ? "Marked as read. It counts toward what you like, not as a recent read." : "Marked done.");
/* ================= Edit and delete =================
 * Edit: one sheet with only the fields that kind of item has. Delete is for
 * good (Let go keeps the item in your history so Shoebox learns from it), so
 * it says so, and gives a few seconds to undo instead of asking first.
 */

function openEdit(id) {
  const item = byId(id);
  if (!item) return;
  const words = item.kind === KIND.QUOTE || item.kind === KIND.NOTE;
  const hasUrl = item.kind === KIND.LINK || item.kind === KIND.VIDEO || Boolean(item.url);
  const f = (key, label, value, { area = false, type = "text", hint = "", ph = "" } = {}) => `<div class="field">
      <label for="ed-${key}">${label}${hint ? ` <span class="hint">${hint}</span>` : ""}</label>
      ${area
        ? `<textarea id="ed-${key}" rows="4" placeholder="${esc(ph)}">${esc(value || "")}</textarea>`
        : `<input id="ed-${key}" type="${type}" autocomplete="off" ${type === "url" ? 'inputmode="url" autocapitalize="off" spellcheck="false"' : ""} placeholder="${esc(ph)}" value="${esc(value ?? "")}">`}
    </div>`;
  const wrap = sheet(`
    <div class="sheet-head"><h2>Edit</h2><button class="x" type="button" data-close aria-label="Close">${I.close}</button></div>
    <p class="note">${esc(KIND_LABEL[item.kind] || "Item")} · saved ${esc(ago(item.created))}${item.fileName ? ` · ${esc(item.fileName)}` : ""}</p>
    ${item.kind !== KIND.PHOTO ? `<div class="pic-edit">
      <div class="lbl"><span id="ed-pic-l">Picture</span></div>
      <div class="picks" id="ed-picks" role="group" aria-labelledby="ed-pic-l"></div>
      <span class="note" id="ed-pic-note" role="status"></span>
      <input type="file" id="ed-pic-file" accept="image/*" hidden>
    </div>` : ""}
    ${words ? f("text", item.kind === KIND.QUOTE ? "Quote" : "Note", item.text, { area: true }) : f("title", "Title", item.title)}
    ${item.kind === KIND.QUOTE || item.kind === KIND.VIDEO ? f("author", item.kind === KIND.QUOTE ? "Who said it" : "Channel", item.author) : ""}
    ${item.kind === KIND.PHOTO ? `<label class="check"><input type="checkbox" id="ed-book" ${item.book ? "checked" : ""}><span>This is a book I want to read<small>Done becomes "I've read it", and counts toward what you like rather than as a recent read.</small></span></label>
      ${f("author", "Author", item.book?.author || item.author)}` : ""}
    ${hasUrl ? f("url", "Link", item.url, { type: "url", ph: "https://" }) : ""}
    ${f("why", "Why you saved it", item.why, { hint: "(shown at the top of the post)", ph: item.hook || "Read this before the roadmap review" })}
    ${!item.why && item.hook ? `<button class="chip use-guess" type="button" id="ed-guess">Start from ${APP}'s guess</button>` : ""}
    ${!words ? f("note", "Your note", item.kind === KIND.LINK ? item.text : item.note, { area: true, ph: "Anything you want to remember about it" }) : ""}
    <div class="two">
      ${f("tags", "Tags", (item.tags || []).join(", "), { ph: "scrum, ai" })}
      ${f("minutes", "Minutes", estimateMinutes(item), { type: "number" })}
    </div>
    ${ai.settings.enabled() ? `<button class="btn retag" type="button" id="ed-retag">Re-tag with AI</button>` : ""}
    <span class="st" id="ed-st" role="status"></span>
    <button class="btn primary" type="button" id="ed-save">Save</button>
    <div class="danger">
      <button class="btn ghost-danger" type="button" id="ed-delete">${I.trash}Delete for good</button>
      <p class="note">Removes it${item.blobId ? " and its file" : ""} from this phone. To keep it in your history so ${APP} learns from it, use Let go instead.</p>
    </div>`, { tall: true, label: "Edit" });

  const val = (k) => $(`#ed-${k}`, wrap)?.value;
  if (item.kind !== KIND.PHOTO) bindPictureEdit(wrap, id);
  const save = async () => {
    const cur = byId(id);
    if (!cur) { closeSheet(); return; }
    const next = { ...cur, editedAt: Date.now() };
    if (words) {
      const t = (val("text") || "").trim();
      if (!t) { $("#ed-st", wrap).textContent = "It can't be empty."; $("#ed-st", wrap).classList.add("err"); return; }
      next.text = t;
      next.title = t.slice(0, 140);
    } else {
      next.title = (val("title") || "").trim().slice(0, 140) || cur.title;
      if (cur.kind === KIND.LINK) next.text = (val("note") || "").trim() || undefined;
      else next.note = (val("note") || "").trim() || undefined;
    }
    if (val("author") !== undefined) next.author = (val("author") || "").trim() || undefined;
    if (hasUrl) {
      const u = (val("url") || "").trim();
      if (u && !/^https?:\/\//i.test(u)) { $("#ed-st", wrap).textContent = "A link starts with https://"; $("#ed-st", wrap).classList.add("err"); return; }
      next.url = u || undefined;
      const vid = u ? youtubeId(u) : null;
      if (cur.kind === KIND.VIDEO || vid) { next.videoId = vid || undefined; if (vid) next.kind = KIND.VIDEO; }
    }
    if (cur.kind === KIND.PHOTO) {
      const isBook = $("#ed-book", wrap)?.checked;
      if (isBook) Object.assign(next, asBook(next, { title: next.title, author: next.author }), { hook: "A book you want to read" });
      else delete next.book;
    }
    next.why = (val("why") || "").trim().slice(0, 140);
    const typed = canonTags((val("tags") || "").split(","), {}, MAX_TAGS);
    const had = new Set((cur.tags || []).map(normTag));
    // A tag you type yourself is wanted, even one you once merged away or deleted.
    const released = releaseTags(state.tagAliases, typed.filter((t) => !had.has(t)));
    if (Object.keys(released).length !== Object.keys(state.tagAliases).length) {
      state.tagAliases = released;
      await db.meta.set("tagAliases", released);
    }
    next.tags = typed;
    const m = Math.round(+val("minutes"));
    next.minutes = Number.isFinite(m) && m > 0 ? Math.min(m, 600) : cur.minutes;
    await saveItem(next);
    tick(true);
    closeSheet();
    render();
    toast("Saved.");
  };
  $("#ed-save", wrap).addEventListener("click", save);
  wrap.querySelectorAll("input").forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); }));
  $("#ed-guess", wrap)?.addEventListener("click", (e) => {
    const input = $("#ed-why", wrap);
    input.value = byId(id)?.hook || "";
    input.focus(); input.select();
    e.currentTarget.remove();
  });
  $("#ed-retag", wrap)?.addEventListener("click", async () => {
    const btn = $("#ed-retag", wrap), st = $("#ed-st", wrap);
    const cur = byId(id);
    if (!cur) return;
    btn.disabled = true;
    st.classList.remove("err");
    st.textContent = "Reading it again for tags…";
    try {
      const blob = cur.blobId && [KIND.PHOTO, KIND.PDF, KIND.TEXT].includes(cur.kind) ? await db.blobs.get(cur.blobId) : null;
      const tags = tidyTags(await ai.retag(cur, blob, { vocab: vocab() }));
      if (!tags.length) throw new Error("No tags came back. Try again.");
      $("#ed-tags", wrap).value = tags.join(", ");
      st.textContent = "New tags filled in. Save to keep them.";
    } catch (e) {
      noteError(e, { quiet: true, where: "re-tag" });
      st.textContent = e.message || "Couldn't re-tag.";
      st.classList.add("err");
    } finally { btn.disabled = false; }
  });
  $("#ed-delete", wrap).addEventListener("click", () => { closeSheet(); deleteItem(id); });
}

/* The Picture section of Edit: changes apply at once and show on the post behind the sheet. */
function bindPictureEdit(wrap, id) {
  const box = $("#ed-picks", wrap), note = $("#ed-pic-note", wrap), file = $("#ed-pic-file", wrap);
  const current = (it) => {
    if (it.coverOff) return "none";
    if (it.cover && it.cover.blobId && it.cover.pinned) return "own";
    const i = (box._cands || []).findIndex((c) => c.src === it.imageUrl);
    return i >= 0 ? i : null;
  };
  const show = async () => {
    const it = byId(id);
    if (!it) return;
    const own = it.cover && it.cover.blobId ? await blobUrl(it.cover.blobId) : "";
    // The picture it has now is always offered, even when it didn't come from the page's list (a video's still).
    const cands = [...(it.imageCands || [])];
    if (it.imageUrl && !cands.some((c) => c.src === it.imageUrl)) cands.unshift({ src: it.imageUrl, alt: it.imageAlt || null });
    box._cands = cands;
    box.innerHTML = pickTilesHtml(cands, current(it), { ownUrl: own, suggest: false })
      + (it.kind === KIND.LINK && it.url && ai.relayBase() ? `<button class="pk txt" type="button" data-pk="again">${I.requeue}<span>Look again</span></button>` : "");
    const pic = pictureOf(it);
    note.textContent = it.coverOff ? "No picture. The post shows the link on its own."
      : !pic ? (cands.length ? "Pick one, or add your own." : it.kind === KIND.LINK && !ai.relayBase() ? "Pictures from the page need the relay (Settings)." : "No pictures found. Add your own.")
      : pic.from === "mine" ? "Your photo." : pic.from === "page" ? "From the page." : "";
  };
  const after = async () => { await show(); refreshPost(id); render(); };
  box.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-pk]");
    if (!b) return;
    const k = b.dataset.pk;
    const cur = byId(id);
    if (k === "own") { unlock(); file.click(); return; }
    if (k === "again") {
      note.textContent = "Looking at the page again…";
      await saveItem({ ...cur, imageCands: undefined, picSettled: undefined, pageTries: 0 });
      await fetchPage(byId(id));
      const fresh = byId(id);
      const usable = await usableImages(fresh.imageCands || []);
      await saveItem({ ...fresh, imageCands: usable, picSettled: Date.now() });
      await after();
      return;
    }
    const c = k === "none" ? null : (box._cands || [])[+k];
    if (k !== "none" && !c) return;
    if (cur.cover && cur.cover.blobId) await db.blobs.remove(cur.cover.blobId);
    if (k === "none") await saveItem({ ...cur, cover: null, coverOff: true, picPicked: true, tint: undefined });
    else {
      await saveItem({ ...cur, cover: null, coverOff: false, imageUrl: c.src, imageAlt: c.alt || cur.imageAlt, picPicked: true, tint: undefined });
    }
    tick(true);
    await after();
  });
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    file.value = "";
    if (!f) return;
    const blob = (await shrinkImage(f)) || f;
    const cur = byId(id);
    const blobId = db.newId();
    await db.blobs.put(blobId, blob);
    if (cur.cover && cur.cover.blobId) await db.blobs.remove(cur.cover.blobId);
    await saveItem({ ...cur, cover: { blobId, from: "mine", pinned: true }, coverOff: false, picPicked: true, tint: undefined });
    tick(true);
    await after();
  });
  show();
}

/** A chosen photo, scaled down to a phone screen's worth so it stays small on the device. */
async function shrinkImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
  } catch {
    return null; // a format this browser can't decode: keep the original
  }
}

/*
 * Delete for good, with Undo. The record goes at once; its stored file waits
 * out the undo window, so Undo brings back everything.
 */
async function deleteItem(id) {
  const item = byId(id);
  if (!item) return;
  await db.items.remove(id);
  state.items = state.items.filter((i) => i.id !== id);
  const edAt = state.edition ? state.edition.ids.indexOf(id) : -1;
  if (edAt >= 0) { state.edition = { ...state.edition, ids: state.edition.ids.filter((x) => x !== id) }; await db.meta.set("edition", state.edition); }
  // Take it out of whatever is on screen.
  const r = state.reader, rAt = r ? r.ids.indexOf(id) : -1;
  if (rAt >= 0) {
    r.ids.splice(rAt, 1); r.total -= 1;
    if (r.mode === "single" || !r.ids.length) closeReader();
    else { if (r.index >= r.ids.length) r.index = r.ids.length - 1; renderStory(); }
  }
  tick(true);
  render();
  let undone = false;
  // The files go only once the Undo message has closed without Undo, however long it stayed up.
  const purge = async () => {
    if (undone) return;
    if (item.blobId) await db.blobs.remove(item.blobId);
    if (item.thumbId) await db.blobs.remove(item.thumbId);
    if (item.cover && item.cover.blobId) await db.blobs.remove(item.cover.blobId);
  };
  toast("Deleted.", {
    onExpire: purge,
    action: "Undo",
    onAction: async () => {
      undone = true;
      await saveItem(item);
      if (edAt >= 0 && state.edition) { const ids = [...state.edition.ids]; ids.splice(edAt, 0, id); state.edition = { ...state.edition, ids }; await db.meta.set("edition", state.edition); }
      render();
    },
  });
}
/* ================= Add (sheet) ================= */

function openAdd() {
  const wrap = sheet(`
    <div class="sheet-head"><h2>Add</h2><button class="x" type="button" data-close aria-label="Close">${I.close}</button></div>
    <div class="cap">
      <label class="sr-only" for="cap-text">Link, note, quote or anything</label>
      <textarea id="cap-text" placeholder="Paste a link or a quote, or type a thought.">${esc(state.capText)}</textarea>
    </div>
    <div class="field why-field"><label for="cap-why">Why are you saving this? <span>Optional. It's the first thing you'll see when it comes back.</span></label>
      <input id="cap-why" type="text" autocomplete="off" maxlength="140" placeholder="Read this before the roadmap review" value="${esc(state.capWhy)}"></div>
    <div class="tray" id="cap-tray"></div>
    <div class="cap-pics" id="cap-pics" hidden></div>
    <input type="file" id="cap-own" accept="image/*" hidden>
    <ul class="detect" id="cap-detect" aria-live="polite"></ul>
    <span class="st" id="cap-st" role="status"></span>
    <div class="cap-bar">
      <button class="round" type="button" id="cap-paste" aria-label="Paste from clipboard">${I.paste}</button>
      <button class="save" type="button" id="cap-save">Save</button>
      <button class="round" type="button" id="cap-attach" aria-label="Attach photos or files">${I.attach}</button>
    </div>
    <input type="file" id="in-any" multiple hidden>`, { label: "Add" });
  wrap.classList.add("adding");
  const ta = $("#cap-text", wrap);
  ta.addEventListener("input", () => { state.capText = ta.value; updateDetect(); });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveCapture(); });
  ta.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (!files.length) return;
    e.preventDefault();
    stageFiles(files);
  });
  $("#cap-why", wrap).addEventListener("input", (e) => { state.capWhy = e.target.value; });
  $("#cap-why", wrap).addEventListener("keydown", (e) => { if (e.key === "Enter") saveCapture(); });
  $("#cap-save", wrap).addEventListener("click", saveCapture);
  $("#cap-attach", wrap).addEventListener("click", () => { unlock(); $("#in-any", wrap).click(); });
  $("#cap-paste", wrap).addEventListener("click", pasteIntoBox);
  const own = $("#cap-own", wrap);
  own.addEventListener("change", () => {
    const f = own.files && own.files[0];
    own.value = "";
    if (!f || !state.capPic) return;
    if (state.capPic.ownUrl) URL.revokeObjectURL(state.capPic.ownUrl);
    Object.assign(state.capPic, { ownFile: f, ownUrl: URL.createObjectURL(f), choice: "own", picked: true });
    renderCapPics();
  });
  const input = $("#in-any", wrap);
  input.addEventListener("change", () => { stageFiles(Array.from(input.files || [])); input.value = ""; });
  renderTray();
  updateDetect();
  $("#cap-text", wrap).focus();
}

/** What will be saved, line by line, so there are no surprises. */
function stagedDrafts() {
  const fromText = detectText(state.capText);
  const fromFiles = state.capFiles.map((f) => ({ ...draftFromFile(f.file), blobId: "staged" }));
  return [...fromText, ...fromFiles];
}

function updateDetect() {
  const list = $("#cap-detect");
  if (!list) return;
  const drafts = stagedDrafts();
  list.innerHTML = drafts.map((d) => {
    const detail = d.kind === KIND.NOTE || d.kind === KIND.QUOTE ? "" : d.fileName || (d.videoId ? "" : d.url) || "";
    return `<li>${I.arrow}<span class="what">${esc(describeDraft(d))}</span><span class="d">${esc(detail)}</span></li>`;
  }).join("");
  const save = $("#cap-save");
  save.classList.toggle("ready", drafts.length > 0);
  save.textContent = drafts.length > 1 ? `Save ${drafts.length} items` : "Save";
  schedulePreview();
}

function stageFiles(files) {
  for (const file of files) state.capFiles.push({ file, url: file.type.startsWith("image/") ? URL.createObjectURL(file) : "" });
  renderTray();
  updateDetect();
}

function renderTray() {
  const tray = $("#cap-tray");
  if (!tray) return;
  tray.innerHTML = state.capFiles.map((f, i) => `<div class="thumb">
      ${f.url ? `<img alt="" src="${f.url}">` : `<span class="ext">${esc(ext(f.file.name))}</span>`}
      <button type="button" data-unstage="${i}" aria-label="Remove ${esc(f.file.name)}">${I.close}</button></div>`).join("");
  tray.hidden = !state.capFiles.length;
  tray.querySelectorAll("[data-unstage]").forEach((b) => b.addEventListener("click", () => {
    const [gone] = state.capFiles.splice(+b.dataset.unstage, 1);
    if (gone && gone.url) URL.revokeObjectURL(gone.url);
    renderTray();
    updateDetect();
  }));
}

/** Paste fills the box (or the tray, for images) so you can see it before saving. */
async function pasteIntoBox() {
  unlock();
  try {
    const { text, files } = await readClipboard();
    if (!text && !files.length) { setCapStatus("The clipboard is empty.", true); return; }
    if (text) {
      state.capText = state.capText.trim() ? `${state.capText.trim()}\n${text}` : text;
      $("#cap-text").value = state.capText;
    }
    if (files.length) stageFiles(files);
    else updateDetect();
    setCapStatus("");
  } catch {
    // Some browsers refuse clipboard reads; long-press paste in the box always works.
    $("#cap-text").focus();
    setCapStatus("Clipboard access was blocked. Long-press the box and choose Paste.", true);
  }
}

/** While Add is open, paste and drop fill the box instead of saving straight away. */
function stageTransfer(dt) {
  const files = Array.from(dt.files || []);
  if (files.length) { stageFiles(files); return; }
  const text = dt.getData("text/plain") || dt.getData("text/uri-list");
  if (!text) return;
  state.capText = state.capText.trim() ? `${state.capText.trim()}\n${text}` : text;
  const ta = $("#cap-text");
  if (ta) ta.value = state.capText;
  updateDetect();
}

function setCapStatus(msg, err) {
  const st = $("#cap-st");
  if (!st) return;
  st.textContent = msg;
  st.classList.toggle("err", !!err);
}

async function saveCapture() {
  unlock();
  const text = (state.capText || "").trim();
  if (!text && !state.capFiles.length) {
    $("#cap-text").focus();
    setCapStatus("Type, paste or attach something first.", true);
    return;
  }
  setCapStatus("Saving…");
  const out = [];
  if (text) out.push(...await captureText(text, "drop"));
  for (const f of state.capFiles) {
    out.push(await captureFile(f.file, "drop"));
    if (f.url) URL.revokeObjectURL(f.url);
  }
  const why = (state.capWhy || "").trim().slice(0, 140);
  if (why) for (const it of out) if (it) { it.why = why; await db.items.put(it); }
  for (let k = 0; k < out.length; k++) out[k] = await applyCapPicture(out[k]);
  if (state.capPic?.ownUrl) URL.revokeObjectURL(state.capPic.ownUrl);
  state.capText = "";
  state.capFiles = [];
  state.capWhy = "";
  state.capPic = null;
  closeSheet();
  afterCapture(out);
}
/* ================= Choosing a picture =================
 * The same picker in Add and in Edit: the page's own pictures (only ones
 * that loaded and are big enough), your own photo, or no picture.
 */

function pickTilesHtml(cands, chosen, { ownUrl = "", busy = false, suggest = true } = {}) {
  const tiles = cands.map((c, i) => `<button class="pk" type="button" data-pk="${i}" aria-pressed="${chosen === i}"
      aria-label="${esc(c.alt || `Picture ${i + 1}`)}${c.w ? `, ${c.w} by ${c.h}` : ""}${suggest && i === 0 ? ", suggested" : ""}">
      <img alt="" src="${esc(c.src)}" referrerpolicy="no-referrer" loading="lazy">${suggest && i === 0 ? '<span class="badge" aria-hidden="true">Suggested</span>' : ""}</button>`).join("");
  return `${tiles}${busy ? `<span class="pk wait" role="status">Looking at the page…</span>` : ""}
    <button class="pk txt" type="button" data-pk="own" aria-pressed="${chosen === "own"}">${ownUrl ? `<img alt="" src="${esc(ownUrl)}">` : `${I.attach}<span>Your photo</span>`}</button>
    <button class="pk txt" type="button" data-pk="none" aria-pressed="${chosen === "none"}">${I.letGo}<span>No picture</span></button>`;
}

/* ---- In Add: once the box holds a single link, read its page for pictures ---- */

let previewTimer = 0;
function schedulePreview() {
  clearTimeout(previewTimer);
  const drafts = stagedDrafts();
  const link = drafts.length === 1 && drafts[0].kind === KIND.LINK && drafts[0].url ? drafts[0].url : "";
  const p = state.capPic;
  if (!link || !ai.relayBase()) {
    if (p && !p.ownFile) state.capPic = null;
    renderCapPics();
    return;
  }
  if (p && p.url === link) return;
  state.capPic = { url: link, status: "loading", list: [], choice: 0, ownFile: p?.ownFile || null, ownUrl: p?.ownUrl || "" };
  if (p?.ownFile) state.capPic.choice = "own";
  renderCapPics();
  previewTimer = setTimeout(() => loadPreview(link), 500);
}

async function loadPreview(url) {
  let list = [];
  try {
    const res = await withTimeout(fetch(`${ai.relayBase()}/preview?url=${encodeURIComponent(url)}`), 15000);
    if (res.ok) {
      const data = await res.json();
      list = await usableImages(candidatesOf(data), { timeout: 6000 });
      if (state.capPic && state.capPic.url === url) state.capPic.page = { title: data.title, description: data.description, site: data.site };
    }
  } catch (e) { noteError(e, { quiet: true, where: "add: page pictures" }); }
  const p = state.capPic;
  if (!p || p.url !== url) return;
  p.status = "done";
  p.list = list.slice(0, 6);
  if (p.choice !== "own" && p.choice !== "none" && !p.list.length) p.choice = "none";
  renderCapPics();
}

function renderCapPics() {
  const box = $("#cap-pics");
  if (!box) return;
  const p = state.capPic;
  if (!p) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  const found = p.status === "loading" ? "Looking…" : p.list.length ? `${p.list.length} found on the page` : "None found on the page";
  box.innerHTML = `<div class="lbl"><span id="cap-pics-l">Picture</span><span>${found}</span></div>
    <div class="picks" role="group" aria-labelledby="cap-pics-l">${pickTilesHtml(p.list, p.choice, { ownUrl: p.ownUrl, busy: p.status === "loading" })}</div>`;
  box.querySelectorAll("[data-pk]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.pk;
    if (k === "own") { $("#cap-own").click(); return; }
    p.choice = k === "none" ? "none" : +k;
    p.picked = true;
    renderCapPics();
  }));
}

/** Put the picture choice from Add onto the link it was made for. */
async function applyCapPicture(item) {
  const p = state.capPic;
  if (!p || !item || item.kind !== KIND.LINK || item.url !== p.url) return item;
  const upd = { ...item };
  if (p.page) {
    if (p.page.title && upd.title === titleFromUrl(upd.url)) upd.title = String(p.page.title).slice(0, 140);
    if (p.page.description && !upd.summary) upd.summary = String(p.page.description).slice(0, 200);
    if (p.page.site) upd.site = String(p.page.site).slice(0, 60);
  }
  if (p.status === "done" && p.list.length) { upd.imageCands = p.list; upd.picSettled = p.picked ? Date.now() : undefined; }
  if (p.choice === "own" && p.ownFile) {
    const blob = (await shrinkImage(p.ownFile)) || p.ownFile;
    const blobId = db.newId();
    await db.blobs.put(blobId, blob);
    Object.assign(upd, { cover: { blobId, from: "mine", pinned: true }, picPicked: true });
  } else if (p.choice === "none" && p.picked) {
    Object.assign(upd, { coverOff: true, picPicked: true, picSettled: Date.now() });
  } else if (typeof p.choice === "number" && p.list[p.choice]) {
    const c = p.list[p.choice];
    Object.assign(upd, { imageUrl: c.src, imageAlt: c.alt || undefined, picPicked: !!p.picked });
  }
  await db.items.put(upd);
  return upd;
}

/* ================= Settings (sheet) ================= */

function openSettings() {
  const c = counts(state.items);
  const wrap = sheet(`
    <div class="sheet-head"><h2>Settings</h2><button class="x" type="button" data-close aria-label="Close">${I.close}</button></div>
    <div class="section">
      <h3>Your photo</h3>
      <div class="me-row"><span id="set-me">${avatarHtml("lg")}</span>
        <div class="two">
          <button class="btn" type="button" id="set-me-choose">${state.avatar ? "Change" : "Choose a photo"}</button>
          <button class="btn" type="button" id="set-me-clear" ${state.avatar ? "" : "disabled"}>Remove</button>
        </div></div>
      <input type="file" id="set-me-file" accept="image/*" hidden>
      <p class="note">Shown on every post you wrote. It stays on this phone.</p>
    </div>
    <div class="section">
      <h3>AI (Anthropic API)</h3>
      <div class="field"><label for="set-key">API key</label>
        <input id="set-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(ai.settings.key())}"></div>
      <div class="two">
        <button class="btn primary" type="button" id="set-save">Save and test</button>
        <button class="btn" type="button" id="set-clear">Remove key</button>
      </div>
      <span class="st" id="set-st" role="status"></span>
      <p class="note">The key stays on this device and is sent only to Anthropic. With it, Shoebox titles and tags each new save (photos and PDFs too), picks the best picture from a link's page, ranks your queue from what you finish and let go, and can search for new reading. Each is a paid API call on your account.</p>
    </div>
    <div class="section">
      <h3>Relay and discovery</h3>
      <div class="field"><label for="set-pplx">Perplexity API key <span class="hint">(optional)</span></label>
        <input id="set-pplx" type="password" autocomplete="off" spellcheck="false" placeholder="pplx-…" value="${esc(ai.settings.pplxKey())}"></div>
      <div class="field"><label for="set-relay">Relay address</label>
        <input id="set-relay" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://edition-relay.you.workers.dev" value="${esc(ai.settings.relay())}"></div>
      <div class="two">
        <button class="btn primary" type="button" id="set-pplx-save">Save and test</button>
        <button class="btn" type="button" id="set-pplx-clear">Remove key</button>
      </div>
      <span class="st" id="set-pplx-st" role="status"></span>
      <p class="note">The relay is your own free Cloudflare Worker (steps in the repo's relay folder). Its address looks like https://edition-relay.yourname.workers.dev. It reads link pages so posts get their own pictures, and it carries Perplexity calls. The Perplexity key is optional: with it, Find something new asks Perplexity; without it, Claude does the searching. The key stays on this phone.</p>
    </div>
    <div class="section">
      <h3>Today</h3>
      <div class="two">
        <button class="btn" type="button" id="set-rebuild">Rebuild today</button>
        <button class="btn" type="button" id="set-discover" ${ai.settings.canDiscover() ? "" : "disabled"}>Find something new</button>
      </div>
      <span class="st" id="set-ed-st" role="status"></span>
    </div>
    <div class="section">
      <h3>Suggestions</h3>
      <div id="sug-profile"></div>
    </div>
    <div class="section" id="set-tags">
      <h3>Tags</h3>
      <div id="tag-list"></div>
    </div>
    <div class="section">
      <h3>Sounds</h3>
      <div class="chips" role="group" aria-label="Sounds">
        <button class="chip" type="button" data-sound="1" aria-pressed="${soundOn()}">On</button>
        <button class="chip" type="button" data-sound="0" aria-pressed="${!soundOn()}">Off</button>
      </div>
      <p class="note">A soft click when you give a verdict or save something.</p>
    </div>
    <div class="section">
      <h3>Samples</h3>
      <div class="two">
        <button class="btn" type="button" id="set-samples-load">Reload samples</button>
        <button class="btn" type="button" id="set-samples-clear" ${state.items.some((i) => i.sample) ? "" : "disabled"}>Remove samples</button>
      </div>
      <span class="st" id="set-sm-st" role="status"></span>
    </div>
    <div class="section">
      <h3>Backup</h3>
      <div class="two">
        <button class="btn" type="button" id="set-export">Export</button>
        <button class="btn" type="button" id="set-import">Import</button>
      </div>
      <input type="file" id="set-import-file" accept="application/json,.json" hidden>
      <span class="st" id="set-bk-st" role="status"></span>
      <p class="note">Exports titles, notes, links and history as JSON. Photos and files stay on this device.</p>
    </div>
    <div class="section">
      <h3>Problems</h3>
      <p class="note" id="set-pr-n"></p>
      <div class="two">
        <button class="btn" type="button" id="set-pr-copy">Copy diagnostics</button>
        <button class="btn" type="button" id="set-pr-clear">Clear</button>
      </div>
      <p class="note">Errors are kept on this phone (the last 20) and never sent anywhere. Copy them into a message when something isn't working. No titles, notes, links or keys are included.</p>
    </div>
    <p class="version">${APP} ${VERSION} · ${c.inbox} new · ${c.queued} queued · ${c.done} done · ${c.archived} let go</p>`, { label: "Settings" });

  const st = $("#set-st", wrap);
  const say = (el, msg, err) => { el.textContent = msg; el.classList.toggle("err", !!err); };
  $("#set-save", wrap).addEventListener("click", async () => {
    ai.settings.setKey($("#set-key", wrap).value.trim());
    ai.settings.setModel(""); // always the default model; clears any old override
    if (!ai.settings.enabled()) { say(st, "No key saved."); return; }
    say(st, "Testing…");
    try {
      await ai.testKey();
      say(st, "Key works. Reading your saves now.");
      state.items = state.items.map((i) => ({ ...i, enrichTries: 0 }));
      $("#set-discover", wrap).disabled = false;
      enrichPending();
    } catch (e) {
      noteError(e, { quiet: true, where: "settings: Anthropic test" });
      say(st, e.message, true);
      refreshProblems(wrap);
    }
  });
  $("#set-clear", wrap).addEventListener("click", () => {
    ai.settings.setKey("");
    $("#set-key", wrap).value = "";
    say(st, `Key removed. ${APP} works without AI.`);
  });
  renderSuggestProfile(wrap);
  renderTagList(wrap);
  refreshProblems(wrap);
  $("#set-pr-copy", wrap).addEventListener("click", copyDiagnostics);
  $("#set-pr-clear", wrap).addEventListener("click", () => { clearProblems(); refreshProblems(wrap); });
  const pSt = $("#set-pplx-st", wrap);
  $("#set-pplx-save", wrap).addEventListener("click", async () => {
    ai.settings.setPplxKey($("#set-pplx", wrap).value.trim());
    const relay = ai.relayBase($("#set-relay", wrap).value);
    ai.settings.setRelay(relay);
    $("#set-relay", wrap).value = relay;
    if (!relay && !ai.settings.pplxEnabled()) { say(pSt, "Nothing saved yet. Add the relay address."); return; }
    say(pSt, "Testing…");
    const notes = [];
    // The relay on its own: it reads link pages for pictures, no Perplexity key needed.
    if (relay) {
      try {
        const res = await withTimeout(fetch(`${relay}/preview?url=${encodeURIComponent("https://example.com/")}`), 15000);
        if (res.status === 403) throw new Error("The relay answered but refused this app. Check ALLOWED_ORIGINS in the relay code.");
        if (!res.ok) throw new Error(`The relay answered with an error (${res.status}). Check the address.`);
        const data = await res.json();
        notes.push(Array.isArray(data.images) ? "Relay works. Links get pictures from their pages." : "Relay works, but it's the older version: redeploy it to get the full picture picker.");
        state.items = state.items.map((i) => (i.imageCands ? i : { ...i, pageTries: 0 }));
        picturePending();
      } catch (e) {
        noteError(e, { quiet: true, where: "settings: relay test" });
        say(pSt, e.message === "Failed to fetch" || e.message === "Timed out" ? "Couldn't reach the relay. Check the address, and that the Worker is deployed." : e.message, true);
        refreshProblems(wrap);
        return;
      }
    }
    if (ai.settings.pplxEnabled()) {
      try {
        await ai.testPplxKey();
        notes.push("Perplexity key works. Find something new uses Perplexity.");
        $("#set-discover", wrap).disabled = false;
      } catch (e) {
        noteError(e, { quiet: true, where: "settings: Perplexity test" });
        say(pSt, [...notes, e.message].join(" "), true);
        refreshProblems(wrap);
        return;
      }
    }
    say(pSt, notes.join(" "));
  });
  $("#set-pplx-clear", wrap).addEventListener("click", () => {
    ai.settings.setPplxKey("");
    $("#set-pplx", wrap).value = "";
    $("#set-discover", wrap).disabled = !ai.settings.canDiscover();
    say(pSt, ai.settings.enabled() ? "Key removed. Claude does the searching." : "Key removed.");
  });
  const edSt = $("#set-ed-st", wrap);
  $("#set-rebuild", wrap).addEventListener("click", async () => {
    say(edSt, ai.settings.enabled() ? "Ranking your queue…" : "Rebuilding…");
    try {
      await ensureEdition({ force: true });
      closeSheet(); render(); toast("Today is rebuilt.");
    } catch (e) { say(edSt, e.message || "Could not rebuild.", true); }
  });
  $("#set-discover", wrap).addEventListener("click", () => findNew(edSt).then((n) => { refreshProblems(wrap); if (n) render(); }));
  const smSt = $("#set-sm-st", wrap);
  $("#set-samples-load", wrap).addEventListener("click", async () => {
    const n = await seedSamples({ force: true });
    await ensureEdition();
    closeSheet();
    state.tab = "today";
    render({ top: true });
    picturePending();
    toast(`Loaded ${n} fresh samples. They're on Today.`);
  });
  $("#set-samples-clear", wrap).addEventListener("click", async () => {
    const n = await removeSamples();
    $("#set-samples-clear", wrap).disabled = true;
    say(smSt, `Removed ${n} sample items.`);
    render();
  });
  bindAvatarSettings(wrap);
  wrap.querySelectorAll("[data-sound]").forEach((b) => b.addEventListener("click", () => {
    setSound(b.dataset.sound === "1");
    wrap.querySelectorAll("[data-sound]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    if (soundOn()) { unlock(); tick(true); }
  }));
  $("#set-export", wrap).addEventListener("click", async () => {
    const blob = new Blob([await db.exportJson()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `shoebox-backup-${dayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  const importInput = $("#set-import-file", wrap);
  $("#set-import", wrap).addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", async () => {
    const f = importInput.files[0];
    if (!f) return;
    try {
      const n = await db.importJson(await f.text());
      state.items = await db.items.all();
      closeSheet(); render(); toast(`Imported ${n} items.`);
    } catch (e) { say($("#set-bk-st", wrap), e.message || "That file couldn't be read.", true); }
  });
}

/* What your answers to suggestions taught, with a way to undo any of it. */
function renderSuggestProfile(wrap) {
  const box = $("#sug-profile", wrap);
  if (!box) return;
  const p = { ...emptySuggestProfile(), ...state.suggest };
  const list = (map, sign) => Object.entries(map).filter(([, v]) => sign * v > 0).sort((a, b) => sign * (b[1] - a[1]));
  const welcome = list(p.topics, 1), avoid = list(p.topics, -1), deeper = list(p.deeper, 1);
  const chips = (rows, kind) => rows.map(([t]) => `<button class="chip unlearn" type="button" data-unlearn="${kind}" data-key="${esc(t)}" aria-label="Forget ${esc(t)}">${esc(t)} ${I.close}</button>`).join("");
  const max = suggestMaxMinutes(p);
  const row = (label, body) => body ? `<div class="sug-row"><span class="k">${label}</span><div class="chips">${body}</div></div>` : "";
  const any = welcome.length || avoid.length || deeper.length || p.blocked.length || max;
  box.innerHTML = any ? `
    ${row("More of", chips(welcome, "topics"))}
    ${row("Less of", chips(avoid, "topics"))}
    ${row("Only deeper pieces on", chips(deeper, "deeper"))}
    ${row("Never from", p.blocked.map((h) => `<button class="chip unlearn" type="button" data-unlearn="blocked" data-key="${esc(h)}" aria-label="Unblock ${esc(h)}">${esc(h)} ${I.close}</button>`).join(""))}
    ${row("Length", max ? `<button class="chip unlearn" type="button" data-unlearn="shorter" aria-label="Any length again">Under ${max} min ${I.close}</button>` : "")}
    <p class="note">Learned from your answers to suggestions, never from your own saves. Tap one to forget it.</p>
    <button class="btn" type="button" id="sug-reset">Forget all of it</button>`
    : `<p class="note">Suggestions come after your own saves, two a day. When one isn't for you, Let go asks why (optional). What it learns shows here, and you can undo any of it.</p>`;
  const save = async () => { await db.meta.set("suggest", state.suggest); renderSuggestProfile(wrap); };
  box.querySelectorAll("[data-unlearn]").forEach((b) => b.addEventListener("click", async () => {
    const k = b.dataset.unlearn, key = b.dataset.key;
    const next = { ...emptySuggestProfile(), ...state.suggest, topics: { ...state.suggest.topics }, deeper: { ...state.suggest.deeper } };
    if (k === "topics") delete next.topics[key];
    else if (k === "deeper") delete next.deeper[key];
    else if (k === "blocked") next.blocked = (next.blocked || []).filter((h) => h !== key);
    else if (k === "shorter") next.shorter = 0;
    state.suggest = next;
    await save();
  }));
  $("#sug-reset", box)?.addEventListener("click", async () => { state.suggest = emptySuggestProfile(); await save(); toast("Forgotten. Suggestions start fresh."); });
}

/* Settings > Your photo: cropped square, scaled down, stored on this phone. */
function bindAvatarSettings(wrap) {
  const file = $("#set-me-file", wrap);
  const paint = () => {
    $("#set-me", wrap).innerHTML = avatarHtml("lg");
    $("#set-me-choose", wrap).textContent = state.avatar ? "Change" : "Choose a photo";
    $("#set-me-clear", wrap).disabled = !state.avatar;
  };
  $("#set-me-choose", wrap).addEventListener("click", () => { unlock(); file.click(); });
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    file.value = "";
    if (!f) return;
    const blob = await squareImage(f, 320);
    if (!blob) { toast("That photo couldn't be read. Try another."); return; }
    const old = await db.meta.get("avatarBlobId", null);
    const id = db.newId();
    await db.blobs.put(id, blob);
    await db.meta.set("avatarBlobId", id);
    if (old) { await db.blobs.remove(old); urls.delete(old); }
    await loadAvatar();
    paint();
    render();
    toast("Your photo is set.");
  });
  $("#set-me-clear", wrap).addEventListener("click", async () => {
    const old = await db.meta.get("avatarBlobId", null);
    await db.meta.set("avatarBlobId", null);
    if (old) { await db.blobs.remove(old); urls.delete(old); }
    state.avatar = "";
    paint();
    render();
  });
}

/** The middle square of a photo, `edge` pixels across, as JPEG. */
async function squareImage(file, edge) {
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(bmp.width, bmp.height);
    const c = document.createElement("canvas");
    c.width = c.height = edge;
    c.getContext("2d").drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, edge, edge);
    return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.88));
  } catch {
    return null;
  }
}

/* ================= Tags ================= */

/* Settings > Tags: every tag with its count; tap one to rename, merge or delete it. */
function renderTagList(wrap) {
  const box = $("#tag-list", wrap);
  if (!box) return;
  const stats = tagStats(state.items);
  const al = Object.entries(state.tagAliases || {}).sort((a, b) => a[0].localeCompare(b[0]));
  box.innerHTML = (stats.length
    ? `<div class="chips tag-chips">${stats.map((s) => `<button class="chip tag-chip" type="button" data-tag="${esc(s.tag)}">${esc(s.tag)} <span class="n">${s.count}</span></button>`).join("")}</div>
       <p class="note">Tap a tag to rename it, merge it into another, or delete it. The AI is shown these tags and reuses them before making new ones.</p>`
    : `<p class="note">No tags yet. With an API key, each save is tagged as it arrives; you can also type tags when you edit an item.</p>`)
    + (al.length ? `<div class="sug-row"><span class="k">Kept from your merges and deletes</span><div class="chips">${al.map(([f, t]) =>
      `<button class="chip unlearn" type="button" data-alias="${esc(f)}" aria-label="Forget ${esc(f)}">${esc(f)} ${t ? `→ ${esc(t)}` : "(deleted)"} ${I.close}</button>`).join("")}</div>
      <p class="note">New tags follow these. Tap one to forget it, so the old name can be used again.</p></div>` : "");
  box.querySelectorAll("[data-tag]").forEach((b) => b.addEventListener("click", () => openTag(b.dataset.tag)));
  box.querySelectorAll("[data-alias]").forEach((b) => b.addEventListener("click", async () => {
    const next = { ...state.tagAliases };
    delete next[b.dataset.alias];
    state.tagAliases = next;
    await db.meta.set("tagAliases", next);
    renderTagList(wrap);
  }));
}

function backToTags() {
  openSettings();
  $("#set-tags")?.scrollIntoView({ block: "start" });
}

function openTag(tag) {
  const s = tagStats(state.items).find((x) => x.tag === tag) || { tag, count: 0, score: 0 };
  const others = tagStats(state.items).map((x) => x.tag).filter((t) => t !== tag);
  const lean = s.score > 0 ? `Your verdicts lean toward it (+${s.score}).` : s.score < 0 ? `Your verdicts lean away from it (${s.score}).` : "No verdicts on it yet.";
  const wrap = sheet(`
    <div class="sheet-head"><h2>${esc(tag)}</h2><button class="x" type="button" data-close aria-label="Close">${I.close}</button></div>
    <p class="note">On ${s.count} item${s.count === 1 ? "" : "s"}. ${lean}</p>
    <div class="field"><label for="tg-to">New name, or a tag to merge it into</label>
      <input id="tg-to" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" list="tg-others" value="${esc(tag)}"></div>
    <datalist id="tg-others">${others.map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
    ${others.length ? `<div class="chips tag-chips" aria-label="Merge into">${others.slice(0, 12).map((t) => `<button class="chip" type="button" data-into="${esc(t)}">${esc(t)}</button>`).join("")}</div>` : ""}
    <span class="st" id="tg-st" role="status"></span>
    <div class="two">
      <button class="btn" type="button" id="tg-back">Back</button>
      <button class="btn primary" type="button" id="tg-go" disabled>Rename</button>
    </div>
    <div class="danger">
      <button class="btn ghost-danger" type="button" id="tg-del">${I.trash}Delete this tag</button>
      <p class="note">Removes it from every item and keeps the AI from using it again. The items themselves stay.</p>
    </div>`, { label: `Tag ${tag}` });
  const input = $("#tg-to", wrap), go = $("#tg-go", wrap);
  const sync = () => {
    const to = normTag(input.value);
    go.disabled = !to || to === tag;
    go.textContent = others.includes(to) ? `Merge into ${to}` : "Rename";
  };
  input.addEventListener("input", sync);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !go.disabled) go.click(); });
  wrap.querySelectorAll("[data-into]").forEach((b) => b.addEventListener("click", () => { input.value = b.dataset.into; sync(); }));
  $("#tg-back", wrap).addEventListener("click", backToTags);
  go.addEventListener("click", async () => {
    const to = normTag(input.value);
    const merge = others.includes(to);
    const n = await changeTag(tag, to);
    backToTags();
    toast(merge ? `Merged ${tag} into ${to} on ${n} item${n === 1 ? "" : "s"}.` : `Renamed to ${to}.`, { action: "Undo", onAction: undoTagChange });
  });
  $("#tg-del", wrap).addEventListener("click", async () => {
    const n = await changeTag(tag, "");
    backToTags();
    toast(`Deleted ${tag} from ${n} item${n === 1 ? "" : "s"}.`, { action: "Undo", onAction: undoTagChange });
  });
}

/*
 * Rename, merge (to a tag in use) or delete (to "") a tag everywhere: on every
 * item, in what suggestions learned, and as an alias so the AI follows it.
 * Keeps what it replaced, for Undo.
 */
let lastTagChange = null;
async function changeTag(from, to) {
  const changed = renameTag(state.items, from, to);
  lastTagChange = { items: changed.map((c) => byId(c.id)), aliases: state.tagAliases, suggest: state.suggest };
  for (const it of changed) await saveItem(it);
  state.tagAliases = addAlias(state.tagAliases, from, to);
  state.suggest = renameInSuggestProfile(state.suggest, from, to);
  await db.meta.set("tagAliases", state.tagAliases);
  await db.meta.set("suggest", state.suggest);
  refresh();
  return changed.length;
}

async function undoTagChange() {
  const b = lastTagChange;
  if (!b) return;
  lastTagChange = null;
  for (const it of b.items) if (it) await saveItem(it);
  state.tagAliases = b.aliases;
  state.suggest = b.suggest;
  await db.meta.set("tagAliases", b.aliases);
  await db.meta.set("suggest", b.suggest);
  refresh();
  if ($("#tag-list")) renderTagList($(".sheet-wrap"));
}
/* ================= Problems and diagnostics ================= */

function refreshProblems(wrap) {
  const n = $("#set-pr-n", wrap);
  if (!n) return;
  const last = problems[problems.length - 1];
  n.textContent = problems.length
    ? `${problems.length} logged on this phone. Latest: ${last.where}: ${last.msg}`
    : "Nothing logged.";
  $("#set-pr-clear", wrap).disabled = !problems.length;
}

/** Everything useful for fixing a problem, and nothing private. */
async function diagnostics() {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const mb = (n) => (n / 1048576).toFixed(1) + " MB";
  const c = counts(state.items);
  const relay = ai.relayBase();
  return [
    `${APP} ${VERSION}, ${new Date().toISOString()}`,
    navigator.userAgent,
    `Home Screen app: ${matchMedia("(display-mode: standalone)").matches || navigator.standalone ? "yes" : "no"}; window ${innerWidth}x${innerHeight}; screen height ${fit.screen}; app height ${fit.used}${fit.short ? " (page was short, sized to screen)" : ""}; bottom inset ${getComputedStyle(document.documentElement).getPropertyValue("--safe-b").trim() || "env"}; offline copy: ${navigator.serviceWorker?.controller ? "yes" : "no"}`,
    `Items: ${c.inbox} inbox, ${c.queued} queued, ${c.done} done, ${c.archived} let go; storage ${est ? `${mb(est.usage)} of ${mb(est.quota)}` : "unknown"}`,
    `Anthropic key: ${ai.settings.enabled() ? "set" : "none"}; Perplexity key: ${ai.settings.pplxEnabled() ? "set" : "none"}; relay: ${relay ? new URL(relay).host : "none"}`,
    `Problems (${problems.length}):`,
    ...(problems.length ? problems.slice().reverse().map(formatProblem) : ["- none"]),
  ].join("\n");
}

async function copyDiagnostics() {
  const text = await diagnostics();
  try { await navigator.clipboard.writeText(text); toast("Diagnostics copied. Paste them into a message."); }
  catch { showToCopy(text); }
}

/** When the clipboard is blocked: show the text selected, ready to copy by hand. */
function showToCopy(text) {
  const wrap = sheet(`
    <div class="sheet-head"><h2>Diagnostics</h2><button class="x" type="button" data-close aria-label="Close">${I.close}</button></div>
    <p class="note">Select all and copy, then paste into a message.</p>
    <textarea class="diag" readonly rows="14">${esc(text)}</textarea>`, { label: "Diagnostics" });
  const ta = $(".diag", wrap);
  ta.focus(); ta.select();
}
/* ================= Sheets, toasts, global input ================= */

let lastFocus = null;
function sheet(html, { tall = false, label = "" } = {}) {
  closeSheet();
  expireToast(); // a leftover message shouldn't sit over the sheet
  lastFocus = document.activeElement;
  const wrap = document.createElement("div");
  wrap.className = "sheet-wrap";
  wrap.innerHTML = `<div class="sheet ${tall ? "tall" : ""}" role="dialog" aria-modal="true" aria-label="${esc(label)}"><span class="grab" aria-hidden="true"></span>${html}</div>`;
  wrap.addEventListener("click", (e) => { if (e.target === wrap) closeSheet(); });
  wrap.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeSheet));
  document.body.appendChild(wrap);
  const panel = $(".sheet", wrap);
  bindPull({ scroller: panel, target: panel, host: wrap, onBack: closeSheet });
  $("#app")?.setAttribute("inert", "");
  $(".reader")?.setAttribute("inert", "");
  requestAnimationFrame(() => { if (!wrap.contains(document.activeElement)) (panel.querySelector("[data-close]") || panel).focus(); });
  return wrap;
}

function closeSheet() {
  const s = $(".sheet-wrap");
  if (s) { const cb = s._onClose; s._onClose = null; s.remove(); if (cb) cb(); }
  if (!$(".reader")) $("#app")?.removeAttribute("inert");
  $(".reader")?.removeAttribute("inert");
  if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
}

/*
 * Pull down and release to go back, as in Tabs. At the top of a scrolling
 * pane, pull down: the pane follows at half the finger's pace and a pill says
 * where release will take you; past 90px it lights up, and letting go goes
 * back. Pull less and it springs back. Touch events, because iOS hands a
 * pointer gesture to the scroller before a pull can claim it.
 */
/*
 * Sheets use the same gesture without the pill: the sheet follows the finger
 * one to one and closes past 110px or on a quick flick, like any phone sheet.
 */
const PULL = 90, DRAG_CLOSE = 110;
function bindPull({ scroller, target, host, label, onBack }) {
  const drag = !label; // a sheet: plain drag to close
  const tip = document.createElement("div");
  if (!drag) {
    tip.className = "pull-tip";
    tip.setAttribute("aria-hidden", "true");
    tip.innerHTML = `${I.down}<span>${esc(label)}</span>`;
    host.appendChild(tip);
  }
  let x0 = 0, y0 = null, t0 = 0, dy = 0, lit = false;
  const willClose = () => drag ? dy >= DRAG_CLOSE || (dy > 40 && dy / Math.max(1, Date.now() - t0) > 0.6) : dy >= PULL;
  const reset = () => {
    y0 = null; dy = 0; lit = false;
    tip.style.opacity = ""; tip.classList.remove("go");
    target.style.transition = "transform 0.2s ease";
    target.style.transform = "";
  };
  scroller.addEventListener("touchstart", (e) => {
    if (scroller.scrollTop > 0 || e.touches.length !== 1) return;
    if (e.target.closest("input, textarea, iframe, video, audio, .chips, .tray")) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); dy = 0;
  }, { passive: true });
  scroller.addEventListener("touchmove", (e) => {
    if (y0 == null) return;
    const dx = e.touches[0].clientX - x0;
    dy = e.touches[0].clientY - y0;
    if (dy <= 0 || scroller.scrollTop > 0 || Math.abs(dx) > dy) { if (dy < -4 || Math.abs(dx) > Math.max(dy, 12)) reset(); return; }
    e.preventDefault();
    target.style.transition = "none";
    if (drag) { target.style.transform = `translateY(${dy}px)`; return; }
    target.style.transform = `translateY(${Math.min(dy, PULL * 1.6) * 0.5}px)`;
    tip.style.opacity = String(Math.min(1, dy / PULL));
    const go = dy >= PULL;
    if (go && !lit) tick();
    lit = go;
    tip.classList.toggle("go", go);
  }, { passive: false });
  scroller.addEventListener("touchend", () => {
    if (y0 == null) return;
    const go = willClose();
    if (drag && go) { // slide the rest of the way out, then close
      y0 = null;
      target.style.transition = "transform 0.18s ease-in";
      target.style.transform = "translateY(100%)";
      setTimeout(onBack, 170);
      return;
    }
    reset();
    if (go) onBack();
  });
  scroller.addEventListener("touchcancel", reset);
}

let toastTimer;
/** Close the message on screen; whatever it was waiting on (a delete's file purge) goes ahead. */
function expireToast(el = $(".toast")) {
  if (!el) return;
  el.remove();
  const f = el._onExpire;
  el._onExpire = null;
  if (f) f();
}

function toast(msg, { action, onAction, onExpire, high = false, sticky = false } = {}) {
  expireToast();
  clearTimeout(toastTimer);
  const el = document.createElement("div");
  el.className = "toast" + (high || state.reader ? " high" : "");
  el.setAttribute("role", "status");
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action)}</button>` : ""}`;
  el._onExpire = onExpire || null;
  if (action) $("button", el).addEventListener("click", () => { el._onExpire = null; el.remove(); onAction && onAction(); });
  document.body.appendChild(el);
  // Long enough to read and reach Undo; held while a finger or the keyboard is on it.
  const arm = () => { clearTimeout(toastTimer); if (!sticky) toastTimer = setTimeout(() => expireToast(el), action ? 7000 : 3500); };
  el.addEventListener("pointerenter", () => clearTimeout(toastTimer));
  el.addEventListener("pointerleave", arm);
  el.addEventListener("focusin", () => clearTimeout(toastTimer));
  el.addEventListener("focusout", arm);
  arm();
}

const refresh = () => render();

function wireGlobal() {
  window.addEventListener("error", (e) => noteError(e, { where: "page" }));
  window.addEventListener("unhandledrejection", (e) => noteError(e, { where: "promise" }));
  onFirstProblem(() => toast("Something went wrong. Your saves are safe.", { action: "Copy details", onAction: copyDiagnostics }));
  window.addEventListener("pointerdown", unlock, { once: true });
  // iOS ignores the viewport's zoom limits; block pinch gestures on the page itself.
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("paste", async (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (!e.clipboardData) return;
    e.preventDefault();
    if ($(".sheet-wrap.adding")) { stageTransfer(e.clipboardData); return; }
    afterCapture(await captureTransfer(e.clipboardData, "paste"));
  });
  const zone = document.createElement("div");
  zone.className = "dropzone";
  zone.textContent = "Drop to save";
  document.body.appendChild(zone);
  let depth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; zone.classList.add("on"); });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) zone.classList.remove("on"); });
  window.addEventListener("drop", async (e) => {
    e.preventDefault(); depth = 0; zone.classList.remove("on");
    if (!e.dataTransfer) return;
    if ($(".sheet-wrap.adding")) { stageTransfer(e.dataTransfer); return; }
    afterCapture(await captureTransfer(e.dataTransfer, "drop"));
  });
  document.addEventListener("keydown", (e) => {
    const s = $(".sheet-wrap");
    // Keep the keyboard inside an open sheet.
    if (s && e.key === "Tab") {
      const f = [...s.querySelectorAll("button, input, textarea, select, a[href], [tabindex]:not([tabindex='-1'])")].filter((x) => !x.disabled && !x.hidden && x.offsetParent !== null);
      if (f.length) {
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
        else if (!s.contains(document.activeElement)) { first.focus(); e.preventDefault(); }
      }
      return;
    }
    if (e.key !== "Escape") return;
    if (s) closeSheet();
    else if (state.reader) closeReader();
  });
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "hidden") { const t = $(".toast"); if (t && t._onExpire) expireToast(t); return; }
    if (document.visibilityState !== "visible") return;
    const before = state.items.length;
    const day = state.edition && state.edition.date;
    await importShares();
    await ensureEdition();
    if (state.items.length !== before || (state.edition && state.edition.date !== day)) {
      if (state.edition && state.edition.date !== day) state.recent.clear();
      if (!state.reader && !$(".sheet-wrap")) render();
      picturePending();
      enrichPending();
    }
  });
}

/*
 * Once, after updating from Edition: links that had a stock photo found for
 * them (not one you chose) lose it and have their page read again, so the
 * picture comes from the page itself.
 */
async function migratePictures() {
  if (await db.meta.get("picturesV", 0) >= 2) return;
  const changed = [];
  state.items = state.items.map((i) => {
    if (i.cover && i.cover.from === "search" && !i.cover.pinned) {
      const next = { ...i, cover: null, coverTries: undefined, tint: undefined };
      if (i.kind === KIND.LINK && !i.imageUrl) next.pageTries = 0;
      changed.push(next);
      return next;
    }
    return i;
  });
  if (changed.length) await db.items.putMany(changed);
  await db.meta.set("picturesV", 2);
}

/* ================= Small formatters ================= */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function ago(ts, short = false) {
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (short) return d <= 0 ? "today" : `${d}d`;
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}
function host(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }
function ext(name) { const e = String(name || "").split(".").pop(); return e && e !== name ? e.slice(0, 4).toUpperCase() : "FILE"; }
function size(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; }
function withTimeout(p, ms) { return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("Timed out")), ms))]); }


boot().catch((e) => {
  noteError(e, { quiet: true, where: "start" });
  $("#splash")?.remove();
  app.innerHTML = `<main class="tl"><section class="end"><h2>Something broke.</h2><p>${esc(e && e.message)}</p></section></main>`;
});
