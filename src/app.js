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
  friendlyWhen, usablePicture, discoveryItems, schoolToday,
  setAside, wakeAside, bringBackNow, asideChoices, fromDateInput, toDateInput, shortDate, reminderIcs,
} from "./model.js";
import * as db from "./db.js";
import * as push from "./push.js";
import { parseIcs, eventsOn, calLink, cleanEventTitle, eventPlace, freeGaps, barRange } from "./calendar.js";
import * as daily from "./daily.js";
import { captureText, captureFile, captureTransfer, readClipboard, captureShares } from "./capture.js";
import { sampleItems, SAMPLES_VERSION } from "./samples.js";
import * as ai from "./ai.js";
import { tick, unlock, soundOn, setSound } from "./feel.js";
import { I, LOGO } from "./icons.js";
import { topicColor, dominantColor, tintInks, focusOf } from "./visuals.js";
import { problems, noteError as logError, onFirstProblem, clearProblems, formatProblem } from "./problems.js";
import { track, trackError, sendReport, statsOn, setStatsOn } from "./stats.js";

export const VERSION = "4.24.3";
const APP = "Shoebox";
const noteError = (e, opts = {}) => { trackError(opts.where || "other"); return logError(e, { ...opts, version: VERSION }); };

const KIND_LABEL = { link: "Link", note: "Note", quote: "Quote", photo: "Photo", pdf: "PDF", text: "Text", video: "Video", audio: "Audio", file: "File" };
const ALL_FILTERS = [
  { label: "Kept", id: STATUS.QUEUED },
  { label: "New", id: STATUS.INBOX },
  { label: "Set aside", id: STATUS.ASIDE },
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
  capForm: {},       // the other Add fields: title, note, author, tags, minutes (and which you typed)
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

/*
 * The keyboard. iOS doesn't shrink the page for it; it slides the visible
 * part instead, and a fixed sheet ends up half behind the keys. So a sheet
 * follows the visible area (--vv-top, --vv-h): it sits above the keyboard and
 * scrolls inside. When the keyboard goes, the page is put back where it was.
 */
function fitKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const open = fit.inner - vv.height > 120;
  const root = document.documentElement;
  root.style.setProperty("--vv-top", `${Math.max(0, vv.offsetTop)}px`);
  root.style.setProperty("--vv-h", `${vv.height}px`);
  if (open !== root.classList.contains("kb")) {
    root.classList.toggle("kb", open);
    if (!open) { window.scrollTo(0, 0); document.body.scrollTop = 0; }
  }
}
window.visualViewport?.addEventListener("resize", fitKeyboard);
window.visualViewport?.addEventListener("scroll", fitKeyboard);
document.addEventListener("focusin", () => { setTimeout(fitKeyboard, 50); setTimeout(fitKeyboard, 400); });
document.addEventListener("focusout", () => setTimeout(() => { if (!document.documentElement.classList.contains("kb")) window.scrollTo(0, 0); }, 250));

async function boot() {
  const migrated = await db.migrateFromLocalStorage(migrateLegacy).catch(() => 0);
  ai.migrateAiSettings();
  state.items = await db.items.all();
  state.edition = await db.meta.get("edition", null);
  state.suggest = await db.meta.get("suggest", null) || emptySuggestProfile();
  state.tagAliases = await db.meta.get("tagAliases", null) || {};
  state.wonDay = await db.meta.get("wonDay", null);
  await loadAvatar();
  await migratePictures();
  // No sample items any more: a new phone gets the welcome steps instead. Anyone with saves is past them.
  const seeded = 0;
  if (state.items.some((i) => !i.sample) || migrated) setFlag(ONBOARDED, true);
  await importShares();
  await importFromUrl();
  await wakeDue();
  await ensureEdition();
  bindScreen();
  render();
  if (migrated) toast(`Brought over ${migrated} saved item${migrated === 1 ? "" : "s"} from the old version.`);
  else if (seeded) toast(`Loaded ${seeded} sample items. Remove them in Settings.`);
  hideSplash();
  if (state.openId) { jumpTo(state.openId); state.openId = null; }
  wireGlobal();
  picturePending();
  enrichPending();
  schoolPictures();
  registerWorker();
  toNative({ type: "ready" });
  track("open");
  sendReport(ai.relayBase(), { version: VERSION, platform: personal() ? "me" : NATIVE ? "ios" : "web" });
  refreshCalendar();
  loadMorning();
  checkInbox();
  setInterval(() => { if (document.visibilityState === "visible") refreshCalendar(); }, 15 * 60e3);
}

/* Appearance: Match phone, Light or Dark. Kept on this phone; applied before the first paint by index.html. */
const THEME_KEY = "edition.theme";
function themeChoice() { try { return localStorage.getItem(THEME_KEY) || "system"; } catch { return "system"; } }
function setThemeChoice(t) {
  try { if (t === "system") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t); } catch { /* storage blocked */ }
  applyTheme();
}
function applyTheme() {
  const t = themeChoice();
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  // The status bar and browser chrome follow the chosen look too.
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.removeAttribute("media"); m.setAttribute("content", dark ? "#1B1033" : "#FBF8FF"); });
}
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if (themeChoice() === "system") applyTheme(); });
applyTheme();

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
  // A tapped notification, while Shoebox is already open.
  navigator.serviceWorker.addEventListener("message", async (e) => {
    if (e.data?.type !== "open") return;
    await wakeDue();
    render();
    try { const id = new URL(e.data.url).searchParams.get("open"); if (id) jumpTo(id); } catch { /* no item */ }
  });
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
  const before = state.items.find((i) => i.id === item.id);
  if (!before) track(item.suggested ? "story_added" : "save");
  else if (before.status !== item.status) track(`status_${item.status}`);
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

async function afterCapture(list, until = null) {
  list = list.filter(Boolean);
  if (!list.length) return;
  list.forEach((it) => { state.items = [it, ...state.items.filter((i) => i.id !== it.id)]; });
  tick(true);
  state.tab = "today";
  render({ top: true });
  picturePending();
  toast(until ? `Set aside until ${shortDate(until)}. It'll be at the top of Today that morning.`
    : `Saved ${list.length === 1 ? "1 item" : list.length + " items"} to ${APP}.`, {
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
  if (p.get("open")) state.openId = p.get("open");
  // Shoebox Me (Graham's private build) opens with ?me=1: personal modules stay on.
  if (p.get("me") === "1") { try { localStorage.setItem("edition.me", "1"); } catch { /* storage blocked */ } }
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
            title: cur.editedAt || cur.titleMine ? cur.title : out.title || cur.title,
            summary: out.summary || cur.summary,
            tags: cur.tagsMine || !tags.length ? cur.tags : tags,
            minutes: cur.minutesMine ? cur.minutes : out.minutes || cur.minutes,
            intent: out.intent || cur.intent,
            points: out.points.length ? out.points : cur.points,
            transcript: out.transcript || cur.transcript,
            hook: out.hook || cur.hook,
            hookV: out.hook ? ai.HOOK_VERSION : cur.hookV,
            extended: out.extended || cur.extended,
            imageAlt: cur.imageAlt || (cur.kind === KIND.PHOTO ? out.alt : "") || undefined,
            photoQuery: out.photoQuery || cur.photoQuery,
            focus: cur.kind === KIND.PHOTO && cur.blobId && out.focus ? { key: cur.blobId, ...out.focus, by: "ai" } : cur.focus,
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
  findPhotos();
  focusPending();
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
  if (!ai.settings.canDiscover()) { set("Turn on AI in Settings first.", true); return 0; }
  set("Finding today's top stories…");
  try {
    const known = new Set(state.items.map((i) => i.url).filter(Boolean));
    const picks = await ai.discover(interestProfile(discoveryItems(state.items)), { known, guide: suggestionGuide(state.suggest), vocab: vocab(), blocked: state.suggest?.blocked || [] });
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
    set(fresh.length ? `${fresh.length} top stor${fresh.length === 1 ? "y" : "ies"} found. Two show a day, after your own saves.` : "No new top stories. Try again later.");
    if (fresh.length) picturePending();
    return fresh.length;
  } catch (e) {
    noteError(e, { quiet: true, where: "discover" });
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
  if (item.imageUrl) {
    const c = (item.imageCands || []).find((x) => x.src === item.imageUrl);
    if (c && c.credit) return { src: item.imageUrl, from: "search", credit: c.credit, license: c.license, link: c.link };
    return { src: item.imageUrl, from: item.kind === KIND.LINK || item.school ? "page" : "own" };
  }
  // An older version's found stock photo shows only if you chose it yourself.
  if (c && c.blobId) return { blobId: c.blobId, from: "mine" };
  return null;
}

/** The credit under a found photo, linked to where it came from. */
function creditHtml(pic) {
  const credit = creditLine(pic);
  if (!credit) return "";
  return `<p class="credit">${pic.link ? `<a href="${esc(pic.link)}" target="_blank" rel="noopener">${esc(credit)}</a>` : esc(credit)}</p>`;
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
  let pick = usable.length ? 0 : -1, alt = "", focus = null;
  if (usable.length && ai.settings.enabled() && (cur0.enrichedAt || (cur0.enrichTries || 0) >= 2)) {
    try {
      const r = await withTimeout(ai.pickPicture(cur0, usable), 20000);
      pick = r.index; alt = r.alt; focus = r.focus;
    } catch (e) { noteError(e, { quiet: true, where: "pick picture" }); }
  }
  const cur = byId(item.id);
  if (!cur) return;
  const upd = { ...cur, imageCands: usable, picSettled: Date.now() };
  if (!cur.picPicked && !cur.coverOff) {
    upd.imageUrl = pick >= 0 ? usable[pick].src : undefined;
    upd.imageAlt = pick >= 0 ? alt || usable[pick].alt || cur.imageAlt || undefined : cur.imageAlt;
    upd.tint = undefined;
    if (pick >= 0 && focus) upd.focus = { key: usable[pick].src, ...focus, by: "ai" };
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
  findPhotos();
  focusPending();
}

/* ---- A photo for posts with none ----
 * A save with no picture of its own (a note, a file, a link whose page had
 * none worth using) gets one: openly licensed photos for its subject, found
 * through the relay (Openverse), with Claude picking the best and describing
 * it. Credited under the photo. Never for a post where you chose No picture.
 */
let findPhotoRunning = false;
async function findPhotos() {
  if (findPhotoRunning || !ai.relayBase()) return;
  findPhotoRunning = true;
  try {
    const open = (i) => i.status === STATUS.INBOX || i.status === STATUS.QUEUED || state.edition?.ids.includes(i.id);
    for (;;) {
      const next = state.items.find((i) => open(i) && !i.school && !i.sample && i.kind !== KIND.PHOTO && !pictureOf(i)
        && !i.coverOff && !i.picPicked && !i.photoSearched
        && (i.enrichedAt || (i.enrichTries || 0) >= 2 || !ai.settings.enabled())
        && (i.kind !== KIND.LINK || i.picSettled || !i.url));
      if (!next) break;
      const query = next.photoQuery || (next.tags || []).slice(0, 2).join(" ") || firstWords(next.title || "", 4);
      let cands = [];
      try {
        const res = await withTimeout(fetch(`${ai.relayBase()}/photo?q=${encodeURIComponent(query)}`), 15000);
        const data = res.ok ? await res.json() : {};
        cands = (data.photos || []).slice(0, 4).map((p) => ({ src: p.src, credit: p.credit, license: p.license, link: p.link }));
      } catch (e) {
        noteError(e, { quiet: true, where: "find a photo" });
        if (e.message === "Failed to fetch" || e.message === "Timed out") break; // relay unreachable: try again another time
      }
      cands = await usableImages(cands, { timeout: 6000 });
      let pick = cands.length ? 0 : -1, alt = "", focus = null;
      if (cands.length && ai.settings.enabled()) {
        try { const r = await withTimeout(ai.pickPicture(next, cands), 20000); pick = r.index; alt = r.alt; focus = r.focus; } catch (e) {
          noteError(e, { quiet: true, where: "find a photo: pick" });
          if (e && [0, 429, 529].includes(e.status)) break;
        }
      }
      const cur = byId(next.id);
      if (!cur) continue;
      const upd = { ...cur, photoSearched: true };
      if (pick >= 0 && !pictureOf(cur)) {
        const c = cands[pick];
        Object.assign(upd, { imageUrl: c.src, imageAlt: alt || cur.imageAlt || undefined, picSettled: Date.now(), tint: undefined,
          imageCands: [...(cur.imageCands || []), ...cands.map(({ src, w, h, credit, license, link }) => ({ src, w, h, credit, license, link }))],
          ...(focus ? { focus: { key: c.src, ...focus, by: "ai" } } : {}) });
      }
      await saveItem(upd);
      refreshPost(upd.id);
    }
  } finally {
    findPhotoRunning = false;
  }
  focusPending();
}

/* ---- Keeping a picture's subject in view ----
 * Every picture gets a focus point, worked out on the phone (see visuals.js).
 * With an Anthropic key, Claude looks at the picture and its answer replaces
 * the phone's guess. Kept per picture, so a new picture is looked at afresh.
 */

/** Which picture a focus belongs to: a photo's thumbnail and full size share one. */
function focusKey(item, pic) {
  if (!pic) return "";
  if (pic.blobId && item.kind === KIND.PHOTO && (pic.blobId === item.thumbId || pic.blobId === item.blobId)) return item.blobId;
  return pic.blobId || pic.src || "";
}

/** The crop position for a picture's img tag, when its focus is known. */
function focusAttr(item, pic) {
  const f = item.focus;
  if (!f || !Number.isFinite(f.x) || f.key !== focusKey(item, pic)) return "";
  return ` style="object-position:${f.x}% ${f.y}%"`;
}

let focusRunning = false;
async function focusPending() {
  if (focusRunning) return;
  focusRunning = true;
  let aiOff = !ai.settings.enabled();
  try {
    const open = (i) => i.status === STATUS.INBOX || i.status === STATUS.QUEUED || state.edition?.ids.includes(i.id);
    for (;;) {
      const needs = (i) => { const k = focusKey(i, pictureOf(i)); return k && (!i.focus || i.focus.key !== k); };
      const local = state.items.find((i) => open(i) && needs(i));
      if (local) {
        const pic = pictureOf(local), key = focusKey(local, pic);
        const src = pic.blobId ? await blobUrl(pic.blobId) : pic.src;
        const f = await focusOf(src, { relay: ai.relayBase() });
        const cur = byId(local.id);
        if (!cur || focusKey(cur, pictureOf(cur)) !== key) continue;
        await saveItem({ ...cur, focus: f ? { key, ...f, by: "phone" } : { key, by: "none" } });
        refreshPost(cur.id);
        continue;
      }
      if (aiOff) break;
      // Claude reads pictures by address, so this covers pictures from pages; photos get theirs when they're filed.
      const ask = state.items.find((i) => {
        const pic = pictureOf(i);
        return open(i) && pic && pic.src && i.focus && i.focus.key === pic.src && i.focus.by !== "ai" && !i.focus.asked;
      });
      if (!ask) break;
      const src = pictureOf(ask).src;
      let f = null;
      try { f = await withTimeout(ai.focusPoint(src), 20000); } catch (e) {
        noteError(e, { quiet: true, where: "picture focus" });
        if (e && [0, 429, 529].includes(e.status)) aiOff = true;
      }
      const cur = byId(ask.id);
      if (!cur || pictureOf(cur)?.src !== src) continue;
      await saveItem({ ...cur, focus: f ? { key: src, ...f, by: "ai" } : { ...cur.focus, asked: true } });
      if (f) refreshPost(cur.id);
    }
  } catch (e) {
    noteError(e, { quiet: true, where: "picture focus" });
  } finally {
    focusRunning = false;
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
  const fresh = state.items.filter((i) => !i.suggested && !i.school && isNew(i)).sort((a, b) => (b.backAt || b.created) - (a.backAt || a.created));
  const freshIds = new Set(fresh.map((i) => i.id));
  const v = editionView(state.items, state.edition);
  const six = v.pages.filter((p) => !freshIds.has(p.id) && !p.school);
  const sixIds = new Set(six.map((p) => p.id));
  const sugg = state.items.filter((i) => i.suggested && !sixIds.has(i.id) && isNew(i))
    .sort((a, b) => b.created - a.created).slice(0, SUGGESTIONS_PER_DAY);
  // School posts: every one not done, each day, apart from New and the six. Settled ones stay till tomorrow, stamped.
  const school = state.items.filter((i) => i.school && (schoolToday([i]).length || (state.recent.has(i.id))))
    .sort((a, b) => (a.school.date || "9999").localeCompare(b.school.date || "9999") || a.created - b.created);
  return { fresh, six, sugg, school, edition: v };
}

function todayIds() {
  const s = todaySections();
  return [...s.school, ...s.fresh, ...s.six, ...s.sugg].map((i) => i.id);
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
  app.innerHTML = `<div class="tl" id="tl">
    <header class="top">
      <div class="bar">
        <h1 class="mark"><span class="logo" aria-hidden="true">${LOGO}</span><span class="word">${APP}</span></h1>
        <button class="icon-btn" type="button" data-act="settings" aria-label="Settings">${I.settings}</button>
      </div>
      <div class="tabs" role="tablist" aria-label="Show">
        <button class="tab" role="tab" id="tab-today" type="button" data-tab="today" aria-selected="${state.tab === "today"}" aria-controls="panel" tabindex="${state.tab === "today" ? 0 : -1}">Today</button>
        <button class="tab" role="tab" id="tab-all" type="button" data-tab="all" aria-selected="${state.tab === "all"}" aria-controls="panel" tabindex="${state.tab === "all" ? 0 : -1}">All saves</button>
      </div>
    </header>
    <main id="panel" role="tabpanel" aria-labelledby="tab-${state.tab}">
      ${state.tab === "today" ? todayHtml() : allHtml()}
    </main>
  </div>
  <button class="fab" type="button" data-act="add" aria-label="Save something">${I.plus}</button>`;
  const tl = $("#tl");
  tl.scrollTop = scroll;
  hydrate(tl);
  bindTimeline(tl);
  tintVisible(tl);
  updateWidget();
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
  let h = stripHtml(s) + welcomeHtml() + aiAskHtml() + calendarHtml() + morningHtml() + schoolAskHtml();
  if (s.school.length) h += sectionHead("From school", `${s.school.filter(isOpen).length || "All"} to do`) + s.school.map((i) => postHtml(i)).join("");
  if (s.fresh.length) h += sectionHead("New", `${s.fresh.filter(isOpen).length || "All"} to sort`) + s.fresh.map((i) => postHtml(i)).join("");
  if (s.six.length) h += sectionHead("Today's six", `${s.six.filter(isOpen).length} of ${s.six.length} left`) + s.six.map((i) => postHtml(i)).join("");
  if (s.sugg.length) h += sectionHead("Top stories") + s.sugg.map((i) => postHtml(i)).join("");
  return h + endHtml(s);
}

/* ================= This morning =================
 * The daily set at the top of Today: weather and radar (or your camera),
 * last night's games, a Jung quote, On this day, and CPMAI practice. Each
 * can be turned off in Settings › Mornings. Read fresh each day; never saved.
 */
const MORNING_KEY = "edition.morning", MORNING_CACHE = "edition.morningCache";

/** Shoebox Me, Graham's private build, opens with ?me=1: personal modules stay available there. */
const personal = () => { try { return localStorage.getItem("edition.me") === "1"; } catch { return false; } };
/** Modules that only Shoebox Me shows: unofficial scores, a quote set, a one-library song. */
const PERSONAL_MODULES = ["hockey", "jung", "song"];
const MORNING_PUBLIC = { weather: true, zip: "", place: null, cam: "", otd: true, study: false, studyTopic: "", hockey: false, teams: [], jung: false, song: false };
const MORNING_ME = { ...MORNING_PUBLIC, zip: "28409", hockey: true, teams: ["CAR", "WSH"], jung: true, song: true, study: true, studyTopic: "PMI-CPMAI" };
function morningSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(MORNING_KEY) || "{}") || {}; } catch { /* storage blocked */ }
  // Earlier versions had a CPMAI switch; it's now a study deck on that topic.
  if (saved.cpmai !== undefined && saved.study === undefined) { saved.study = saved.cpmai; saved.studyTopic = saved.studyTopic || "PMI-CPMAI"; }
  const m = { ...(personal() ? MORNING_ME : MORNING_PUBLIC), ...saved };
  if (!personal()) for (const k of PERSONAL_MODULES) m[k] = false;
  return m;
}
/** Can this phone tell Shoebox where it is? (the iPhone app, or a browser that shares location) */
const canLocate = () => nativeCan("location") || (!NATIVE && typeof navigator !== "undefined" && Boolean(navigator.geolocation));

/** Weather for wherever the phone is, from now on. Asks for permission. Returns the place. */
async function useMyLocation() {
  const loc = await getLocation({ ask: true });
  const place = await withTimeout(daily.placeFromCoords(loc.lat, loc.lon, { name: loc.name || "", zip: loc.zip || "" }), 15000);
  setMorningSettings({ ...morningSettings(), place, zip: "", useLocation: true, weather: true });
  const c = morningCache(); delete c.weather; c.locAt = Date.now(); saveMorningCache(c);
  render({ top: false });
  loadMorning();
  return place;
}

/** Turn on the iPhone's own calendars: asks for access, then reads today. */
async function turnOnNativeCalendar() {
  try {
    const r = await nativeAsk("calendar", { ask: true, from: startOfToday(), to: startOfToday() + 864e5 }, 90000);
    if (!r.ok) return { ok: false, msg: r.status === "denied" ? "Calendar access is off. Turn it on in the iPhone's Settings › Shoebox › Calendars." : "Couldn't read your calendars." };
    setCalNative(true);
    await refreshCalendar({ force: true });
    render({ top: false });
    const n = (r.events || []).length;
    return { ok: true, msg: n ? `On. ${n} event${n === 1 ? "" : "s"} today.` : "On. Nothing on your calendar today." };
  } catch (e) { return { ok: false, msg: e.message }; }
}

/** Where the weather is for: the built-in place for a known ZIP, or one looked up in Settings. */
const placeOf = (m) => daily.PLACES[m.zip] || m.place || null;
const studyLabel = (m) => String(m.studyTopic || "Study").slice(0, 40);
function setMorningSettings(v) { try { localStorage.setItem(MORNING_KEY, JSON.stringify(v)); } catch { /* private mode */ } }
function morningCache() {
  try { const c = JSON.parse(localStorage.getItem(MORNING_CACHE) || "null"); return c && c.day === dayKey() ? c : { day: dayKey() }; } catch { return { day: dayKey() }; }
}
function saveMorningCache(c) { try { localStorage.setItem(MORNING_CACHE, JSON.stringify(c)); } catch { /* full */ } }
const yesterdayKey = () => dayKey(Date.now() - 864e5);

let morningLoading = false;
async function loadMorning() {
  if (morningLoading) return;
  morningLoading = true;
  let m = morningSettings();
  let c = morningCache(), changed = false;
  try {
    // Weather follows the phone: once a day, if it has moved town, the place moves with it.
    if (m.weather && m.useLocation && !c.locAt) {
      c.locAt = Date.now(); changed = true;
      try {
        const loc = await withTimeout(getLocation({ ask: false }), 25000);
        if (!m.place || daily.kmBetween(m.place, loc) > 15) {
          const place = await withTimeout(daily.placeFromCoords(loc.lat, loc.lon, { name: loc.name || "", zip: loc.zip || "" }), 15000);
          m = { ...morningSettings(), place, zip: "" };
          setMorningSettings(m);
          delete c.weather;
        }
      } catch (e) { if (e.message !== "notAsked") noteError(e, { quiet: true, where: "location" }); }
    }
    const place = placeOf(m);
    const relay = ai.relayBase();
    if (relay && (!c.relayInfo || Date.now() - c.relayInfo.at > 6 * 3600e3)) {
      try { const r = await withTimeout(fetch(`${relay}/version`), 10000); c.relayInfo = { ...(r.ok ? await r.json() : {}), at: Date.now() }; changed = true; } catch { /* older relay */ }
    }
    if (m.weather && place && (!c.weather || c.weatherFor !== place.name || Date.now() - c.weather.at > 30 * 60e3)) {
      let w = null;
      // Apple Weather when the relay has the Apple key and Services ID; the free source otherwise.
      if (relay && c.relayInfo?.weatherkit) {
        try {
          const r = await withTimeout(fetch(`${relay}/apple/weather?lat=${place.lat}&lon=${place.lon}&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York")}`), 15000);
          if (r.ok) w = daily.fromWeatherKit(await r.json());
        } catch (e) { noteError(e, { quiet: true, where: "Apple Weather" }); }
      }
      if (!w) { try { w = await withTimeout(daily.fetchWeather({ ...place, tide: null }), 15000); } catch (e) { noteError(e, { quiet: true, where: "weather" }); } }
      if (w && place.tide) { try { w.tides = await withTimeout(daily.fetchTides(place.tide), 10000); } catch { /* tides are a bonus */ } }
      if (w) { c.weather = w; c.weatherFor = place.name; changed = true; }
    }
    if (m.song && relay && c.relayInfo?.apple && (!c.songAt || Date.now() - c.songAt > 30 * 60e3)) {
      try {
        const r = await withTimeout(fetch(`${relay}/apple/song`, { headers: { "x-inbox-key": inboxKey() } }), 15000);
        if (r.ok) {
          const d = await r.json();
          c.song = d.song && d.song.at && Date.now() - d.song.at < 30 * 3600e3 ? { ...d.song, match: d.match } : null;
          c.songAt = Date.now();
          try { localStorage.setItem("edition.songKey", d.songKey || ""); } catch { /* full */ }
          changed = true;
        }
      } catch (e) { noteError(e, { quiet: true, where: "song of the day" }); }
    }
    if (m.hockey && ai.relayBase() && (!c.gamesAt || (!c.games?.length && Date.now() - c.gamesAt > 2 * 3600e3))) {
      try {
        const res = await withTimeout(fetch(`${ai.relayBase()}/nhl?date=${yesterdayKey()}`), 15000);
        if (res.ok) { c.games = daily.gamesFor(await res.json(), m.teams); c.gamesAt = Date.now(); changed = true; }
      } catch (e) { noteError(e, { quiet: true, where: "hockey" }); }
    }
    if (c.cpmai && c.cpmaiTopic !== m.studyTopic) { delete c.cpmai; delete c.cpmaiTried; changed = true; }
    if (m.study && m.studyTopic && ai.settings.enabled() && !c.cpmai && !c.cpmaiTried) {
      c.cpmaiTried = true;
      try {
        const recent = (() => { try { return JSON.parse(localStorage.getItem("edition.cpmaiRecent") || "[]"); } catch { return []; } })();
        const questions = await withTimeout(ai.studyQuestions({ topic: m.studyTopic, count: 3, seed: daily.dayOfYear(), recent }), 60000);
        if (questions.length) {
          c.cpmai = { questions, answers: {} };
          c.cpmaiTopic = m.studyTopic;
          try { localStorage.setItem("edition.cpmaiRecent", JSON.stringify([...questions.map((q) => q.q.slice(0, 80)), ...recent].slice(0, 24))); } catch { /* full */ }
        }
      } catch (e) { noteError(e, { quiet: true, where: "study questions" }); }
      changed = true;
    }
  } finally {
    morningLoading = false;
  }
  if (changed) {
    c = { ...morningCache(), ...c };
    saveMorningCache(c);
    if (state.tab === "today" && !state.reader && !$(".sheet-wrap")) render({ top: false });
  }
}

function morningHtml() {
  const m = morningSettings(), c = morningCache();
  const cards = [];
  const place = placeOf(m);
  const card = (cls, rail, meta, body) => `<article class="post daily ${cls}"><div class="rail">${rail}</div><div class="main"><div class="meta">${meta}</div>${body}</div></article>`;
  const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "");
  if (m.weather && !place && flag(ONBOARDED)) {
    cards.push(`<div class="wx-mini"><span class="wx-ic-s" aria-hidden="true">${I.sun}</span><span>Weather: add your ZIP code and it shows here each morning.</span>
      <button class="btn sm ghost" type="button" data-day="wx-setup">Add</button></div>`);
  } else if (m.weather && c.weather && c.wxHidden) {
    const w = c.weather;
    cards.push(`<div class="wx-mini"><span class="wx-ic-s" aria-hidden="true">${I.sun}</span><span>${w.now}° · ${esc(w.word)} · High ${w.hi}° · Low ${w.lo}°${w.rain != null ? ` · Rain ${w.rain}%` : ""}</span>
      <button class="btn sm ghost" type="button" data-day="wx-show">Show</button></div>`);
  } else if (m.weather && c.weather) {
    const w = c.weather;
    const yt = daily.youtubeId(m.cam);
    const radar = place.radar ? `https://radar.weather.gov/ridge/standard/${place.radar}_0.gif?t=${Math.floor(Date.now() / 6e5)}` : "";
    const pic = yt ? "" : m.cam || radar;
    const fig = yt
      ? `<figure class="wx-pic wx-live"><iframe src="https://www.youtube-nocookie.com/embed/${esc(yt)}?autoplay=1&mute=1&playsinline=1" title="Live camera" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe><figcaption>Your live camera</figcaption></figure>`
      : pic ? `<figure class="wx-pic"><img alt="${m.cam ? "Camera view" : `Weather radar around ${esc(place.name)}`}" src="${esc(pic)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.closest('figure')?.remove()">
         <figcaption>${m.cam ? "Your camera" : `Radar, ${esc(place.radar)} ${esc(place.name)} (National Weather Service)`}</figcaption></figure>` : "";
    cards.push(card("wx", `<span class="av av-day wx-ic" aria-hidden="true">${I.sun}</span>`,
      `<span class="who">Weather,</span> <span class="when">${esc(place.name)}${m.zip ? ` ${esc(m.zip)}` : ""}</span><button class="act icon more" type="button" data-day="wx-hide" aria-label="Shrink the weather for today">${I.close}</button>`,
      `<p class="wx-now"><span class="deg">${w.now}°</span><span class="wx-word">${esc(w.word)}<small>Feels like ${w.feels}°</small></span></p>
       <p class="wx-line">High ${w.hi}° · Low ${w.lo}°${w.rain != null ? ` · Rain ${w.rain}%` : ""} · Wind ${esc(w.windFrom)} ${w.wind} mph${w.gusts > w.wind + 5 ? `, gusts ${w.gusts}` : ""}</p>
       ${w.nextHour ? `<p class="wx-line wx-next">${esc(w.nextHour)}</p>` : ""}
       <p class="wx-line">Sunrise ${hm(w.sunrise)} · Sunset ${hm(w.sunset)}</p>
       ${w.tides?.length ? `<p class="wx-line">Tides: ${w.tides.map((t) => `${t.type} ${hm(t.t.replace(" ", "T"))}`).join(" · ")}</p>` : ""}
       ${fig}
       ${w.source === "apple" ? `<p class="wx-attr"><a href="https://weatherkit.apple.com/legal-attribution.html" target="_blank" rel="noopener"> Weather</a></p>` : ""}`));
  }
  if (m.song && c.song) {
    const sg = c.song, mt = sg.match || {};
    const last = sg.lastPlayed ? (() => { const t = Date.parse(sg.lastPlayed); return Number.isFinite(t) ? `last played ${friendlyWhen(t)}` : ""; })() : "";
    cards.push(card("song", `<span class="av av-day" aria-hidden="true">${I.music}</span>`, `<span class="who">Song of the day</span>`,
      `<div class="song">${mt.artwork ? `<img class="art" alt="" src="${esc(mt.artwork)}" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
        <div class="song-t"><p class="ttl">${esc(mt.name || sg.title)}</p><p class="wx-line">${esc(mt.artist || sg.artist || "")}${mt.year ? ` · ${esc(mt.year)}` : ""}</p>${last ? `<p class="wx-line">You ${esc(last)}</p>` : ""}</div></div>
       <div class="song-acts">${mt.preview ? `<button class="btn sm" type="button" data-preview="${esc(mt.preview)}">${I.play}<span>Preview</span></button>` : ""}
         ${mt.url ? `<a class="btn sm primary" href="${esc(mt.url)}" target="_blank" rel="noopener">Open in Apple Music</a>` : ""}</div>`));
  }
  if (m.hockey) for (const g of c.games || []) {
    if (!g.done) continue;
    const res = g.won ? "W" : "L";
    cards.push(card(`nhl t-${esc(g.team)}`, `<span class="av av-day team" aria-hidden="true">${esc(g.team)}</span>`,
      `<span class="who">${esc(g.name)},</span> <span class="when">last night</span><span class="tag ${g.won ? "won" : ""}">${res}${g.end ? ` · ${esc(g.end)}` : ""}</span>`,
      `<p class="score">${esc(g.name)} ${g.us}, ${esc(g.opp)} ${g.them}</p>
       <p class="wx-line">${g.home ? "At home" : "Away"}${g.scorers.length ? ` · Goals: ${esc(g.scorers.join(", "))}` : ""}</p>
       ${g.recap || g.center ? `<a class="btn sm hl" href="${esc(g.recap || g.center)}" target="_blank" rel="noopener">${I.play}<span>${g.recap ? "Watch highlights" : "Game recap"}</span></a>` : ""}`));
  }
  if (m.jung) {
    const j = daily.jungFor(Date.now(), jungRetired());
    if (j && c.jungDone !== j.index) {
      const kept = state.items.some((i) => i.jung === j.index);
      cards.push(card("jung", `<span class="av av-day" aria-hidden="true">J</span>`, `<span class="who">Carl Jung</span>`,
        `<blockquote class="jung-q">${esc(j.q)}</blockquote><p class="wx-line">${esc(j.src)}</p>
         <div class="acts day-acts"><span class="grow"></span>
           <button class="act" type="button" data-day="jung-no:${j.index}">${I.letGo}<span>Not for me</span></button>
           <button class="act done" type="button" data-day="jung-keep:${j.index}" ${kept ? "disabled" : ""}>${I.keep}<span>${kept ? "Kept" : "Keep"}</span></button></div>`));
    } else if (j && c.jungDone === j.index) {
      cards.push(`<div class="wx-mini"><span class="wx-ic-s" aria-hidden="true">J</span><span>${state.items.some((i) => i.jung === j.index) ? "Today's Jung quote is in your saves." : "Jung quote cleared for today."}</span></div>`);
    }
  }
  if (m.otd) {
    const o = daily.onThisDay(state.items);
    if (o) {
      const pic = pictureOf(o.item);
      const img = pic ? (pic.blobId ? `<img alt="" data-blob="${esc(pic.blobId)}">` : `<img alt="" src="${esc(pic.src)}" referrerpolicy="no-referrer" onerror="this.remove()">`) : "";
      cards.push(card("otd", avatarHtml(), `<span class="who">On this day,</span> <span class="when">${esc(o.label.toLowerCase())}</span>`,
        `<button class="otd-card" type="button" data-open="${esc(o.item.id)}">${img ? `<span class="otd-pic">${img}</span>` : ""}
          <span class="otd-t"><span class="ttl">${esc(o.item.why || o.item.title || "Something you saved")}</span>${o.item.why && o.item.title ? `<span class="site">${esc(o.item.title)}</span>` : ""}</span></button>`));
    }
  }
  if (m.study && c.cpmai?.questions?.length && c.cpmai.done) {
    const sc = cpmaiScore();
    cards.push(`<div class="wx-mini"><span class="wx-ic-s" aria-hidden="true">Q</span><span>${esc(studyLabel(m))} done: ${c.cpmai.right} of ${c.cpmai.questions.length} right today${sc.total ? ` · ${sc.right} of ${sc.total} this month` : ""}</span>
      <button class="btn sm ghost" type="button" data-day="cq-show">Review</button></div>`);
  } else if (m.study && c.cpmai?.questions?.length) {
    const qs = c.cpmai.questions, ans = c.cpmai.answers || {};
    const right = qs.filter((q, k) => ans[k] && ans[k].length === q.answer.length && ans[k].every((x) => q.answer.includes(x))).length;
    const doneN = qs.filter((q, k) => ans[k] && ans[k].length === q.answer.length).length;
    cards.push(card("quiz", `<span class="av av-day" aria-hidden="true">Q</span>`,
      `<span class="who">${esc(studyLabel(m))} practice,</span> <span class="when">${doneN === qs.length ? `${right} of ${qs.length} right` : `${qs.length} questions`}</span>`,
      qs.map((q, k) => {
        const picked = ans[k] || [], shown = picked.length === q.answer.length;
        return `<div class="cq${shown ? " shown" : ""}"><p class="cq-q"><b>${k + 1}.</b> ${esc(q.q)}${q.answer.length > 1 && !/choose two/i.test(q.q) ? " <em>(Choose two.)</em>" : ""}</p>
          <div class="cq-opts">${q.options.map((o, i) => {
            const st = shown ? (q.answer.includes(i) ? "right" : picked.includes(i) ? "wrong" : "") : picked.includes(i) ? "picked" : "";
            return `<button class="cq-o ${st}" type="button" data-cq="${k}:${i}" ${shown ? "disabled" : ""}><span class="l">${"ABCDE"[i]}</span><span>${esc(o)}</span></button>`;
          }).join("")}</div>
          ${shown ? `<p class="cq-why"><b>${q.answer.length === picked.length && picked.every((x) => q.answer.includes(x)) ? "Right." : `Answer: ${q.answer.map((i) => "ABCDE"[i]).join(", ")}.`}</b> ${esc(q.why)}</p>` : ""}</div>`;
      }).join("") + (doneN === qs.length ? `<div class="acts day-acts"><span class="cq-score">${right} of ${qs.length} right</span><span class="grow"></span>
        <button class="act done" type="button" data-day="cq-done:${right}">${I.done}<span>Done</span></button></div>` : "")));
  }
  // Named for the time of day, like the greeting above it.
  const h = new Date().getHours();
  return cards.length ? sectionHead(h < 5 || h >= 17 ? "This evening" : h < 12 ? "This morning" : "This afternoon") + cards.join("") : "";
}

/* The morning cards' own buttons: shrink the weather, finish CPMAI, keep or retire a Jung quote. */
const jungRetired = () => { try { return JSON.parse(localStorage.getItem("edition.jungRetired") || "[]"); } catch { return []; } };
function cpmaiScore(now = Date.now()) {
  try {
    const all = JSON.parse(localStorage.getItem("edition.cpmaiScores") || "{}"), month = dayKey(now).slice(0, 7);
    return Object.entries(all).filter(([d]) => d.startsWith(month)).reduce((a, [, v]) => ({ right: a.right + v[0], total: a.total + v[1] }), { right: 0, total: 0 });
  } catch { return { right: 0, total: 0 }; }
}
async function dayAction(what) {
  const [act, arg] = what.split(":");
  const c = morningCache();
  if (act === "wx-setup") { openSettings("set-morning"); return; }
  if (act === "wx-hide") c.wxHidden = true;
  else if (act === "wx-show") c.wxHidden = false;
  else if (act === "cq-done" && c.cpmai) {
    c.cpmai.done = true; c.cpmai.right = +arg || 0;
    try { const all = JSON.parse(localStorage.getItem("edition.cpmaiScores") || "{}"); all[dayKey()] = [c.cpmai.right, c.cpmai.questions.length]; localStorage.setItem("edition.cpmaiScores", JSON.stringify(all)); } catch { /* full */ }
    tick(true);
  } else if (act === "cq-show" && c.cpmai) c.cpmai.done = false;
  else if (act === "jung-keep") {
    const j = daily.JUNG[+arg];
    if (j && !state.items.some((i) => i.jung === +arg)) {
      const item = createItem({ kind: KIND.QUOTE, text: j.q, author: "Carl Jung", title: j.q.slice(0, 140) }, { id: db.newId(), source: "jung" });
      Object.assign(item, { jung: +arg, note: j.src, status: STATUS.QUEUED, queuedAt: Date.now(), tags: ["jung", "psychology"], enrichedAt: Date.now() });
      await saveItem(item);
      toast("Kept. It's in your saves and can come back as one of your six.");
    }
    c.jungDone = +arg; tick(true);
  } else if (act === "jung-no") {
    try { const r = jungRetired(); if (!r.includes(+arg)) r.push(+arg); localStorage.setItem("edition.jungRetired", JSON.stringify(r)); } catch { /* full */ }
    c.jungDone = +arg;
    toast("That one won't come back.");
  }
  saveMorningCache(c);
  render({ top: false });
}

/** Play or stop a song's 30-second preview. */
let previewAudio = null;
function playPreview(btn) {
  const src = btn.dataset.preview;
  const label = $("span", btn);
  if (previewAudio && !previewAudio.paused && previewAudio.src === src) { previewAudio.pause(); label.textContent = "Preview"; return; }
  if (previewAudio) previewAudio.pause();
  previewAudio = new Audio(src);
  previewAudio.addEventListener("ended", () => { label.textContent = "Preview"; });
  previewAudio.play().then(() => { label.textContent = "Stop"; }).catch(() => { label.textContent = "Preview"; });
}

/** A tap on a CPMAI option: pick it; once enough are picked, show the answer. */
function answerCpmai(k, i) {
  const c = morningCache();
  const q = c.cpmai?.questions?.[k];
  if (!q) return;
  const ans = c.cpmai.answers || (c.cpmai.answers = {});
  const cur = ans[k] || [];
  if (cur.length >= q.answer.length) return;
  ans[k] = cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i];
  saveMorningCache(c);
  tick(true);
  render({ top: false });
}

/* ================= Your Shoebox email address =================
 * Mail you forward to your Shoebox address waits at the relay until the app
 * collects it. School mail becomes school posts (one per piece that matters);
 * anything else becomes a post of its own, titled by its subject.
 */
function inboxKey() {
  try {
    let k = localStorage.getItem("edition.inboxKey");
    if (!k) { k = (crypto.randomUUID ? crypto.randomUUID() + crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^\w-]/g, ""); localStorage.setItem("edition.inboxKey", k); }
    return k;
  } catch { return ""; }
}

/**
 * Is this mail from school? The sender or subject says so, or (for a newsletter
 * you forwarded yourself) the opening of the email does: the district's
 * address, the school's name, or a word you set (the mascot, say "Ducks").
 */
function isSchoolMail(m, c = schoolSettings()) {
  const words = [c.school, ...(c.words || [])].filter(Boolean)
    .map((w) => String(w).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter((w) => w.length > 2);
  if (!words.length) return false;
  const re = new RegExp(words.join("|"), "i");
  return re.test(`${m.from} ${m.fromName} ${m.subject}`) || re.test(String(m.text || "").slice(0, 4000));
}

let inboxRunning = false;
async function checkInbox({ statusEl = null } = {}) {
  const base = ai.relayBase();
  if (!base || inboxRunning) return 0;
  inboxRunning = true;
  const say = (msg, err) => { if (statusEl) { statusEl.textContent = msg; statusEl.classList.toggle("err", !!err); } };
  let made = 0;
  try {
    const res = await withTimeout(fetch(`${base}/inbox`, { headers: { "x-inbox-key": inboxKey() } }), 15000);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { say(data?.error?.message || `The relay said ${res.status}.`, true); return 0; }
    if (data.address) { try { localStorage.setItem("edition.inboxAddress", data.address); } catch { /* full */ } }
    const done = [];
    for (const m of data.mails || []) {
      const c = schoolSettings();
      const school = isSchoolMail(m, c);
      if (school && ai.settings.enabled()) {
        const before = state.items.length;
        await pullNewsletter(`${m.subject}\n\n${m.text}`, null);
        made += state.items.length - before;
      } else {
        const link = (m.links || [])[0];
        const body = String(m.text || "").trim();
        const item = createItem({ kind: KIND.NOTE, text: body.slice(0, 8000), title: m.subject || body.slice(0, 80) || "Email" }, { id: db.newId(), source: "email" });
        Object.assign(item, { title: m.subject || item.title, email: { from: m.from, fromName: m.fromName || m.from, at: m.at }, url: link || undefined });
        await saveItem(item);
        made++;
      }
      done.push(m.id);
    }
    if (done.length) await fetch(`${base}/inbox/ack`, { method: "POST", headers: { "x-inbox-key": inboxKey(), "content-type": "application/json" }, body: JSON.stringify({ ids: done }) }).catch(() => {});
    say(done.length ? `${done.length} email${done.length === 1 ? "" : "s"} collected.` : "No new email.");
    if (made) { tick(true); render({ top: false }); enrichPending(); picturePending(); }
    return made;
  } catch (e) {
    noteError(e, { quiet: true, where: "inbox" });
    say("Couldn't reach your relay.", true);
    return 0;
  } finally {
    inboxRunning = false;
  }
}

/* ================= School newsletter =================
 * On Mondays and Fridays, Today asks whether a newsletter came from school.
 * Paste its link (Outlook's Safe Links are unwrapped) or its text, and
 * Shoebox pulls out only what matters for your son, written as a short post
 * from the school with the dates and to-dos underneath. Needs an Anthropic key;
 * a link also needs the relay to read the page.
 */
const SCHOOL_KEY = "edition.school", SCHOOL_ASKED = "edition.schoolAsked";
const SCHOOL_PUBLIC = { on: false, days: [1, 5], child: "", school: "", about: "", words: [] };
const SCHOOL_ME = { on: true, days: [1, 5], child: "Gunner", school: "Myrtle Grove Middle", words: ["nhcs.net", "Ducks", "Duck Weekly"],
  about: "Gunner is in 8th grade at Myrtle Grove Middle School. He plays in the band, and plays soccer and lacrosse." };
function schoolSettings() {
  const base = personal() ? SCHOOL_ME : SCHOOL_PUBLIC;
  let c;
  try { c = { ...base, ...JSON.parse(localStorage.getItem(SCHOOL_KEY) || "{}") }; } catch { c = { ...base }; }
  if (c.child === "your son") c.child = base.child; // earlier versions saved the placeholder
  if (/^My son is in 8th grade/.test(c.about)) c.about = base.about;
  if (!Array.isArray(c.words)) c.words = base.words;
  return c;
}
/** The names given for the newsletter, for keeping them on the phone. */
const childNames = (c) => String(c.child || "").split(/,|\band\b/).map((n) => n.trim()).filter(Boolean);
function setSchoolSettings(v) { try { localStorage.setItem(SCHOOL_KEY, JSON.stringify(v)); } catch { /* private mode */ } }
const schoolAsked = () => { try { return localStorage.getItem(SCHOOL_ASKED) === dayKey(); } catch { return false; } };
const markSchoolAsked = () => { try { localStorage.setItem(SCHOOL_ASKED, dayKey()); } catch { /* private mode */ } };

/** support@tangomike.app serves several apps: the subject says which, so mail can be sorted by app. */
export const SUPPORT_EMAIL = "support@tangomike.app";
function supportMail() {
  const where = NATIVE ? "iPhone app" : "web";
  const subject = `[${APP} ${VERSION} ${where}] `;
  const body = `\n\n---\n${APP} ${VERSION} (${where})\n${navigator.userAgent}`;
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Owner view (Shoebox Me): the last 30 days of anonymous stats, from the relay. */
async function showUsage(box) {
  try {
    const u = await ai.ownerStats();
    const days = Object.entries(u.days || {}).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 30);
    if (!days.length) { box.innerHTML = `<p class="note">No reports yet. Each install reports the day after it's used.</p>`; return; }
    const sum = (k) => days.reduce((n, [, d]) => n + (d.counts[k] || 0), 0);
    const last7 = days.slice(0, 7);
    const avg = Math.round(last7.reduce((n, [, d]) => n + d.installs, 0) / last7.length);
    const ret = (u.retention || []).filter((r) => r.d1 != null).slice(0, 8);
    const errs = {};
    days.forEach(([, d]) => Object.entries(d.errors || {}).forEach(([k, v]) => { errs[k] = (errs[k] || 0) + v; }));
    box.innerHTML = `<p class="note"><b>${avg}</b> active a day (last 7 days) · <b>${days.reduce((n, [, d]) => n + d.new, 0)}</b> new installs in 30 days ·
        <b>${sum("save")}</b> saves · <b>${sum("edition_finished")}</b> mornings finished</p>
      <table class="usage"><thead><tr><th>Day</th><th>Active</th><th>New</th><th>Saves</th><th>Done</th></tr></thead><tbody>
        ${days.slice(0, 14).map(([day, d]) => `<tr><td>${esc(day.slice(5))}</td><td>${d.installs}</td><td>${d.new}</td><td>${d.counts.save || 0}</td><td>${d.counts.edition_finished || 0}</td></tr>`).join("")}</tbody></table>
      ${ret.length ? `<h3 class="sub">Came back (by start day)</h3><table class="usage"><thead><tr><th>Started</th><th>New</th><th>Day 1</th><th>Day 7</th><th>Day 30</th></tr></thead><tbody>
        ${ret.map((r) => `<tr><td>${esc(r.day.slice(5))}</td><td>${r.new}</td><td>${r.d1}%</td><td>${r.d7 == null ? "–" : `${r.d7}%`}</td><td>${r.d30 == null ? "–" : `${r.d30}%`}</td></tr>`).join("")}</tbody></table>` : ""}
      ${Object.keys(errs).length ? `<h3 class="sub">Problems, 30 days</h3><p class="note">${Object.entries(errs).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${esc(k.replace(/_/g, " "))}: ${v}`).join(" · ")}</p>` : ""}`;
  } catch (e) { box.innerHTML = `<p class="note err">${esc(e.message || "Couldn't load stats.")}</p>`; }
}

/* ================= Welcome =================
 * A new phone starts empty, with four steps done for real in the app: save
 * one thing (with the same + everyone uses), set up the morning, choose
 * about AI, and learn to save from other apps. Each ticks off as it's done.
 */
const ONBOARDED = "edition.onboarded";
const flag = (k) => { try { return localStorage.getItem(k) === "1"; } catch { return true; } };
const setFlag = (k, on) => { try { localStorage.setItem(k, on ? "1" : "0"); } catch { /* storage blocked */ } };

function welcomeSteps() {
  const m = morningSettings();
  return [
    { key: "save", done: state.items.some((i) => !i.sample), title: "Save your first thing",
      body: "Something you mean to come back to: a link you haven't read, a photo, an idea. Tap + any time to add more.",
      acts: `<button class="btn primary" type="button" data-welcome="add">${I.plus || ""}<span>Add it</span></button>` },
    { key: "morning", done: flag("edition.welcomeMorning"), title: "Set up your morning",
      body: "Your weather and today's calendar sit at the top of Today.",
      acts: `${placeOf(m) ? `<span class="wel-ok">✓ Weather for ${esc(placeOf(m).name)}</span>`
          : `${canLocate() ? `<button class="btn primary" type="button" data-welcome="loc">Use my location</button>` : ""}
             <button class="btn" type="button" data-welcome="zip">Enter a ZIP code</button>`}
        ${nativeCan("calendar") ? (calNative() ? `<span class="wel-ok">✓ Your calendar</span>` : `<button class="btn" type="button" data-welcome="cal">Show my calendar</button>`) : ""}
        <button class="btn ${placeOf(m) || calNative() ? "primary" : "ghost"}" type="button" data-welcome="morning-skip">${placeOf(m) || calNative() ? "Done" : "Later"}</button>` },
    { key: "ai", done: ai.settings.asked(), title: "Turn on AI?",
      body: AI_DISCLOSURE,
      acts: `<button class="btn primary" type="button" data-ai-ask="1">Turn on AI</button><button class="btn" type="button" data-ai-ask="0">Not now</button>` },
    { key: "share", done: flag("edition.welcomeShare"), title: "Save from anywhere",
      body: NATIVE ? "In Safari or any app, tap Share, then Shoebox. It lands here, ready for tomorrow morning."
        : "On iPhone, tap Share, then Add to Home Screen, so Shoebox opens like an app. Links shared to it land here.",
      acts: `<button class="btn primary" type="button" data-welcome="share">Got it</button>` },
  ];
}

function welcomeHtml() {
  if (flag(ONBOARDED)) return "";
  const steps = welcomeSteps();
  const cur = steps.findIndex((x) => !x.done);
  if (cur === -1) { setFlag(ONBOARDED, true); track("welcome_done"); setTimeout(() => toast("You're set. Your first edition is below."), 300); return ""; }
  const done = steps.filter((x) => x.done).length;
  return `<section class="ask welcome" aria-labelledby="wel-h">
      <div class="ask-top">
        <div><h2 id="wel-h">${done ? "Next" : "Welcome to Shoebox"}</h2><p>${done ? `${done} of ${steps.length} done` : "Save what you mean to come back to. Each morning, Shoebox hands a few things back, finished."}</p></div></div>
      <ol class="wel-steps">${steps.map((x, k) => `<li class="${x.done ? "done" : k === cur ? "now" : ""}">
          <span class="wel-n" aria-hidden="true">${x.done ? "✓" : k + 1}</span>
          <div class="wel-b"><p class="wel-t">${esc(x.title)}${x.done ? '<span class="sr-only"> (done)</span>' : ""}</p>
            ${k === cur ? `<p class="wel-d">${esc(x.body)}</p><div class="ask-acts">${x.acts}</div><span class="st" id="wel-st" role="status"></span>` : ""}</div></li>`).join("")}</ol>
      <button class="btn ghost sm wel-skip" type="button" data-welcome="skip">Skip setup</button>
    </section>`;
}

async function welcomeAction(what, btn) {
  track(`welcome_${what.replace(/-/g, "_")}`);
  const st = $("#wel-st");
  const say = (msg, err) => { if (st) { st.textContent = msg; st.classList.toggle("err", !!err); } };
  if (what === "add") { openAdd(); return; }
  if (what === "zip") { openSettings("set-morning"); return; }
  if (what === "morning-skip") setFlag("edition.welcomeMorning", true);
  else if (what === "share") setFlag("edition.welcomeShare", true);
  else if (what === "skip") setFlag(ONBOARDED, true);
  else if (what === "loc") {
    btn.disabled = true; say("Finding where you are…");
    try { const p = await useMyLocation(); toast(`Weather for ${p.name}.`); } catch (e) { btn.disabled = false; say(e.message, true); return; }
  } else if (what === "cal") {
    btn.disabled = true; say("Asking for your calendars…");
    const r = await turnOnNativeCalendar();
    if (!r.ok) { btn.disabled = false; say(r.msg, true); return; }
    toast(r.msg);
  }
  render({ top: false });
}

/* Apple's rule 5.1.2(i): say plainly what goes to which AI company, and ask first. */
export const AI_DISCLOSURE = "Shoebox uses Claude, an AI model made by Anthropic, to read, tag and rank what you save, find pictures, and turn newsletters into posts. "
  + "When AI is on, the text of your saves, your notes and photos you add are sent to Anthropic through Shoebox's server for that. "
  + "Anthropic doesn't use them to train its models, and Shoebox's server doesn't keep them. You can turn AI off any time in Settings.";

function aiAskHtml() {
  if (ai.settings.asked() || !flag(ONBOARDED)) return "";
  return `<section class="ask" aria-labelledby="ai-ask-h">
      <div class="ask-top"><span class="av av-school av-ai" aria-hidden="true">AI</span>
        <div><h2 id="ai-ask-h">Turn on AI?</h2><p>${esc(AI_DISCLOSURE)}</p></div></div>
      <div class="ask-acts"><button class="btn primary" type="button" data-ai-ask="1">Turn on AI</button>
        <button class="btn" type="button" data-ai-ask="0">Not now</button></div>
    </section>`;
}

function setAi(on) {
  ai.settings.setConsent(on);
  track(on ? "ai_on" : "ai_off");
  if (on) {
    state.items = state.items.map((i) => ({ ...i, enrichTries: 0 }));
    enrichPending();
    toast("AI is on. Reading your saves now.");
  }
}

function schoolAskHtml() {
  const c = schoolSettings();
  if (!state.schoolForce && (!c.on || !c.days.includes(new Date().getDay()) || schoolAsked())) return "";
  return `<section class="ask" aria-labelledby="ask-h">
      <div class="ask-top"><span class="av av-school" aria-hidden="true">${esc((c.school || "S").charAt(0))}</span>
        <div><h2 id="ask-h">Newsletter from ${esc(c.school || "school")}?</h2><p>Paste the link or the text. Each thing that matters${c.child ? ` for ${esc(c.child)}` : ""} becomes its own post.</p></div></div>
      <label class="sr-only" for="ask-in">Newsletter link or text</label>
      <textarea id="ask-in" rows="2" placeholder="Paste the link or the newsletter">${esc(state.schoolDraft || "")}</textarea>
      <div class="ask-acts"><button class="btn primary" type="button" data-school="go">Pull what matters</button>
        <button class="btn" type="button" data-school="skip">None this time</button></div>
      <span class="st" id="ask-st" role="status"></span>
    </section>`;
}

/** Read a newsletter (link or text) and post what matters. Returns true when a post was made. */
async function pullNewsletter(raw, statusEl) {
  const set = (msg, err) => { if (statusEl) { statusEl.textContent = msg; statusEl.classList.toggle("err", !!err); } };
  const input = String(raw || "").trim();
  if (!input) { set("Paste the newsletter's link or text first.", true); return false; }
  if (!ai.settings.enabled()) { set("This needs AI. Turn it on in Settings › AI.", true); return false; }
  const c = schoolSettings();
  const first = input.split(/\s+/)[0];
  const isLink = /^https?:\/\/\S+$/i.test(input);
  let url = isLink ? ai.unwrapLink(first) : "", text = isLink ? "" : input, pageImgs = [];
  if (isLink) {
    if (!ai.relayBase()) { set("Reading a link needs the relay (Settings › Relay). Or paste the newsletter's text instead.", true); return false; }
    set("Reading the newsletter…");
    try {
      const res = await withTimeout(fetch(`${ai.relayBase()}/preview?text=1&url=${encodeURIComponent(url)}`), 20000);
      const data = res.ok ? await res.json() : {};
      text = [data.title, data.description, data.text].filter(Boolean).join("\n\n");
      pageImgs = candidatesOf(data).slice(0, 4);
    } catch (e) { noteError(e, { quiet: true, where: "school: read page" }); }
    if (text.length < 300) { set("That page didn't give up its text (it may need a sign-in or build itself in the browser). Copy the newsletter's text and paste it here instead.", true); return false; }
  }
  set("Picking out what matters…");
  let out;
  // Names stay on the phone: AI reads "your child" wherever a name was.
  try { out = await ai.schoolPosts({ text: ai.maskNames(text, childNames(c)), about: ai.maskNames(c.about, childNames(c)) || "No details given: keep what any family at the school needs.", school: c.school }); } catch (e) {
    noteError(e, { quiet: true, where: "school newsletter" });
    set(e.message || "Couldn't read it.", true);
    return false;
  }
  if (!out.posts.length) { set(`Nothing in this one for ${c.child}.`); markSchoolAsked(); return false; }
  const now = Date.now(), name = out.school || c.school;
  // Newest first in New, so the newsletter's first piece is created last and shows on top.
  for (let k = out.posts.length - 1; k >= 0; k--) {
    const p = out.posts[k];
    const item = createItem({ kind: KIND.NOTE, text: p.body, title: p.headline || p.body.slice(0, 80), tags: p.tags.length ? p.tags : ["school"] },
      { id: db.newId(), source: "school", now: now - k });
    Object.assign(item, { title: p.headline || item.title, school: { name, body: p.body, date: p.date, from: url || undefined, query: p.query, pageImgs }, url: url || undefined,
      enrichedAt: Date.now(), picSettled: Date.now(), coverOff: true, hook: p.body });
    await saveItem(item);
  }
  state.schoolCount = out.posts.length;
  setTimeout(schoolPictures, 50);
  state.schoolDraft = "";
  state.schoolForce = false;
  markSchoolAsked();
  return true;
}

/*
 * A picture for each school post: the newsletter page's own photos first,
 * then openly licensed photos (Openverse, through the relay) for the post's
 * subject. Claude picks one and writes a line about Gunner that fits it,
 * shown large over the photo. One post at a time, in the background.
 */
let schoolPicRunning = false;
async function schoolPictures() {
  if (schoolPicRunning) return;
  schoolPicRunning = true;
  try {
    for (;;) {
      const next = state.items.find((i) => i.school && i.school.body && !i.school.picDone && (i.school.picTries || 0) < 2
        && (i.status === STATUS.INBOX || i.status === STATUS.QUEUED));
      if (!next) break;
      const relay = ai.relayBase();
      let cands = [...(next.school.pageImgs || [])].slice(0, 2);
      const query = next.school.query || firstWords(next.title || "", 4);
      if (relay && query) {
        try {
          const res = await withTimeout(fetch(`${relay}/photo?q=${encodeURIComponent(query)}`), 15000);
          const data = res.ok ? await res.json() : {};
          cands.push(...(data.photos || []).slice(0, 4).map((p) => ({ src: p.src, credit: p.credit, license: p.license, link: p.link, search: true })));
        } catch (e) { noteError(e, { quiet: true, where: "school: photo search" }); }
      }
      cands = await usableImages(cands, { timeout: 6000 });
      const c = schoolSettings();
      let pick = cands.length ? 0 : -1, overlay = "", alt = "";
      if (cands.length && ai.settings.enabled()) {
        try {
          const r = await withTimeout(ai.schoolPicture({ headline: next.title, body: next.school.body, child: childNames(c).length ? ai.CHILD_TOKEN : "", candidates: cands }), 25000);
          pick = r.index; overlay = ai.unmaskName(r.overlay, childNames(c)[0] || ""); alt = r.alt;
        } catch (e) {
          noteError(e, { quiet: true, where: "school: pick picture" });
          if (e && [0, 429, 529].includes(e.status)) break;
        }
      }
      const cur = byId(next.id);
      if (!cur) continue;
      const tries = (cur.school.picTries || 0) + 1;
      const done = pick >= 0 || tries >= 2 || !relay;
      const upd = { ...cur, school: { ...cur.school, picTries: tries, picDone: done, overlay: overlay || cur.school.overlay } };
      if (pick >= 0) {
        const ch = cands[pick];
        Object.assign(upd, { coverOff: false, cover: null, imageUrl: ch.src, imageAlt: alt || ch.alt || undefined,
          imageCands: cands.map(({ src, w, h, alt: a, credit, license, link }) => ({ src, w, h, alt: a, credit, license, link })) });
      }
      await saveItem(upd);
      refreshPost(upd.id);
      if (!relay) break;
    }
  } finally {
    schoolPicRunning = false;
  }
  focusPending();
}

/** A school post's photo, with the line about Gunner over it. */
function schoolMediaHtml(item) {
  const pic = pictureOf(item);
  if (!pic) return "";
  const credit = creditLine(pic);
  const img = pic.blobId ? `<img alt="${esc(item.imageAlt || "")}"${focusAttr(item, pic)} data-blob="${esc(pic.blobId)}">`
    : `<img alt="${esc(item.imageAlt || "")}"${focusAttr(item, pic)} src="${esc(pic.src)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.closest('.pic')?.remove()">`;
  return `<div class="pic school-pic"><button class="open" type="button" data-open="${esc(item.id)}" aria-label="Open: ${esc(item.title)}">
      ${img}
      ${item.school.overlay ? `<span class="overlay">${esc(item.school.overlay)}</span>` : ""}</button></div>
    ${credit ? `<p class="credit">${pic.link ? `<a href="${esc(pic.link)}" target="_blank" rel="noopener">${esc(credit)}</a>` : esc(credit)}</p>` : ""}`;
}

/* ================= Today's calendar =================
 * Your calendar's events for today, as pages at the top of Today. They come
 * from the calendar's private address (Settings › Calendar), through your
 * relay; they're never saved as items, so there's nothing to keep, let go or
 * remove, and tomorrow they're gone. Read again every 15 minutes while open.
 */

const CAL_KEY = "edition.calendars", CAL_CACHE = "edition.calCache";
const calUrls = () => { try { return JSON.parse(localStorage.getItem(CAL_KEY) || "[]"); } catch { return []; } };
/** The iPhone's own calendars (iPhone app only), on or off. */
const calNative = () => { try { return localStorage.getItem("edition.calNative") === "1" && nativeCan("calendar"); } catch { return false; } };
const setCalNative = (on) => { try { localStorage.setItem("edition.calNative", on ? "1" : "0"); localStorage.removeItem(CAL_CACHE); } catch { /* private mode */ } };
const calOn = () => calUrls().length > 0 || calNative();
const setCalUrls = (list) => { try { localStorage.setItem(CAL_KEY, JSON.stringify(list)); localStorage.removeItem(CAL_CACHE); } catch { /* private mode */ } };

function calCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CAL_CACHE) || "null");
    return c && c.day === dayKey() ? c : null; // yesterday's events go away by themselves
  } catch { return null; }
}

let calLoading = false;
/** Read today's events from every calendar address. Keeps the last good read if offline. */
async function loadCalendar({ force = false } = {}) {
  const urls = calUrls(), native = calNative();
  if ((!urls.length && !native) || calLoading) return calCache();
  const have = calCache();
  if (!force && have && Date.now() - have.at < 15 * 60e3) return have;
  calLoading = true;
  try {
    const dayStart = startOfToday();
    const events = [], errors = [];
    if (native) {
      try {
        const r = await nativeAsk("calendar", { from: dayStart, to: dayStart + 864e5 });
        if (!r.ok) throw new Error(r.status === "denied" ? "Calendar access is off. Turn it on in the iPhone's Settings › Shoebox › Calendars." : "Couldn't read your calendars.");
        events.push(...(r.events || []).map((e) => ({ ...e, start: +e.start, end: +e.end, allDay: Boolean(e.allDay), calendar: e.calendar || "Calendar" })));
      } catch (e) { errors.push(e.message); noteError(e, { quiet: true, where: "calendar (iPhone)" }); }
    }
    for (const url of urls) {
      try {
        let res;
        try { res = await withTimeout(fetch(`${ai.relayBase()}/ical?url=${encodeURIComponent(url)}`), 30000); } catch {
          throw new Error(`Couldn't reach your relay at ${new URL(ai.relayBase()).host}. Check the address in Settings › Relay.`);
        }
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          const msg = d?.error?.message || "";
          // An older relay has no calendar step: its answer is a plain "Not found."
          if (res.status === 404 && msg === "Not found.") throw new Error("Your relay is an older copy without the calendar. Update it: Settings › Relay › How to update.");
          throw new Error(msg || `The relay said ${res.status}.`);
        }
        const label = calLabel(url);
        events.push(...eventsOn(parseIcs(await res.text()), dayStart).map((e) => ({ ...e, calendar: calName(e.calendar, label) })));
      } catch (e) { errors.push(e.message); noteError(e, { quiet: true, where: "calendar" }); }
    }
    if (errors.length === urls.length + (native ? 1 : 0) && have) return have;
    const seen = new Set();
    const list = events.sort((a, b) => (b.allDay - a.allDay) || a.start - b.start)
      .filter((e) => { const k = `${e.uid}|${e.start}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const c = { day: dayKey(), at: Date.now(), events: list, errors };
    try { localStorage.setItem(CAL_CACHE, JSON.stringify(c)); } catch { /* full */ }
    return c;
  } finally {
    calLoading = false;
  }
}

/** Which service a calendar address belongs to. */
function calLabel(url) {
  const h = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  return /google\.com$/.test(h) ? "Google Calendar" : /icloud\.com$/.test(h) ? "iCloud Calendar"
    : /outlook\.(com|office365\.com|live\.com)$/.test(h) ? "Outlook Calendar" : "Calendar";
}

/** A calendar's own name, unless it's an email address (Google names your main calendar after it). */
function calName(name, label) {
  return !name || /@/.test(name) ? label : name;
}

function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

const clock = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(":00", "");
function eventWhen(e) {
  if (e.allDay) return "All day";
  if (e.end <= e.start) return clock(e.start);
  const a = clock(e.start), b = clock(e.end);
  const am = (t) => / AM$/.test(t), pm = (t) => / PM$/.test(t);
  return `${(am(a) && am(b)) || (pm(a) && pm(b)) ? a.replace(/ [AP]M$/, "") : a} – ${b}`;
}

/** Calendars the person chose not to see on Today (by name). */
const calHidden = () => { try { return JSON.parse(localStorage.getItem("edition.calHidden") || "[]"); } catch { return []; } };
const setCalHidden = (list) => { try { localStorage.setItem("edition.calHidden", JSON.stringify(list)); } catch { /* full */ } };

const shortClock = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(" AM", "a").replace(" PM", "p");

/**
 * Today's calendar as a day bar: a strip from morning to night with a block
 * per event and a line for now, so a packed day reads at a glance. Under it,
 * what's on now or next (with Join), and the free stretches still ahead.
 * Tap the bar for the full list.
 */
function calendarHtml() {
  const c = calCache();
  if (!c || !c.events.length) return "";
  const hidden = new Set(calHidden());
  const evs = c.events.filter((e) => !hidden.has(calName(e.calendar, "Calendar")));
  if (!evs.length) return "";
  const now = Date.now(), dayStart = startOfToday();
  const ends = (e) => (e.end > e.start ? e.end : e.start + 15 * 60e3);
  const allDay = evs.filter((e) => e.allDay);
  const timed = evs.filter((e) => !e.allDay).sort((a, b) => a.start - b.start);
  const ahead = timed.filter((e) => ends(e) > now);
  const focus = ahead[0];
  // The busiest calendar gets the house purple; the others clearly different colors (sorted by name, so they stay put).
  const tally = {};
  for (const e of timed) tally[calName(e.calendar, "Calendar")] = (tally[calName(e.calendar, "Calendar")] || 0) + 1;
  const names = [...new Set(evs.map((e) => calName(e.calendar, "Calendar")))].sort((a, b) => (tally[b] || 0) - (tally[a] || 0) || a.localeCompare(b));
  const CAL_COLORS = ["#7B3FF2", "#E0A100", "#1F8A70", "#D9485F", "#2F7DD1", "#8A5A2B"];
  const colorOf = (e) => CAL_COLORS[Math.max(0, names.indexOf(calName(e.calendar, "Calendar"))) % CAL_COLORS.length];
  const dot = (e) => names.length > 1 ? `<span class="cal-dot" style="--c:${colorOf(e)}" title="${esc(calName(e.calendar, "Calendar"))}"></span>` : "";

  // The bar
  const { from, to } = barRange(timed, dayStart);
  const pct = (t) => (Math.min(Math.max(t, from), to) - from) / (to - from) * 100;
  const blocks = timed.map((e) => {
    const l = pct(e.start), w = Math.max(pct(ends(e)) - l, 0.9);
    return `<span class="db-blk${ends(e) <= now ? " past" : ""}" style="left:${l.toFixed(2)}%;width:${w.toFixed(2)}%;--c:${colorOf(e)}"></span>`;
  }).join("");
  const ticks = [];
  for (let t = from; t <= to; t += 3600e3) {
    const hr = new Date(t).getHours();
    if (hr % 4 === 0 && t > from && t < to) ticks.push(`<span class="db-tick" style="left:${pct(t).toFixed(2)}%">${esc(shortClock(t))}</span>`);
  }
  const nowLine = now > from && now < to ? `<span class="db-now" style="left:${pct(now).toFixed(2)}%"></span>` : "";
  const label = `${timed.length} events today${focus ? `, next at ${shortClock(focus.start)}` : ""}. Show the list.`;

  // Now or next
  let focusHtml = "";
  if (focus) {
    const live = focus.start <= now;
    const mins = Math.round((focus.start - now) / 60e3);
    const place = eventPlace(focus), link = calLink(focus);
    const when = live ? `Now, until ${shortClock(focus.end)}` : mins <= 90 ? `In ${mins} min · ${shortClock(focus.start)}` : `Next · ${shortClock(focus.start)}`;
    focusHtml = `<div class="db-next${live ? " live" : ""}">
        <div class="db-next-t"><p class="ag-when">${esc(when)}${place.text ? ` · ${esc(place.text)}` : ""}</p>
          <p class="db-next-n">${esc(cleanEventTitle(focus.title))}</p></div>
        ${link ? `<a class="btn sm primary" href="${esc(link)}" target="_blank" rel="noopener">${place.online ? "Join" : "Open"}</a>` : ""}
      </div>`;
  }

  // Free stretches still ahead, until the evening (or the last event, if later)
  const lastEnd = timed.length ? Math.max(...timed.map(ends)) : 0;
  const gaps = focus ? freeGaps(ahead, Math.max(now, from), Math.min(to, Math.max(lastEnd, dayStart + 21 * 3600e3)), 45 * 60e3) : [];
  // A stretch that starts now only repeats "in 46 min": show the ones after the next event.
  const gapChips = gaps.filter((g) => g.start > now + 60e3).slice(0, 3).map((g) => {
    const open = g.end >= Math.max(lastEnd, dayStart + 21 * 3600e3) - 60e3 && g.start >= lastEnd;
    return `<span class="db-free">${open ? `Free after ${esc(shortClock(g.start))}` : `Free ${esc(shortClock(g.start))}–${esc(shortClock(g.end))}`}</span>`;
  }).join("");
  const left = ahead.length;
  const head = left ? `${left} left${lastEnd ? ` · done ${shortClock(lastEnd)}` : ""}` : timed.length ? "All done for today" : "";

  const rows = timed.map((e) => `<li class="ag-row${ends(e) <= now ? " past" : ""}">${dot(e)}<span class="ag-t">${esc(shortClock(e.start))}</span><span class="ag-n">${esc(cleanEventTitle(e.title))}</span></li>`).join("");
  return `<article class="post event daybar" aria-label="Today's calendar">
      <div class="rail"><span class="av av-cal" aria-hidden="true">${I.cal}</span></div>
      <div class="main">
        <div class="meta"><span class="who">${esc(new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }))}</span>${head ? ` <span class="when">· ${esc(head)}</span>` : ""}</div>
        ${allDay.length ? `<p class="ag-allday">${allDay.map((e) => `<span class="chip">${dot(e)}${esc(cleanEventTitle(e.title))}</span>`).join("")}</p>` : ""}
        ${timed.length ? `<details class="db">
          <summary aria-label="${esc(label)}"><span class="db-wrap" aria-hidden="true"><span class="db-track">${blocks}</span>${nowLine}</span><span class="db-ticks" aria-hidden="true">${ticks.join("")}<span class="db-more"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span></span></summary>
          <ol class="ag-list">${rows}</ol>
        </details>` : ""}
        ${focusHtml}
        ${gapChips ? `<p class="db-frees">${gapChips}</p>` : ""}
      </div>
    </article>`;
}

async function refreshCalendar(opts) {
  if (!calOn()) return;
  const before = JSON.stringify(calCache()?.events || []);
  const c = await loadCalendar(opts);
  if (JSON.stringify(c?.events || []) !== before && state.tab === "today" && !state.reader && !$(".sheet-wrap")) render({ top: false });
}

/*
 * The Today strip, at the top of Today: a greeting, what's left, and a
 * circle for each of today's six. A circle fills with a check once that
 * post has its verdict; tap one to jump to its post. Cleared, it becomes
 * a gold badge.
 */
function stripHtml(s) {
  const all = [...s.fresh, ...s.six];
  if (!all.length) return "";
  const left = all.filter(isOpen).length;
  const h = new Date().getHours();
  const hello = h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const status = !left ? "Today is cleared" : `${left} left today${s.fresh.filter(isOpen).length ? `, ${s.fresh.filter(isOpen).length} new` : ""}`;
  const dots = s.six.map((i) => {
    const done = !isOpen(i);
    const pic = pictureOf(i);
    const face = pic && pic.blobId ? `<img alt=""${focusAttr(i, pic)} data-blob="${esc(pic.blobId)}">`
      : pic && pic.src ? `<img alt=""${focusAttr(i, pic)} src="${esc(pic.src)}" referrerpolicy="no-referrer" onerror="this.remove()">`
      : `<span class="dot-l" style="--c:${topicColor(i)}">${esc(firstWords(headline(i), 1).charAt(0).toUpperCase() || "•")}</span>`;
    return `<button class="dot${done ? " done" : ""}" type="button" data-jump="${esc(i.id)}" aria-label="${esc(firstWords(headline(i), 8))}${done ? ", done" : ""}">${face}${done ? `<span class="tick" aria-hidden="true">${I.done}</span>` : ""}</button>`;
  }).join("");
  return `<section class="strip" aria-label="Today">
    <div class="hello">${avatarHtml("sm")}<div><p class="hi">${hello}.</p><p class="left" id="count" aria-live="polite">${esc(status)}</p></div></div>
    ${left || !s.six.length ? `<div class="dots" role="group" aria-label="Today's six">${dots}</div>` : `<span class="cleared">${I.done}<span>Cleared</span></span>`}
  </section>`;
}

/** The end of Today: what's left, or the finish moment once it's all cleared. */
function endHtml(s) {
  const all = [...s.fresh, ...s.six];
  const open = all.filter(isOpen).length;
  const c = counts(state.items);
  const more = `${c.queued ? `<button class="btn" type="button" data-act="one-more">Read one more</button>` : ""}
    ${ai.settings.canDiscover() ? `<button class="btn" type="button" data-act="discover">Get top stories</button>` : ""}`;
  if (!state.items.length) {
    if (!flag(ONBOARDED)) return ""; // the welcome steps say it already
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
  if (first) { state.wonDay = dayKey(); db.meta.set("wonDay", state.wonDay); track("edition_finished"); }
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
  if (pic && pic.blobId) return `<img alt=""${focusAttr(item, pic)} data-blob="${esc(pic.blobId)}">`;
  if (pic && pic.src) return `<img alt=""${focusAttr(item, pic)} referrerpolicy="no-referrer" src="${esc(pic.src)}" onerror="this.remove()">`;
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
    .sort((a, b) => (f.id === STATUS.ASIDE ? (a.until || 0) - (b.until || 0) : 0)
      || (b.loved && f.id === "loved" ? b.loved - (a.loved || 0) : 0) || (b.doneAt || b.archivedAt || b.created) - (a.doneAt || a.archivedAt || a.created));
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
  if (item.school) return { who: item.school.name || "School", when: friendlyWhen(item.created) };
  if (item.email) return { who: item.email.fromName || "Email", when: friendlyWhen(item.created) };
  return { who: "You", when: friendlyWhen(item.created) };
}

function postHtml(item, { compact = false } = {}) {
  const words = item.kind === KIND.QUOTE || item.kind === KIND.NOTE;
  const settled = state.tab === "today" ? settledAs(item) : null;
  const open = state.tab === "today" ? isOpen(item) : item.status === STATUS.INBOX || item.status === STATUS.QUEUED;
  const b = byline(item);
  const tag = item.loved ? `<span class="tag love">${I.heartFill}<span>Loved</span></span>`
    : item.suggested ? `<span class="tag">Top story</span>`
    : item.backAt && item.status === STATUS.INBOX && dayKey(item.backAt) === dayKey() ? `<span class="tag back">Back today</span>`
    : isFaded(item) ? `<span class="tag fade">Faded</span>`
    : state.tab === "all" && item.status !== STATUS.QUEUED ? `<span class="tag">${{ inbox: "New", done: "Done", archived: "Let go", aside: "Set aside" }[item.status] || ""}</span>` : "";
  // The words at the top: your reason, else Shoebox's line about it (marked as a guess), else nothing.
  let say = "";
  if (item.suggested) say = `<p class="body">${esc(item.suggestReason || item.summary || "Picked from what you finish.")}</p>`;
  else if (item.email) say = `<p class="school-head">${esc(item.title)}</p><p class="body">${esc(String(item.text || "").replace(/\s+/g, " ").slice(0, 280))}${String(item.text || "").length > 280 ? "…" : ""}</p>`;
  else if (item.school) say = `<p class="school-head">${esc(item.title)}</p><p class="body">${esc(item.school.body || "")}</p>`
    + (item.school.date ? `<p class="ev-place">${I.cal}<span>${esc(shortDate(fromDateInput(item.school.date)))}</span></p>` : "");
  else if (item.kind === KIND.NOTE) say = `<p class="say">${esc(item.text || item.title)}</p>`;
  else if (item.why) say = `<p class="say">${esc(item.why)}</p>`;
  else if (item.hook && !words) say = `<p class="guess"><span class="sr-only">${APP}'s guess: </span>${esc(item.hook)}</p>`;
  const why = item.why && item.kind === KIND.NOTE ? `<p class="why-line"><span>Why you kept it</span>${esc(item.why)}</p>` : "";
  const quote = item.kind === KIND.QUOTE ? `<figure class="quote ${String(item.text || "").length > 160 ? "long" : ""}"><blockquote>“${esc(item.text || item.title)}”</blockquote>${item.author ? `<figcaption>${esc(item.author)}</figcaption>` : ""}</figure>${item.why ? `<p class="why-line"><span>Why you kept it</span>${esc(item.why)}</p>` : ""}` : "";
  const points = !compact && item.points && item.points.length && [KIND.LINK, KIND.PDF, KIND.TEXT].includes(item.kind)
    ? `<div class="quick"><h3>Quick read</h3><ul>${item.points.slice(0, 3).map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>` : "";
  const coming = item.school && item.school.items?.length ? `<div class="quick coming"><h3>For ${esc(schoolSettings().child || "your family")}</h3><ul>${item.school.items.map((i) =>
    `<li>${i.date ? `<b>${esc(shortDate(fromDateInput(i.date)))}</b> · ` : ""}${esc(i.text)}</li>`).join("")}</ul></div>` : "";
  const busy = state.enriching.has(item.id) ? `<p class="busy" role="status">Reading it…</p>` : "";
  const replies = repliesHtml(item, compact);
  const tintStyle = item.tint && tintInks(item.tint) ? ` style="--t:${esc(tintInks(item.tint).t)}"` : "";
  return `<article class="post${compact ? " compact" : ""}${settled ? " settled" : ""}${item.tint ? " tinted" : ""}" id="p-${esc(item.id)}" data-id="${esc(item.id)}"${tintStyle}
      aria-label="${esc(b.who)}, ${esc(b.when)}${item.title && !words ? ": " + esc(item.title) : ""}">
    <div class="rail">${item.suggested ? `<span class="av av-sb" aria-hidden="true">${LOGO}</span>` : item.school ? `<span class="av av-school" aria-hidden="true">${esc((item.school.name || "S").charAt(0))}</span>` : avatarHtml()}${replies ? '<span class="line" aria-hidden="true"></span>' : ""}</div>
    <div class="main">
      <div class="meta"><span class="who">${esc(b.who)},</span> <span class="when">${esc(b.when)}</span>${tag}<button class="act icon more" type="button" data-edit="${esc(item.id)}" aria-label="Edit">${I.menu}</button></div>
      ${say}${quote}${why}
      ${item.school ? schoolMediaHtml(item) : mediaHtml(item, compact)}
      ${busy}${item.school ? coming : points}
    </div>
    <div class="acts-row">${settled ? stampHtml(item, settled) : actionsHtml(item, open)}</div>
  </article>${replies}`;
}

/*
 * A settled post says what you decided, as plain status text so it never
 * looks like a button, with one real action beside it: Undo for a verdict
 * given this session, else Bring back.
 */
function stampHtml(item, v) {
  const isDone = v === VERDICT.DONE || v === VERDICT.READ_NOW;
  const label = isDone ? (doneLabel(item) === "Done" ? "You marked this done" : "You've read it")
    : v === VERDICT.LET_GO ? (item.suggested ? "You said not for me" : "You let this go")
    : item.status === STATUS.QUEUED && state.recent.get(item.id)?.stage === "inbox" ? "Kept for a later day" : "Back tomorrow";
  const cls = isDone ? "done" : v === VERDICT.LET_GO ? "go" : "later";
  const action = state.recent.has(item.id)
    ? `<button class="act" type="button" data-undo="${esc(item.id)}">${I.requeue}<span>Undo</span></button>`
    : item.status === STATUS.DONE || item.status === STATUS.ARCHIVED
      ? `<button class="act" type="button" data-requeue="${esc(item.id)}">${I.requeue}<span>Bring back</span></button>` : "";
  return `<div class="settled-row"><p class="stamp ${cls}">${cls === "done" ? I.done : cls === "go" ? I.letGo : I.later}<span>${esc(label)}</span></p>${action}</div>`;
}

function actionsHtml(item, open) {
  const love = `<button class="act icon" type="button" data-love="${esc(item.id)}" aria-pressed="${!!item.loved}" aria-label="Love">${item.loved ? I.heartFill : I.heart}</button>`;
  const reply = item.suggested ? "" : `<button class="act icon" type="button" data-reply="${esc(item.id)}" aria-label="Reply to yourself${item.replies?.length ? `, ${item.replies.length} so far` : ""}">${I.reply}${item.replies?.length ? `<span class="n" aria-hidden="true">${item.replies.length}</span>` : ""}</button>`;
  if (!open && item.status === STATUS.ASIDE) {
    return `<div class="settled-row"><p class="stamp later">${I.later}<span>Comes back ${esc(shortDate(item.until))}</span></p>
      <button class="act" type="button" data-backnow="${esc(item.id)}">${I.requeue}<span>Bring back now</span></button></div>`;
  }
  if (!open) {
    const requeue = item.status === STATUS.DONE || item.status === STATUS.ARCHIVED
      ? `<button class="act" type="button" data-requeue="${esc(item.id)}">${I.requeue}<span>Bring back</span></button>` : "";
    return `<div class="acts">${love}${reply}<span class="grow"></span>${requeue}</div>`;
  }
  if (item.school) {
    return `<div class="acts">${love}<span class="grow"></span>
    <button class="act" type="button" data-v="${VERDICT.LET_GO}" data-id="${esc(item.id)}">${I.letGo}<span>Not needed</span></button>
    <button class="act done" type="button" data-v="${VERDICT.DONE}" data-id="${esc(item.id)}">${I.done}<span>Done</span></button>
  </div>`;
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
    ? `<img class="${cls}" alt="${alt}"${focusAttr(item, pic)} data-blob="${esc(pic.blobId)}">`
    : `<img class="${cls}" alt="${alt}"${focusAttr(item, pic)} src="${esc(pic.src)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.closest('.pic')?.remove()">`;
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
        ${openBtn(`${pic ? "" : `<span class="fav" style="--c:${topicColor(item)}" aria-hidden="true">${esc((item.site || host(item.url) || "?").charAt(0).toUpperCase())}</span>`}<span class="lk"><span class="site">${esc(siteLine(item))}</span><span class="ttl">${esc(item.title)}</span></span>`, `Open ${item.title}`)}</div>${pic ? creditHtml(pic) : ""}`;
    case KIND.QUOTE:
    case KIND.NOTE:
      return pic ? `<div class="pic wide note-pic">${openBtn(imgTag(), `Open: ${item.title || "note"}`)}</div>${creditHtml(pic)}` : "";
    default: {
      const name = item.fileName || item.title;
      return `${pic ? `<div class="pic wide note-pic">${openBtn(imgTag(), `Open ${name}`)}</div>${creditHtml(pic)}` : ""}<div class="card file">${openBtn(`<span class="ext" style="--c:${topicColor(item)}">${esc(ext(item.fileName))}</span><span class="lk"><span class="ttl">${esc(item.title)}</span><span class="site">${esc([KIND_LABEL[item.kind], item.size ? size(item.size) : "", `${estimateMinutes(item)} min`].filter(Boolean).join(" · "))}</span></span>`, `Open ${name}`)}</div>`;
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
  $("#ask-in", tl)?.addEventListener("input", (e) => { state.schoolDraft = e.target.value; });
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
  if ((b = hit("[data-preview]"))) { playPreview(b); return; }
  if ((b = hit("[data-day]"))) { await dayAction(b.dataset.day); return; }
  if ((b = hit("[data-cq]"))) { const [k, i] = b.dataset.cq.split(":").map(Number); answerCpmai(k, i); return; }
  if ((b = hit("[data-school=go]"))) {
    b.disabled = true;
    const ok = await pullNewsletter($("#ask-in")?.value, $("#ask-st"));
    b.disabled = false;
    if (ok) { tick(true); render({ top: true }); toast(`${state.schoolCount} post${state.schoolCount === 1 ? "" : "s"} from school, under From school on Today.`); }
    return;
  }
  if ((b = hit("[data-welcome]"))) { await welcomeAction(b.dataset.welcome, b); return; }
  if ((b = hit("[data-ai-ask]"))) { setAi(b.dataset.aiAsk === "1"); render({ top: false }); return; }
  if ((b = hit("[data-school=skip]"))) { markSchoolAsked(); state.schoolDraft = ""; state.schoolForce = false; render({ top: false }); return; }
  if ((b = hit("[data-act]"))) { runAct(b.dataset.act, b); return; }
  if ((b = hit("[data-backnow]"))) {
    const cur = byId(b.dataset.backnow);
    if (cur) { dropReminder(cur); const back = bringBackNow(cur); delete back.reminder; await saveItem(back); tick(true); render({ top: false }); toast("It's back, at the top of Today."); }
    return;
  }
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
  if ((b = hit("[data-jump]"))) {
    const el = document.getElementById("p-" + b.dataset.jump);
    if (el) { el.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" }); el.querySelector("button")?.focus({ preventScroll: true }); }
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
  const img = pic.blobId ? `<img alt="${alt}" ${gone}${focusAttr(item, pic)} data-blob="${esc(pic.blobId)}">` : `<img alt="${alt}" ${gone}${focusAttr(item, pic)} referrerpolicy="no-referrer" src="${esc(pic.src)}">`;
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
  const sch = item.school;
  const hasUrl = item.kind === KIND.LINK || item.kind === KIND.VIDEO || Boolean(item.url);
  const f = (key, label, value, { area = false, type = "text", hint = "", ph = "" } = {}) => `<div class="field">
      <label for="ed-${key}">${label}${hint ? ` <span class="hint">${hint}</span>` : ""}</label>
      ${area
        ? `<textarea id="ed-${key}" rows="4" placeholder="${esc(ph)}">${esc(value || "")}</textarea>`
        : `<input id="ed-${key}" type="${type}" autocomplete="off" ${type === "url" ? 'inputmode="url" autocapitalize="off" spellcheck="false"' : ""} placeholder="${esc(ph)}" value="${esc(value ?? "")}">`}
    </div>`;
  const wrap = sheet(`
    <div class="sheet-head"><h2>Edit</h2><button class="x" type="button" data-close aria-label="Close">${I.close}</button></div>
    <p class="note">${sch ? `From ${esc(sch.name || "school")}` : esc(KIND_LABEL[item.kind] || "Item")} · ${sch ? "" : "saved "}${esc(ago(item.created))}${item.fileName ? ` · ${esc(item.fileName)}` : ""}</p>
    ${item.status === STATUS.DONE || item.status === STATUS.ARCHIVED ? "" : asideHtml("ed", item.status === STATUS.ASIDE ? item.until : null)}
    ${item.kind !== KIND.PHOTO ? `<div class="pic-edit">
      <div class="lbl"><span id="ed-pic-l">Picture</span></div>
      <div class="picks" id="ed-picks" role="group" aria-labelledby="ed-pic-l"></div>
      <span class="note" id="ed-pic-note" role="status"></span>
      <input type="file" id="ed-pic-file" accept="image/*" hidden>
    </div>` : ""}
    ${sch ? `${f("title", "Headline", item.title)}
      ${f("text", "Post", sch.body || item.text, { area: true })}
      ${f("overlay", "Line over the photo", sch.overlay, { ph: schoolSettings().child ? `${schoolSettings().child}, …` : "A line over the photo" })}
      ${f("sdate", "Date", sch.date || "", { type: "date" })}`
    : words ? f("text", item.kind === KIND.QUOTE ? "Quote" : "Note", item.text, { area: true }) : f("title", "Title", item.title)}
    ${item.kind === KIND.QUOTE || item.kind === KIND.VIDEO ? f("author", item.kind === KIND.QUOTE ? "Who said it" : "Channel", item.author) : ""}
    ${item.kind === KIND.PHOTO ? `<label class="check"><input type="checkbox" id="ed-book" ${item.book ? "checked" : ""}><span>This is a book I want to read<small>Done becomes "I've read it", and counts toward what you like rather than as a recent read.</small></span></label>
      ${f("author", "Author", item.book?.author || item.author)}` : ""}
    ${hasUrl ? f("url", "Link", item.url, { type: "url", ph: "https://" }) : ""}
    ${sch ? "" : f("why", "Why you saved it", item.why, { hint: "(shown at the top of the post)", ph: item.hook || "Read this before the roadmap review" })}
    ${!sch && !item.why && item.hook ? `<button class="chip use-guess" type="button" id="ed-guess">Start from ${APP}'s guess</button>` : ""}
    ${!words ? f("note", "Your note", item.kind === KIND.LINK ? item.text : item.note, { area: true, ph: "Anything you want to remember about it" }) : ""}
    ${sch ? f("tags", "Tags", (item.tags || []).join(", "), { ph: "band, soccer" }) : `<div class="two">
      ${f("tags", "Tags", (item.tags || []).join(", "), { ph: "scrum, ai" })}
      ${f("minutes", "Minutes", estimateMinutes(item), { type: "number" })}
    </div>`}
    ${ai.settings.enabled() ? `<button class="btn retag" type="button" id="ed-retag">Re-tag with AI</button>` : ""}
    <span class="st" id="ed-st" role="status"></span>
    ${item.email ? `<button class="btn" type="button" id="ed-to-school">Turn into school posts</button>` : ""}
    <button class="btn primary" type="button" id="ed-save">Save</button>
    <div class="danger">
      <button class="btn ghost-danger" type="button" id="ed-delete">${I.trash}Delete for good</button>
      <p class="note">Removes it${item.blobId ? " and its file" : ""} from this phone. To keep it in your history so ${APP} learns from it, use Let go instead.</p>
    </div>`, { tall: true, label: "Edit" });

  const val = (k) => $(`#ed-${k}`, wrap)?.value;
  if (item.kind !== KIND.PHOTO) bindPictureEdit(wrap, id);
  const wasUntil = item.status === STATUS.ASIDE ? item.until : null;
  let edUntil = wasUntil;
  if ($(".aside-pick", wrap)) bindAside(wrap, "ed", (u) => { edUntil = u; $("#ed-save", wrap).textContent = u && u !== wasUntil ? `Set aside until ${shortDate(u)}` : "Save"; });
  const save = async () => {
    const cur = byId(id);
    if (!cur) { closeSheet(); return; }
    // The calendar alert goes first, while this is still the tap.
    const remindMe = edUntil && edUntil !== wasUntil && $("#ed-remind", wrap)?.checked;
    if (remindMe && !notifyOn()) {
      downloadReminder({ title: val("title") || cur.title, why: val("why") ?? cur.why, url: val("url") ?? cur.url, until: edUntil });
    }
    const next = { ...cur, editedAt: Date.now() };
    if (cur.school) {
      const t = (val("text") || "").trim();
      next.title = (val("title") || "").trim().slice(0, 140) || cur.title;
      next.text = t || cur.text;
      next.school = { ...cur.school, body: t || cur.school.body, overlay: (val("overlay") || "").trim().slice(0, 60), date: /^\d{4}-\d{2}-\d{2}$/.test(val("sdate") || "") ? val("sdate") : null };
    } else if (words) {
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
    if (typed.join() !== (cur.tags || []).join()) next.tagsMine = true;
    next.tags = typed;
    const m = Math.round(+val("minutes"));
    next.minutes = Number.isFinite(m) && m > 0 ? Math.min(m, 600) : cur.minutes;
    let done = next, msg = "Saved.";
    if (edUntil !== wasUntil) { dropReminder(cur); delete next.reminder; }
    if (edUntil && edUntil !== wasUntil) {
      done = setAside(next, edUntil);
      msg = `Set aside until ${shortDate(edUntil)}.`;
      if (state.edition && state.edition.ids.includes(id)) {
        state.edition = { ...state.edition, ids: state.edition.ids.filter((x) => x !== id) };
        await db.meta.set("edition", state.edition);
      }
    } else if (!edUntil && wasUntil) { done = bringBackNow(next); msg = "It's back, at the top of Today."; }
    await saveItem(done);
    if (remindMe && notifyOn()) scheduleReminder(done);
    tick(true);
    closeSheet();
    render();
    toast(msg);
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
      // Use what's in the form now, so a note typed a moment ago counts before Save.
      const draft = { ...cur, why: (val("why") ?? cur.why ?? "").trim() };
      const note = val("note");
      if (note !== undefined) { if (cur.kind === KIND.LINK) draft.text = note.trim(); else draft.note = note.trim(); }
      const tags = tidyTags(await ai.retag(draft, blob, { vocab: vocab() }));
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
  // An email that was really a school newsletter: one post per piece that matters, then the email goes.
  $("#ed-to-school", wrap)?.addEventListener("click", async (e) => {
    const cur = byId(id);
    if (!cur) return;
    e.currentTarget.disabled = true;
    const st = $("#ed-st", wrap);
    const before = state.items.length;
    const ok = await pullNewsletter(`${cur.title || ""}\n\n${cur.text || ""}`, st);
    if (!ok) { e.currentTarget.disabled = false; return; }
    const n = state.items.length - before;
    await db.items.remove(id);
    state.items = state.items.filter((i) => i.id !== id);
    closeSheet();
    tick(true);
    render({ top: true });
    toast(`${n} post${n === 1 ? "" : "s"} from school, under From school.`);
  });
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
    note.textContent = it.coverOff ? (it.school ? "No picture." : "No picture. The post shows the link on its own.")
      : !pic ? (cands.length ? "Pick one, or add your own." : it.kind === KIND.LINK && !ai.relayBase() ? "Pictures from the page need the relay (Settings)." : "No pictures found. Add your own.")
      : pic.from === "mine" ? "Your photo." : pic.from === "page" ? "From the page." : "";
  };
  const after = async () => { await show(); refreshPost(id); render(); focusPending(); };
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
    dropReminder(item);
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
/* ================= Set aside until a date =================
 * In Add and in Edit: Now, or a day it comes back as new, at the top of
 * Today. A calendar alert (an .ics file the phone adds to Calendar) is the
 * reminder outside the app; web apps on iPhone can't schedule their own.
 */

/** Items whose day has come go back to New. Returns how many. */
async function wakeDue() {
  const woke = wakeAside(state.items);
  for (const it of woke) await saveItem(it);
  return woke.length;
}

/** Show one post: Today if it's there, else All saves. */
function jumpTo(id) {
  const item = byId(id);
  if (!item) return;
  if (!todayIds().includes(id)) { state.tab = "all"; state.allFilter = ALL_FILTERS.findIndex((f) => f.id === "all"); state.allQuery = item.title || ""; }
  else state.tab = "today";
  render();
  requestAnimationFrame(() => { const el = document.getElementById("p-" + id); if (el) el.scrollIntoView({ block: "start" }); });
}

/** Ask the relay to notify this phone at 9:00 on the day. Quiet on failure, with a note. */
async function scheduleReminder(item) {
  if (!item || !item.until || !notifyOn()) return;
  try {
    const at = new Date(item.until).setHours(9, 0, 0, 0);
    const body = [item.title || headline(item), item.why].filter(Boolean).join(" · ").slice(0, 200);
    if (NATIVE) {
      // The iPhone app schedules it on the phone itself; no relay needed.
      toNative({ type: "remind", id: item.id, at, title: "Back in Shoebox", body });
      const cur = byId(item.id);
      if (cur) await saveItem({ ...cur, reminder: { id: item.id, native: true } });
      return;
    }
    const r = await push.remind({ id: item.id, at, title: "Back in Shoebox", body, url: `${location.origin}${location.pathname}?open=${encodeURIComponent(item.id)}` });
    const cur = byId(item.id);
    if (cur) await saveItem({ ...cur, reminder: r });
  } catch (e) {
    noteError(e, { quiet: true, where: "reminder" });
    toast(`Couldn't set the notification: ${e.message}`);
  }
}

function dropReminder(item) {
  if (!item || !item.reminder) return;
  if (item.reminder.native) toNative({ type: "cancel", id: item.reminder.id });
  else push.cancel(item.reminder);
}

/* ================= The iPhone app =================
 * In the Shoebox iPhone app, this page runs inside a native shell that adds
 * the share sheet, a home-screen widget and on-phone notifications. It
 * announces itself as window.shoeboxNative; messages go to it here.
 */
const NATIVE = typeof window !== "undefined" && Boolean(window.shoeboxNative);
/** What this copy of the iPhone app can do (older builds can't answer calendar or location questions). */
const nativeCan = (f) => NATIVE && (window.shoeboxNative.features || []).includes(f);
const nativeWaits = new Map();
/** Ask the iPhone app something and wait for its answer. */
function nativeAsk(type, payload = {}, ms = 15000) {
  if (!NATIVE) return Promise.reject(new Error("Only in the iPhone app."));
  const id = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { nativeWaits.delete(id); reject(new Error("The iPhone app didn't answer.")); }, ms);
    nativeWaits.set(id, (r) => { clearTimeout(t); resolve(r); });
    toNative({ type, id, ...payload });
  });
}
if (NATIVE) window.shoeboxReply = (id, r) => { const f = nativeWaits.get(id); if (f) { nativeWaits.delete(id); f(r || {}); } };

/** Roughly where the phone is: the iPhone app's own location, or the browser's. Asks only when told to. */
async function getLocation({ ask = false } = {}) {
  if (nativeCan("location")) {
    const r = await nativeAsk("location", { ask }, ask ? 90000 : 20000);
    if (!r.ok) throw new Error(r.status === "denied" ? "Location is off for Shoebox. Turn it on in the iPhone's Settings › Shoebox." : r.status === "notAsked" ? "notAsked" : "Couldn't find where you are right now.");
    return r;
  }
  if (!navigator.geolocation) throw new Error("This browser can't share a location.");
  if (!ask) {
    const st = await navigator.permissions?.query({ name: "geolocation" }).catch(() => null);
    if (!st || st.state !== "granted") throw new Error("notAsked");
  }
  const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { maximumAge: 3600e3, timeout: 30000, enableHighAccuracy: false }))
    .catch((e) => { throw new Error(e && e.code === 1 ? "Location is off for Shoebox in this browser." : "Couldn't find where you are right now."); });
  return { lat: pos.coords.latitude, lon: pos.coords.longitude };
}
function toNative(msg) {
  try { window.webkit?.messageHandlers?.shoebox?.postMessage(msg); } catch { /* not in the app */ }
}
/** Reminders can be notifications: on the phone in the app, or through the relay on the web. */
function notifyOn() { return NATIVE || push.enabled(); }

/** Things shared to Shoebox from other apps, handed over by the iPhone app. */
async function receiveShared(list) {
  const out = [];
  for (const t of list || []) {
    try {
      if (t.kind === "file" && t.data) {
        const bytes = Uint8Array.from(atob(t.data), (c) => c.charCodeAt(0));
        out.push(await captureFile(new File([bytes], t.name || "shared", { type: t.mime || "application/octet-stream" }), "share"));
      } else if (t.value) {
        const text = [t.value, t.title && t.kind === "url" && t.title !== t.value ? t.title : ""].filter(Boolean).join("\n");
        out.push(...await captureText(text, "share"));
      }
    } catch (e) { noteError(e, { quiet: true, where: "share sheet" }); }
  }
  if (out.length) afterCapture(out);
}

/** What the widget shows: today's open posts, soonest first. */
let widgetTimer = 0;
function updateWidget() {
  if (!NATIVE) return;
  clearTimeout(widgetTimer);
  widgetTimer = setTimeout(() => {
    try {
      const s = todaySections();
      const list = [...s.school, ...s.fresh, ...s.six];
      const h = new Date().getHours();
      toNative({
        type: "today",
        greeting: h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening",
        left: [...s.fresh, ...s.six].filter(isOpen).length,
        posts: list.slice(0, 12).map((i) => ({ id: i.id, title: String(i.title || headline(i) || "").slice(0, 140), why: i.why || "", kind: i.kind, done: !isOpen(i) })),
      });
    } catch (e) { noteError(e, { quiet: true, where: "widget" }); }
  }, 600);
}

if (NATIVE) {
  window.shoeboxReceive = (list) => receiveShared(list);
  window.shoeboxOpen = (id) => jumpTo(id);
  window.shoeboxActive = () => { refreshCalendar(); loadMorning(); checkInbox(); };
  document.documentElement.classList.add("native");
}

const remindOn = () => { try { return localStorage.getItem("edition.remind") !== "0"; } catch { return true; } };
const setRemind = (on) => { try { localStorage.setItem("edition.remind", on ? "1" : "0"); } catch { /* private mode */ } };

function asideHtml(prefix, until) {
  const choices = asideChoices();
  const custom = until && !choices.some((c) => c.until === until);
  const tomorrow = toDateInput(choices[0].until);
  return `<div class="aside-pick">
      <div class="lbl"><span id="${prefix}-aside-l">Show it</span><span id="${prefix}-aside-when">${until ? `From ${esc(shortDate(until))}` : "Now"}</span></div>
      <div class="chips wrap" role="group" aria-labelledby="${prefix}-aside-l">
        <button class="chip" type="button" data-until="" aria-pressed="${!until}">Now</button>
        ${choices.map((c) => `<button class="chip" type="button" data-until="${c.until}" aria-pressed="${until === c.until}">${c.label}</button>`).join("")}
        <span class="chip date-chip" aria-pressed="${!!custom}"><span class="dl">${custom ? esc(shortDate(until)) : "Pick a date"}</span>
          <input type="date" id="${prefix}-aside-date" min="${tomorrow}" value="${custom ? toDateInput(until) : ""}" aria-label="Pick a date"></span>
      </div>
      <label class="check remind" ${until ? "" : "hidden"}><input type="checkbox" id="${prefix}-remind" ${remindOn() ? "checked" : ""}>
        <span>Remind me that morning<small>${notifyOn() ? "A notification at 9:00" : "Adds a 9:00 alert to your Calendar"}</small></span></label>
    </div>`;
}

/** Wire an asideHtml block. onPick(until or null) on every change. */
function bindAside(root, prefix, onPick) {
  const box = $(".aside-pick", root);
  const paint = (until) => {
    const choices = asideChoices();
    const custom = until && !choices.some((c) => c.until === until);
    box.querySelectorAll("[data-until]").forEach((b) => b.setAttribute("aria-pressed", String(String(until || "") === b.dataset.until)));
    const dc = $(".date-chip", box);
    dc.setAttribute("aria-pressed", String(!!custom));
    $(".dl", dc).textContent = custom ? shortDate(until) : "Pick a date";
    $(`#${prefix}-aside-when`, box).textContent = until ? `From ${shortDate(until)}` : "Now";
    $(".remind", box).hidden = !until;
    onPick(until || null);
  };
  box.addEventListener("click", (e) => {
    const b = e.target.closest("[data-until]");
    if (!b) return;
    const date = $(`#${prefix}-aside-date`, box);
    date.value = "";
    paint(b.dataset.until ? +b.dataset.until : null);
  });
  $(`#${prefix}-aside-date`, box).addEventListener("change", (e) => {
    const t = fromDateInput(e.target.value);
    paint(t && t > Date.now() ? t : null);
  });
  $(`#${prefix}-remind`, box).addEventListener("change", (e) => setRemind(e.target.checked));
}

/** Hand the phone a calendar alert for the day. Call straight from a tap, so the phone allows it. */
function downloadReminder({ title, why, url, until }) {
  const ics = reminderIcs({ title, why, url, until, appUrl: location.origin + location.pathname });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = "shoebox-reminder.ics";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

/* ================= Add (sheet) ================= */

function openAdd() {
  const F = state.capForm;
  const field = (key, label, { area = false, type = "text", hint = "", ph = "", rows = 2, attrs = "" } = {}) => `<div class="field" data-f="${key}" hidden>
      <label for="cap-${key}">${label}${hint ? ` <span class="hint">${hint}</span>` : ""}</label>
      ${area
        ? `<textarea id="cap-${key}" rows="${rows}" placeholder="${esc(ph)}" ${attrs}>${esc(key === "why" ? state.capWhy : F[key] || "")}</textarea>`
        : `<input id="cap-${key}" type="${type}" autocomplete="off" placeholder="${esc(ph)}" value="${esc(F[key] ?? "")}" ${attrs}>`}
    </div>`;
  const wrap = sheet(`
    <div class="sheet-head"><h2>Add</h2><button class="x" type="button" data-close aria-label="Close">${I.close}</button></div>
    <div class="cap">
      <label class="sr-only" for="cap-text">Link, note, quote or anything</label>
      <textarea id="cap-text" rows="2" placeholder="Paste a link or a quote, or type a thought.">${esc(state.capText)}</textarea>
      <div class="cap-src">
        <button class="chip" type="button" id="cap-paste">${I.paste}<span>Paste</span></button>
        <button class="chip" type="button" id="cap-attach">${I.attach}<span>Photo or file</span></button>
      </div>
    </div>
    <div class="tray" id="cap-tray"></div>
    <ul class="detect" id="cap-detect" aria-live="polite"></ul>
    <div class="cap-pics" id="cap-pics" hidden></div>
    <input type="file" id="cap-own" accept="image/*" hidden>
    ${field("title", "Title", { ph: "Fills in from the page" })}
    ${field("author", "Who said it")}
    ${field("why", "Why you're saving it", { area: true, hint: "(top of the post)", ph: "Read this before the roadmap review", attrs: 'maxlength="140"' })}
    ${field("note", "Your note", { area: true, ph: "Anything you want to remember about it" })}
    <div data-f="aside" hidden>${asideHtml("cap", F.until || null)}</div>
    <div class="cap-foot sheet-foot">
      <span class="st" id="cap-st" role="status"></span>
      <button class="btn primary save" type="button" id="cap-save">Save</button>
    </div>
    <input type="file" id="in-any" multiple hidden>`, { tall: true, label: "Add", guard: capHasDraft });
  wrap.classList.add("adding");
  const ta = $("#cap-text", wrap);
  const grow = (el, max) => { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight + 2, max)}px`; };
  ta.addEventListener("input", () => { state.capText = ta.value; grow(ta, 240); updateDetect(); });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveCapture(); });
  ta.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (!files.length) return;
    e.preventDefault();
    stageFiles(files);
  });
  const why = $("#cap-why", wrap);
  why.addEventListener("input", () => { state.capWhy = why.value; grow(why, 160); });
  for (const k of ["title", "author", "note"]) {
    const el = $(`#cap-${k}`, wrap);
    el.addEventListener("input", () => {
      F[k] = el.value;
      if (k === "title") F.titleTyped = true;
      if (el.tagName === "TEXTAREA") grow(el, 200);
    });
    if (el.tagName === "INPUT") el.addEventListener("keydown", (e) => { if (e.key === "Enter") saveCapture(); });
  }
  [why, $("#cap-note", wrap)].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveCapture(); }));
  bindAside(wrap, "cap", (until) => { F.until = until; updateDetect(); });
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
  [ta, why, $("#cap-note", wrap)].forEach((el) => el.value && grow(el, 240));
  ta.focus();
}

/** Something typed or attached in Add that a stray tap shouldn't throw away. */
function capHasDraft() {
  const F = state.capForm;
  return Boolean((state.capText || "").trim() || state.capFiles.length || (state.capWhy || "").trim() || F.note || F.until);
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
  const one = drafts.length === 1 ? drafts[0] : null;
  list.innerHTML = drafts.map((d) => {
    const detail = one || d.kind === KIND.NOTE || d.kind === KIND.QUOTE ? "" : d.fileName || (d.videoId ? "" : d.url) || "";
    return `<li>${I.arrow}<span class="what">${esc(describeDraft(d))}</span>${detail ? `<span class="d">${esc(detail)}</span>` : ""}</li>`;
  }).join("");
  // Title, why and note once there's something to describe; the AI tags it from what you write. Several at once share why.
  const words = one && (one.kind === KIND.NOTE || one.kind === KIND.QUOTE);
  const show = { why: drafts.length > 0, aside: drafts.length > 0, title: one && !words, author: one && one.kind === KIND.QUOTE, note: one && !words };
  for (const [k, on] of Object.entries(show)) { const el = $(`[data-f=${k}]`); if (el) el.hidden = !on; }
  const save = $("#cap-save");
  save.disabled = !drafts.length;
  const until = state.capForm.until;
  save.textContent = until ? `Set aside until ${shortDate(until)}` : drafts.length > 1 ? `Save ${drafts.length} items` : "Save";
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
  const until = state.capForm.until && state.capForm.until > Date.now() ? state.capForm.until : null;
  const remindMe = until && $("#cap-remind")?.checked;
  if (remindMe && !notifyOn()) {
    const first = stagedDrafts()[0] || {};
    downloadReminder({ title: String(state.capForm.title || first.title || text.split("\n")[0] || "").trim(), why: state.capWhy, url: first.url, until });
  }
  setCapStatus("Saving…");
  const out = [];
  if (text) out.push(...await captureText(text, "drop"));
  for (const f of state.capFiles) {
    out.push(await captureFile(f.file, "drop"));
    if (f.url) URL.revokeObjectURL(f.url);
  }
  for (let k = 0; k < out.length; k++) out[k] = await applyCapPicture(out[k]);
  await applyCapFields(out);
  if (until) for (let k = 0; k < out.length; k++) if (out[k]) { out[k] = setAside(out[k], until); await db.items.put(out[k]); }
  if (remindMe && notifyOn()) Promise.resolve().then(async () => { for (const it of out) await scheduleReminder(it); });
  if (state.capPic?.ownUrl) URL.revokeObjectURL(state.capPic.ownUrl);
  state.capText = "";
  state.capFiles = [];
  state.capWhy = "";
  state.capForm = {};
  state.capPic = null;
  closeSheet();
  afterCapture(out, until);
}
/** Put what you filled in on Add onto what was saved. What you typed, the AI leaves alone. */
async function applyCapFields(out) {
  const F = state.capForm, list = out.filter(Boolean), one = list.length === 1 ? list[0] : null;
  const why = (state.capWhy || "").trim().slice(0, 140);
  for (const it of list) {
    if (why) it.why = why;
    if (it === one) {
      const words = it.kind === KIND.NOTE || it.kind === KIND.QUOTE;
      const title = String(F.title || "").trim();
      if (!words && F.titleTyped && title) { it.title = title.slice(0, 140); it.titleMine = true; }
      const note = String(F.note || "").trim();
      if (!words && note) {
        if (it.kind === KIND.LINK) it.text = [it.text, note].filter(Boolean).join("\n\n");
        else it.note = note;
      }
      const author = String(F.author || "").trim();
      if (it.kind === KIND.QUOTE && author) it.author = author.slice(0, 80);
    }
    await db.items.put(it);
  }
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
      if (state.capPic && state.capPic.url === url) {
        state.capPic.page = { title: data.title, description: data.description, site: data.site };
        const t = $("#cap-title");
        if (t && data.title && !state.capForm.titleTyped) { t.value = state.capForm.title = String(data.title).slice(0, 140); }
      }
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

function bindSchoolSettings(wrap) {
  const st = $("#set-sc-st", wrap);
  const read = () => ({ ...schoolSettings(),
    school: $("#set-sc-school", wrap).value.trim(),
    child: $("#set-sc-child", wrap).value.trim(),
    about: $("#set-sc-about", wrap).value.trim(),
    words: $("#set-sc-words", wrap).value.split(",").map((w) => w.trim()).filter(Boolean) });
  wrap.querySelectorAll("[data-school-on]").forEach((b) => b.addEventListener("click", () => {
    const on = b.dataset.schoolOn === "1";
    setSchoolSettings({ ...read(), on });
    wrap.querySelectorAll("[data-school-on]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    render({ top: false });
  }));
  $("#set-sc-save", wrap).addEventListener("click", () => { setSchoolSettings(read()); st.textContent = "Saved."; render({ top: false }); });
  $("#set-sc-now", wrap).addEventListener("click", () => {
    setSchoolSettings(read());
    state.schoolForce = true;
    closeSheet();
    state.tab = "today";
    render({ top: true });
    requestAnimationFrame(() => $("#ask-in")?.focus());
  });
}

function bindCalendarSettings(wrap) {
  const st = $("#set-cal-st", wrap);
  const say = (msg, err) => { st.textContent = msg; st.classList.toggle("err", !!err); };
  $("#set-cal-save", wrap).addEventListener("click", async () => {
    const urls = [...new Set($("#set-cal", wrap).value.split(/\s+/).map((u) => u.trim()).filter(Boolean)
      .map((u) => u.replace(/^webcals?:\/\//i, "https://")))].filter((u) => /^https:\/\//i.test(u)).slice(0, 6);
    setCalUrls(urls);
    $("#set-cal", wrap).value = urls.join("\n");
    if (!urls.length) { say("Nothing saved. Paste a calendar address that starts with https:// or webcal://.", true); return; }
    if (!ai.relayBase()) { say("Saved. Add your relay address (Relay, above) so Shoebox can read it.", true); return; }
    say("Reading…");
    const c = await loadCalendar({ force: true });
    if (!c || c.errors.length === urls.length) { say((c && c.errors[0]) || "Couldn't read the calendar.", true); return; }
    const n = c.events.length;
    say(`${n ? `${n} event${n === 1 ? "" : "s"} today` : "Works. Nothing on it today"}${c.errors.length ? `. One address failed: ${c.errors[0]}` : "."}`, !!c.errors.length);
    render({ top: false });
  });
  $("#set-cal-clear", wrap).addEventListener("click", () => {
    setCalUrls([]);
    $("#set-cal", wrap).value = "";
    say("Removed. Your calendar no longer shows on Today.");
    render({ top: false });
  });
}

function bindPushSettings(wrap) {
  const say = (el, msg, err) => { el.textContent = msg; el.classList.toggle("err", !!err); };
  const st = $("#set-push-st", wrap), onBtn = $("#set-push-on", wrap), testBtn = $("#set-push-test", wrap);
  const paint = () => {
    const on = push.enabled();
    onBtn.textContent = on ? "Turn off" : "Turn on";
    testBtn.disabled = !on;
    $("#set-push-sv", wrap).textContent = on ? "On" : "Off";
  };
  // Have the relay's key ready, so the tap can ask for permission straight away.
  if (ai.relayBase() && !push.enabled()) push.prefetchKey().catch(() => {});
  onBtn.addEventListener("click", async () => {
    st.classList.remove("err");
    if (push.enabled()) { await push.turnOff(); paint(); say(st, "Notifications are off. Set-aside reminders go to your Calendar instead."); return; }
    if (!ai.relayBase()) { say(st, "Add your relay address first (Relay, above).", true); return; }
    say(st, "Asking…");
    try {
      await push.turnOn();
      paint();
      say(st, "On. Sending a test…");
      await push.sendTest();
      say(st, "On. A test notification is on its way.");
    } catch (e) {
      noteError(e, { quiet: true, where: "notifications" });
      paint();
      say(st, e.message || "Couldn't turn on notifications.", true);
    }
  });
  testBtn.addEventListener("click", async () => {
    say(st, "Sending…");
    try { await push.sendTest(); say(st, "Sent. It should arrive in a few seconds."); } catch (e) { say(st, e.message, true); }
  });
}

function openSettings(focus = "") {
  const c = counts(state.items);
  const m = morningSettings(), sc = schoolSettings(), me = personal();
  const onOff = (key, label, on) => `<div class="row"><span class="rk">${label}</span><div class="seg" role="group" aria-label="${label}"><button type="button" data-mo="${key}:1" aria-pressed="${on}">On</button><button type="button" data-mo="${key}:0" aria-pressed="${!on}">Off</button></div></div>`;
  const mailOn = (() => { try { return Boolean(localStorage.getItem("edition.inboxAddress")); } catch { return false; } })();
  const wrap = sheet(`
    <div class="sheet-head"><h2>Settings</h2><button class="x" type="button" data-close aria-label="Close">${I.close}</button></div>
    <div class="group">
      <div class="row"><span class="rk">Your photo</span>
        <span class="me-row"><span id="set-me">${avatarHtml("sm")}</span>
          <button class="btn sm" type="button" id="set-me-choose">${state.avatar ? "Change" : "Choose"}</button>
          <button class="btn sm ghost" type="button" id="set-me-clear" ${state.avatar ? "" : "disabled"}>Remove</button></span>
        <input type="file" id="set-me-file" accept="image/*" hidden></div>
      <div class="row"><span class="rk">Appearance</span>
        <div class="seg" role="group" aria-label="Appearance">${["system", "light", "dark"].map((t) => `<button type="button" data-look="${t}" aria-pressed="${themeChoice() === t}">${{ system: "Phone", light: "Light", dark: "Dark" }[t]}</button>`).join("")}</div></div>
      <div class="row"><span class="rk">Sounds</span>
        <div class="seg" role="group" aria-label="Sounds">
          <button type="button" data-sound="1" aria-pressed="${soundOn()}">On</button><button type="button" data-sound="0" aria-pressed="${!soundOn()}">Off</button></div></div>
    </div>

    <h3 class="set-h">Your morning</h3>
    <details class="group" id="set-morning">
      <summary><span>Weather</span><span class="sv">${m.weather ? esc(placeOf(m)?.name || "Add a place") : "Off"}</span></summary>
      ${onOff("weather", "Show weather", m.weather)}
      ${canLocate() ? `<div class="row"><span class="rk">Where</span><button class="btn sm" type="button" id="set-mo-loc">${m.useLocation ? `Following you: ${esc(placeOf(m)?.name || "…")}` : "Use my location"}</button></div>` : ""}
      <div class="field"><label for="set-mo-zip">${canLocate() ? "Or a ZIP code or town" : "ZIP code or town"}</label>
        <input id="set-mo-zip" type="text" autocomplete="postal-code" value="${esc(m.useLocation ? "" : m.zip || placeOf(m)?.name || "")}" placeholder="e.g. 28409"></div>
      <div class="field"><label for="set-mo-cam">Camera <span class="hint">(optional)</span></label>
        <input id="set-mo-cam" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="A webcam picture or a YouTube live link" value="${esc(m.cam)}"></div>
      <p class="note">Blank shows the weather radar. To find a camera, search your town and "webcam": local TV stations and <a href="https://www.windy.com/webcams" target="_blank" rel="noopener">windy.com/webcams</a> list live ones. Use the address of the picture itself (often ending in .jpg) or a YouTube live link.</p>
      <button class="btn primary" type="button" id="set-mo-save">Save</button>
      <span class="st" id="set-mo-st" role="status"></span>
    </details>
    <details class="group" id="set-study">
      <summary><span>Study deck</span><span class="sv">${m.study && m.studyTopic ? esc(studyLabel(m)) : "Off"}</span></summary>
      ${onOff("study", "Daily questions", m.study)}
      <div class="field"><label for="set-study-topic">Topic</label>
        <input id="set-study-topic" type="text" autocomplete="off" placeholder="e.g. AWS Solutions Architect, Spanish verbs, US history" value="${esc(m.studyTopic)}"></div>
      <button class="btn" type="button" id="set-study-save">Save</button>
      <span class="st" id="set-study-st" role="status"></span>
      <p class="note">Three practice questions each morning, written by AI. Mark them Done once answered.</p>
    </details>
    <details class="group">
      <summary><span>More cards</span></summary>
      ${onOff("otd", "On this day", m.otd)}
      ${me ? onOff("song", "Song of the day", m.song) + onOff("hockey", "Last night's games", m.hockey) + onOff("jung", "Jung quote", m.jung) : ""}
      ${me ? `<div class="field"><label for="set-mo-teams">Teams</label><input id="set-mo-teams" type="text" autocomplete="off" autocapitalize="characters" value="${esc(m.teams.join(", "))}"></div>
      <button class="btn" type="button" id="set-mo-teams-save">Save teams</button>
      <h3 class="sub">Song of the day: your Shortcut</h3>
      <p class="note">Song key: <b id="set-song-key">${esc((() => { try { return localStorage.getItem("edition.songKey") || "appears once the relay has your Apple key"; } catch { return ""; } })())}</b>
        <button class="btn sm" type="button" id="set-song-copy">Copy</button></p>
      <p class="note">In Shortcuts: Find Music where Play Count is greater than 0, sort by Last Played, oldest first, limit 1. Then Get Contents of URL: <b>${esc(ai.relayBase())}/song</b>, method POST, header <b>x-song-key</b> = your key, JSON body title (Name), artist (Artist), lastPlayed (Last Played). Run it from a daily 6:00 AM automation.</p>` : ""}
      <span class="st" id="set-more-st" role="status"></span>
    </details>

    <h3 class="set-h">What comes in</h3>
    <details class="group">
      <summary><span>Calendar</span><span class="sv">${calOn() ? "On" : "Off"}</span></summary>
      ${nativeCan("calendar") ? `<div class="row"><span class="rk">This iPhone's calendars</span><div class="seg" role="group" aria-label="This iPhone's calendars"><button type="button" data-calnative="1" aria-pressed="${calNative()}">On</button><button type="button" data-calnative="0" aria-pressed="${!calNative()}">Off</button></div></div>
      <p class="note">Everything in the Calendar app: iCloud, Google, Outlook. Events stay on your iPhone.</p>` : ""}
      ${(() => { const seen = [...new Set((calCache()?.events || []).map((e) => calName(e.calendar, "Calendar")).concat(calHidden()))].sort();
        return seen.length > 1 ? `<h3 class="sub">Show on Today</h3>${seen.map((n) => `<div class="row"><span class="rk">${esc(n)}</span><div class="seg" role="group" aria-label="${esc(n)}"><button type="button" data-calshow="${esc(n)}:1" aria-pressed="${!calHidden().includes(n)}">Show</button><button type="button" data-calshow="${esc(n)}:0" aria-pressed="${calHidden().includes(n)}">Hide</button></div></div>`).join("")}` : ""; })()}
      <div class="field"><label for="set-cal">${nativeCan("calendar") ? "Or a calendar address" : "Calendar addresses"} <span class="hint">(one per line)</span></label>
        <textarea id="set-cal" rows="3" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics">${esc(calUrls().join("\n"))}</textarea></div>
      <div class="two">
        <button class="btn primary" type="button" id="set-cal-save">Save and test</button>
        <button class="btn" type="button" id="set-cal-clear">Remove</button>
      </div>
      <span class="st" id="set-cal-st" role="status"></span>
      <p class="note">Today's events show at the top of Today and leave at midnight. Google: calendar settings › Secret address in iCal format. iPhone: Calendar › calendar info › Public Calendar › Share Link.</p>
    </details>
    <details class="group">
      <summary><span>Newsletters</span><span class="sv">${sc.on ? "Mon, Fri" : "Off"}</span></summary>
      <div class="row"><span class="rk">Ask me</span>
        <div class="seg" role="group" aria-label="Ask me"><button type="button" data-school-on="1" aria-pressed="${sc.on}">Mon and Fri</button><button type="button" data-school-on="0" aria-pressed="${!sc.on}">Off</button></div></div>
      <div class="field"><label for="set-sc-school">From <span class="hint">(a school, club or team)</span></label><input id="set-sc-school" type="text" autocomplete="off" placeholder="e.g. Lincoln Middle School" value="${esc(sc.school)}"></div>
      <div class="field"><label for="set-sc-about">What matters to you <span class="hint">(grade, activities, teams)</span></label>
        <textarea id="set-sc-about" rows="3" placeholder="e.g. 8th grade, band, soccer and lacrosse">${esc(sc.about)}</textarea></div>
      <div class="field"><label for="set-sc-child">Child's name <span class="hint">(optional)</span></label><input id="set-sc-child" type="text" autocomplete="off" value="${esc(sc.child)}"></div>
      <p class="note">Names stay on this phone. AI only ever sees "your child"; Shoebox puts the name back on the post.</p>
      ${me || mailOn ? `<div class="field"><label for="set-sc-words">Words that mark it in email <span class="hint">(sender, district, mascot; commas)</span></label><input id="set-sc-words" type="text" autocomplete="off" value="${esc(sc.words.join(", "))}"></div>` : `<input id="set-sc-words" type="hidden" value="${esc(sc.words.join(", "))}">`}
      <div class="two">
        <button class="btn primary" type="button" id="set-sc-save">Save</button>
        <button class="btn" type="button" id="set-sc-now">Add one now</button>
      </div>
      <span class="st" id="set-sc-st" role="status"></span>
    </details>
    ${me || mailOn ? `<details class="group">
      <summary><span>Email in</span><span class="sv">${mailOn ? "On" : "Off"}</span></summary>
      <p class="note">${(() => { try { const a = localStorage.getItem("edition.inboxAddress"); return a ? `Forward anything to <b>${esc(a)}</b>. Newsletters become posts; everything else becomes a post of its own.` : "Forward email to your own Shoebox address."; } catch { return ""; } })()}</p>
      <button class="btn" type="button" id="set-mail-check">Check for email now</button>
      <span class="st" id="set-mail-st" role="status"></span>
    </details>` : ""}

    <h3 class="set-h">AI and reminders</h3>
    <details class="group">
      <summary><span>AI</span><span class="sv">${ai.settings.enabled() ? "On" : "Off"}</span></summary>
      <div class="row"><span class="rk">Use AI</span>
        <div class="seg" role="group" aria-label="Use AI">
          <button type="button" data-ai="1" aria-pressed="${ai.settings.consented()}">On</button><button type="button" data-ai="0" aria-pressed="${!ai.settings.consented()}">Off</button></div></div>
      <p class="note">${esc(AI_DISCLOSURE)}</p>
      <p class="note" id="set-ai-use"></p>
      <button class="btn" type="button" id="set-discover" ${ai.settings.canDiscover() ? "" : "disabled"}>Get top stories now</button>
      <span class="st" id="set-st" role="status"></span>
    </details>
    <details class="group" id="set-push-g">
      <summary><span>Notifications</span><span class="sv" id="set-push-sv">${push.enabled() ? "On" : "Off"}</span></summary>
      <div class="two">
        <button class="btn primary" type="button" id="set-push-on">${push.enabled() ? "Turn off" : "Turn on"}</button>
        <button class="btn" type="button" id="set-push-test" ${push.enabled() ? "" : "disabled"}>Send a test</button>
      </div>
      <span class="st" id="set-push-st" role="status"></span>
      <p class="note">When something you set aside comes back, at 9:00${push.needsHomeScreen() ? ". On iPhone, open Shoebox from your Home Screen" : ""}.</p>
    </details>

    <h3 class="set-h">Your data</h3>
    <details class="group">
      <summary><span>Backup</span></summary>
      <div class="two">
        <button class="btn" type="button" id="set-export">Export backup</button>
        <button class="btn" type="button" id="set-import">Import backup</button>
      </div>
      <p class="note">The backup holds everything: items, photos and files, and your settings. Keep it somewhere private.</p>
      <input type="file" id="set-import-file" accept="application/json,.json" hidden>
      <span class="st" id="set-bk-st" role="status"></span>
      ${state.items.some((i) => i.sample) ? `<button class="btn" type="button" id="set-samples-clear">Remove the sample items</button>
      <span class="st" id="set-sm-st" role="status"></span>` : ""}
    </details>
    <details class="group">
      <summary><span>What Shoebox learned</span></summary>
      <h3 class="sub">Suggestions</h3>
      <div id="sug-profile"></div>
      <h3 class="sub" id="set-tags">Tags</h3>
      <div id="tag-list"></div>
    </details>

    <h3 class="set-h">Help</h3>
    <div class="group help-links">
      <a class="row" href="${supportMail()}"><span class="rk">Contact support</span><span class="sv">support@tangomike.app</span></a>
      <a class="row" href="privacy" target="_blank" rel="noopener"><span class="rk">Privacy</span></a>
    </div>
    <div class="group">
      <div class="row"><span class="rk">Anonymous usage stats</span>
        <div class="seg" role="group" aria-label="Anonymous usage stats"><button type="button" data-stats="1" aria-pressed="${statsOn()}">On</button><button type="button" data-stats="0" aria-pressed="${!statsOn()}">Off</button></div></div>
      <p class="note">Once a day: counts only (how many saves, finished mornings, kinds of problem), never what you saved. It helps make Shoebox better.</p>
    </div>
    ${me ? `<details class="group" id="set-usage">
      <summary><span>Usage (owner)</span></summary>
      <div id="set-usage-box"><p class="note">Loading…</p></div>
    </details>` : ""}
    <details class="group">
      <summary><span>Something wrong?</span><span class="sv">${problems.length ? `${problems.length} logged` : "None"}</span></summary>
      <p class="note" id="set-pr-n"></p>
      <div class="two">
        <button class="btn" type="button" id="set-pr-copy">Copy diagnostics</button>
        <button class="btn" type="button" id="set-pr-clear">Clear</button>
      </div>
      <button class="btn" type="button" id="set-rebuild">Rebuild today</button>
      <span class="st" id="set-ed-st" role="status"></span>
    </details>
    <p class="version">${APP}${me ? " Me" : ""} ${VERSION} · ${c.inbox} new · ${c.queued} queued · ${c.done} done · ${c.archived} let go</p>`, { label: "Settings" });

  const st = $("#set-st", wrap);
  const say = (el, msg, err) => { el.textContent = msg; el.classList.toggle("err", !!err); };
  wrap.querySelectorAll("[data-ai]").forEach((b) => b.addEventListener("click", () => {
    const on = b.dataset.ai === "1";
    setAi(on);
    wrap.querySelectorAll("[data-ai]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    $("#set-discover", wrap).disabled = !on;
    say(st, on ? "AI is on." : `AI is off. ${APP} works without it.`);
    const sv = b.closest("details")?.querySelector(".sv"); if (sv) sv.textContent = on ? "On" : "Off";
    render({ top: false });
  }));
  if (ai.settings.consented() && ai.settings.device()) {
    ai.usage().then((u) => { const el = $("#set-ai-use", wrap); if (el) el.textContent = `Today: ${u.cents.toFixed(1)}¢ of AI${u.limit ? ` (daily allowance ${u.limit}¢)` : ""}. Install id: ${u.device}.`; }).catch(() => {});
  }
  renderSuggestProfile(wrap);
  renderTagList(wrap);
  refreshProblems(wrap);
  $("#set-pr-copy", wrap).addEventListener("click", copyDiagnostics);
  $("#set-pr-clear", wrap).addEventListener("click", () => { clearProblems(); refreshProblems(wrap); });
  bindPushSettings(wrap);
  bindCalendarSettings(wrap);
  bindSchoolSettings(wrap);
  wrap.querySelectorAll("[data-mo]").forEach((b) => b.addEventListener("click", () => {
    const [k, on] = b.dataset.mo.split(":");
    setMorningSettings({ ...morningSettings(), [k]: on === "1" });
    wrap.querySelectorAll(`[data-mo^="${k}:"]`).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    render({ top: false });
    loadMorning();
  }));
  $("#set-mo-save", wrap).addEventListener("click", async () => {
    const st2 = $("#set-mo-st", wrap);
    const q = $("#set-mo-zip", wrap).value.trim();
    const cam = $("#set-mo-cam", wrap).value.trim();
    const cur = morningSettings();
    let next = { ...cur, cam: /^https:\/\//.test(cam) ? cam : "" };
    if (cam && !next.cam) { say(st2, "The camera address needs to start with https://.", true); return; }
    if (q && q !== cur.zip && q !== placeOf(cur)?.name) {
      say(st2, "Finding that place…");
      try {
        const place = await withTimeout(daily.lookupPlace(q), 15000);
        if (!place) { say(st2, "Couldn't find that place. Try a 5-digit ZIP code.", true); return; }
        next = { ...next, zip: place.zip || "", place, weather: true };
        const c = morningCache(); delete c.weather; saveMorningCache(c);
      } catch (e) { noteError(e, { quiet: true, where: "place lookup" }); say(st2, "Couldn't look that up right now. Try again shortly.", true); return; }
      next.useLocation = false;
    } else if (!q && !cur.useLocation) next = { ...next, zip: "", place: null };
    setMorningSettings(next);
    say(st2, placeOf(next) ? `Saved: weather for ${placeOf(next).name}.` : "Saved.");
    const sv = $("#set-morning .sv", wrap); if (sv) sv.textContent = next.weather ? placeOf(next)?.name || "Add a place" : "Off";
    render({ top: false });
    loadMorning();
  });
  $("#set-study-save", wrap).addEventListener("click", () => {
    const topic = $("#set-study-topic", wrap).value.trim().slice(0, 80);
    setMorningSettings({ ...morningSettings(), studyTopic: topic, study: Boolean(topic) });
    wrap.querySelectorAll('[data-mo^="study:"]').forEach((x) => x.setAttribute("aria-pressed", String((x.dataset.mo === "study:1") === Boolean(topic))));
    say($("#set-study-st", wrap), topic ? (ai.settings.enabled() ? `Saved. Questions on ${topic} come each morning.` : "Saved. Turn on AI for the questions.") : "Study deck off.");
    const sv = $("#set-study .sv", wrap); if (sv) sv.textContent = topic ? topic.slice(0, 40) : "Off";
    render({ top: false });
    loadMorning();
  });
  $("#set-mo-teams-save", wrap)?.addEventListener("click", () => {
    const teams = $("#set-mo-teams", wrap).value.toUpperCase().split(/[\s,]+/).filter((t) => /^[A-Z]{3}$/.test(t)).slice(0, 4);
    setMorningSettings({ ...morningSettings(), teams: teams.length ? teams : MORNING_ME.teams });
    const c = morningCache(); delete c.gamesAt; delete c.games; saveMorningCache(c);
    say($("#set-more-st", wrap), "Teams saved.");
    loadMorning();
  });
  $("#set-song-copy", wrap)?.addEventListener("click", async () => {
    const st2 = $("#set-more-st", wrap);
    try { await navigator.clipboard.writeText($("#set-song-key", wrap).textContent); say(st2, "Song key copied."); } catch { say(st2, "Couldn't copy; select it and copy."); }
  });
  wrap.querySelectorAll("[data-stats]").forEach((b) => b.addEventListener("click", () => {
    setStatsOn(b.dataset.stats === "1");
    wrap.querySelectorAll("[data-stats]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
  $("#set-usage", wrap)?.addEventListener("toggle", (ev) => { if (ev.currentTarget.open) showUsage($("#set-usage-box", wrap)); });
  $("#set-mail-check", wrap)?.addEventListener("click", () => checkInbox({ statusEl: $("#set-mail-st", wrap) }));
  if (focus) {
    const g = $(`#${focus}`, wrap);
    if (g) { g.open = true; requestAnimationFrame(() => g.scrollIntoView({ block: "start" })); }
  }
  const edSt = $("#set-ed-st", wrap);
  $("#set-rebuild", wrap).addEventListener("click", async () => {
    say(edSt, ai.settings.enabled() ? "Ranking your queue…" : "Rebuilding…");
    try {
      await ensureEdition({ force: true });
      closeSheet(); render(); toast("Today is rebuilt.");
    } catch (e) { say(edSt, e.message || "Could not rebuild.", true); }
  });
  $("#set-discover", wrap).addEventListener("click", () => findNew(st).then((n) => { refreshProblems(wrap); if (n) render(); }));
  $("#set-samples-clear", wrap)?.addEventListener("click", async () => {
    const n = await removeSamples();
    $("#set-samples-clear", wrap).disabled = true;
    say($("#set-sm-st", wrap), `Removed ${n} sample items.`);
    render();
  });
  $("#set-mo-loc", wrap)?.addEventListener("click", async (ev) => {
    const btn = ev.currentTarget, st2 = $("#set-mo-st", wrap);
    say(st2, "Finding where you are…");
    try {
      const place = await useMyLocation();
      btn.textContent = `Following you: ${place.name}`;
      $("#set-mo-zip", wrap).value = "";
      say(st2, `Weather for ${place.name}. It follows you when you travel.`);
      const sv = $("#set-morning .sv", wrap); if (sv) sv.textContent = place.name;
    } catch (e) { say(st2, e.message, true); }
  });
  wrap.querySelectorAll("[data-calshow]").forEach((b) => b.addEventListener("click", () => {
    const i = b.dataset.calshow.lastIndexOf(":"), name = b.dataset.calshow.slice(0, i), show = b.dataset.calshow.slice(i + 1) === "1";
    const list = new Set(calHidden());
    if (show) list.delete(name); else list.add(name);
    setCalHidden([...list]);
    wrap.querySelectorAll(`[data-calshow^="${CSS.escape(name)}:"]`).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    render({ top: false });
  }));
  wrap.querySelectorAll("[data-calnative]").forEach((b) => b.addEventListener("click", async () => {
    const st2 = $("#set-cal-st", wrap);
    if (b.dataset.calnative === "1") {
      say(st2, "Asking for your calendars…");
      const r = await turnOnNativeCalendar();
      say(st2, r.msg, !r.ok);
      if (!r.ok) return;
    } else { setCalNative(false); say(st2, "This iPhone's calendars are off."); render({ top: false }); }
    wrap.querySelectorAll("[data-calnative]").forEach((x) => x.setAttribute("aria-pressed", String((x.dataset.calnative === "1") === calNative())));
  }));
  bindAvatarSettings(wrap);
  wrap.querySelectorAll("[data-look]").forEach((b) => b.addEventListener("click", () => {
    setThemeChoice(b.dataset.look);
    wrap.querySelectorAll("[data-look]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
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
      if (n.settings) { location.reload(); return; }
      state.items = await db.items.all();
      closeSheet(); render(); toast(`Imported ${n.items} items.`);
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
    <p class="note">Tap one to forget it.</p>
    <button class="btn" type="button" id="sug-reset">Forget all of it</button>`
    : `<p class="note">Nothing yet. It learns when you say a suggestion isn't for you.</p>`;
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
    $("#set-me", wrap).innerHTML = avatarHtml("sm");
    $("#set-me-choose", wrap).textContent = state.avatar ? "Change" : "Choose";
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
       <p class="note">Tap a tag to rename, merge or delete it.</p>`
    : `<p class="note">No tags yet.</p>`)
    + (al.length ? `<div class="sug-row"><span class="k">Kept from your merges and deletes</span><div class="chips">${al.map(([f, t]) =>
      `<button class="chip unlearn" type="button" data-alias="${esc(f)}" aria-label="Forget ${esc(f)}">${esc(f)} ${t ? `→ ${esc(t)}` : "(deleted)"} ${I.close}</button>`).join("")}</div>
      <p class="note">Tap one to forget it.</p></div>` : "");
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
  const t = $("#set-tags");
  if (t) { t.closest("details").open = true; t.scrollIntoView({ block: "start" }); }
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
    `AI: ${ai.settings.enabled() ? "on" : "off"}${ai.settings.key() ? " (older key still set)" : ""}; relay: ${relay ? new URL(relay).host : "none"}`,
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
function sheet(html, { tall = false, label = "", guard = null } = {}) {
  closeSheet();
  expireToast(); // a leftover message shouldn't sit over the sheet
  lastFocus = document.activeElement;
  const wrap = document.createElement("div");
  wrap.className = "sheet-wrap";
  // Three parts: the grab handle, a body that scrolls on its own, and an optional footer
  // (anything marked .sheet-foot) that stays put below it. The sheet is sized to what's visible.
  wrap.innerHTML = `<div class="sheet ${tall ? "tall" : ""}" role="dialog" aria-modal="true" aria-label="${esc(label)}"><span class="grab" aria-hidden="true"></span><div class="sheet-body">${html}</div></div>`;
  // A sheet with something typed in it (guard) doesn't close on a stray tap outside it.
  wrap.addEventListener("click", (e) => {
    if (e.target !== wrap) return;
    if (guard && guard()) { document.activeElement?.blur?.(); return; }
    closeSheet();
  });
  wrap.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeSheet));
  const panel = $(".sheet", wrap), body = $(".sheet-body", panel);
  const foot = $(".sheet-foot", body);
  if (foot) panel.appendChild(foot);
  document.body.appendChild(wrap);
  // A swipe never scrolls the page behind: outside the body, or past its top or end, iOS would hand
  // the swipe to the page, so it's stopped here. The body itself scrolls normally.
  let sy = 0;
  wrap.addEventListener("touchstart", (e) => { sy = e.touches[0].clientY; }, { passive: true });
  wrap.addEventListener("touchmove", (e) => {
    if (!e.cancelable) return;
    if (!body.contains(e.target)) { if (!panel.contains(e.target) || !panel.style.transform) e.preventDefault(); return; }
    if (e.target.closest(".picks, .chips, .tray")) return; // rows that scroll sideways
    const box = e.target.closest("textarea");
    if (box && box.scrollHeight > box.clientHeight + 1) return; // a long field scrolls itself
    const dy = e.touches[0].clientY - sy;
    const atTop = body.scrollTop <= 0, atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
    if (body.scrollHeight <= body.clientHeight + 1 || (dy < 0 && atEnd)) e.preventDefault();
    else if (dy > 0 && atTop) e.preventDefault(); // at the top, a pull moves the sheet (to close), not the page
  }, { passive: false });
  // Never sideways: if iOS nudges the body left or right (a wide field, a focus jump), put it back.
  body.addEventListener("scroll", () => { if (body.scrollLeft) body.scrollLeft = 0; }, { passive: true });
  bindPull({ scroller: panel, target: panel, host: wrap, onBack: closeSheet, guard, pos: body });
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
function bindPull({ scroller, target, host, label, onBack, guard = null, pos = null }) {
  const at = pos || scroller; // the element whose scroll position decides whether a pull starts
  const drag = !label; // a sheet: plain drag to close
  const tip = document.createElement("div");
  if (!drag) {
    tip.className = "pull-tip";
    tip.setAttribute("aria-hidden", "true");
    tip.innerHTML = `${I.down}<span>${esc(label)}</span>`;
    host.appendChild(tip);
  }
  let x0 = 0, y0 = null, t0 = 0, dy = 0, lit = false, typing = false;
  const willClose = () => drag ? dy >= DRAG_CLOSE || (dy > 40 && dy / Math.max(1, Date.now() - t0) > 0.6) : dy >= PULL;
  const reset = () => {
    y0 = null; dy = 0; lit = false;
    tip.style.opacity = ""; tip.classList.remove("go");
    target.style.transition = "transform 0.2s ease";
    target.style.transform = "";
  };
  scroller.addEventListener("touchstart", (e) => {
    if (y0 == null && target.style.transform) { target.style.transition = "transform 0.2s ease"; target.style.transform = ""; }
    if (at.scrollTop > 0 || e.touches.length !== 1) return;
    if (e.target.closest("input, textarea, iframe, video, audio, .chips, .tray, .picks")) return;
    if (drag) {
      // While typing, a pull down only puts the keyboard away. With a draft, only the handle and title bar close it.
      typing = document.activeElement && host.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
      if (!typing && guard && guard() && !e.target.closest(".grab, .sheet-head")) return;
    }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); dy = 0;
  }, { passive: true });
  scroller.addEventListener("touchmove", (e) => {
    if (y0 == null) return;
    const dx = e.touches[0].clientX - x0;
    dy = e.touches[0].clientY - y0;
    if (dy <= 0 || at.scrollTop > 0 || Math.abs(dx) > dy) { if (dy < -4 || Math.abs(dx) > Math.max(dy, 12)) reset(); return; }
    // A few pixels of give first: a scroll that starts with a wobble stays a scroll.
    if (dy < 6 && !target.style.transform) return;
    if (drag && typing) { if (dy > 24) { document.activeElement?.blur?.(); y0 = null; } return; }
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
    if (typing) { y0 = null; typing = false; return; }
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
    const woke = await wakeDue();
    refreshCalendar();
    loadMorning();
    checkInbox();
    await ensureEdition();
    if (woke || state.items.length !== before || (state.edition && state.edition.date !== day)) {
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
