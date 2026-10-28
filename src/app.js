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
  setAside, startOfDay, wakeAside, bringBackNow, asideChoices, fromDateInput, toDateInput, shortDate, reminderIcs,
  senderName, plainEntities,
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
import { problems, realProblems, noteError as logError, onFirstProblem, clearProblems, formatProblem } from "./problems.js";
import { track, trackError, sendReport, statsOn, setStatsOn } from "./stats.js";
import * as songs from "./songs.js";
import { TOPICS, followTopics, followedTopics, withFollows, makeCoach, shareStep, pickTip, tipDone, mixStories, followOrder } from "./onboard.js";

export const VERSION = "4.61.0";
const APP = "Shoebox";
const noteError = (e, opts = {}) => { trackError(opts.where || "other"); return logError(e, { ...opts, version: VERSION }); };

const KIND_LABEL = { link: "Link", note: "Note", quote: "Quote", photo: "Photo", pdf: "PDF", text: "Text", video: "Video", audio: "Audio", file: "File" };
/*
 * All saves is where you come to find something ("that video about…"), or to
 * pick something to read now. So: search first and across everything; then
 * what you'd reach for, in the order you'd reach for it; then what kind of
 * thing it was, which is often what you remember.
 */
const ALL_FILTERS = [
  { label: "Everything", id: "all", test: () => true },
  { label: "To read", id: "toread", test: (i) => i.status === STATUS.QUEUED || i.status === STATUS.INBOX },
  { label: "Loved", id: "loved", test: (i) => Boolean(i.loved) },
  { label: "Coming back", id: STATUS.ASIDE, test: (i) => i.status === STATUS.ASIDE },
  { label: "Finished", id: STATUS.DONE, test: (i) => i.status === STATUS.DONE },
  { label: "Let go", id: STATUS.ARCHIVED, test: (i) => i.status === STATUS.ARCHIVED },
];
/** What each All saves list is for, said where it's empty. */
const EMPTY_ALL = {
  all: "Everything you save lives here. Tap + or share from any app to start.",
  toread: "Nothing waiting. Tap + or share from any app, and it comes back on Today.",
  loved: "Double-tap a photo or tap the heart on anything. Loved things are kept here for good.",
  [STATUS.ASIDE]: "Set something aside until a day you choose. It waits here, then tops Today that morning.",
  [STATUS.DONE]: "What you finish lands here, so you can find it again.",
  [STATUS.ARCHIVED]: "What you let go waits here for a while. Open any of it to bring it back.",
};
const isVideoLink = (i) => i.kind === KIND.LINK && /youtube\.com|youtu\.be|vimeo\.com|tiktok\.com/i.test(i.url || "");
const ALL_KINDS = [
  { label: "Articles", id: "articles", test: (i) => i.kind === KIND.LINK && !isVideoLink(i) && !i.school && !i.email },
  { label: "Videos", id: "videos", test: (i) => i.kind === KIND.VIDEO || isVideoLink(i) },
  { label: "Photos", id: "photos", test: (i) => i.kind === KIND.PHOTO && !i.school },
  { label: "Notes and quotes", id: "words", test: (i) => (i.kind === KIND.NOTE || i.kind === KIND.QUOTE) && !i.school && !i.email },
  { label: "Files", id: "files", test: (i) => [KIND.PDF, KIND.TEXT, KIND.FILE, KIND.AUDIO].includes(i.kind) },
  { label: "School", id: "school", test: (i) => Boolean(i.school) },
  { label: "Email", id: "email", test: (i) => Boolean(i.email) && !i.school },
];
const PAGE = 30;
const IDLE_MS = 3000;

const state = {
  items: [],
  edition: null,
  tab: "today",
  allFilter: 0,
  allKind: "",
  allQuery: "",
  allShown: PAGE,
  capText: "",
  capFiles: [],
  capWhy: "",
  capForm: {},       // the other Add fields: title, note, author, tags, minutes (and which you typed)
  capPic: null,      // the picture picker in Add: { url, status, list, choice, ownFile, ownUrl }
  enriching: new Set(),
  expanded: new Set(), // posts opened in place by a tap on their words
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

/** Shoebox's first address. Saves live per address, so the iPhone app carries them over from its backup. */
const OLD_HOST = "shoebox.tangomike.app";
/**
 * First open at inmyshoebox.com in the iPhone app: nothing is here yet, so bring in the newest
 * daily backup (items, files, settings, the inbox key and AI sign-up). Once per install.
 */
async function restoreAfterMove() {
  if (!nativeCan("restore") || location.hostname === OLD_HOST) return "";
  try { if (localStorage.getItem("edition.moveChecked")) return ""; } catch { return ""; }
  let note = "";
  try {
    if (!(await db.items.all()).length) {
      const r = await nativeAsk("restore", {}, 90000);
      if (r.ok && r.data) {
        const n = await db.importJson(r.data);
        note = `Shoebox moved to inmyshoebox.com and brought your ${n.items === 1 ? "save" : `${n.items} saves`} along.`;
        track("moved");
      }
    }
  } catch (e) { noteError(e, { quiet: true, where: "restore after move" }); }
  try { localStorage.setItem("edition.moveChecked", "1"); } catch { /* full */ }
  return note;
}

async function boot() {
  const movedNote = await restoreAfterMove();
  sealMeSettings();
  const migrated = await db.migrateFromLocalStorage(migrateLegacy).catch(() => 0);
  ai.migrateAiSettings();
  state.items = await db.items.all();
  state.edition = await db.meta.get("edition", null);
  state.suggest = await db.meta.get("suggest", null) || emptySuggestProfile();
  state.tagAliases = await db.meta.get("tagAliases", null) || {};
  state.wonDay = await db.meta.get("wonDay", null);
  await loadAvatar();
  await migratePictures();
  {
    const kid = childNames(schoolSettings())[0] || "";
    if (kid) for (const i of state.items.filter((x) => x.school && !x.school.named && /\b(your child|your student|\{child\})/i.test(`${x.title} ${x.school.body || ""}`))) {
      const fix = (t) => ai.nameIn(String(t || "").replace(/\byour (child|student)\b/gi, ai.CHILD_TOKEN), kid);
      await saveItem({ ...i, title: fix(i.title), text: fix(i.text), hook: fix(i.hook), school: { ...i.school, body: fix(i.school.body), named: true } });
    }
  }
  // Links shared with their title used to land as notes; make them links so they get a picture.
  for (const i of state.items.filter((x) => x.kind === KIND.NOTE && x.source === "share" && /^https?:\/\/\S+\n[^\n]{1,200}$/.test(x.text || ""))) {
    const d = detectText(i.text)[0];
    if (d && d.kind !== KIND.NOTE && d.url) { const { text, hook, summary, enrichedAt, ...rest } = i; await saveItem({ ...rest, ...d, enrichTries: 0, pictureTries: 0 }); }
  }
  for (const i of state.items.filter((x) => x.email && /&#\d+;|&#x[0-9a-f]+;|&amp;|&nbsp;/i.test(`${x.text || ""} ${x.title || ""}`))) {
    await saveItem({ ...i, text: plainEntities(i.text), title: plainEntities(i.title) });
  }
  // No sample items any more: a new phone gets the welcome steps instead. Anyone with saves is past them.
  const seeded = 0;
  if (state.items.some((i) => !i.sample) || migrated) { setFlag(ONBOARDED, true); setFlag(FIRST_SAVE, true); }
  if (state.items.some((i) => i.source === "share")) setFlag(SHARED, true);
  const sharedIn = await importShares();
  if (sharedIn) setFlag(SHARED, true);
  await importFromUrl();
  await wakeDue();
  await ensureEdition();
  bindScreen();
  render();
  if (movedNote) toast(movedNote);
  else if (migrated) toast(`Brought over ${migrated} saved item${migrated === 1 ? "" : "s"} from the old version.`);
  else if (seeded) toast(`Loaded ${seeded} sample items. Remove them in Settings.`);
  hideSplash();
  if (state.openId) { jumpTo(state.openId); state.openId = null; }
  if (sharedIn) celebrateSave(state.items.slice(0, sharedIn));
  if (!navigator.onLine && flag(ONBOARDED) && coach.take("offline")) toast("You're offline. Everything you've saved still works.");
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
  checkInbox().then(keepAddress);
  dailyStories();
  dailyBackup();
  maybeAskSong();
  setInterval(() => { if (document.visibilityState === "visible") refreshCalendar(); }, 15 * 60e3);
  setInterval(() => { if (document.visibilityState === "visible") checkInbox(); }, 5 * 60e3);
}

/* Colors: Grape soda (the default) or Plain, a quiet paper-and-ink look. Applied before the first paint by index.html. */
const PALETTE_KEY = "edition.palette";
function paletteChoice() { try { return localStorage.getItem(PALETTE_KEY) === "plain" ? "plain" : "grape"; } catch { return "grape"; } }
function setPalette(p) {
  try { if (p === "plain") localStorage.setItem(PALETTE_KEY, "plain"); else localStorage.removeItem(PALETTE_KEY); } catch { /* storage blocked */ }
  if (p === "plain") document.documentElement.setAttribute("data-palette", "plain"); else document.documentElement.removeAttribute("data-palette");
  track(`palette_${p}`);
  applyTheme();
}

/*
 * Delete all my data: the relay's copy first (it needs this phone's keys),
 * then reminders, then everything on the phone. The page starts over empty.
 */
function confirmErase() {
  const wrap = sheet(`
    <div class="sheet-head"><h2>Delete all your data?</h2><button class="x" type="button" data-close aria-label="Close">${I.close}</button></div>
    <p class="note">Every save, photo, note and setting on this ${NATIVE ? "iPhone" : "device"} goes, along with your Shoebox email address and any mail waiting for it. This can't be undone.</p>
    ${NATIVE ? `<p class="note">Daily backups already in Files or iCloud Drive stay. Delete them in the Files app if you want them gone too.</p>` : ""}
    <span class="st" id="erase-st" role="status"></span>
    <div class="sheet-foot two"><button class="btn" type="button" id="erase-backup">Back up first</button><button class="btn erase" type="button" id="erase-go">Delete everything</button></div>`, { label: "Delete all your data" });
  $("#erase-backup", wrap).addEventListener("click", () => openSettings("backup"));
  $("#erase-go", wrap).addEventListener("click", async (e) => {
    e.target.disabled = true;
    $("#erase-st", wrap).textContent = "Deleting…";
    track("erase");
    const base = ai.relayBase();
    const got = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
    if (base) {
      await withTimeout(fetch(`${base}/me/delete`, { method: "POST", headers: { "x-inbox-key": got("edition.inboxKey"), "x-shoebox-device": got("edition.aiDevice"), "x-shoebox-token": got("edition.aiToken") } }), 15000).catch(() => {});
    }
    for (const i of state.items) {
      if (!i.reminder) continue;
      if (i.reminder.native) toNative({ type: "cancel", id: i.reminder.id }); else await push.cancel(i.reminder).catch(() => {});
    }
    await push.turnOff().catch(() => {});
    await db.eraseAll();
    try { localStorage.clear(); sessionStorage.clear(); } catch { /* blocked */ }
    try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* no caches */ }
    location.replace(location.href.split("#")[0]);
  });
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
  const plain = paletteChoice() === "plain";
  const bar = plain ? (dark ? "#161514" : "#FAF9F6") : (dark ? "#1B1033" : "#FBF8FF");
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.removeAttribute("media"); m.setAttribute("content", bar); });
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
  if (list.some((i) => i.source === "share")) setFlag(SHARED, true);
  tick(true);
  state.tab = "today";
  render({ top: true });
  celebrateSave(list);
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

/** Today's stories from the shared per-topic searches, up to three, for the topics followed (four at most). */
async function sharedPicks(known) {
  const topics = followOrder(state.suggest).slice(0, 4);
  if (!topics.length) return [];
  const place = placeOf(morningSettings())?.name || "";
  const lists = await Promise.all(topics.map(async (t) => {
    if (t === "local" && !place) return { topic: t, picks: [] };
    const picks = await ai.topicStories(t, { place: t === "local" ? place : "" }).catch((e) => { noteError(e, { quiet: true, where: `stories: ${t}` }); return []; });
    return { topic: t === "local" ? `local:${place}` : t, picks };
  }));
  return mixStories(lists, 3, known);
}

async function findNew(statusEl) {
  const set = (msg, err) => { if (statusEl) { statusEl.textContent = msg; statusEl.classList.toggle("err", !!err); } };
  if (!ai.settings.canDiscover()) { set("Turn on AI in Settings first.", true); return 0; }
  set("Finding today's top stories…");
  try {
    const known = new Set(state.items.map((i) => i.url).filter(Boolean));
    const profile = withFollows(interestProfile(discoveryItems(state.items)), state.suggest, { place: placeOf(morningSettings())?.name || "" });
    // Topics followed in Build my morning share one search a day with everyone; otherwise a search of their own.
    let picks = await sharedPicks(known).catch((e) => { noteError(e, { quiet: true, where: "shared stories" }); return []; });
    if (!picks.length) picks = await ai.discover(profile, { known, guide: suggestionGuide(state.suggest), vocab: vocab(), blocked: state.suggest?.blocked || [] });
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
  // School posts: the newest newsletter's posts first (in its own order), then the rest by their date.
  // A post settled this session keeps its place, so the list doesn't jump under your finger.
  const unsorted = (i) => i.status === STATUS.INBOX || state.recent.get(i.id)?.stage === "inbox";
  const newest = Math.max(0, ...state.items.filter((i) => i.school && unsorted(i)).map((i) => i.created));
  const batch = (i) => unsorted(i) && newest - i.created < 10 * 60e3;
  const school = state.items.filter((i) => i.school && (schoolToday([i]).length || (state.recent.has(i.id))))
    .sort((a, b) => (batch(b) - batch(a)) || (batch(a) ? b.created - a.created : 0)
      || (a.school.date || "9999").localeCompare(b.school.date || "9999") || a.created - b.created);
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
  return [...s.school, ...s.fresh, ...s.six].filter(isOpen).length;
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
  if (state.reveal) $("#panel", tl)?.classList.add("reveal");
  requestAnimationFrame(() => { placeSpot(); coachPass(tl); tintSongCard(); refreshDayLine(); watchFoldCards(); });
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
  // Replies hang under the post as their own block: swap them too.
  const oldReplies = el.nextElementSibling?.matches?.(`.replies[data-for="${CSS.escape(id)}"]`) ? el.nextElementSibling : null;
  const newReplies = next.nextElementSibling;
  el.replaceWith(next);
  if (oldReplies) oldReplies.remove();
  if (newReplies) { next.after(newReplies); hydrate(newReplies); }
  hydrate(next);
  tintVisible(next.parentElement || next);
}

function sectionHead(title, note = "") {
  return `<h2 class="sep"><span>${esc(title)}</span>${note ? `<span class="sep-note">${esc(note)}</span>` : ""}</h2>`;
}

function todayHtml() {
  const s = todaySections();
  let h = stripHtml(s) + songAskHtml() + whatsNewHtml() + welcomeHtml() + aiAskHtml() + calendarHtml() + morningHtml() + dayTipHtml() + schoolAskHtml();
  if (s.school.length) h += sectionHead("From school", `${s.school.filter(isOpen).length || "All"} to do`) + s.school.map((i) => postHtml(i)).join("");
  if (s.fresh.length) h += sectionHead("New", `${s.fresh.filter(isOpen).length || "All"} to sort`) + s.fresh.map((i) => postHtml(i)).join("");
  if (s.six.length) h += sectionHead("Today's six", `${s.six.filter(isOpen).length} of ${s.six.length} left`) + s.six.map((i) => postHtml(i)).join("");
  if (s.sugg.length) h += sectionHead("Top stories") + s.sugg.map((i) => postHtml(i)).join("");
  else if (state.storiesMiss && !state.storiesLoading && state.tab === "today") h += sectionHead("Top stories") + `<p class="finding miss" role="status">No stories came through just now. Shoebox looks again tomorrow morning.${ai.settings.canDiscover() ? ` <button class="linkish" type="button" data-act="discover">Try again</button>` : ""}</p>`;
  else if (state.storiesLoading) h += sectionHead("Top stories") + `<p class="finding" role="status"><span class="spin" aria-hidden="true"></span>Finding today's top stories${followedTopics(state.suggest).length ? ` on ${esc(followedTopics(state.suggest).slice(0, 3).join(", "))}` : ""}…</p>`;
  return h + endHtml(s);
}

/* ================= This morning =================
 * The daily set at the top of Today: weather and radar (or your camera),
 * last night's games, a Jung quote, On this day, and CPMAI practice. Each
 * can be turned off in Settings › Mornings. Read fresh each day; never saved.
 */
const MORNING_KEY = "edition.morning", MORNING_CACHE = "edition.morningCache";

/** Shoebox Me, Graham's private build, opens with ?me=1: personal modules stay available there. */
const personal = () => { try { return Boolean(window.shoeboxNative) && localStorage.getItem("edition.me") === "1"; } catch { return false; } };
/** Shoebox Me: write today's school and morning settings to the phone once, so they never depend on defaults in the code. */
function sealMeSettings() {
  if (!personal()) return;
  try {
    if (localStorage.getItem("edition.meSealed")) return;
    localStorage.setItem(SCHOOL_KEY, JSON.stringify(schoolSettings()));
    localStorage.setItem(MORNING_KEY, JSON.stringify(morningSettings()));
    localStorage.setItem("edition.meSealed", "1");
  } catch { /* storage full or blocked */ }
}
/** Shoebox Me sends its AI sign-up so the relay gives it a firstname-keep address. */
const staffHeaders = () => (personal() ? ai.ownerHeaders() : {});
/** Shoebox Me: move an address made before -keep (graham-uppx) to graham-keep, once. The old one still delivers. */
async function keepAddress() {
  let a = "", shared = "";
  try { a = localStorage.getItem("edition.inboxAddress") || ""; shared = localStorage.getItem("edition.inboxShared") || ""; } catch { return; }
  const h = staffHeaders();
  if (!personal() || !h["x-shoebox-device"] || !a || a === shared || /-keep@/.test(a)) return;
  try {
    const res = await withTimeout(fetch(`${ai.relayBase()}/inbox/address`, { method: "POST", headers: { "x-inbox-key": inboxKey(), "content-type": "application/json", ...h }, body: JSON.stringify({ name: a.split("-")[0], keep: true }) }), 15000);
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.address) localStorage.setItem("edition.inboxAddress", d.address);
  } catch { /* next launch */ }
}
/** Modules that only Shoebox Me shows: unofficial scores, a quote set, a one-library song. */
const PERSONAL_MODULES = ["hockey", "song"];
const MORNING_PUBLIC = { weather: true, zip: "", place: null, cam: "", otd: true, study: false, studyTopic: "", hockey: false, teams: [], jung: false, song: false, quote: false, quoteFrom: "" };
// Shoebox Me's own choices live on its phone (written there once by sealMeSettings); only the modules are switched on here.
const MORNING_ME = { ...MORNING_PUBLIC, hockey: true, song: true, quote: true, quoteFrom: "Carl Jung" };
function morningSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(MORNING_KEY) || "{}") || {}; } catch { /* storage blocked */ }
  // Earlier versions had a CPMAI switch; it's now a study deck on that topic.
  if (saved.cpmai !== undefined && saved.study === undefined) { saved.study = saved.cpmai; saved.studyTopic = saved.studyTopic || "PMI-CPMAI"; }
  // The Jung card became Quote of the day; whoever had it on keeps Jung.
  if (saved.jung !== undefined && saved.quote === undefined) { saved.quote = saved.jung; saved.quoteFrom = saved.quoteFrom || "Carl Jung"; }
  const m = { ...(personal() ? MORNING_ME : MORNING_PUBLIC), ...saved };
  // Song of the day is for everyone in the iPhone app (from the phone's own library); otherwise only in Shoebox Me.
  if (!personal()) for (const k of PERSONAL_MODULES) if (!(k === "song" && nativeCan("music"))) m[k] = false;
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

/** Weather pictures for the small weather card. */
const wxSvg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const CLOUD = '<path d="M7 18.5h10a3.5 3.5 0 0 0 .4-7A5 5 0 0 0 7.8 10 4.3 4.3 0 0 0 7 18.5z"/>';
const WX_ICONS = {
  sun: wxSvg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/>'),
  moon: wxSvg('<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>'),
  partly: wxSvg('<path d="M8.5 3v1.6M3.3 8.2h1.6M4.8 4.6l1.1 1.1M13 4.6l-1.1 1.1"/><path d="M6.2 10.5a3.3 3.3 0 0 1 5.9-2.4"/><path d="M8.5 19.5h9a3 3 0 0 0 .3-6 4.4 4.4 0 0 0-8.4-.9 3.5 3.5 0 0 0-.9 6.9z"/>'),
  cloud: wxSvg(CLOUD),
  rain: wxSvg('<path d="M7 15.5h10a3.5 3.5 0 0 0 .4-7A5 5 0 0 0 7.8 7 4.3 4.3 0 0 0 7 15.5z"/><path d="M8.5 18.5l-1 2.5M12.5 18.5l-1 2.5M16.5 18.5l-1 2.5"/>'),
  storm: wxSvg('<path d="M7 15.5h10a3.5 3.5 0 0 0 .4-7A5 5 0 0 0 7.8 7 4.3 4.3 0 0 0 7 15.5z"/><path d="M12.5 14.5l-2 3.5h3l-2 3.5"/>'),
  snow: wxSvg('<path d="M7 15.5h10a3.5 3.5 0 0 0 .4-7A5 5 0 0 0 7.8 7 4.3 4.3 0 0 0 7 15.5z"/><path d="M8.5 19h.01M12 20.5h.01M15.5 19h.01"/>'),
  fog: wxSvg('<path d="M4 10h16M6 14h12M4 18h16M8 6h8"/>'),
  wind: wxSvg('<path d="M3 9h11a2.5 2.5 0 1 0-2.5-2.5M3 13h15a2.5 2.5 0 1 1-2.5 2.5M3 17h8"/>'),
};
const WX_MIN = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';

/** The ••• on a card: opens that card's settings right there. */
const cardMore = (panel, label) => `<button class="act icon more" type="button" data-panel="${panel}" aria-label="${esc(label)} settings">${I.menu}</button>`;

/** Where the weather is for: the built-in place for a known ZIP, or one looked up in Settings. */
const placeOf = (m) => daily.PLACES[m.zip] || m.place || null;
const studyLabel = (m) => String(m.studyTopic || "Study").slice(0, 40);
function setMorningSettings(v) { try { localStorage.setItem(MORNING_KEY, JSON.stringify(v)); } catch { /* private mode */ } }
function morningCache() {
  try { const c = JSON.parse(localStorage.getItem(MORNING_CACHE) || "null"); return c && c.day === dayKey() ? c : { day: dayKey() }; } catch { return { day: dayKey() }; }
}
const SONG_LOG = "edition.songLog";
function songLog() { try { return JSON.parse(localStorage.getItem(SONG_LOG) || "[]") || []; } catch { return []; } }
function saveSongLog(l) { try { localStorage.setItem(SONG_LOG, JSON.stringify(l)); } catch { /* full */ } }

/** Back in the app 10 minutes or more after playing the song of the day: ask how it landed. */
async function maybeAskSong() {
  if (!nativeCan("music") || state.songAsk) return;
  const e = songs.pendingAsk(songLog());
  if (!e) return;
  const r = await nativeAsk("music", { op: "check", song: e.id }, 15000).catch(() => null);
  if (!r || !r.ok) { saveSongLog(songs.markAsked(songLog(), e.id)); return; }
  const heard = songs.heardIt(e, r);
  saveSongLog(songs.markAsked(songLog(), e.id, { heard }));
  state.songAsk = { ...e, heard };
  track(heard ? "song_heard" : "song_unheard");
  if (state.tab === "today" && !$(".sheet-wrap") && !state.reader) render({ top: false });
}

function songAskHtml() {
  const e = state.songAsk;
  if (!e) return "";
  const gap = e.prevLast ? friendlyWhen(e.prevLast).replace(/^in /, "") : "";
  const name = `<b>${esc(e.title)}</b>${e.artist ? ` by ${esc(e.artist)}` : ""}`;
  const head = e.heard ? "Welcome back. How was it?" : "Not the right moment?";
  const body = e.heard
    ? `You listened to ${name} all the way through${e.prevLast ? `, for the first time since ${esc(gap)}` : ""}.`
    : `${name} didn't play all the way through. That's fine; some songs need a different day.`;
  const acts = e.heard
    ? `<button class="btn primary" type="button" data-song-ans="loved">Loved it</button><button class="btn" type="button" data-song-ans="fine">It was fine</button><button class="btn ghost" type="button" data-song-ans="never">Not for me</button>`
    : `<button class="btn primary" type="button" data-song-ans="again">Try it again</button><button class="btn" type="button" data-song-ans="later">Skip it for now</button><button class="btn ghost" type="button" data-song-ans="never">Not for me</button>`;
  return `<section class="ask song-ask" aria-labelledby="song-ask-h">
      <div class="ask-top"><span class="av av-day" aria-hidden="true">${I.music}</span><div><h2 id="song-ask-h">${head}</h2><p>${body}</p></div></div>
      <div class="ask-acts">${acts}</div></section>`;
}

async function songAnswer(v) {
  const e = state.songAsk;
  if (!e) return;
  state.songAsk = null;
  track(`song_${v}`);
  if (v === "again") {
    saveSongLog(songs.logPlay(songLog(), { id: e.id, title: e.title, artist: e.artist, plays: e.prevPlays, lastPlayed: e.prevLast }));
    render({ top: false });
    const sg = morningCache().song;
    if (sg?.url && sg.id === e.id) window.open(sg.url, "_blank", "noopener"); else toast("Find it in Music and give it the whole song.");
    return;
  }
  saveSongLog(songs.answer(songLog(), e.id, v === "again" ? "fine" : v));
  render({ top: false });
  if (v === "loved") {
    const r = await nativeAsk("music", { op: "keep", song: e.id }, 20000).catch(() => ({ ok: false }));
    const n = songs.songStats(songLog()).loved;
    toast(r.ok ? `Added to your Rediscovered playlist in Music. ${n === 1 ? "Your first one." : `${n} songs there now.`}` : "Loved. (Couldn't add it to a playlist in Music.)");
  } else if (v === "never") toast("Got it. That one won't come back.");
  else if (v === "later") toast("Skipped for a few months.");
  else toast("Noted.");
}

/** Today's song from the phone, looked up in Apple Music once: the link to open it there, a preview, artwork. */
async function findInAppleMusic() {
  const relay = ai.relayBase(), c = morningCache(), sg = c.song;
  if (!relay || !sg?.native || sg.looked) return;
  try {
    const r = await withTimeout(fetch(`${relay}/apple/find?title=${encodeURIComponent(sg.title)}&artist=${encodeURIComponent(sg.artist || "")}`), 15000);
    const d = r.ok ? await r.json() : {};
    const m = d.match || {};
    const now = morningCache();
    if (now.song?.id !== sg.id) return;
    now.song = { ...now.song, looked: true, url: m.url || "", preview: m.preview || "", artwork: m.artwork || "" };
    saveMorningCache(now);
    if (state.tab === "today" && !$(".sheet-wrap") && !state.reader) render({ top: false });
  } catch (e) { noteError(e, { quiet: true, where: "song: Apple Music lookup" }); }
}

/** A song from the iPhone's library, as the morning card keeps it. */
function nativeSong(r) {
  return { native: true, id: String(r.id || ""), title: r.title || "Untitled", artist: r.artist || "", album: r.album || "", year: r.year || "",
    plays: r.plays || 0, lastPlayed: r.lastPlayed || 0, art: r.art ? `data:image/jpeg;base64,${r.art}` : "" };
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
    if (m.song && nativeCan("music") && !c.song && !c.songTried) {
      c.songTried = true; changed = true;
      try { const r = await nativeAsk("music", { op: "pick", seed: daily.dayOfYear(), skip: songs.skipIds(songLog()) }, 20000); if (r.ok) c.song = nativeSong(r); else c.songStatus = r.status; }
      catch (e) { noteError(e, { quiet: true, where: "song of the day (iPhone)" }); }
    } else if (m.song && !nativeCan("music") && relay && c.relayInfo?.apple && (!c.songAt || Date.now() - c.songAt > 30 * 60e3)) {
      try {
        const r = await withTimeout(fetch(`${relay}/apple/song`, { headers: { "x-inbox-key": inboxKey(), ...ai.ownerHeaders() } }), 15000);
        const d = await r.json().catch(() => ({}));
        if (r.ok) {
          c.song = d.song && d.song.at && Date.now() - d.song.at < 30 * 3600e3 ? { ...d.song, match: d.match } : null;
          c.songAt = Date.now();
          try { localStorage.setItem("edition.songKey", d.songKey || ""); localStorage.setItem("edition.songLast", String(d.song?.at || "")); localStorage.removeItem("edition.songErr"); } catch { /* full */ }
          changed = true;
        } else { try { localStorage.setItem("edition.songErr", d?.error?.message || `The relay said ${r.status}.`); } catch { /* full */ } }
      } catch (e) { noteError(e, { quiet: true, where: "song of the day" }); }
    }
    if (m.hockey && ai.relayBase() && (!c.gamesAt || (!c.games?.length && Date.now() - c.gamesAt > 2 * 3600e3))) {
      try {
        const res = await withTimeout(fetch(`${ai.relayBase()}/nhl?date=${yesterdayKey()}`), 15000);
        if (res.ok) { c.games = daily.gamesFor(await res.json(), m.teams); c.gamesAt = Date.now(); changed = true; }
      } catch (e) { noteError(e, { quiet: true, where: "hockey" }); }
    }
    if (c.quotes && c.quotes.from !== m.quoteFrom) { delete c.quotes; delete c.quotesTried; changed = true; }
    if (m.quote && m.quoteFrom && !isJung(m.quoteFrom) && ai.settings.enabled() && !c.quotes && !c.quotesTried) {
      c.quotesTried = true;
      try {
        const list = await withTimeout(ai.dailyQuotes(m.quoteFrom), 90000);
        if (list.length) c.quotes = { from: m.quoteFrom, list, i: 0 };
      } catch (e) { noteError(e, { quiet: true, where: "quotes" }); }
      changed = true;
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
    else state.staleToday = true; // drawn when the sheet or reader closes
  }
}

function morningHtml() {
  const m = morningSettings(), c = morningCache();
  const cards = [];
  const place = placeOf(m);
  // A card you can finish for the day: a button folds it to one line (or hides it, by your choice) until tomorrow.
  const folds = [], foldMode = m.doneMode === "hide" ? "hide" : "fold";
  const card = (cls, rail, meta, body, f) => {
    if (f && c.folded?.[f.key]) { if (foldMode === "fold") folds.push(f); return ""; }
    const done = f ? `<div class="acts fold-acts"><span class="grow"></span><button class="act done" type="button" data-day="fold:${esc(f.key)}">${I.done}<span>${esc(f.btn)}</span></button></div>` : "";
    return `<article class="post daily ${cls}"${f ? ` data-fold="${esc(f.key)}"` : ""}><div class="rail">${rail}</div><div class="main"><div class="meta">${meta}</div>${body}${done}</div></article>`;
  };
  const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "");
  if (m.weather && !place && flag(ONBOARDED)) {
    cards.push(`<div class="wx-mini"><span class="wx-ic-s" aria-hidden="true">${I.sun}</span><span>Weather: add your ZIP code and it shows here each morning.</span>
      <button class="btn sm ghost" type="button" data-day="wx-setup">Add</button></div>`);
  } else if (m.weather && c.weather && (m.wxSmall || c.wxHidden)) {
    // Small: the picture and the temperature. Tap for the whole card.
    const w = c.weather;
    cards.push(`<button class="wx-small" type="button" data-day="wx-big" aria-label="Weather: ${w.now} degrees, ${esc(w.word)}. Show the full weather.">
        <span class="wx-ico wx-${daily.weatherKind(w)}" aria-hidden="true">${WX_ICONS[daily.weatherKind(w)]}</span><span class="deg">${w.now}°</span><span class="wx-open" aria-hidden="true">${WX_MIN}</span></button>`);
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
      `<span class="who">Weather,</span> <span class="when">${esc(place.name)}${m.zip ? ` ${esc(m.zip)}` : ""}</span><button class="act icon more wx-min" type="button" data-day="wx-small" aria-label="Make the weather small">${WX_MIN}</button>${cardMore("weather", "Weather")}`,
      `<p class="wx-now"><span class="deg">${w.now}°</span><span class="wx-word">${esc(w.word)}<small>Feels like ${w.feels}°</small></span></p>
       <p class="wx-line">High ${w.hi}° · Low ${w.lo}°${w.rain != null ? ` · Rain ${w.rain}%` : ""} · Wind ${esc(w.windFrom)} ${w.wind} mph${w.gusts > w.wind + 5 ? `, gusts ${w.gusts}` : ""}</p>
       ${w.nextHour ? `<p class="wx-line wx-next">${esc(w.nextHour)}</p>` : ""}
       <p class="wx-line">Sunrise ${hm(w.sunrise)} · Sunset ${hm(w.sunset)}</p>
       ${w.tides?.length ? `<p class="wx-line">Tides: ${w.tides.map((t) => `${t.type} ${hm(t.t.replace(" ", "T"))}`).join(" · ")}</p>` : ""}
       ${fig}
       ${w.source === "apple" ? `<p class="wx-attr"><a href="https://weatherkit.apple.com/legal-attribution.html" target="_blank" rel="noopener"> Weather</a></p>` : ""}`));
  }
  if (m.song && c.song?.native) {
    const sg = c.song;
    if (!sg.looked && !findInAppleMusic.busy) { findInAppleMusic.busy = true; setTimeout(() => findInAppleMusic().finally(() => { findInAppleMusic.busy = false; }), 0); }
    const st = songs.songStats(songLog());
    cards.push(card("song", `<span class="av av-day" aria-hidden="true">${I.music}</span>`, `<span class="who">Song of the day</span>${cardMore("cards", "Daily cards")}`,
      songCard({ art: sg.art || sg.artwork, title: sg.title, artist: sg.artist, year: sg.year, when: sg.lastPlayed, preview: sg.preview, url: sg.url, openId: sg.id, next: true, tint: sg.tint,
        tally: [st.month ? `${st.month} song${st.month === 1 ? "" : "s"} brought back this month` : "", st.loved ? `${st.loved} in your Rediscovered playlist` : ""].filter(Boolean).join(" · ") }), { key: "song", label: sg.title, btn: "Listened" }));
  } else if (m.song && nativeCan("music") && c.songStatus === "empty") {
    cards.push(card("song", `<span class="av av-day" aria-hidden="true">${I.music}</span>`, `<span class="who">Song of the day</span>${cardMore("cards", "Daily cards")}`,
      `<p class="wx-line">Song of the day picks from songs you've played in the Music app. Play a few there and one shows up here tomorrow.</p>`));
  } else if (m.song && c.song) {
    const sg = c.song, mt = sg.match || {};
    const t = sg.lastPlayed ? Date.parse(sg.lastPlayed) : NaN;
    cards.push(card("song", `<span class="av av-day" aria-hidden="true">${I.music}</span>`, `<span class="who">Song of the day</span>${cardMore("cards", "Daily cards")}`,
      songCard({ art: mt.artwork, title: mt.name || sg.title, artist: mt.artist || sg.artist, year: mt.year, when: Number.isFinite(t) ? t : 0, preview: mt.preview, url: mt.url, tint: sg.tint }), { key: "song", label: mt.name || sg.title, btn: "Listened" }));
  }
  if (m.hockey) for (const g of c.games || []) {
    if (!g.done) continue;
    const res = g.won ? "W" : "L";
    cards.push(card(`nhl t-${esc(g.team)}`, `<span class="av av-day team" aria-hidden="true">${esc(g.team)}</span>`,
      `<span class="who">${esc(g.name)},</span> <span class="when">last night</span><span class="tag ${g.won ? "won" : ""}">${res}${g.end ? ` · ${esc(g.end)}` : ""}</span>${cardMore("cards", "Daily cards")}`,
      `<p class="score">${esc(g.name)} ${g.us}, ${esc(g.opp)} ${g.them}</p>
       <p class="wx-line">${g.home ? "At home" : "Away"}${g.scorers.length ? ` · Goals: ${esc(g.scorers.join(", "))}` : ""}</p>
       ${g.recap || g.center ? `<a class="btn sm hl" href="${esc(g.recap || g.center)}" target="_blank" rel="noopener">${I.play}<span>${g.recap ? "Watch highlights" : "Game recap"}</span></a>` : ""}`,
      { key: `nhl-${g.team}`, label: `${g.name} ${g.us}–${g.them}`, btn: "Seen it" }));
  }
  if (m.quote && isJung(m.quoteFrom)) {
    // Carl Jung: the hand-picked set, on the phone, no AI needed.
    const j = daily.jungFor(Date.now(), jungRetired());
    if (j && c.jungDone !== j.index) {
      const kept = state.items.some((i) => i.jung === j.index);
      cards.push(card("quote", `<span class="av av-day" aria-hidden="true">${I.quote}</span>`, `<span class="who">Quote of the day</span>${cardMore("cards", "Daily cards")}`,
        `<blockquote class="jung-q">${esc(j.q)}</blockquote><p class="wx-line">Carl Jung, ${esc(j.src)}</p>
         <div class="acts"><span class="grow"></span>
           <button class="act" type="button" data-day="jung-no:${j.index}">${I.letGo}<span>Not for me</span></button>
           <button class="act done" type="button" data-day="jung-keep:${j.index}" ${kept ? "disabled" : ""}>${I.keep}<span>${kept ? "Kept" : "Keep"}</span></button></div>`));
    } else if (j && c.jungDone === j.index) {
      cards.push(`<div class="wx-mini"><span class="wx-ic-s" aria-hidden="true">${I.quote}</span><span>${state.items.some((i) => i.jung === j.index) ? "Today's quote is in your saves." : "Quote cleared for today."}</span></div>`);
    }
  } else if (m.quote && m.quoteFrom) {
    const qs = c.quotes?.list || [], gone = quoteRetired();
    let i = c.quotes?.i || 0;
    while (i < qs.length && gone.includes(quoteId(qs[i]))) i++;
    const qt = qs[i];
    if (qt && !c.quotes.done) {
      const kept = state.items.some((x) => x.quoteId === quoteId(qt));
      cards.push(card("quote", `<span class="av av-day" aria-hidden="true">${I.quote}</span>`, `<span class="who">Quote of the day</span>${cardMore("cards", "Daily cards")}`,
        `<blockquote class="jung-q">${esc(qt.q)}</blockquote>
         <p class="wx-line">${esc(qt.who)}, ${esc(qt.src)} <a class="q-src" href="${esc(qt.url)}" target="_blank" rel="noopener">Source</a></p>
         <div class="acts"><span class="grow"></span>
           <button class="act" type="button" data-day="quote-no:${i}">${I.letGo}<span>Not for me</span></button>
           <button class="act done" type="button" data-day="quote-keep:${i}" ${kept ? "disabled" : ""}>${I.keep}<span>${kept ? "Kept" : "Keep"}</span></button></div>`));
    } else if (qt && c.quotes.done) {
      cards.push(`<div class="wx-mini"><span class="wx-ic-s" aria-hidden="true">${I.quote}</span><span>${state.items.some((x) => x.quoteId === quoteId(qt)) ? "Today's quote is in your saves." : "Quote cleared for today."}</span></div>`);
    } else if (!ai.settings.enabled()) {
      cards.push(`<div class="wx-mini"><span class="wx-ic-s" aria-hidden="true">${I.quote}</span><span>Quotes from ${esc(m.quoteFrom)} start when AI is on.</span><button class="btn sm" type="button" data-panel="ai">Turn on</button></div>`);
    } else if (c.quotesTried && !qs.length) {
      cards.push(`<div class="wx-mini"><span class="wx-ic-s" aria-hidden="true">${I.quote}</span><span>No checked quotes from ${esc(m.quoteFrom)} today. Shoebox looks again tomorrow.</span></div>`);
    }
  }

  if (m.otd) {
    const o = daily.onThisDay(state.items);
    if (o) {
      const pic = pictureOf(o.item);
      const img = pic ? (pic.blobId ? `<img alt="" data-blob="${esc(pic.blobId)}">` : `<img alt="" src="${esc(pic.src)}" referrerpolicy="no-referrer" onerror="this.remove()">`) : "";
      cards.push(card("otd", avatarHtml(), `<span class="who">On this day,</span> <span class="when">${esc(o.label.toLowerCase())}</span>${cardMore("cards", "Daily cards")}`,
        `<button class="otd-card" type="button" data-open="${esc(o.item.id)}">${img ? `<span class="otd-pic">${img}</span>` : ""}
          <span class="otd-t"><span class="ttl">${esc(o.item.why || o.item.title || "Something you saved")}</span>${o.item.why && o.item.title ? `<span class="site">${esc(o.item.title)}</span>` : ""}</span></button>`,
        { key: "otd", label: "On this day", btn: "Seen it" }));
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
      `<span class="who">${esc(studyLabel(m))} practice,</span> <span class="when">${doneN === qs.length ? `${right} of ${qs.length} right` : `${qs.length} questions`}</span>${cardMore("study", "Study deck")}`,
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
  const shown = cards.filter(Boolean);
  if (folds.length) shown.push(`<div class="fold-row" role="group" aria-label="Done for today">${folds.map((f) => `<button class="chip fold-chip" type="button" data-day="unfold:${esc(f.key)}" aria-label="${esc(f.label)}, done for today. Show it again.">${I.done}<span>${esc(f.label)}</span></button>`).join("")}</div>`);
  return shown.length ? sectionHead(h < 5 || h >= 17 ? "This evening" : h < 12 ? "This morning" : "This afternoon") + shown.join("") : "";
}

/* The morning cards' own buttons: shrink the weather, finish CPMAI, keep or retire a Jung quote. */
/** Finish a morning card for today; it folds to a line (or hides) until tomorrow. */
function foldCard(c, key) {
  c.folded = { ...(c.folded || {}), [key]: Date.now() };
  track(`fold_${String(key).replace(/^nhl-.*/, "nhl").replace(/[^a-z]/g, "")}`);
}
/*
 * Folding by itself: the song once you come back from Apple Music or the preview plays out;
 * scores and On this day once you've had them on screen and leave the app. A card you
 * opened again stays open. Settings › Daily cards turns this off.
 */
const autoFoldOn = () => morningSettings().doneAuto !== false;
function autoFold(key) {
  if (!autoFoldOn()) return;
  const c = morningCache();
  if (c.folded?.[key] || c.unfolded?.[key] || !document.querySelector(`[data-fold="${CSS.escape(key)}"]`)) return false;
  foldCard(c, key);
  saveMorningCache(c);
  return true;
}
let foldSeen = null;
function watchFoldCards() {
  if (!("IntersectionObserver" in window)) return;
  foldSeen?.disconnect();
  const timers = new Map();
  foldSeen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const key = e.target.dataset.fold;
      if (e.isIntersecting && e.intersectionRatio >= 0.6) timers.set(key, setTimeout(() => { state.foldSeen = { ...(state.foldSeen || {}), [key]: true }; }, 2000));
      else { clearTimeout(timers.get(key)); timers.delete(key); }
    }
  }, { threshold: [0, 0.6] });
  document.querySelectorAll('#panel [data-fold]:not([data-fold="song"])').forEach((el) => foldSeen.observe(el));
}
const isJung = (from) => /^\s*(carl\s+(gustav\s+)?)?jung\s*$/i.test(String(from || ""));
/** A quote's id: its first words, so "Not for me" and Keep follow it across days. */
const quoteId = (q) => String(q?.q || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
const quoteRetired = () => { try { return JSON.parse(localStorage.getItem("edition.quoteRetired") || "[]"); } catch { return []; } };
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
  if (act === "wx-setup") { openSettings("weather", { fromCard: true }); return; }
  if (act === "wx-small" || act === "wx-hide") { setMorningSettings({ ...morningSettings(), wxSmall: true }); delete c.wxHidden; }
  else if (act === "wx-big" || act === "wx-show") { setMorningSettings({ ...morningSettings(), wxSmall: false }); delete c.wxHidden; }
  else if (act === "cq-done" && c.cpmai) {
    c.cpmai.done = true; c.cpmai.right = +arg || 0;
    try { const all = JSON.parse(localStorage.getItem("edition.cpmaiScores") || "{}"); all[dayKey()] = [c.cpmai.right, c.cpmai.questions.length]; localStorage.setItem("edition.cpmaiScores", JSON.stringify(all)); } catch { /* full */ }
    tick(true);
  } else if (act === "cq-show" && c.cpmai) c.cpmai.done = false;
  else if (act === "fold") { foldCard(c, arg); live("Done for today."); }
  else if (act === "unfold") { if (c.folded) delete c.folded[arg]; c.unfolded = { ...(c.unfolded || {}), [arg]: true }; }
  else if (act === "jung-keep") {
    const j = daily.JUNG[+arg];
    if (j && !state.items.some((i) => i.jung === +arg)) {
      const item = createItem({ kind: KIND.QUOTE, text: j.q, author: "Carl Jung", title: j.q.slice(0, 140) }, { id: db.newId(), source: "jung" });
      Object.assign(item, { jung: +arg, note: j.src, status: STATUS.QUEUED, queuedAt: Date.now(), tags: ["jung", "psychology"], enrichedAt: Date.now() });
      await saveItem(item);
      toast("Kept. It's in your saves and can come back as one of your six.");
    }
    c.jungDone = +arg; tick(true);
  } else if (act === "quote-keep" && c.quotes) {
    const qt = c.quotes.list[+arg];
    if (qt && !state.items.some((x) => x.quoteId === quoteId(qt))) {
      const item = createItem({ kind: KIND.QUOTE, text: qt.q, author: qt.who, title: qt.q.slice(0, 140) }, { id: db.newId(), source: "quote" });
      Object.assign(item, { quoteId: quoteId(qt), note: qt.src, url: qt.url, status: STATUS.QUEUED, queuedAt: Date.now(), tags: ["quotes"], enrichedAt: Date.now() });
      await saveItem(item);
      toast("Kept. It's in your saves and can come back as one of your six.");
    }
    c.quotes.i = +arg; c.quotes.done = true; tick(true);
  } else if (act === "quote-no" && c.quotes) {
    const qt = c.quotes.list[+arg];
    try { const r = quoteRetired(); if (qt && !r.includes(quoteId(qt))) r.push(quoteId(qt)); localStorage.setItem("edition.quoteRetired", JSON.stringify(r.slice(-300))); } catch { /* full */ }
    // The next of today's quotes, if there is one; otherwise done for today.
    c.quotes.i = +arg + 1;
    if (c.quotes.i >= c.quotes.list.length) c.quotes.done = true;
    live("That one won't come back.");
  } else if (act === "jung-no") {
    try { const r = jungRetired(); if (!r.includes(+arg)) r.push(+arg); localStorage.setItem("edition.jungRetired", JSON.stringify(r)); } catch { /* full */ }
    c.jungDone = +arg;
    live("That one won't come back.");
  }
  saveMorningCache(c);
  render({ top: false });
}

/**
 * The song card: the album cover large, with the preview's play button on it (a ring fills as it plays),
 * when you last played it, one way to open it in Apple Music, and a shuffle button for another one.
 * The card takes its colour from the cover.
 */
function songCard({ art = "", title = "", artist = "", year = "", when = 0, preview = "", url = "", openId = "", next = false, tint = "", tally = "" }) {
  const ago = when ? new Date(when).toLocaleDateString("en-US", Date.now() - when < 45 * 864e5 ? { month: "long", day: "numeric" } : { month: "long", year: "numeric" }) : "";
  return `<div class="disc"${tint ? ` style="--tint:${esc(tint)}"` : ""}>
    <div class="disc-top">
      <div class="disc-art">${art ? `<img alt="" src="${esc(art)}" referrerpolicy="no-referrer" onerror="this.remove()" data-tint-from="1">` : `<span class="disc-blank">${I.music}</span>`}
        ${preview ? `<button class="disc-play" type="button" data-preview="${esc(preview)}" aria-label="Play a preview of ${esc(title)}"><svg class="ring" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="21"/><circle class="fill" cx="24" cy="24" r="21"/></svg>${I.play}${I.pause}</button>` : ""}</div>
      <div class="disc-t">
        ${ago ? `<p class="disc-when">Last played ${esc(ago)}</p>` : ""}
        <p class="ttl">${esc(title)}</p>
        <p class="by">${esc(artist || "")}${year ? ` · ${esc(year)}` : ""}</p>
      </div>
    </div>
    <div class="disc-acts">
      ${url ? `<a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener"${openId ? ` data-song-open="${esc(openId)}"` : ""}>${I.music}<span>Play in Apple Music</span></a>` : ""}
      ${next ? `<button class="btn disc-next" type="button" data-song-next="1" aria-label="Another song" title="Another song">${I.shuffle}</button>` : ""}
    </div>
    ${tally ? `<p class="song-tally">${esc(tally)}</p>` : ""}
  </div>`;
}

/** The cover's colour, kept with today's song so the card is tinted from the first paint. */
function tintSongCard() {
  const img = $("#panel .disc-art img[data-tint-from]");
  const c = morningCache();
  if (!img || !c.song || c.song.tint) return;
  const probe = new Image();
  probe.crossOrigin = "anonymous";
  probe.onload = () => {
    try {
      const cv = document.createElement("canvas"); cv.width = cv.height = 16;
      const g = cv.getContext("2d"); g.drawImage(probe, 0, 0, 16, 16);
      const d = g.getImageData(0, 0, 16, 16).data;
      const tint = songs.coverTint(d);
      const now = morningCache(); if (!now.song) return;
      now.song.tint = tint; saveMorningCache(now);
      img.closest(".disc")?.style.setProperty("--tint", tint);
    } catch { /* the cover's server doesn't allow reading it: the card keeps its plain colour */ }
  };
  probe.src = img.src;
}

/** Play or stop a song's 30-second preview; the ring around the button fills as it plays. */
let previewAudio = null;
function playPreview(btn) {
  const src = btn.dataset.preview;
  const show = (on) => { btn.classList.toggle("playing", on); btn.setAttribute("aria-label", on ? "Stop the preview" : "Play a preview"); if (!on) btn.style.setProperty("--p", 0); };
  if (previewAudio && !previewAudio.paused && previewAudio.src === src) { previewAudio.pause(); show(false); return; }
  if (previewAudio) { previewAudio.pause(); document.querySelectorAll(".disc-play.playing").forEach((x) => { x.classList.remove("playing"); x.style.setProperty("--p", 0); }); }
  previewAudio = new Audio(src);
  previewAudio.addEventListener("timeupdate", () => { const a = previewAudio; if (a.duration) btn.style.setProperty("--p", (a.currentTime / a.duration).toFixed(3)); });
  previewAudio.addEventListener("ended", () => { show(false); if (btn.closest('[data-fold="song"]')) { autoFold("song"); render({ top: false }); } });
  previewAudio.play().then(() => show(true)).catch(() => show(false));
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

/** The PDFs and pictures that came with a mail, fetched from the relay (base64), plus PDFs it links to (up to 3). */
async function mailFiles(base, m) {
  const out = [];
  for (const link of (m.links || []).filter((l) => /\.pdf($|[?#])/i.test(l)).slice(0, 3)) {
    try {
      const res = await withTimeout(fetch(`${base}/file?url=${encodeURIComponent(link)}`), 30000);
      if (!res.ok) continue;
      const f = await res.json();
      if (f.data) out.push({ name: f.name, type: f.type, data: f.data, link });
    } catch (e) { noteError(e, { quiet: true, where: "inbox: linked PDF" }); }
  }
  for (const a of (m.attachments || []).slice(0, 6)) {
    try {
      const res = await withTimeout(fetch(`${base}/inbox/file?id=${encodeURIComponent(m.id)}&n=${a.n}`, { headers: { "x-inbox-key": inboxKey() } }), 30000);
      if (!res.ok) continue;
      const { data } = await res.json();
      if (data) out.push({ name: a.name, type: a.type, data });
    } catch (e) { noteError(e, { quiet: true, where: "inbox: attachment" }); }
  }
  return out;
}

/** Top stories once a day, by themselves, when AI is on. */
async function dailyStories() {
  if (!storiesAuto() || !ai.settings.canDiscover()) return;
  try { if (localStorage.getItem("edition.storiesDay") === dayKey()) return; localStorage.setItem("edition.storiesDay", dayKey()); } catch { return; }
  const n = await findNew(null).catch(() => 0);
  if (n && state.tab === "today" && !$(".sheet-wrap")) render({ top: false });
}

/**
 * A backup each day, kept by the iPhone app in Files › On My iPhone ›
 * Shoebox › Backups (the last 7). It rides along in the phone's own iCloud
 * Backup, and Import backup reads it on a new phone.
 */
async function dailyBackup() {
  if (!nativeCan("backup")) return;
  // On the old address, every open makes a fresh backup: it's what the app restores from at inmyshoebox.com.
  const moving = location.hostname === OLD_HOST;
  try { if (!moving && localStorage.getItem("edition.backupDay") === dayKey()) return; } catch { return; }
  try {
    const r = await nativeAsk("backup", { name: `shoebox-backup-${dayKey()}.json`, data: await db.exportJson() }, 60000);
    if (r.ok) { localStorage.setItem("edition.backupDay", dayKey()); localStorage.setItem("edition.backupAt", String(Date.now())); localStorage.setItem("edition.backupICloud", r.icloud ? "1" : "0"); }
    else noteError(new Error(r.error || "Backup failed"), { quiet: true, where: "daily backup" });
  } catch (e) { noteError(e, { quiet: true, where: "daily backup" }); }
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
    try {
      const before = localStorage.getItem("edition.inboxAddress");
      if (data.address) localStorage.setItem("edition.inboxAddress", data.address); else localStorage.removeItem("edition.inboxAddress");
      if (data.shared) localStorage.setItem("edition.inboxShared", data.shared); else localStorage.removeItem("edition.inboxShared");
      if (data.pick) localStorage.setItem("edition.inboxPick", data.pick); else localStorage.removeItem("edition.inboxPick");
    } catch { /* full */ }
    const done = [];
    for (const m of data.mails || []) {
      const c = schoolSettings();
      const school = isSchoolMail(m, c);
      const files = await mailFiles(base, m);
      // A PDF you send yourself (a district calendar, a flyer) may be school too, even from your own address:
      // when school posts are on, let the AI read it for your child first; if nothing in it is for them, it's saved as a file.
      const maybeSchool = !school && c.on && files.some((f) => f.type === "application/pdf") && Boolean(c.about || c.child);
      let schoolMade = 0;
      if ((school || maybeSchool) && ai.settings.enabled()) {
        const before = state.items.length;
        // A short email that only points at the newsletter's web page: read the page.
        const body = String(m.text || "").trim(), link = (m.links || [])[0];
        const raw = !files.length && body.length < 400 && link ? link : `${m.subject}\n\n${m.text}`;
        await pullNewsletter(raw, null, { files });
        schoolMade = state.items.length - before;
        made += schoolMade;
      }
      if (school && ai.settings.enabled()) { /* done above */ } else if (schoolMade) { /* the PDF was school after all */ } else {
        // Anything attached becomes its own saved file, read like any PDF or photo you save.
        for (const f of files) {
          try {
            const bytes = Uint8Array.from(atob(f.data), (ch) => ch.charCodeAt(0));
            const it = await captureFile(new File([bytes], f.name, { type: f.type }), "email");
            it.email = { from: m.from, fromName: m.fromName || m.from, at: m.at };
            await saveItem(it);
            made++;
          } catch (e) { noteError(e, { quiet: true, where: "inbox: attachment" }); }
        }
        const link = (m.links || [])[0];
        const body = plainEntities(String(m.text || "").trim());
        m.subject = plainEntities(m.subject || "");
        // The same message twice (forwarded to two addresses while moving): keep one.
        const twin = state.items.find((i) => i.email && i.title === (m.subject || "") && i.email.from === m.from && Math.abs((i.email.at || 0) - (m.at || 0)) < 2 * 864e5);
        if (twin) { done.push(m.id); continue; }
        const item = createItem({ kind: KIND.NOTE, text: body.slice(0, 8000), title: m.subject || body.slice(0, 80) || "Email" }, { id: db.newId(), source: "email" });
        track("save_email");
        Object.assign(item, { title: m.subject || item.title, email: { from: m.from, fromName: m.fromName || m.from, at: m.at }, url: link || undefined });
        await saveItem(item);
        made++;
      }
      done.push(m.id);
    }
    if (done.length) await fetch(`${base}/inbox/ack`, { method: "POST", headers: { "x-inbox-key": inboxKey(), "content-type": "application/json" }, body: JSON.stringify({ ids: done }) }).catch(() => {});
    try { localStorage.setItem("edition.inboxChecked", String(Date.now())); } catch { /* full */ }
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
const SCHOOL_ME = SCHOOL_PUBLIC;
/** What a school post asks of you. */
const SCHOOL_TYPES = { action: "Action", decision: "Decision", info: "Info" };

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

/** Support mail: the subject carries the app, version and platform, so mail can be sorted. */
export const SUPPORT_EMAIL = "support@inmyshoebox.com";
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
 * A new phone starts empty. One button builds their morning for real
 * (topics, weather, calendar, AI); then a card teaches saving from other
 * apps by doing it, and coach marks teach the rest when it first applies.
 */
const ONBOARDED = "edition.onboarded";
const flag = (k) => { try { return localStorage.getItem(k) === "1"; } catch { return true; } };
const setFlag = (k, on) => { try { localStorage.setItem(k, on ? "1" : "0"); } catch { /* storage blocked */ } };

/* Flags for the welcome: a first save, a first share from another app, Shoebox pinned in the share row. */
const FIRST_SAVE = "edition.firstSave", SHARED = "edition.shared", PINNED = "edition.sharePinned", SHARE_OFF = "edition.shareGuideOff";
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const SHARE_ICON = `<svg class="sg-ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11v9h12v-9"/></svg>`;

/** Today's top card for someone new: one button. After that, the "save from anywhere" guide. */
function welcomeHtml() {
  if (!flag(ONBOARDED)) {
    return `<section class="ask welcome hero" aria-labelledby="wel-h">
      <div class="ask-top"><span class="av av-sb" aria-hidden="true">${LOGO}</span>
        <div><h2 id="wel-h">Welcome to Shoebox</h2>
        <p>Your own feed: the things you saved come back a few at a time, with your day and weather on top. It ends when you're done.</p></div></div>
      <div class="ask-acts"><button class="btn primary" type="button" data-welcome="start">Get started</button></div>
      <button class="btn ghost sm wel-skip" type="button" data-welcome="skip">Skip</button>
    </section>`;
  }
  return shareGuideHtml();
}

function shareGuideHtml() {
  const step = shareStep({ native: NATIVE, standalone: isStandalone(), shared: flag(SHARED), pinned: flag(PINNED),
    dismissed: flag(SHARE_OFF), saves: state.items.length });
  if (!step) return "";
  const card = (h, p, body, acts, skip = true) => `<section class="ask guide" aria-labelledby="sg-h">
      <div class="ask-top"><span class="av av-sb" aria-hidden="true">${LOGO}</span><div><h2 id="sg-h">${h}</h2><p>${p}</p></div></div>
      ${body}<div class="ask-acts">${acts}</div>
      ${skip ? `<button class="btn ghost sm wel-skip" type="button" data-welcome="share-off">Not now</button>` : ""}
    </section>`;
  if (step === "share") return card("Save something from Safari", "This is how anything gets into Shoebox. Try it once now.",
    `<ol class="sg-steps"><li>In Safari, tap <b>Share</b> ${SHARE_ICON}</li>
      <li>In the row of apps, tap <b>Shoebox</b>. Not there? Swipe the row to the end and tap <b>More</b>.</li>
      <li>Come back here. It'll be waiting.</li></ol>`,
    `<a class="btn primary" href="https://en.wikipedia.org/wiki/Special:Random" target="_blank" rel="noopener" data-welcome="safari">Try it on a random article</a>
     <button class="btn" type="button" data-welcome="add">Paste a link</button>`);
  if (step === "pin") return card("Put Shoebox first in the share row", "One minute now saves a swipe every time.",
    `<ol class="sg-steps"><li>Next time you tap <b>Share</b> ${SHARE_ICON}, swipe the row of apps to the end and tap <b>More</b>.</li>
      <li>Tap <b>Edit</b>, then the green <b>+</b> next to Shoebox.</li><li>Tap <b>Done</b>. Shoebox stays at the front.</li></ol>`,
    `<button class="btn primary" type="button" data-welcome="pinned">Done</button>`, false);
  if (step === "home") return card("Keep Shoebox on your Home Screen", "It opens like an app and works offline.",
    `<ol class="sg-steps"><li>In Safari, tap <b>Share</b> ${SHARE_ICON}</li><li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol>`,
    `<button class="btn primary" type="button" data-welcome="share-off">I added it</button>
     <button class="btn" type="button" data-welcome="add">Save a link</button>`, false);
  return card("Save your first thing", "Copy a link and tap +, or paste it anywhere on this screen.", "",
    `<button class="btn primary" type="button" data-welcome="add">${I.plus || ""}<span>Save something</span></button>`);
}

/** The day onboarding ended: the first-week tips count from it. A replay starts the week over. */
function markStart() { coach.see(`new-${WHATS_NEW}`); try { localStorage.setItem(START_DAY, dayKey()); localStorage.removeItem(TIP_LOG); } catch { /* blocked */ } }

async function welcomeAction(what) {
  track(`welcome_${what.replace(/-/g, "_")}`);
  if (what === "start") { openBuild(); return; }
  if (what === "add") { openAdd(); return; }
  if (what === "safari") return; // the link opens Safari by itself
  if (what === "skip") { setFlag(ONBOARDED, true); coach.see("build"); markStart(); }
  else if (what === "share-off") setFlag(SHARE_OFF, true);
  else if (what === "pinned") { setFlag(PINNED, true); toast("Done. Shoebox is first in line."); }
  render({ top: false });
}

/*
 * Build my morning: five short steps in one sheet (getting things in, your day, school, optional topics, AI),
 * then Today assembles in front of them with their own weather, calendar
 * and top stories.
 */
function openBuild(step = 1) {
  state.build = state.build || { topics: new Set(followedTopics(state.suggest)), study: "" };
  const b = state.build, m = morningSettings();
  // Your own things first: how they get in. Then your day, school, optional topics, and AI.
  const mailOk = (() => { try { return Boolean(localStorage.getItem("edition.inboxPick")); } catch { return false; } })();
  const head = (h) => `<div class="sheet-head"><h2>${h}</h2><button class="x" type="button" data-close aria-label="Close">${I.close}</button></div>
    <p class="bm-n">Step ${step} of 5</p>`;
  let html;
  if (step === 1) {
    let addr = "", pick = "";
    try { addr = localStorage.getItem("edition.inboxAddress") || ""; pick = localStorage.getItem("edition.inboxPick") || ""; } catch { /* blocked */ }
    const mine = /-[a-z2-9]{4}@|-keep@/.test(addr);
    const share = NATIVE ? `<b>From any app:</b> tap Share, then Shoebox. Not in the row? Swipe to the end and tap More.`
      : `<b>Anything you copy:</b> open Shoebox and tap +, or paste anywhere on Today.`;
    html = `${head("Get your things in")}
      <p class="note">Shoebox is your own feed: only what you choose goes in. Save it the moment you see it, and it comes back a few at a time.</p>
      <ul class="mail-uses bm-ways"><li>${share}</li>
        ${mailOk ? `<li><b>By email:</b> forward anything, sign up for newsletters, or add your address in your school's parent app.</li>` : ""}</ul>
      ${!mailOk ? "" : mine ? `<div class="mail-addr"><b id="bm-addr">${esc(addr)}</b><button class="btn sm" type="button" data-bm="copy">Copy</button></div>`
      : `<label class="bm-l" for="bm-mail">Your Shoebox email address <span>The first part is yours; four random letters keep it private.</span></label>
        <div class="mail-pick"><input id="bm-mail" type="text" autocomplete="given-name" autocapitalize="none" placeholder="Your first name" maxlength="16"><span>-····@${esc(pick)}</span></div>`}
      <span class="st" id="bm-st" role="status"></span>
      <div class="sheet-foot two">${!mailOk || mine ? `<button class="btn primary" type="button" data-bm="2" style="grid-column: 1 / -1">Next</button>` : `<button class="btn" type="button" data-bm="2">Not now</button><button class="btn primary" type="button" data-bm="mail">Make my address</button>`}</div>`;
  } else if (step === 2) {
    const place = placeOf(m);
    html = `${head("Your day")}
      <p class="note">Your weather and today's calendar sit at the top of Today, so there's a reason to look each morning.</p>
      <div class="bm-row"><div><b>Weather</b><span id="bm-wx">${place ? `For ${esc(place.name)}` : "Where are you?"}</span></div>
        ${canLocate() ? `<button class="btn${place ? "" : " primary"}" type="button" data-bm="loc">${place ? "Update" : "Use my location"}</button>` : ""}</div>
      <div class="bm-zip"><label class="sr-only" for="bm-zip">ZIP code or city</label><input id="bm-zip" type="text" autocomplete="postal-code" placeholder="Or a ZIP code" inputmode="numeric">
        <button class="btn" type="button" data-bm="zip">Set</button></div>
      ${nativeCan("calendar") ? `<div class="bm-row"><div><b>Calendar</b><span id="bm-cal">${calNative() ? "On" : "Your day at a glance, with free time"}</span></div>
        ${calNative() ? "" : `<button class="btn primary" type="button" data-bm="cal">Show my calendar</button>`}</div>` : ""}
      ${nativeCan("music") ? `<div class="bm-row"><div><b>Song of the day</b><span id="bm-song">${m.song ? "On" : "One from your music you haven't played in a while"}</span></div>
        ${m.song ? "" : `<button class="btn" type="button" data-bm="song">Turn on</button>`}</div>` : ""}
      <span class="st" id="bm-st" role="status"></span>
      <div class="sheet-foot"><button class="btn primary wide" type="button" data-bm="3">Next</button></div>`;
  } else if (step === 3) {
    const sc = schoolSettings();
    html = `${head("Kids in school?")}
      <p class="note">Forward school email and newsletters to Shoebox, and it turns them into short posts about your child: what to do, what to decide, what to know, with the dates. Your child's name stays on this phone.</p>
      <label class="bm-l" for="bm-kid">Child's first name <span>Optional. Add more later in Settings.</span></label>
      <input id="bm-kid" type="text" autocomplete="off" autocapitalize="words" placeholder="First name" value="${esc(sc.child || "")}">
      <label class="bm-l" for="bm-kid-about" style="margin-top:12px">Grade and school <span>Helps Shoebox keep only what's for them</span></label>
      <input id="bm-kid-about" type="text" autocomplete="off" placeholder="7th grade at Lincoln Middle; band, soccer" value="">
      <span class="st" id="bm-st" role="status"></span>
      <div class="sheet-foot two"><button class="btn" type="button" data-bm="4">No kids in school</button><button class="btn primary" type="button" data-bm="kid">Next</button></div>`;
  } else if (step === 4) {
    html = `${head("Anything else to follow?")}
      <p class="note">Optional. Pick a few topics and Shoebox adds the day's biggest stories on them, marked as picked for you. Your own saves always come first.</p>
      <div class="bm-chips" role="group" aria-label="Topics">${TOPICS.map((t) => `<button type="button" class="bm-chip" data-bm-topic="${t}" aria-pressed="${b.topics.has(t)}">${t}</button>`).join("")}</div>
      <label class="bm-l" for="bm-study">Studying for something? <span>Optional. Three practice questions a day.</span></label>
      <input id="bm-study" type="text" autocomplete="off" placeholder="AWS Solutions Architect, Spanish verbs" value="${esc(b.study || (m.study ? m.studyTopic : ""))}">
      <div class="sheet-foot two"><button class="btn" type="button" data-bm="5">Skip</button><button class="btn primary" type="button" data-bm="topics">Next</button></div>`;
  } else if (!ai.available()) {
    html = `${head("You're set")}
      <p class="note">${esc(ai.WEB_AI_NOTE)} Top stories, summaries and found pictures turn on there.</p>
      <div class="sheet-foot"><button class="btn primary" type="button" data-bm="ai-0">Show me Today</button></div>`;
  } else {
    html = `${head("Turn on AI?")}
      <p class="note">With AI on, Shoebox writes a line about each thing you save, finds pictures, turns school email into posts, and picks stories on your topics. With it off, everything else still works.</p>
      <p class="note">To do that, the text of what you save goes to an outside AI service through Shoebox's server. It isn't used to train AI.</p>
      <details class="bm-more"><summary>Exactly what's sent</summary><p>${esc(AI_DISCLOSURE)}</p></details>
      <div class="sheet-foot two"><button class="btn" type="button" data-bm="ai-0">Not now</button><button class="btn primary" type="button" data-bm="ai-1">Turn on AI</button></div>`;
  }
  const wrap = sheet(html, { label: "Get started" });
  wrap.addEventListener("click", (e) => buildClick(e, step, wrap));
}

async function buildClick(e, step, wrap) {
  const b = state.build;
  const t = e.target.closest("[data-bm-topic]");
  if (t) {
    const k = t.dataset.bmTopic;
    if (b.topics.has(k)) b.topics.delete(k); else b.topics.add(k);
    t.setAttribute("aria-pressed", String(b.topics.has(k)));
    tick();
    return;
  }
  const btn = e.target.closest("[data-bm]");
  if (!btn) return;
  const what = btn.dataset.bm;
  const st = $("#bm-st", wrap);
  const say = (msg, err) => { if (st) { st.textContent = msg; st.classList.toggle("err", !!err); } };
  if (what === "topics") {
    b.study = $("#bm-study", wrap)?.value.trim() || "";
    state.suggest = followTopics(state.suggest, [...b.topics]);
    await db.meta.set("suggest", state.suggest);
    if (b.study) setMorningSettings({ ...morningSettings(), study: true, studyTopic: b.study.slice(0, 80) });
    if (b.topics.size) track("onboard_topics");
    openBuild(5);
  } else if (what === "2") openBuild(2);
  else if (what === "3") openBuild(3);
  else if (what === "4") openBuild(4);
  else if (what === "5") openBuild(5);
  else if (what === "copy") {
    try { await navigator.clipboard.writeText($("#bm-addr", wrap).textContent); affirm(st, "Address copied."); } catch { say("Couldn't copy; press and hold the address to copy it.", true); }
  } else if (what === "mail") {
    const name = $("#bm-mail", wrap).value.trim();
    if (!name) { say("Type a first part, like your first name.", true); $("#bm-mail", wrap).focus(); return; }
    btn.disabled = true; say("Making your address…");
    try {
      const res = await withTimeout(fetch(`${ai.relayBase()}/inbox/address`, { method: "POST", headers: { "x-inbox-key": inboxKey(), "content-type": "application/json", ...staffHeaders() }, body: JSON.stringify({ name }) }), 15000);
      const d = await res.json();
      if (!res.ok || !d.address) throw new Error(d?.error?.message || "No address came back.");
      localStorage.setItem("edition.inboxAddress", d.address);
      track("onboard_email");
      openBuild(1);
    } catch (err) { btn.disabled = false; say(err.message || "Couldn't reach Shoebox's server. You can do this later in Settings › Email.", true); }
  } else if (what === "kid") {
    const name = $("#bm-kid", wrap).value.trim().slice(0, 40), about = $("#bm-kid-about", wrap).value.trim().slice(0, 200);
    if (name || about) {
      const school = (about.match(/\bat ([^;,.]+)/i) || [])[1]?.trim() || "";
      const cur = schoolSettings();
      setSchoolSettings({ ...cur, on: true, child: name || cur.child, about: about ? `${name || "My child"}: ${about}` : cur.about, school: school || cur.school,
        words: [...new Set([...(cur.words || []), ...(school ? [school] : [])])] });
      track("onboard_school");
    }
    openBuild(4);
  } else if (what === "song") {
    btn.disabled = true; say("Asking for your music…");
    const r = await nativeAsk("music", { op: "pick", ask: true, seed: daily.dayOfYear() }, 60000).catch(() => ({ ok: false }));
    if (r.ok) {
      setMorningSettings({ ...morningSettings(), song: true });
      const c = morningCache(); c.song = nativeSong(r); c.songTried = true; saveMorningCache(c);
      $("#bm-song", wrap).textContent = `On. Today: ${r.title}`; btn.remove(); say("");
    } else { btn.disabled = false; say(r.status === "denied" ? "Music access is off. Turn it on in the iPhone's Settings › Shoebox." : "No songs with plays in your Music library yet.", true); }
  } else if (what === "loc") {
    btn.disabled = true; say("Finding where you are…");
    try { const p = await useMyLocation(); $("#bm-wx", wrap).textContent = `For ${p.name}`; btn.textContent = "Update"; btn.classList.remove("primary"); say(""); }
    catch (err) { say(err.message, true); }
    btn.disabled = false;
  } else if (what === "zip") {
    const q = $("#bm-zip", wrap).value.trim();
    if (!q) { say("Type a ZIP code or a city.", true); return; }
    btn.disabled = true; say("Finding that place…");
    try {
      const place = await withTimeout(daily.lookupPlace(q), 15000);
      if (!place) say("Couldn't find that place. Try a 5-digit ZIP code.", true);
      else {
        setMorningSettings({ ...morningSettings(), zip: place.zip || "", place, weather: true, useLocation: false });
        const c = morningCache(); delete c.weather; saveMorningCache(c);
        loadMorning();
        $("#bm-wx", wrap).textContent = `For ${place.name}`; say("");
      }
    } catch (err) { noteError(err, { quiet: true, where: "place lookup" }); say("Couldn't look that up right now.", true); }
    btn.disabled = false;
  } else if (what === "cal") {
    btn.disabled = true; say("Asking for your calendars…");
    const r = await turnOnNativeCalendar();
    if (!r.ok) { btn.disabled = false; say(r.msg, true); return; }
    $("#bm-cal", wrap).textContent = r.msg; btn.remove(); say("");
  } else if (what === "ai-1" || what === "ai-0") finishBuild(what === "ai-1");
}

/** The reveal: close the sheet and let Today fill in, card by card. Top stories follow when AI is on. */
async function finishBuild(aiOn) {
  setAi(aiOn);
  setFlag(ONBOARDED, true);
  coach.see("build");
  markStart();
  track("onboard_done");
  state.build = null;
  closeSheet();
  state.reveal = true;
  state.tab = "today";
  const stories = aiOn && storiesAuto();
  if (stories) { state.storiesLoading = true; try { localStorage.setItem("edition.storiesDay", dayKey()); } catch { /* full */ } }
  render({ top: true });
  setTimeout(() => { state.reveal = false; const tl = $("#tl"); if (tl) coachPass(tl); }, 2600);
  if (!stories) return;
  const n = await findNew(null).catch(() => 0);
  state.storiesLoading = false;
  state.storiesMiss = !n;
  if (!$(".sheet-wrap")) render({ top: false });
  if (n) { buzz(8); toNative({ type: "haptic" }); }
}

/*
 * The first save ever drops into a little shoebox, once. Every share after
 * that gets the quiet confirmation: a toast and a light tap.
 */
function celebrateSave(list) {
  // Where saves come from (share sheet, +, paste, email): anonymous counts only.
  for (const i of list) if (i) track(`save_${String(i.source || "add").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "add"}`);
  const shared = list.some((i) => i && i.source === "share");
  if (shared) { buzz(8); toNative({ type: "haptic" }); }
  if (flag(FIRST_SAVE)) return;
  setFlag(FIRST_SAVE, true);
  track("first_save");
  toNative({ type: "haptic" });
  live("Your first save is in the box.");
  if (reduced()) return;
  const el = document.createElement("div");
  el.className = "celebrate";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `<div class="cb-stage"><span class="cb-item"></span><span class="cb-lid"></span><span class="cb-box"></span>
    ${[[-34, -26], [34, -26], [-20, -46], [20, -46], [0, -54]].map(([x, y]) => `<span class="cb-dot" style="--x:${x}px;--y:${y}px"></span>`).join("")}</div>
    <p class="cb-msg">Your first save is in the box.</p>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/*
 * Spotlight: when Shoebox teaches something, everything else on screen dims
 * and blurs, and the thing itself stays sharp and tappable. Four panels
 * frame a hole around it; a tap on the dimmed part (or Got it) ends it.
 * When guidance ends, the next thing to try (usually +) pulses, silently.
 */
let spot = null;
function spotlight({ sel, text = "", key = "", next = ".fab" } = {}) {
  endSpot(false);
  const el = document.createElement("div");
  el.className = "spot";
  el.innerHTML = `<div class="spot-dim" aria-hidden="true"></div><div class="spot-p" data-p="t"></div><div class="spot-p" data-p="b"></div><div class="spot-p" data-p="l"></div><div class="spot-p" data-p="r"></div>
    <div class="spot-ring" aria-hidden="true"></div>
    ${text ? `<div class="spot-tip" role="dialog" aria-label="Tip"><p>${esc(text)}</p><button class="btn sm" type="button" data-spot-ok>Got it</button></div>` : ""}`;
  // A tap outside the hole closes the tip and still does what it was aimed at (Settings, a tab, a button).
  el.querySelectorAll(".spot-p").forEach((p) => p.addEventListener("click", (e) => {
    endSpot();
    el.querySelectorAll(".spot-p, .spot-tip").forEach((x) => { x.style.pointerEvents = "none"; });
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest("button, a[href], summary, [role=button]");
    if (under && !el.contains(under)) under.click();
  }));
  $("[data-spot-ok]", el)?.addEventListener("click", () => endSpot());
  document.body.appendChild(el);
  spot = { el, sel, key, next };
  placeSpot();
  requestAnimationFrame(() => { el.classList.add("on"); $("[data-spot-ok]", el)?.focus({ preventScroll: true }); });
}
/** Keep the hole on its target through scrolls and re-renders; no target, no spotlight. */
function placeSpot() {
  if (!spot) return;
  const t = $(spot.sel);
  if (!t || $(".sheet-wrap")) { endSpot(false); return; }
  const r = t.getBoundingClientRect(), pad = 8, W = innerWidth, H = innerHeight;
  const x0 = Math.max(0, r.left - pad), y0 = Math.max(0, r.top - pad), x1 = Math.min(W, r.right + pad), y1 = Math.min(H, r.bottom + pad);
  const set = (p, s) => Object.assign($(`[data-p="${p}"]`, spot.el).style, s);
  set("t", { left: "0px", top: "0px", width: `${W}px`, height: `${y0}px` });
  set("b", { left: "0px", top: `${y1}px`, width: `${W}px`, height: `${Math.max(0, H - y1)}px` });
  set("l", { left: "0px", top: `${y0}px`, width: `${x0}px`, height: `${Math.max(0, y1 - y0)}px` });
  set("r", { left: `${x1}px`, top: `${y0}px`, width: `${Math.max(0, W - x1)}px`, height: `${Math.max(0, y1 - y0)}px` });
  Object.assign($(".spot-ring", spot.el).style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
  // The dimmed, blurred layer has a hole with rounded corners, matching the ring (the four tap panels are invisible).
  const hole = `M0 0H${W}V${H}H0Z M${x0 + 18} ${y0}H${x1 - 18}A18 18 0 0 1 ${x1} ${y0 + 18}V${y1 - 18}A18 18 0 0 1 ${x1 - 18} ${y1}H${x0 + 18}A18 18 0 0 1 ${x0} ${y1 - 18}V${y0 + 18}A18 18 0 0 1 ${x0 + 18} ${y0}Z`;
  const mask = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}'><path fill-rule='evenodd' d='${hole}'/></svg>`)}")`;
  const dim = $(".spot-dim", spot.el).style;
  dim.webkitMaskImage = dim.maskImage = mask;
  const tip = $(".spot-tip", spot.el);
  if (tip) {
    const below = H - y1 > tip.offsetHeight + 24 || y0 < tip.offsetHeight + 24;
    tip.style.top = below ? `${Math.min(H - tip.offsetHeight - 12, y1 + 12)}px` : `${Math.max(12, y0 - tip.offsetHeight - 12)}px`;
  }
}
function endSpot(pulse = true) {
  if (!spot) return;
  const { el, next } = spot;
  spot = null;
  el.classList.remove("on");
  setTimeout(() => el.remove(), 200);
  if (pulse && next) pulseNext(next);
}
/** One last, silent nudge toward what to try next. */
function pulseNext(sel) {
  const t = $(sel);
  if (!t) return;
  t.classList.remove("pulse-next");
  void t.offsetWidth;
  t.classList.remove("away"); t.classList.add("pulse-next");
  setTimeout(() => t.classList.remove("pulse-next"), 4200);
}
addEventListener("resize", () => placeSpot());
document.addEventListener("scroll", () => placeSpot(), { capture: true, passive: true });
// The + button steps aside while you scroll down through posts, and comes back when you scroll up or reach the end.
let fabY = new WeakMap();
document.addEventListener("scroll", (ev) => {
  const el = ev.target === document ? document.scrollingElement : ev.target;
  if (!el || el.closest?.(".sheet-wrap, .reader")) return;
  const fab = $(".fab"); if (!fab) return;
  const y = el.scrollTop, last = fabY.get(el) ?? y; fabY.set(el, y);
  const atEnd = y + el.clientHeight >= el.scrollHeight - 24;
  if (y < 40 || atEnd || y < last - 6) fab.classList.remove("away");
  else if (y > last + 6) fab.classList.add("away");
}, { capture: true, passive: true });

/*
 * Coach marks: one sentence the first time a feature is on screen, one per
 * session. It waits until the thing is fully in view, so the page never
 * jumps to it, then spotlights it.
 */
const coachStore = { getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, setItem: (k, v) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } } };
const coach = makeCoach(coachStore);
const COACH = [
  { key: "dbl", sel: "[data-dbl]", text: "Double-tap a photo to love it." },
  { key: "stories", sel: ".post .av-sb", host: ".post", text: "Top stories come from the topics you follow. Tap Not for me and say why, and tomorrow's picks change." },
  { key: "daybar", sel: ".daybar details.db", text: "This is a view of your schedule today. Tap the bar to see each event, and online meetings get a Join button." },
  { key: "song", sel: ".post.song .disc", host: ".post", text: "A song from your music you haven't played in a while. Open it in Apple Music, and Shoebox asks later how it landed." },
  { key: "more", sel: ".daily .more[data-panel], .daybar .more[data-panel]", text: "Tap ••• on any card to change it right where you see it." },
];
const inView = (el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.top >= 70 && r.bottom <= innerHeight - 90; };
/** The target to spotlight for a coach entry: the element, or the card around it. */
function coachTarget(c) {
  const el = $(`#panel ${c.sel}`);
  if (!el) return null;
  if (c.host) { const h = el.closest(c.host); if (h) { h.id ||= `spot-${c.key}`; return h; } }
  el.id ||= `spot-${c.key}`;
  return el;
}
let coachTimer = 0;
function coachPass(tl) {
  if (!tl._coachBound) { tl._coachBound = true; tl.addEventListener("scroll", () => { clearTimeout(coachTimer); coachTimer = setTimeout(() => coachPass(tl), 400); }, { passive: true }); }
  if (spot || $(".sheet-wrap") || state.tab !== "today" || state.reveal || state.reader) return;
  // The welcome card, the first time: everything else waits.
  if (!flag(ONBOARDED)) { const h = $("#panel .welcome.hero"); if (h && !state.heroSpot) { state.heroSpot = true; h.id = "spot-hero"; spotlight({ sel: "#spot-hero", next: '[data-welcome="start"]' }); } return; }
  // Right after Build my morning: the share guide, once.
  const g = $("#panel .ask.guide");
  if (g && coach.can("guide") && inView(g) && coach.take("guide")) { g.id = "spot-guide"; spotlight({ sel: "#spot-guide" }); return; }
  // Today's Did you know card, once, when it scrolls into view.
  const tip = $("#panel .ask.tip");
  const tipKey = tip && `tip-${tip.querySelector("[data-tip]")?.dataset.tip.split(":")[1]}`;
  if (tip && coach.can(tipKey) && inView(tip) && coach.take(tipKey)) { tip.id = "spot-tip"; spotlight({ sel: "#spot-tip" }); return; }
  const c = COACH.find((x) => coach.can(x.key) && coachTarget(x) && inView(coachTarget(x)));
  if (!c || !coach.take(c.key)) return;
  track(`coach_${c.key}`);
  spotlight({ sel: `#${coachTarget(c).id}`, text: c.text, key: c.key });
}
/** A feature was used: its tip never needs to show, and goes if it's showing. */
function coachUsed(key) {
  coach.see(key);
  if (spot?.key === key) endSpot();
}

/*
 * What's new, once per release that adds something worth trying, for people
 * who were already using Shoebox (new people learn it all in onboarding).
 */
const WHATS_NEW = "4.47";
function whatsNewItems() {
  const m = morningSettings();
  let mail = "", pick = "";
  try { mail = localStorage.getItem("edition.inboxAddress") || ""; pick = localStorage.getItem("edition.inboxPick") || ""; } catch { /* blocked */ }
  return [
    nativeCan("music") && !m.song && { k: "song", t: "Song of the day", d: "One from your music you haven't played in a while, each morning.", go: "Turn it on" },
    pick && !/-[a-z2-9]{4}@/.test(mail) && { k: "email", t: "Your own email address", d: "Sign up for newsletters with it, or forward school email to it.", go: "Set it up" },
    { k: "colors", t: "Plain colors", d: "A quiet paper-and-ink look, if grape isn't your thing.", go: "Try it" },
    { k: "all", t: "Everything Shoebox can do", d: "One page, with Show me on each.", go: "See all" },
  ].filter(Boolean);
}
function whatsNewHtml() {
  if (!flag(ONBOARDED) || coach.seen(`new-${WHATS_NEW}`)) return "";
  const items = whatsNewItems();
  return `<section class="ask whatsnew" aria-labelledby="wn-h">
      <div class="ask-top"><span class="av av-sb" aria-hidden="true">${LOGO}</span><div><p class="tip-k">New in Shoebox</p><h2 id="wn-h">A few things to try</h2></div></div>
      <ul class="wn-list">${items.map((x) => `<li><div><b>${esc(x.t)}</b><span>${esc(x.d)}</span></div><button class="btn sm" type="button" data-wn="${x.k}">${esc(x.go)}</button></li>`).join("")}</ul>
      <button class="btn ghost sm wel-skip" type="button" data-wn="done">Got it</button>
    </section>`;
}
function whatsNewAction(k) {
  track(`whatsnew_${k}`);
  if (k === "done") { coach.see(`new-${WHATS_NEW}`); render({ top: false }); return; }
  if (k === "song") openSettings("cards");
  else if (k === "email") openSettings("email");
  else if (k === "colors") openSettings("you");
  else if (k === "all") openSettings("features");
}

/* ===== The first week: one "Did you know" card a morning ===== */
const START_DAY = "edition.onboardedDay", TIP_LOG = "edition.dayTips";
/* Built when used: NATIVE is set further down the file. */
const dayTips = () => ({
  song: { h: "A song you forgot you loved", p: "Turn on Song of the day and each morning brings one from your music you haven't played in a while.", go: "Turn it on", act: () => openSettings("cards") },
  email: { h: "Your own Shoebox email address", p: "Sign up for newsletters with it and they come straight here. Anything else, forward to it.", go: "Set it up", act: () => openSettings("email") },
  more: { h: "Change a card where you see it", p: "Tap ••• on the weather or calendar card to change just that card, without hunting through Settings.", go: "Try it on weather", act: () => openSettings("weather", { fromCard: true }) },
  newsletters: { h: "School email becomes short posts", p: "Forward school email and newsletters. Shoebox pulls out each thing to do, decide or know, with the dates.", go: "Set it up", act: () => openSettings("newsletters") },
  later: { h: "Pick when things come back", p: "Set something aside until a day you choose. It waits under Coming back, then tops Today that morning, with a reminder if you like.", go: "Pick a reminder time", act: () => openSettings("reminders") },
  find: { h: "Find anything you saved", p: "All saves has Loved, Coming back and Finished, and search looks through everything, even your notes on a save. Untouched saves fade after a few weeks, so the list stays light.", go: "Open All saves", act: () => selectTab("all") },
  backup: NATIVE
    ? { h: "Your saves are backed up every day", p: "A copy goes to Files and your iCloud Drive each day, and Shoebox works without a connection.", go: "See backups", act: () => openSettings("backup") }
    : { h: "Keep a copy of your saves", p: "Everything lives on this device. Save a backup now and then from Settings › Backup.", go: "Back up now", act: () => openSettings("backup") },
});
function tipsUsed() {
  const used = new Set();
  const got = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  if (got("edition.inboxAddress") || state.items.some((i) => i.source === "email")) used.add("email");
  if (coach.seen("more")) used.add("more");
  if (!nativeCan("music") || morningSettings().song) used.add("song");
  if (schoolSettings().on || !ai.settings.enabled()) used.add("newsletters");
  if (got("edition.remindTime") || state.items.some((i) => i.status === STATUS.ASIDE)) used.add("later");
  if (flag("edition.searched")) used.add("find");
  return used;
}
function tipLog() { try { return JSON.parse(localStorage.getItem(TIP_LOG) || "{}") || {}; } catch { return {}; } }
function saveTipLog(v) { try { localStorage.setItem(TIP_LOG, JSON.stringify(v)); } catch { /* full */ } }
function dayTipHtml() {
  let start = "";
  try { start = localStorage.getItem(START_DAY) || ""; } catch { /* blocked */ }
  const before = tipLog();
  const { key, log } = pickTip({ today: dayKey(), startDay: start, used: tipsUsed(), log: before });
  if (log !== before) { saveTipLog(log); if (key) track(`tip_${key}`); }
  const t = dayTips()[key];
  if (!t) return "";
  return `<section class="ask tip" aria-labelledby="tip-h">
      <div class="ask-top"><span class="av av-sb" aria-hidden="true">${LOGO}</span>
        <div><p class="tip-k">Did you know</p><h2 id="tip-h">${esc(t.h)}</h2><p>${esc(t.p)}</p></div></div>
      <div class="ask-acts"><button class="btn primary" type="button" data-tip="go:${key}">${esc(t.go)}</button><button class="btn ghost" type="button" data-tip="off:${key}">Got it</button></div>
    </section>`;
}
function tipAction(v) {
  const [what, key] = v.split(":");
  saveTipLog(tipDone(tipLog(), key));
  track(`tip_${what}`);
  render({ top: false });
  if (what === "go") dayTips()[key]?.act();
}

/* ===== Help › Things Shoebox can do: every feature, one line each, with Show me where it can ===== */
const features = () => [
  ["Getting things in", [
    ["Save from any app", "In Safari or any app, tap Share, then Shoebox.", "share"],
    ["Your Shoebox email address", "Sign up for newsletters with it, or forward anything to it.", "email"],
    ["Tap + or paste", "Links, photos, files and notes. Paste anywhere on Today, too.", "add"],
    ["School email and newsletters", "Each thing to do, decide or know becomes its own short post.", "newsletters"],
  ]],
  ["Your morning", [
    ["Weather", "Tap the small weather line to open the full card. ••• changes the place.", ""],
    ["Day bar", "Your day at a glance with free time. Tap it for each event and Join.", "daybar"],
    ["Top stories", "Picked each morning from the topics you follow. Say why you let one go and the picks change.", "stories"],
    ["Study deck", "Three practice questions a day on whatever you're studying.", "study"],
    ["••• on a card", "Changes that card right where you see it.", "more"],
    ["Read one more", "After you clear Today, one more from your saves if you want it.", ""],
  ]],
  ["Deciding", [
    ["Love", "Double-tap a photo, or tap the heart. Loved things are kept for good.", "dbl"],
    ["Done, Later, Let go", "Later shows a few days to pick from, right on the card. Something put off eight times fades, so nothing nags.", ""],
    ["Set aside until a day", "It waits under Coming back, then tops Today that morning.", "reminders"],
    ["Undo and bring back", "Every choice has Undo. Let go things wait under All saves › Let go.", ""],
    ["Reply to yourself", "Add a thought to any save. It's searchable later.", ""],
  ]],
  ["Finding and keeping", [
    ["All saves and search", "Filters for Loved, Coming back and Finished. Search looks through everything.", "find"],
    ["Fading", "Saves untouched for weeks fade, so the list stays light. Keep any to bring it back.", ""],
    ["Works offline", "Everything saved opens without a connection.", ""],
    ["Daily backup", NATIVE ? "A copy goes to Files and iCloud Drive each day." : "Save a copy from Settings › Backup.", "backup"],
  ]],
];
function featuresBody() {
  return features().map(([h, rows]) => `<div class="group"><h3 class="sub">${esc(h)}</h3>
    ${rows.map(([t, d, k]) => `<div class="feat"><div><b>${esc(t)}</b><span>${esc(d)}</span></div>${k ? `<button class="btn sm" type="button" data-feat="${k}">Show me</button>` : ""}</div>`).join("")}
  </div>`).join("") + `<div class="group"><button class="btn" type="button" id="set-replay">Show me around again</button></div>`;
}
function showFeature(k) {
  track(`feature_${k}`);
  const panels = { email: "email", newsletters: "newsletters", study: "study", reminders: "reminders", backup: "backup" };
  if (panels[k]) { openSettings(panels[k]); return; }
  closeSheet();
  if (k === "add") { openAdd(); return; }
  if (k === "find") { selectTab("all"); $("#all-q")?.focus(); return; }
  state.tab = "today";
  if (k === "share") { setFlag(SHARE_OFF, false); setFlag(PINNED, false); coach.forget("guide"); render({ top: true }); return; }
  const c = COACH.find((x) => x.key === k);
  if (!c) return;
  render({ top: false });
  const target = $(`#panel ${c.sel}`);
  if (!target) { coach.forget(k); toast("Nothing like that on Today right now. The tip shows when one comes up."); pulseNext(".fab"); return; }
  coach.see(k);
  const t = coachTarget(c);
  t.scrollIntoView({ behavior: "auto", block: "center" });
  spotlight({ sel: `#${t.id}`, text: c.text, key: k });
}

/*
 * Apple's rule 5.1.2(i): say plainly that personal data goes to an outside AI,
 * and ask first. The short line (AI_SHORT) says what happens without a brand;
 * the full text (AI_DISCLOSURE), one tap away and in the privacy policy, names it.
 */
export const AI_SHORT = "Shoebox's AI picks your top stories, summarizes your saves and finds pictures. To do that, the text of what you save goes to an outside AI service through Shoebox's server. It isn't used to train AI, and you can turn it off any time.";
export const AI_DISCLOSURE = "Shoebox uses Claude, an AI model made by Anthropic, to read, tag and rank what you save, find pictures, and turn newsletters into posts. "
  + "When AI is on, the text of your saves, your notes and photos you add are sent to Anthropic through Shoebox's server for that. "
  + "Anthropic doesn't use them to train its models, and Shoebox's server doesn't keep them. You can turn AI off any time in Settings.";

function aiAskHtml() {
  if (ai.settings.asked() || !flag(ONBOARDED) || !ai.available()) return "";
  return `<section class="ask" aria-labelledby="ai-ask-h">
      <div class="ask-top"><span class="av av-school av-ai" aria-hidden="true">AI</span>
        <div><h2 id="ai-ask-h">Turn on AI?</h2><p>${esc(AI_SHORT)}</p></div></div>
      <details class="bm-more"><summary>Exactly what's sent</summary><p class="note">${esc(AI_DISCLOSURE)}</p></details>
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
    if (state.items.length) toast("AI is on. Reading your saves now.");
  }
}

function schoolAskHtml() {
  const c = schoolSettings();
  if (!state.schoolForce && (!c.on || !c.days.includes(new Date().getDay()) || schoolAsked())) return "";
  return `<section class="ask" aria-labelledby="ask-h">
      <div class="ask-top"><span class="av av-school" aria-hidden="true">${esc((c.school || "S").charAt(0))}</span>
        <div><h2 id="ask-h">Newsletter from ${esc(c.school || "school")}?</h2><p>Paste the link or the text. Each thing that matters${c.child ? ` for ${esc(c.child)}` : ""} becomes its own post.</p></div>${cardMore("newsletters", "Newsletters")}</div>
      <label class="sr-only" for="ask-in">Newsletter link or text</label>
      <textarea id="ask-in" rows="2" placeholder="Paste the link or the newsletter">${esc(state.schoolDraft || "")}</textarea>
      <div class="ask-acts"><button class="btn primary" type="button" data-school="go">Pull what matters</button>
        <button class="btn" type="button" data-school="skip">None this time</button></div>
      <span class="st" id="ask-st" role="status"></span>
    </section>`;
}

/** Read a newsletter (link or text) and post what matters. Returns true when a post was made. */
async function pullNewsletter(raw, statusEl, { files = [] } = {}) {
  const set = (msg, err) => { if (statusEl) { statusEl.textContent = msg; statusEl.classList.toggle("err", !!err); } };
  const input = String(raw || "").trim();
  if (!input && !files.length) { set("Paste the newsletter's link or text first.", true); return false; }
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
  // Attachments (flyers, PDFs) go as they are: Claude reads them with the text.
  // The child's name never leaves the phone: the AI sees and writes {child}, and the name goes back in here.
  const kid = childNames(c)[0] || "";
  try { out = await ai.schoolPosts({ text: ai.maskNames(text, childNames(c), kid ? ai.CHILD_TOKEN : "your child"), about: ai.maskNames(c.about, childNames(c), kid ? ai.CHILD_TOKEN : "your child") || "No details given: keep what any family at the school needs.", school: c.school, files, named: Boolean(kid) }); } catch (e) {
    noteError(e, { quiet: true, where: "school newsletter" });
    set(e.message || "Couldn't read it.", true);
    return false;
  }
  if (!out.posts.length) { set(`Nothing in this one for ${c.child || "you"}.`); markSchoolAsked(); return false; }
  const now = Date.now(), name = out.school || c.school;
  // Newest first in New, so the newsletter's first piece is created last and shows on top.
  for (let k = out.posts.length - 1; k >= 0; k--) {
    const p0 = out.posts[k];
    const p = { ...p0, headline: ai.nameIn(p0.headline, kid), body: ai.nameIn(p0.body, kid) };
    const item = createItem({ kind: KIND.NOTE, text: p.body, title: p.headline || p.body.slice(0, 80), tags: p.tags.length ? p.tags : ["school"] },
      { id: db.newId(), source: "school", now: now - k });
    Object.assign(item, { title: p.headline || item.title, school: { name, body: p.body, date: p.date, type: p.type, from: url || undefined, query: p.query, pageImgs, fromFile: p.source || undefined }, url: url || undefined,
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
 * subject. Claude picks one and writes a line about the child that fits it,
 * shown large over the photo. One post at a time, in the background.
 */
let schoolPicRunning = false;
let photoSearchDown = 0;
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
      if (relay && query && Date.now() - photoSearchDown > 10 * 60e3) {
        try {
          const res = await withTimeout(fetch(`${relay}/photo?q=${encodeURIComponent(query)}`), 20000);
          const data = res.ok ? await res.json() : {};
          cands.push(...(data.photos || []).slice(0, 4).map((p) => ({ src: p.src, credit: p.credit, license: p.license, link: p.link, search: true })));
        } catch (e) {
          // One slow answer means the photo service is struggling: stop asking for ten minutes.
          photoSearchDown = Date.now();
          noteError(e, { quiet: true, where: "school: photo search" });
        }
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

/** A school post's photo, with the line about the child over it. */
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
        <div class="meta"><span class="who">${esc(new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }))}</span>${head ? ` <span class="when">· ${esc(head)}</span>` : ""}${cardMore("calendar", "Calendar")}</div>
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
 * The Today strip, at the top of Today: a greeting, a sentence on what matters today, a bar with a
 * segment per post (purple once settled, gold while new), what's done and about how long the rest takes.
 */
function stripHtml(s) {
  const all = [...s.school, ...s.fresh, ...s.six];
  if (!all.length) return "";
  const open = all.filter(isOpen), done = all.length - open.length, fresh = s.fresh.filter(isOpen).length;
  const h = new Date().getHours();
  const hello = h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const mins = open.reduce((n, i) => n + Math.min(Math.max(+i.minutes || 3, 1), 30), 0);
  const status = !open.length ? "Today is cleared" : `${done} of ${all.length} done${fresh ? ` · ${fresh} new` : ""}`;
  const order = [...all.filter((i) => !isOpen(i)), ...open.filter((i) => !s.fresh.includes(i)), ...open.filter((i) => s.fresh.includes(i))];
  const segs = order.slice(0, 14).map((i) => `<i class="${!isOpen(i) ? "on" : s.fresh.includes(i) ? "new" : ""}"></i>`).join("");
  const line = dayLineText();
  return `<section class="strip" aria-label="Today">
    <div class="hello">${avatarHtml("sm")}<p class="hi">${hello}.</p>
      ${open.length ? `<span class="mins">About ${mins < 60 ? `${Math.max(5, Math.round(mins / 5) * 5)} min` : `${Math.round(mins / 30) / 2} hr`}</span>` : `<span class="cleared">${I.done}<span>Cleared</span></span>`}</div>
    ${line ? `<p class="brief" id="day-line">${esc(line)}</p>` : `<p class="brief" id="day-line" hidden></p>`}
    <div class="seg" role="img" aria-label="${esc(status)}">${segs}</div>
    <p class="left" id="count" aria-live="polite">${esc(status)}</p>
  </section>`;
}

/*
 * The day line. With AI on, one sentence written once a day (again when school posts or the
 * calendar change); otherwise, or until it arrives, one put together here from the same facts.
 */
const DAY_LINE = "edition.dayLine";
function dayFacts() {
  const c = morningCache(), w = c.weather, sc = schoolSettings(), kids = childNames(sc);
  const now = Date.now(), facts = [`Today is ${new Date().toLocaleDateString("en-US", { weekday: "long" })}.`];
  const weekday = (d) => { const t = fromDateInput(d); return t ? new Date(t).toLocaleDateString("en-US", { weekday: "long" }) : ""; };
  const school = state.items.filter((i) => i.school && isOpen(i) && schoolToday([i]).length)
    .sort((a, b) => (a.school.date || "9999").localeCompare(b.school.date || "9999")).slice(0, 4);
  for (const i of school) facts.push(`School: ${ai.maskNames(i.title, kids, ai.CHILD_TOKEN)}${i.school.date ? ` (${weekday(i.school.date)})` : ""}`);
  const cal = calCache(), hidden = new Set(calHidden());
  const evs = (cal?.events || []).filter((e) => !e.allDay && !hidden.has(calName(e.calendar, "Calendar")) && (e.end || e.start) > now).sort((a, b) => a.start - b.start);
  if (evs.length) facts.push(`Calendar: ${evs.length} more event${evs.length === 1 ? "" : "s"} today, the next at ${shortClock(evs[0].start)}.`);
  if (w) facts.push(`Weather${c.weatherFor ? ` in ${c.weatherFor}` : ""}: ${w.now}° now, ${String(w.word || "").toLowerCase()}, high ${w.hi}°${w.rain != null ? `, ${w.rain}% chance of rain` : ""}.${w.nextHour ? ` ${w.nextHour}.` : ""}`);
  const key = `${dayKey()}|${school.map((i) => i.id).join(",")}|${evs.length}|${w ? 1 : 0}`;
  return { facts, key, school, kids, w, evs };
}
function dayLineLocal({ school, kids, w }) {
  const parts = school.slice(0, 2).map((i, k) => { const t = ai.nameIn(ai.maskNames(i.title, kids, ai.CHILD_TOKEN), kids[0] || ""); return k && /^[A-Z][a-z]/.test(t) && !kids.some((n) => t.startsWith(n)) ? t.charAt(0).toLowerCase() + t.slice(1) : t; });
  if (w) parts.push(`it's ${w.now}° and ${String(w.word || "").toLowerCase()}${w.hi != null ? `, up to ${w.hi}°` : ""}`);
  if (!parts.length) return "";
  const line = parts.length > 1 ? `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}.` : `${parts[0]}.`;
  return line.charAt(0).toUpperCase() + line.slice(1);
}
function dayLineText() {
  const f = dayFacts();
  try { const saved = JSON.parse(localStorage.getItem(DAY_LINE) || "null"); if (saved?.key === f.key && saved.text) return saved.text; } catch { /* none yet */ }
  return dayLineLocal(f);
}
let dayLineBusy = false;
async function refreshDayLine() {
  if (dayLineBusy || state.tab !== "today" || !ai.settings.enabled() || !navigator.onLine) return;
  const f = dayFacts();
  if (f.facts.length < 2) return;
  try { const saved = JSON.parse(localStorage.getItem(DAY_LINE) || "null"); if (saved?.key === f.key) return; } catch { /* write a new one */ }
  dayLineBusy = true;
  try {
    const text = ai.nameIn(await ai.dayLine(f.facts), f.kids[0] || "");
    localStorage.setItem(DAY_LINE, JSON.stringify({ key: f.key, text, at: Date.now() }));
    const el = $("#day-line");
    if (el) { el.textContent = text; el.hidden = false; }
  } catch (e) {
    // Try again with the next change rather than every render.
    try { localStorage.setItem(DAY_LINE, JSON.stringify({ key: f.key, text: "", at: Date.now() })); } catch { /* full */ }
    noteError(e, { quiet: true, where: "day line" });
  } finally { dayLineBusy = false; }
}

/** The end of Today: what's left, or the finish moment once it's all cleared. */
function endHtml(s) {
  const all = [...s.fresh, ...s.six, ...s.school];
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
  if (!coach.seen("cleared")) { coach.see("cleared"); state.firstWinDay = dayKey(); }
  const firstEver = state.firstWinDay === dayKey();
  return `<section class="end win ${first ? "first" : ""}" aria-label="Today is done">
    <h2>You cleared today.</h2>
    <p>${firstEver ? "That's the whole idea: a few things, finished. Read one more if you like, or see you tomorrow morning." : "Nothing more until tomorrow morning."}</p>
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
  const f = ALL_FILTERS[state.allFilter] || ALL_FILTERS[0];
  const kind = ALL_KINDS.find((k) => k.id === state.allKind);
  const q = state.allQuery.trim().toLowerCase();
  const match = (i) => !q || [i.title, i.text, i.url, i.summary, i.fileName, i.author, i.transcript, i.why, i.site,
    ...(i.points || []), ...(i.tags || []), ...(i.replies || []).map((r) => r.text)].some((s) => s && String(s).toLowerCase().includes(q));
  const mine = state.items.filter((i) => !i.suggested || i.status !== STATUS.INBOX);
  // A search looks through everything: you remember the thing, not where it sits.
  const inView = q ? mine : mine.filter(f.test);
  const rows = inView.filter((i) => !kind || kind.test(i)).filter(match)
    .sort((a, b) => (!q && f.id === STATUS.ASIDE ? (a.until || 0) - (b.until || 0) : 0)
      || (!q && f.id === "loved" ? (b.loved || 0) - (a.loved || 0) : 0) || (b.doneAt || b.archivedAt || b.created) - (a.doneAt || a.archivedAt || a.created));
  const kinds = ALL_KINDS.map((k) => ({ ...k, n: inView.filter(k.test).length })).filter((k) => k.n || k.id === state.allKind);
  const waiting = !q && !kind && (f.id === "toread" || f.id === "all") ? fading(state.items, state.edition, { limit: 8 }) : [];
  const shown = rows.slice(0, state.allShown);
  const title = q ? `Results for “${state.allQuery.trim()}”` : kind ? `${f.id === "all" ? "" : `${f.label}: `}${kind.label}` : f.label;
  return `<div class="find-wrap">${I.search}<label class="sr-only" for="all-q">Search everything you saved</label>
      <input class="find" id="all-q" type="search" placeholder="Search everything you saved" value="${esc(state.allQuery)}" enterkeyhint="search" autocomplete="off"></div>
    ${q ? "" : `<div class="chips" role="group" aria-label="Show">
      ${ALL_FILTERS.map((x, i) => { const n = x.id === "all" ? 0 : mine.filter(x.test).length;
        return x.id === "all" || n || state.allFilter === i ? `<button class="chip" type="button" data-filter="${i}" aria-pressed="${state.allFilter === i}">${x.label}${n ? ` <span class="n">${n}</span>` : ""}</button>` : ""; }).join("")}
    </div>`}
    ${kinds.length > 1 || state.allKind ? `<div class="chips kinds" role="group" aria-label="Kind">
      ${kinds.map((k) => `<button class="chip sm" type="button" data-kind="${k.id}" aria-pressed="${state.allKind === k.id}">${k.label}</button>`).join("")}
    </div>` : ""}
    ${waiting.length ? `${sectionHead("Fading", `Untouched ${FADE_DAYS / 7} weeks fades`)}<div class="tide">${tideHtml(waiting)}</div>` : ""}
    ${sectionHead(title, `${rows.length} item${rows.length === 1 ? "" : "s"}`)}
    ${shown.length ? shown.map((i) => postHtml(i, { compact: true })).join("") : `<p class="empty">${q ? "Nothing matches. Try fewer words." : kind ? `No ${esc(kind.label.toLowerCase())} here yet.` : EMPTY_ALL[f.id] || "Nothing here yet."}</p>`}
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
  if (item.email) return { who: senderName(item.email.fromName, item.email.from), when: friendlyWhen(item.created) };
  return { who: "You", when: friendlyWhen(item.created) };
}

/** What a tap on a post's words adds: the rest of an email, the summary, your note, every key point and reply. */
const EMAIL_CUT = 280;
function moreHtml(item) {
  const parts = [];
  const said = item.suggestReason || item.summary;
  if (item.extended && !item.suggested) parts.push(`<div class="more-summary">${item.extended.split(/\n\s*\n/).map((p) => `<p>${esc(p.trim())}</p>`).join("")}</div>`);
  else if (item.summary && !(item.suggested && said === item.summary) && !item.school) parts.push(`<p class="more-summary">${esc(item.summary)}</p>`);
  const note = item.kind === KIND.LINK ? item.text : item.kind === KIND.NOTE || item.kind === KIND.QUOTE || item.email ? "" : item.note;
  if (note && String(note).trim()) parts.push(`<p class="more-note"><span>Your note</span>${esc(note)}</p>`);
  return parts.join("");
}
function hasMore(item, compact) {
  const pts = item.points?.length && [KIND.LINK, KIND.PDF, KIND.TEXT].includes(item.kind) ? item.points.length : 0;
  return Boolean(moreHtml(item))
    || (item.email && String(item.text || "").length > EMAIL_CUT)
    || (pts && (compact || pts > 3))
    || (item.replies || []).length > (compact ? 1 : 3);
}
function toggleExpand(id) {
  const item = byId(id);
  if (!item) return;
  const el = document.getElementById("p-" + id);
  if (state.expanded.has(id)) state.expanded.delete(id);
  else if (hasMore(item, el?.classList.contains("compact"))) state.expanded.add(id);
  else return;
  track(state.expanded.has(id) ? "post_expand" : "post_collapse");
  refreshPost(id);
  const now = document.getElementById("p-" + id);
  if (now && !state.expanded.has(id) && now.getBoundingClientRect().top < 0) now.scrollIntoView({ block: "start", behavior: reduced() ? "auto" : "smooth" });
}

function postHtml(item, { compact = false } = {}) {
  const words = item.kind === KIND.QUOTE || item.kind === KIND.NOTE;
  const expanded = state.expanded.has(item.id);
  const settled = state.tab === "today" ? settledAs(item) : null;
  const open = state.tab === "today" ? isOpen(item) : item.status === STATUS.INBOX || item.status === STATUS.QUEUED;
  const b = byline(item);
  const tag = item.loved ? `<span class="tag love">${I.heartFill}<span>Loved</span></span>`
    : item.suggested ? `<span class="tag">Top story</span>`
    : item.school && SCHOOL_TYPES[item.school.type] ? `<span class="tag st-${item.school.type}">${SCHOOL_TYPES[item.school.type]}</span>`
    : item.backAt && item.status === STATUS.INBOX && dayKey(item.backAt) === dayKey() ? `<span class="tag back">Back today</span>`
    : isFaded(item) ? `<span class="tag fade">Faded</span>`
    : state.tab === "all" && item.status !== STATUS.QUEUED ? `<span class="tag">${{ inbox: "New", done: "Finished", archived: "Let go", aside: "Coming back" }[item.status] || ""}</span>` : "";
  // The words at the top: your reason, else Shoebox's line about it (marked as a guess), else nothing.
  let say = "";
  if (item.suggested) say = `<p class="body">${esc(item.suggestReason || item.summary || "Picked from what you finish.")}</p>`;
  else if (item.email) say = `<p class="school-head">${esc(item.title)}</p>` + (expanded
    ? `<p class="body full">${esc(String(item.text || "").trim())}</p>`
    : `<p class="body">${esc(String(item.text || "").replace(/\s+/g, " ").slice(0, EMAIL_CUT))}${String(item.text || "").length > EMAIL_CUT ? "…" : ""}</p>`);
  else if (item.school) say = `<p class="school-head">${esc(item.title)}</p><p class="body">${esc(item.school.body || "")}</p>`
    + (item.school.date ? `<p class="ev-place">${I.cal}<span>${esc(shortDate(fromDateInput(item.school.date)))}</span></p>` : "")
    + (item.school.fromFile ? `<p class="ev-place">${I.attach}<span>From the attached ${esc(item.school.fromFile)}</span></p>` : "");
  else if (item.kind === KIND.NOTE) say = `<p class="say">${esc(item.text || item.title)}</p>`;
  else if (item.why) say = `<p class="say">${esc(item.why)}</p>`;
  else if (item.hook && !words) say = `<p class="guess"><span class="sr-only">${APP}'s guess: </span>${esc(item.hook)}</p>`;
  const why = item.why && item.kind === KIND.NOTE ? `<p class="why-line"><span>Why you kept it</span>${esc(item.why)}</p>` : "";
  const quote = item.kind === KIND.QUOTE ? `<figure class="quote ${String(item.text || "").length > 160 ? "long" : ""}"><blockquote>“${esc(item.text || item.title)}”</blockquote>${item.author ? `<figcaption>${esc(item.author)}</figcaption>` : ""}</figure>${item.why ? `<p class="why-line"><span>Why you kept it</span>${esc(item.why)}</p>` : ""}` : "";
  const points = (expanded || !compact) && item.points && item.points.length && [KIND.LINK, KIND.PDF, KIND.TEXT].includes(item.kind)
    ? `<div class="quick"><h3>Quick read</h3><ul>${(expanded ? item.points : item.points.slice(0, 3)).map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>` : "";
  const more = expanded ? moreHtml(item) : "";
  const toggle = expanded || hasMore(item, compact)
    ? `<button class="more-text" type="button" data-expand="${esc(item.id)}" aria-expanded="${expanded}">${expanded ? "Show less" : "More"}</button>` : "";
  const coming = item.school && item.school.items?.length ? `<div class="quick coming"><h3>For ${esc(schoolSettings().child || "your family")}</h3><ul>${item.school.items.map((i) =>
    `<li>${i.date ? `<b>${esc(shortDate(fromDateInput(i.date)))}</b> · ` : ""}${esc(i.text)}</li>`).join("")}</ul></div>` : "";
  const busy = state.enriching.has(item.id) ? `<p class="busy" role="status">Reading it…</p>` : "";
  const replies = repliesHtml(item, compact, expanded);
  const tintStyle = item.tint && tintInks(item.tint) ? ` style="--t:${esc(tintInks(item.tint).t)}"` : "";
  return `<article class="post${compact ? " compact" : ""}${settled ? " settled" : ""}${item.tint ? " tinted" : ""}${expanded ? " expanded" : ""}" id="p-${esc(item.id)}" data-id="${esc(item.id)}"${tintStyle}
      aria-label="${esc(b.who)}, ${esc(b.when)}${item.title && !words ? ": " + esc(item.title) : ""}">
    <div class="rail">${item.suggested ? `<span class="av av-sb" aria-hidden="true">${LOGO}</span>` : item.school ? `<span class="av av-school" aria-hidden="true">${esc((item.school.name || "S").charAt(0))}</span>` : avatarHtml()}${replies ? '<span class="line" aria-hidden="true"></span>' : ""}</div>
    <div class="main">
      <div class="meta"><span class="who">${esc(b.who)},</span> <span class="when">${esc(b.when)}</span>${tag}<button class="act icon more" type="button" data-edit="${esc(item.id)}" aria-label="Edit">${I.menu}</button></div>
      ${say}${quote}${why}${more}
      ${item.school ? schoolMediaHtml(item) : mediaHtml(item, compact)}
      ${busy}${item.school ? coming : points}${toggle}
    </div>
    <div class="acts-row">${settled ? stampHtml(item, settled) : actionsHtml(item, open)}</div>
  </article>${replies}`;
}

/**
 * Later, right on the card: the buttons turn into one-tap days. Tomorrow on a post from the six is the
 * usual Later (it fades after eight); every other day sets it aside, and it tops Today that morning.
 */
function laterPickHtml(item) {
  const choices = asideChoices();
  const min = toDateInput(choices[0].until);
  return `<div class="later-pick" role="group" aria-label="Show it again">
    <div class="later-head"><span class="later-q">${I.later}<span>Show it again</span></span>
      <button class="act icon" type="button" data-later-close="${esc(item.id)}" aria-label="Keep it here">${I.close}</button></div>
    <div class="later-chips">
      ${choices.map((c, k) => `<button class="chip" type="button" data-later-to="${k === 0 ? "tomorrow" : c.until}" data-id="${esc(item.id)}">${esc(c.label === "Tomorrow" ? "Tomorrow" : c.label)}</button>`).join("")}
      <span class="chip date-chip"><span class="dl">Pick a date</span><input type="date" min="${min}" data-later-date="${esc(item.id)}" aria-label="Pick a date"></span>
    </div>
  </div>`;
}

/** "tomorrow morning", "Saturday morning", "Mon, Nov 9". */
function laterWhen(until) {
  const days = Math.round((startOfDay(until) - startOfDay(Date.now())) / 864e5);
  if (days === 1) return "tomorrow morning";
  if (days > 1 && days < 7) return `${new Date(until).toLocaleDateString("en-US", { weekday: "long" })} morning`;
  return shortDate(until);
}

/** Set a post aside until a day, from its card. It stays on Today, stamped, with Undo. */
async function laterTo(id, until) {
  const before = byId(id);
  if (!before) return;
  state.laterOpen = null;
  dropReminder(before);
  const after = setAside({ ...before, reminder: undefined }, until);
  await saveItem(after);
  if (remindOn() && notifyOn()) scheduleReminder(after);
  state.recent.set(id, { verdict: "aside", stage: before.status === STATUS.INBOX ? "inbox" : "six", undo: async () => { dropReminder(after); await saveItem(before); } });
  tick(true);
  render();
  buzz(8);
  track("later_pick");
  confirmOnCard(id, `Back ${laterWhen(after.until)}.`, { action: "Undo", onAction: () => undoRecent(id) });
}

/*
 * A settled post says what you decided, as plain status text so it never
 * looks like a button, with one real action beside it: Undo for a verdict
 * given this session, else Bring back.
 */
function stampHtml(item, v) {
  const isDone = v === VERDICT.DONE || v === VERDICT.READ_NOW;
  const st = item.school?.type;
  const label = isDone ? (st === "info" ? "Got it" : st === "decision" ? "Decided" : doneLabel(item) === "Done" ? "You marked this done" : "You've read it")
    : v === VERDICT.LET_GO ? (item.suggested ? "You said not for me" : st === "decision" ? "Not for us" : st ? "Not needed" : "You let this go")
    : item.status === STATUS.ASIDE && item.until ? `Back ${laterWhen(item.until)}`
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
  if (state.laterOpen === item.id) return laterPickHtml(item);
  if (item.school) {
    // The buttons say what finishing means for this kind of post.
    const t = item.school.type;
    const [no, yes] = t === "info" ? [null, "Got it"] : t === "decision" ? ["Not for us", "Decided"] : ["Not needed", "Done"];
    return `<div class="acts">${love}<span class="grow"></span>
    ${no ? `<button class="act" type="button" data-v="${VERDICT.LET_GO}" data-id="${esc(item.id)}">${I.letGo}<span>${no}</span></button>` : ""}
    <button class="act" type="button" data-later-open="${esc(item.id)}">${I.later}<span>Later</span></button>
    <button class="act done" type="button" data-v="${VERDICT.DONE}" data-id="${esc(item.id)}">${I.done}<span>${yes}</span></button>
  </div>`;
  }
  const keep = item.status === STATUS.INBOX || isFaded(item);
  return `<div class="acts">${love}${reply}<span class="grow"></span>
    ${keep ? `<button class="act" type="button" data-v="${VERDICT.LATER}" data-id="${esc(item.id)}">${I.keep}<span>Keep</span></button>`
      : `<button class="act" type="button" data-later-open="${esc(item.id)}">${I.later}<span>Later</span></button>`}
    <button class="act" type="button" data-v="${VERDICT.LET_GO}" data-id="${esc(item.id)}">${I.letGo}<span>${item.suggested ? "Not for me" : "Let go"}</span></button>
    <button class="act done" type="button" data-v="${VERDICT.DONE}" data-id="${esc(item.id)}">${I.done}<span>${esc(doneLabel(item))}</span></button>
  </div>`;
}

function repliesHtml(item, compact, expanded = false) {
  const list = item.replies || [];
  if (!list.length) return "";
  const shown = expanded ? list : compact ? list.slice(-1) : list.slice(-3);
  return `<div class="replies" data-for="${esc(item.id)}">${list.length > shown.length ? `<button class="more-replies" type="button" data-expand="${esc(item.id)}">${list.length - shown.length} earlier repl${list.length - shown.length === 1 ? "y" : "ies"}</button>` : ""}
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
  app.addEventListener("change", (e) => {
    const inp = e.target.closest?.("[data-later-date]");
    const u = inp && fromDateInput(inp.value);
    if (u) laterTo(inp.dataset.laterDate, u);
  });
  // Double-tap a photo to love it.
  let lastTap = { id: "", at: 0 };
  app.addEventListener("pointerup", (e) => {
    const box = e.target.closest("[data-dbl]");
    if (!box) return;
    const now = Date.now();
    if (lastTap.id === box.dataset.dbl && now - lastTap.at < 320) {
      lastTap = { id: "", at: 0 };
      dblLoved = now;
      coachUsed("dbl");
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
    if (q.value.trim()) setFlag("edition.searched", true);
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
  if (state.laterOpen && !t.closest(".later-pick, [data-later-open]")) { const id = state.laterOpen; state.laterOpen = null; refreshPost(id); }
  const hit = (sel) => t.closest(sel);
  let b;
  if ((b = hit("[data-tab]"))) { selectTab(b.dataset.tab); return; }
  if ((b = hit("[data-preview]"))) { playPreview(b); return; }
  if (hit('[data-fold="song"] .disc-acts a.btn.primary')) state.songOpened = true;
  if ((b = hit("[data-song-open]"))) {
    // The link opens the song in Apple Music by itself; note it so Shoebox can ask later how it landed.
    const sg = morningCache().song;
    if (sg?.native && sg.id === b.dataset.songOpen) saveSongLog(songs.logPlay(songLog(), sg));
    track("song_open");
    return;
  }
  if ((b = hit("[data-song-ans]"))) { await songAnswer(b.dataset.songAns); return; }

  if ((b = hit("[data-song-next]"))) {
    b.disabled = true;
    const r = await nativeAsk("music", { op: "pick", seed: Math.floor(Math.random() * 1000), skip: songs.skipIds(songLog()) }, 20000).catch(() => ({ ok: false }));
    if (r.ok) { const c = morningCache(); c.song = nativeSong(r); saveMorningCache(c); render({ top: false }); } else b.disabled = false;
    return;
  }
  if ((b = hit("[data-day]"))) { await dayAction(b.dataset.day); return; }
  if ((b = hit("[data-cq]"))) { const [k, i] = b.dataset.cq.split(":").map(Number); answerCpmai(k, i); return; }
  if ((b = hit("[data-school=go]"))) {
    b.disabled = true;
    const ok = await pullNewsletter($("#ask-in")?.value, $("#ask-st"));
    b.disabled = false;
    if (ok) { tick(true); render({ top: true }); toast(`${state.schoolCount} post${state.schoolCount === 1 ? "" : "s"} from school, under From school on Today.`); }
    return;
  }
  if ((b = hit("[data-panel]"))) { coachUsed("more"); openSettings(b.dataset.panel, { fromCard: true }); return; }
  if ((b = hit("[data-welcome]"))) { await welcomeAction(b.dataset.welcome); return; }
  if ((b = hit("[data-tip]"))) { tipAction(b.dataset.tip); return; }
  if ((b = hit("[data-wn]"))) { whatsNewAction(b.dataset.wn); return; }
  if ((b = hit("[data-ai-ask]"))) { setAi(b.dataset.aiAsk === "1"); render({ top: false }); return; }
  if ((b = hit("[data-school=skip]"))) { markSchoolAsked(); state.schoolDraft = ""; state.schoolForce = false; render({ top: false }); return; }
  if ((b = hit("[data-act]"))) { runAct(b.dataset.act, b); return; }
  if ((b = hit("[data-backnow]"))) {
    const cur = byId(b.dataset.backnow);
    if (cur) { dropReminder(cur); const back = bringBackNow(cur); delete back.reminder; await saveItem(back); tick(true); render({ top: false }); toast("It's back, at the top of Today."); }
    return;
  }
  if ((b = hit("[data-filter]"))) { state.allFilter = +b.dataset.filter; state.allShown = PAGE; render({ top: false }); return; }
  if ((b = hit("[data-kind]"))) { state.allKind = state.allKind === b.dataset.kind ? "" : b.dataset.kind; state.allShown = PAGE; render({ top: false }); return; }
  if ((b = hit("[data-later-open]"))) { state.laterOpen = b.dataset.laterOpen; refreshPost(b.dataset.laterOpen); document.querySelector(`#p-${CSS.escape(b.dataset.laterOpen)} .later-chips .chip`)?.focus(); return; }
  if ((b = hit("[data-later-close]"))) { const id = b.dataset.laterClose; state.laterOpen = null; refreshPost(id); document.querySelector(`#p-${CSS.escape(id)} [data-later-open]`)?.focus(); return; }
  if ((b = hit("[data-later-to]"))) {
    const id = b.dataset.id, item = byId(id);
    if (b.dataset.laterTo === "tomorrow" && item?.status === STATUS.QUEUED) { state.laterOpen = null; timelineVerdict(id, VERDICT.LATER); }
    else laterTo(id, b.dataset.laterTo === "tomorrow" ? asideChoices()[0].until : +b.dataset.laterTo);
    return;
  }
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
  // A tap on a post's words opens it in place (and closes it again); picture and title still open the reader.
  if ((b = hit("[data-expand]")) || (b = hit(".post[data-id] .main :is(.say, .body, .guess, .school-head, .why-line, .quote, .more-summary, .more-note, .quick)"))) {
    if (!b.dataset.expand && String(window.getSelection?.() || "").trim()) return; // selecting text isn't a tap
    toggleExpand(b.dataset.expand || b.closest(".post").dataset.id);
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
    findNew($("#end-st")).then((n) => { btn.disabled = false; if (n) { state.storiesMiss = false; render(); } else if (btn.isConnected && btn.classList.contains("linkish")) btn.textContent = "Still nothing. Try later"; });
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

/**
 * After a choice on a card: the card itself shows the result with Undo, so a message would only cover
 * the next card. Screen readers still hear it. A message shows only when the card is out of view.
 */
function confirmOnCard(id, msg, opts = {}) {
  const el = document.getElementById("p-" + id), top = $(".top")?.getBoundingClientRect().bottom || 0;
  const r = el?.getBoundingClientRect();
  if (r && r.bottom > top + 40 && r.top < innerHeight - 40) { live(msg); return; }
  toast(msg, opts);
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
    [VERDICT.LATER]: rec.stage === "inbox" ? "Kept. It'll come back in a later day's six." : rec.after.fadedAt ? "Moved later eight times. It's waiting under Fading."
      : coach.can("later") && coach.take("later") ? "Back tomorrow. Put something off eight times and it fades away, so nothing nags." : "Back tomorrow.",
    [VERDICT.DONE]: doneToast(before),
  };
  if (wasLeft > 0 && nowLeft === 0 && state.tab === "today") {
    buzz([12, 60, 18]);
    $(".end.win")?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "center" });
    live("You cleared today."); // the finish card says it; a message would cover it
  } else {
    buzz(8);
    confirmOnCard(id, words[verdict], { action: "Undo", onAction: () => undoRecent(id) });
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
    ${item.kind === KIND.LINK && !busy && !item.text && !item.summary && !item.extended && !item.note ? `<p class="summary empty-read">Shoebox couldn't read this page${item.url ? ` from ${esc(host(item.url))}` : ""}, often because it needs a sign-in. The original has it all.</p>` : ""}
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
  // The number that says whether your own feed works: saves that came back and got finished.
  track(`v_${String(verdict).replace(/[^a-z]/g, "")}`);
  if (verdict === VERDICT.DONE && !before.suggested && !before.school && Date.now() - (before.created || Date.now()) > 864e5) track("comeback_done");
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
      ${f("sdate", "Date", sch.date || "", { type: "date" })}
      <div class="row"><span class="rk">This is</span><div class="seg" role="group" aria-label="This is">${Object.entries(SCHOOL_TYPES).map(([k, v]) => `<button type="button" data-stype="${k}" aria-pressed="${(sch.type || "info") === k}">${v}</button>`).join("")}</div></div>`
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
      next.school = { ...cur.school, body: t || cur.school.body, overlay: (val("overlay") || "").trim().slice(0, 60), date: /^\d{4}-\d{2}-\d{2}$/.test(val("sdate") || "") ? val("sdate") : null,
        type: wrap.querySelector("[data-stype][aria-pressed='true']")?.dataset.stype || cur.school.type || "info" };
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
      msg = `Back ${laterWhen(edUntil)}.`;
      if (todayIds().includes(id)) state.recent.set(id, { verdict: "aside", stage: cur.status === STATUS.INBOX ? "inbox" : "six", undo: async () => { dropReminder(done); await saveItem(cur); } });
    } else if (!edUntil && wasUntil) { done = bringBackNow(next); msg = "It's back, at the top of Today."; }
    await saveItem(done);
    if (remindMe && notifyOn()) scheduleReminder(done);
    tick(true);
    closeSheet();
    render();
    toast(msg);
  };
  wrap.querySelectorAll("[data-stype]").forEach((b) => b.addEventListener("click", () => {
    wrap.querySelectorAll("[data-stype]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
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

/** Notify this phone at the reminder time on the day (on the phone itself, or through the relay). Quiet on failure, with a note. */
async function scheduleReminder(item) {
  if (!item || !item.until || !notifyOn()) return;
  try {
    const [rh, rm] = remindTime().split(":").map(Number);
    const at = new Date(item.until).setHours(rh, rm, 0, 0);
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
// The iPhone app proves itself to the relay (App Attest) so it can use Shoebox's AI; a web page can't.
if (nativeCan("attest")) ai.setAttester((challenge) => nativeAsk("attest", { challenge }, 30000));

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
      } else if (t.kind === "url" && t.value) {
        // A link from the share sheet: a link post, with the page's title when the app sent one.
        const list = await captureText(t.value, "share");
        for (const it of list) if (t.title && t.title !== t.value && (!it.title || it.title === it.url)) { it.title = t.title; await saveItem(it); }
        out.push(...list);
      } else if (t.value) {
        out.push(...await captureText(t.value, "share"));
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
/** Top stories picked by themselves once a day (on unless turned off). */
const storiesAuto = () => { try { return localStorage.getItem("edition.storiesAuto") !== "0"; } catch { return true; } };
/** When set-aside reminders arrive, "HH:MM" (default 9:00 AM). */
const remindTime = () => { try { const t = localStorage.getItem("edition.remindTime") || ""; return /^\d{2}:\d{2}$/.test(t) ? t : "09:00"; } catch { return "09:00"; } };
const remindLabel = (t = remindTime()) => { const [h, m] = t.split(":").map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); };

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
        <span>Remind me that day<small>${notifyOn() ? `A notification at ${remindLabel()}` : `Adds a ${remindLabel()} alert to your Calendar`}</small></span></label>
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
  const ics = reminderIcs({ title, why, url, until, appUrl: location.origin + location.pathname, time: remindTime() });
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
      ${!flag(FIRST_SAVE) && !state.capText ? `<div class="cap-try" id="cap-try"><p>Nothing handy? Try one of these for your first save.</p>
        <div class="cap-try-b"><button class="btn sm" type="button" data-try="https://apod.nasa.gov/apod/astropix.html">Today's space photo from NASA</button>
        <button class="btn sm" type="button" data-try="https://en.wikipedia.org/wiki/Special:Random">A random Wikipedia article</button></div></div>` : ""}
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
  ta.addEventListener("input", () => { state.capText = ta.value; grow(ta, 240); updateDetect(); if (ta.value.trim()) $("#cap-try", wrap)?.remove(); });
  wrap.querySelectorAll("[data-try]").forEach((b) => b.addEventListener("click", () => {
    track("first_add_try");
    ta.value = b.dataset.try;
    ta.dispatchEvent(new Event("input"));
  }));
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
  $("#set-sc-save", wrap).addEventListener("click", () => { setSchoolSettings(read()); affirm(st, "Saved. School email is read with these details."); render({ top: false }); });
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
  const say = (msg, err) => affirm(st, msg, err);
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
  const say = (el, msg, err) => affirm(el, msg, err);
  const st = $("#set-push-st", wrap), onBtn = $("#set-push-on", wrap), testBtn = $("#set-push-test", wrap);
  const paint = () => {
    const on = push.enabled();
    onBtn.textContent = on ? "Turn off" : "Turn on";
    testBtn.disabled = !on;
    const sv = $("#set-push-sv", wrap); if (sv) sv.textContent = on ? "On" : "Off";
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

/*
 * Settings: one list with each thing's current value ("Weather — Wilmington ›"),
 * and a page for each. Every card on Today opens its own page from its •••
 * button too, so the usual changes happen where you see them.
 */
const SETTINGS_ORDER = [
  ["", ["you"]],
  ["Your Today", ["calendar", "weather", "study", "cards", "newsletters"]],
  ["Saving and reminders", ["email", "reminders", "ai"]],
  ["Your data", ["backup", "learned", "privacy"]],
  ["", ["features", "help", "usage"]],
];

function openSettings(panel = "", { fromCard = false } = {}) {
  const c = counts(state.items);
  const m = morningSettings(), sc = schoolSettings(), me = personal();
  const onOff = (key, label, on) => `<div class="row"><span class="rk">${label}</span><div class="seg" role="group" aria-label="${label}"><button type="button" data-mo="${key}:1" aria-pressed="${on}">On</button><button type="button" data-mo="${key}:0" aria-pressed="${!on}">Off</button></div></div>`;
  const mailOn = (() => { try { return Boolean(localStorage.getItem("edition.inboxAddress")); } catch { return false; } })();
  const mailPick = (() => { try { return localStorage.getItem("edition.inboxPick") || ""; } catch { return ""; } })();
  const calShown = [...new Set((calCache()?.events || []).map((e) => calName(e.calendar, "Calendar")))].filter((n) => !calHidden().includes(n));
  const cardsOn = ["otd", "quote", ...(me ? ["song", "hockey"] : nativeCan("music") ? ["song"] : [])].filter((k) => m[k]).length;
  const P = {
    you: { title: "You", value: { system: "Phone look", light: "Light", dark: "Dark" }[themeChoice()], body: `
      <div class="group">
        <div class="row"><span class="rk">Your photo</span>
          <span class="me-row"><span id="set-me">${avatarHtml("sm")}</span>
            <button class="btn sm" type="button" id="set-me-choose">${state.avatar ? "Change" : "Choose"}</button>
            <button class="btn sm ghost" type="button" id="set-me-clear" ${state.avatar ? "" : "disabled"}>Remove</button></span>
          <input type="file" id="set-me-file" accept="image/*" hidden></div>
        <div class="row"><span class="rk">Look</span>
          <div class="seg" role="group" aria-label="Look">${["system", "light", "dark"].map((t) => `<button type="button" data-look="${t}" aria-pressed="${themeChoice() === t}">${{ system: "Phone", light: "Light", dark: "Dark" }[t]}</button>`).join("")}</div></div>
        <div class="row"><span class="rk">Colors</span>
          <div class="seg" role="group" aria-label="Colors">${["grape", "plain"].map((t) => `<button type="button" data-palette="${t}" aria-pressed="${paletteChoice() === t}">${{ grape: "Grape soda", plain: "Plain" }[t]}</button>`).join("")}</div></div>
        <div class="row"><span class="rk">Sounds</span>
          <div class="seg" role="group" aria-label="Sounds">
            <button type="button" data-sound="1" aria-pressed="${soundOn()}">On</button><button type="button" data-sound="0" aria-pressed="${!soundOn()}">Off</button></div></div>
      </div>` },
    calendar: { title: "Calendar", value: calOn() ? (calShown.length ? calShown.slice(0, 2).join(", ") + (calShown.length > 2 ? "…" : "") : "On") : "Off", body: `
      <div class="group">
      ${nativeCan("calendar") ? `<div class="row"><span class="rk">This iPhone's calendars</span><div class="seg" role="group" aria-label="This iPhone's calendars"><button type="button" data-calnative="1" aria-pressed="${calNative()}">On</button><button type="button" data-calnative="0" aria-pressed="${!calNative()}">Off</button></div></div>
      <p class="note">Everything in the Calendar app: iCloud, Google, Outlook. Events stay on your iPhone.</p>` : ""}
      ${(() => { const seen = [...new Set((calCache()?.events || []).map((e) => calName(e.calendar, "Calendar")).concat(calHidden()))].sort();
        return seen.length > 1 ? `<h3 class="sub">Show on Today</h3>${seen.map((n) => `<div class="row"><span class="rk">${esc(n)}</span><div class="seg" role="group" aria-label="${esc(n)}"><button type="button" data-calshow="${esc(n)}:1" aria-pressed="${!calHidden().includes(n)}">Show</button><button type="button" data-calshow="${esc(n)}:0" aria-pressed="${calHidden().includes(n)}">Hide</button></div></div>`).join("")}` : ""; })()}
      ${(() => {
        // On the iPhone, its own calendars cover almost everyone: a web address is the rare case, so it waits behind a tap.
        const addr = `<div class="field"><label for="set-cal">Calendar addresses <span class="hint">(one per line)</span></label>
          <textarea id="set-cal" rows="3" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics">${esc(calUrls().join("\n"))}</textarea></div>
        <div class="two">
          <button class="btn primary" type="button" id="set-cal-save">Save and test</button>
          <button class="btn" type="button" id="set-cal-clear">Remove</button>
        </div>
        <p class="note">Google: calendar settings › Secret address in iCal format. iPhone: Calendar › calendar info › Public Calendar › Share Link.</p>`;
        return nativeCan("calendar")
          ? `<details class="adv" ${calUrls().length ? "open" : ""}><summary>A calendar that isn't on this iPhone?</summary>${addr}</details>`
          : addr;
      })()}
      <span class="st" id="set-cal-st" role="status"></span>
      </div>` },
    weather: { title: "Weather", value: m.weather ? placeOf(m)?.name || "Add a place" : "Off", body: `
      <div class="group">
      ${onOff("weather", "Show weather", m.weather)}
      ${canLocate() ? `<div class="row"><span class="rk">Where</span><button class="btn sm" type="button" id="set-mo-loc">${m.useLocation ? `Following you: ${esc(placeOf(m)?.name || "…")}` : "Use my location"}</button></div>` : ""}
      <div class="field"><label for="set-mo-zip">${canLocate() ? "Or a ZIP code or town" : "ZIP code or town"}</label>
        <input id="set-mo-zip" type="text" autocomplete="postal-code" value="${esc(m.useLocation ? "" : m.zip || placeOf(m)?.name || "")}" placeholder="e.g. 10001"></div>
      <div class="field"><label for="set-mo-cam">Camera <span class="hint">(optional)</span></label>
        <input id="set-mo-cam" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="A webcam picture or a YouTube live link" value="${esc(m.cam)}"></div>
      ${placeOf(m) && ai.settings.enabled() ? `<button class="btn" type="button" id="set-cam-find">Find live cameras near ${esc(placeOf(m).name)}</button><div class="cam-picks" id="set-cam-picks"></div><span class="st" id="set-cam-st" role="status"></span>` : ""}
      <p class="note">Blank shows the weather radar. ${placeOf(m) && ai.settings.enabled() ? "Or paste" : "Paste"} a webcam's picture address (often ending in .jpg) or a YouTube live link.</p>
      <button class="btn primary" type="button" id="set-mo-save">Save</button>
      <span class="st" id="set-mo-st" role="status"></span>
      </div>` },
    study: { title: "Study deck", value: m.study && m.studyTopic ? studyLabel(m) : "Off", body: `
      <div class="group">
      ${onOff("study", "Daily questions", m.study)}
      <div class="field"><label for="set-study-topic">Topic</label>
        <input id="set-study-topic" type="text" autocomplete="off" placeholder="e.g. AWS Solutions Architect, Spanish verbs, US history" value="${esc(m.studyTopic)}"></div>
      <button class="btn primary" type="button" id="set-study-save">Save</button>
      <span class="st" id="set-study-st" role="status"></span>
      <p class="note">Three practice questions each morning, written by AI. Mark them Done once answered.</p>
      </div>` },
    cards: { title: "Daily cards", value: `${cardsOn} on`, body: `
      <div class="group">
      ${onOff("otd", "On this day", m.otd)}
      ${me || nativeCan("music") ? onOff("song", "Song of the day", m.song) : ""}
      ${nativeCan("music") ? `<p class="note">A song from your Music library you haven't played in a while. It stays on your iPhone.</p>` : ""}
      <div class="row"><span class="rk">When I'm done with a card</span>
        <div class="seg" role="group" aria-label="When I'm done with a card"><button type="button" data-done-mode="fold" aria-pressed="${m.doneMode !== "hide"}">Fold</button><button type="button" data-done-mode="hide" aria-pressed="${m.doneMode === "hide"}">Hide</button></div></div>
      ${onOff("doneAuto", "Fold by itself once I've seen it", m.doneAuto !== false)}
      <p class="note">Song, scores and On this day each get a Listened or Seen it button. Folded cards wait in one line under This morning; tap one to see it again. Hide takes them away until tomorrow. Everything opens fresh each morning.</p>
      ${onOff("quote", "Quote of the day", m.quote)}
      <div class="field q-from" ${m.quote ? "" : "hidden"}><label for="set-q-from">Quotes from <span class="hint">(a person or a theme)</span></label>
        <div class="mail-pick"><input id="set-q-from" type="text" autocomplete="off" maxlength="50" placeholder="Seneca, stoicism, faith…" value="${esc(m.quoteFrom || "")}"><button class="btn sm" type="button" id="set-q-save">Use</button></div>
        <div class="chips wrap q-picks">${["Stoicism", "Motivation", "Faith", "Leadership", "Poetry", "Carl Jung"].map((t) => `<button class="chip" type="button" data-q-pick="${t}" aria-pressed="${(m.quoteFrom || "").toLowerCase() === t.toLowerCase()}">${t}</button>`).join("")}</div>
        <p class="note">Every quote comes with where it's from, checked against a real source. Carl Jung works without AI; anything else needs AI on.</p></div>
      ${me ? onOff("hockey", "Last night's games", m.hockey) : ""}
      ${me ? `<div class="field"><label for="set-mo-teams">Teams</label><input id="set-mo-teams" type="text" autocomplete="off" autocapitalize="characters" value="${esc(m.teams.join(", "))}"></div>
      <button class="btn" type="button" id="set-mo-teams-save">Save teams</button>
      ${nativeCan("music") ? "" : `<h3 class="sub">Song of the day: your Shortcut</h3>
      ${(() => {
        const got = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
        const key = got("edition.songKey"), err = got("edition.songErr"), last = +got("edition.songLast");
        return `<p class="note">A Shortcut on this iPhone sends one song from your library each morning. Set it up once with these two:</p>
        <p class="note">Address</p><div class="mail-addr"><b id="set-song-url">${esc(ai.relayBase())}/song</b><button class="btn sm" type="button" id="set-song-url-copy">Copy</button></div>
        <p class="note">Song key</p><div class="mail-addr"><b id="set-song-key">${esc(key || (err ? "Not available" : "Open Today once, then come back"))}</b>${key ? `<button class="btn sm" type="button" id="set-song-copy">Copy</button>` : ""}</div>
        ${err ? `<p class="note err">${esc(err)}</p>` : ""}
        <ol class="sg-steps">
          <li>In Shortcuts, tap <b>+</b>. Add <b>Find Music</b>: Filter <b>Play Count</b> is greater than 0, Sort by <b>Last Played</b>, Order <b>Oldest First</b>, Limit on, <b>1</b>.</li>
          <li>Add <b>Get Contents of URL</b>. Paste the address. Tap the arrow to show more: Method <b>POST</b>. Headers: add one, key <b>x-song-key</b>, value: paste the song key. Request Body <b>JSON</b>, with three Text fields: <b>title</b> = Music › Name, <b>artist</b> = Music › Artist, <b>lastPlayed</b> = Music › Last Played Date.</li>
          <li>Tap <b>▶</b> to test. It should show <b>{"ok":true}</b>.</li>
          <li>Automation › <b>+</b> › Time of Day, 6:00 AM, Daily, Run Immediately › this Shortcut.</li>
        </ol>
        <p class="note" id="set-song-last">${last ? `Last song arrived ${esc(new Date(last).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }))}.` : "No song has arrived yet."}</p>`;
      })()}`}` : ""}
      <span class="st" id="set-more-st" role="status"></span>
      </div>` },
    newsletters: { title: "Newsletters", value: sc.on ? "Mon, Fri" : "Off", body: `
      <div class="group">
      <div class="row"><span class="rk">Ask me</span>
        <div class="seg" role="group" aria-label="Ask me"><button type="button" data-school-on="1" aria-pressed="${sc.on}">Mon and Fri</button><button type="button" data-school-on="0" aria-pressed="${!sc.on}">Off</button></div></div>
      <div class="field"><label for="set-sc-school">From <span class="hint">(a school, club or team)</span></label><input id="set-sc-school" type="text" autocomplete="off" placeholder="e.g. Lincoln Middle School" value="${esc(sc.school)}"></div>
      <div class="field"><label for="set-sc-about">What matters to you <span class="hint">(grade, activities, teams)</span></label>
        <textarea id="set-sc-about" rows="3" placeholder="e.g. 8th grade, band, soccer and lacrosse">${esc(sc.about)}</textarea></div>
      <div class="field"><label for="set-sc-child">Child's name <span class="hint">(optional)</span></label><input id="set-sc-child" type="text" autocomplete="off" value="${esc(sc.child)}"></div>
      <p class="note">Names stay on this phone: in the newsletter's text AI sees "your child", and Shoebox puts the name back on the post. Attached flyers and PDFs are read as they are.</p>
      ${me || mailOn ? `<div class="field"><label for="set-sc-words">Words that mark it in email <span class="hint">(sender, district, mascot; commas)</span></label><input id="set-sc-words" type="text" autocomplete="off" value="${esc(sc.words.join(", "))}"></div>` : `<input id="set-sc-words" type="hidden" value="${esc(sc.words.join(", "))}">`}
      <div class="two">
        <button class="btn primary" type="button" id="set-sc-save">Save</button>
        <button class="btn" type="button" id="set-sc-now">Add one now</button>
      </div>
      <span class="st" id="set-sc-st" role="status"></span>
      </div>` },
    email: (me || mailOn || mailPick) && { title: "Email to Shoebox", value: mailOn ? "On" : "Off", body: `
      <div class="group">
      ${(() => {
        let a = "", shared = "";
        try { a = localStorage.getItem("edition.inboxAddress") || ""; shared = localStorage.getItem("edition.inboxShared") || ""; } catch { /* blocked */ }
        if (!a && shared) a = shared;
        const personal = Boolean(mailPick) && Boolean(a) && a !== shared;
        const picker = (label) => `<div class="field"><label for="set-mail-name">${label}</label>
            <div class="mail-pick"><input id="set-mail-name" type="text" autocomplete="given-name" autocapitalize="none" placeholder="graham" maxlength="16"><span>-${me ? "keep" : "····"}@${esc(mailPick)}</span></div></div>
          <button class="btn ${personal ? "ghost" : "primary"} sm" type="button" id="set-mail-make">${personal ? "Change my address" : "Make my address"}</button>`;
        const uses = `<ul class="mail-uses">
            <li><b>Newsletters:</b> sign up with this address, and they come straight here.</li>
            <li><b>School email:</b> add it as a second email in your school's parent app, such as ParentSquare or SchoolMessenger.</li>
            <li><b>Anything else:</b> forward it. Newsletters become short posts, with their flyers and PDFs read too.</li></ul>`;
        if (!a && mailPick) return `<p class="note">Make your own Shoebox address. Only this phone gets its mail. ${me ? "Shoebox Me addresses end in -keep, like graham-keep." : "Pick the first part; four random characters keep it private."}</p>${picker("First part of your address")}`;
        if (!a) return `<p class="note">Forward email to your own Shoebox address. It appears here after Shoebox checks for mail.</p>`;
        return `<p class="note">Your Shoebox address${personal ? ", only for this phone" : ""}:</p>
          <div class="mail-addr"><b id="set-mail-addr">${esc(personal ? a : shared || a)}</b><button class="btn sm" type="button" id="set-mail-copy">Copy</button></div>
          ${uses}
          ${shared && personal ? `<p class="note">Your old address, <b>${esc(shared)}</b>, still works. To move a Gmail forward: Gmail › Settings › Forwarding › Add a forwarding address, paste the address above, and Gmail's confirmation code arrives here as a post.</p>` : ""}
          ${mailPick ? (personal ? `<details class="adv"><summary>Change my address</summary><p class="note">${me ? "Your old address keeps working." : "The old address stops working right away."}</p>${picker("New first part")}</details>` : picker("Make a personal address for this phone")) : ""}`;
      })()}
      <p class="note">Shoebox checks by itself when you open it and every few minutes while it's open.${(() => { try { const t = +localStorage.getItem("edition.inboxChecked"); return t ? ` Last checked ${esc(clock(t))}.` : ""; } catch { return ""; } })()}</p>
      <button class="btn ghost sm" type="button" id="set-mail-check">Check now</button>
      <span class="st" id="set-mail-st" role="status"></span>
      </div>` },
    reminders: { title: "Reminders", value: NATIVE || push.enabled() ? remindLabel() : "Off", body: `
      <div class="group">
        <div class="row"><label class="rk" for="set-rem-time">Remind me at</label><input id="set-rem-time" class="time" type="time" value="${remindTime()}"></div>
        <p class="note">When something you set aside comes back, ${NATIVE ? "your iPhone reminds you" : "you get a reminder"} at this time that day.${NATIVE ? " To stop them, turn off Shoebox in the iPhone's Settings › Notifications." : ""}</p>
        <span class="st" id="set-rem-st" role="status"></span>
      </div>` + (NATIVE ? "" : `
      <div class="group" id="set-push-g">
      <div class="two">
        <button class="btn primary" type="button" id="set-push-on">${push.enabled() ? "Turn off" : "Turn on"}</button>
        <button class="btn" type="button" id="set-push-test" ${push.enabled() ? "" : "disabled"}>Send a test</button>
      </div>
      <span class="st" id="set-push-st" role="status"></span>
      <p class="note">Notifications need permission once${push.needsHomeScreen() ? ". On iPhone, open Shoebox from your Home Screen first" : ""}.</p>
      </div>`) },
    ai: { title: "AI", value: ai.settings.enabled() ? "On" : ai.available() ? "Off" : "iPhone app", body: !ai.available() ? `
      <div class="group">
      <p class="note">${esc(ai.WEB_AI_NOTE)}</p>
      <p class="note">On iPhone, AI writes a line about each thing you save, finds its picture, picks the day's top stories and turns school newsletters into posts.</p>
      <a class="btn" href="beta">Get the iPhone beta</a>
      </div>` : `
      <div class="group">
      <div class="row"><span class="rk">Use AI</span>
        <div class="seg" role="group" aria-label="Use AI">
          <button type="button" data-ai="1" aria-pressed="${ai.settings.consented()}">On</button><button type="button" data-ai="0" aria-pressed="${!ai.settings.consented()}">Off</button></div></div>
      <p class="note">An outside AI service reads what you save to tag it, rank it, find pictures and turn newsletters into posts.</p>
      <details class="adv"><summary>Exactly what's sent</summary><p class="note">${esc(AI_DISCLOSURE)}</p></details>
      ${ai.settings.consented() ? `<div class="row"><span class="rk">Top stories each morning</span>
        <div class="seg" role="group" aria-label="Top stories each morning"><button type="button" data-stories="1" aria-pressed="${storiesAuto()}">On</button><button type="button" data-stories="0" aria-pressed="${!storiesAuto()}">Off</button></div></div>
      <p class="note">A few of the biggest stories in what you follow, picked once a day.</p>` : `<p class="note">Top stories, summaries and school posts start when AI is on.</p>`}
      ${me ? `<p class="note" id="set-ai-use"></p>` : ""}
      <button class="btn ghost sm" type="button" id="set-discover" ${ai.settings.canDiscover() ? "" : "disabled"}>Get more top stories now</button>
      <span class="st" id="set-st" role="status"></span>
      </div>` },
    backup: { title: "Backup or move to a new phone", value: "", body: `
      <div class="group">
      <div class="two">
        <button class="btn" type="button" id="set-export">Export backup</button>
        <button class="btn" type="button" id="set-import">Import backup</button>
      </div>
      ${nativeCan("backup") ? `<p class="note"><b>Every day, by itself:</b> a backup goes to Files › On My iPhone › Shoebox › Backups, with a copy in iCloud Drive › Shoebox › Backups when iCloud Drive is on (the last 7 are kept in each).${(() => { try { return localStorage.getItem("edition.backupICloud") === "0" ? " iCloud Drive looks off for Shoebox: turn it on in the iPhone's Settings › your name › iCloud › Drive." : ""; } catch { return ""; } })()}${(() => { try { const t = +localStorage.getItem("edition.backupAt"); return t ? ` Last one: ${esc(friendlyWhen(t))}.` : ""; } catch { return ""; } })()}</p>` : ""}
      <p class="note">The backup holds everything: items, photos and files, and your settings. Keep it somewhere private. On a new phone, open Shoebox and Import it.</p>
      <input type="file" id="set-import-file" accept="application/json,.json" hidden>
      <span class="st" id="set-bk-st" role="status"></span>
      ${state.items.some((i) => i.sample) ? `<button class="btn" type="button" id="set-samples-clear">Remove the sample items</button>
      <span class="st" id="set-sm-st" role="status"></span>` : ""}
      </div>` },
    learned: { title: "Suggestions and tags", value: `${tagStats(state.items).length} tags`, body: `
      <div class="group">
      <h3 class="sub">What your answers to suggestions taught Shoebox</h3>
      <div id="sug-profile"></div>
      <h3 class="sub" id="set-tags">Tags</h3>
      <div id="tag-list"></div>
      </div>` },
    privacy: { title: "Privacy", value: statsOn() ? "Stats on" : "Stats off", body: `
      <div class="group">
      <div class="row"><span class="rk">Anonymous usage stats</span>
        <div class="seg" role="group" aria-label="Anonymous usage stats"><button type="button" data-stats="1" aria-pressed="${statsOn()}">On</button><button type="button" data-stats="0" aria-pressed="${!statsOn()}">Off</button></div></div>
      <p class="note">Once a day: counts only (how many saves, finished mornings, kinds of problem), never what you saved. It helps make Shoebox better.</p>
      </div>
      <div class="group help-links"><a class="row" href="privacy" target="_blank" rel="noopener"><span class="rk">Read the privacy policy</span>${I.next}</a></div>
      <div class="group"><h3 class="sub">Delete all my data</h3>
        <p class="note">Removes every save, photo, note and setting from this ${NATIVE ? "iPhone" : "device"}, and from Shoebox's server your email address, any mail waiting there and this phone's AI sign-up. It can't be undone.</p>
        <button class="btn erase" type="button" id="set-erase">Delete all my data</button></div>` },
    features: { title: "Things Shoebox can do", value: "", body: featuresBody() },
    help: { title: "Help and feedback", value: realProblems().length ? `${realProblems().length} logged` : "", body: `
      <div class="group help-links">
        <a class="row" href="${supportMail()}"><span class="rk">Email support</span><span class="sv">support@inmyshoebox.com</span></a>
        <a class="row" href="support" target="_blank" rel="noopener"><span class="rk">Questions and answers</span>${I.next}</a>
      </div>
      <div class="group">
      <h3 class="sub">Something wrong?</h3>
      <p class="note" id="set-pr-n"></p>
      <div class="two">
        <button class="btn" type="button" id="set-pr-copy">Copy diagnostics</button>
        <button class="btn" type="button" id="set-pr-clear">Clear</button>
      </div>
      <button class="btn" type="button" id="set-rebuild">Rebuild today</button>
      <span class="st" id="set-ed-st" role="status"></span>
      </div>` },
    usage: me && { title: "Usage (owner)", value: "", body: `<div class="group"><div id="set-usage-box"><p class="note">Loading…</p></div></div>` },
  };
  const close = `<button class="x" type="button" data-close aria-label="Close">${I.close}</button>`;
  let html;
  if (panel && P[panel]) {
    html = `<div class="sheet-head set-head">${fromCard ? "" : `<button class="x" type="button" data-set-back aria-label="All settings">${I.back}</button>`}<h2>${esc(P[panel].title)}</h2>${close}</div>
      ${fromCard && panel === "weather" && morningCache().weather ? `<button class="btn" type="button" id="set-wx-hide">${m.wxSmall ? "Show the full weather card" : "Make the weather card small"}</button>` : ""}
      ${P[panel].body}
      ${fromCard ? `<button class="btn ghost sm set-all" type="button" data-set-back>All settings</button>` : ""}`;
  } else {
    html = `<div class="sheet-head"><h2>Settings</h2>${close}</div>` + SETTINGS_ORDER.map(([label, keys]) => {
      const rows = keys.filter((k) => P[k]).map((k) => `<button class="row set-row" type="button" data-set="${k}"><span class="rk">${esc(P[k].title)}</span><span class="sv">${esc(P[k].value || "")}</span>${I.next}</button>`).join("");
      return rows ? `${label ? `<h3 class="set-h">${esc(label)}</h3>` : ""}<div class="group set-list">${rows}</div>` : "";
    }).join("") + `<p class="version">${APP}${me ? " Me" : ""} ${VERSION}</p>`;
  }
  const wrap = sheet(html, { label: panel && P[panel] ? P[panel].title : "Settings" });
  wrap.querySelectorAll("[data-set]").forEach((b) => b.addEventListener("click", () => openSettings(b.dataset.set)));
  wrap.querySelectorAll("[data-set-back]").forEach((b) => b.addEventListener("click", () => openSettings()));
  $("#set-wx-hide", wrap)?.addEventListener("click", () => { closeSheet(); dayAction(m.wxSmall ? "wx-big" : "wx-small"); });
  if (panel === "usage") showUsage($("#set-usage-box", wrap));

  const st = $("#set-st", wrap);
  const say = (el, msg, err) => affirm(el, msg, err);
  wrap.querySelectorAll("[data-ai]").forEach((b) => b.addEventListener("click", () => {
    const on = b.dataset.ai === "1";
    setAi(on);
    wrap.querySelectorAll("[data-ai]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    if ($("#set-discover", wrap)) $("#set-discover", wrap).disabled = !on;
    say(st, on ? "AI is on." : `AI is off. ${APP} works without it.`);
    const sv = b.closest("details")?.querySelector(".sv"); if (sv) sv.textContent = on ? "On" : "Off";
    render({ top: false });
  }));
  if (me && ai.settings.consented() && ai.settings.device()) {
    ai.usage().then((u) => { const el = $("#set-ai-use", wrap); if (el) el.textContent = `This month: ${u.cents.toFixed(1)}¢ of AI${u.limit ? ` (allowance ${u.limit}¢)` : ""}. Install id: ${u.device}.`; }).catch(() => {});
  }
  renderSuggestProfile(wrap);
  renderTagList(wrap);
  refreshProblems(wrap);
  $("#set-pr-copy", wrap)?.addEventListener("click", copyDiagnostics);
  $("#set-pr-clear", wrap)?.addEventListener("click", () => { clearProblems(); refreshProblems(wrap); });
  if ($("#set-push-on", wrap)) bindPushSettings(wrap);
  if ($("#set-cal-save", wrap)) bindCalendarSettings(wrap);
  if ($("#set-sc-save", wrap)) bindSchoolSettings(wrap);
  wrap.querySelectorAll("[data-mo]").forEach((b) => b.addEventListener("click", () => {
    const [k, on] = b.dataset.mo.split(":");
    setMorningSettings({ ...morningSettings(), [k]: on === "1" });
    if (k === "song" && on === "1" && nativeCan("music")) {
      nativeAsk("music", { op: "pick", ask: true, seed: daily.dayOfYear() }, 60000).then((r) => {
        const c = morningCache();
        if (r.ok) { c.song = nativeSong(r); delete c.songStatus; affirm($("#set-more-st", wrap), `Today's song: ${r.title}.`); }
        else { c.songStatus = r.status; affirm($("#set-more-st", wrap), r.status === "denied" ? "Music access is off. Turn it on in the iPhone's Settings › Shoebox › Media & Apple Music." : "No songs with plays in your Music library yet.", true); }
        c.songTried = true; saveMorningCache(c); render({ top: false });
      }).catch(() => {});
    }
    wrap.querySelectorAll(`[data-mo^="${k}:"]`).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    if (k === "quote") { const f = $(".q-from", wrap); if (f) f.hidden = on !== "1"; if (on === "1" && !morningSettings().quoteFrom) $("#set-q-from", wrap)?.focus(); }
    render({ top: false });
    loadMorning();
  }));
  wrap.querySelectorAll("[data-done-mode]").forEach((b) => b.addEventListener("click", () => {
    setMorningSettings({ ...morningSettings(), doneMode: b.dataset.doneMode });
    wrap.querySelectorAll("[data-done-mode]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    render({ top: false });
  }));
  const useQuoteFrom = (from) => {
    const v = String(from || "").trim().slice(0, 50);
    if (!v) { affirm($("#set-more-st", wrap), "Type a person or a theme.", true); return; }
    setMorningSettings({ ...morningSettings(), quote: true, quoteFrom: v });
    const c = morningCache(); delete c.quotes; delete c.quotesTried; delete c.jungDone; saveMorningCache(c);
    $("#set-q-from", wrap).value = v;
    wrap.querySelectorAll("[data-q-pick]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.qPick.toLowerCase() === v.toLowerCase())));
    affirm($("#set-more-st", wrap), isJung(v) || ai.settings.enabled() ? `Quotes from ${v}, starting today.` : `Saved. Turn on AI in Settings › AI for quotes from ${v}.`);
    render({ top: false });
    loadMorning();
  };
  $("#set-q-save", wrap)?.addEventListener("click", () => useQuoteFrom($("#set-q-from", wrap).value));
  $("#set-q-from", wrap)?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); useQuoteFrom(e.target.value); } });
  wrap.querySelectorAll("[data-q-pick]").forEach((b) => b.addEventListener("click", () => useQuoteFrom(b.dataset.qPick)));
  $("#set-cam-find", wrap)?.addEventListener("click", async (e) => {
    const st2 = $("#set-cam-st", wrap), box = $("#set-cam-picks", wrap), place = placeOf(morningSettings()), label = e.target.textContent;
    const waitBox = (html, err = false) => { box.innerHTML = `<div class="cam-wait${err ? " err" : ""}" role="status">${err ? "" : '<span class="spin" aria-hidden="true"></span>'}<span>${html}</span></div>`; box.scrollIntoView({ block: "nearest", behavior: reduced() ? "auto" : "smooth" }); };
    e.target.disabled = true; e.target.textContent = "Looking…"; say(st2, "");
    waitBox(`Looking for live cameras near ${esc(place.name)}. The first look for a town can take a minute.`);
    const done = () => { e.target.disabled = false; e.target.textContent = label; };
    try {
      const cams = await ai.findCams(place.name);
      track("cams_found");
      done();
      if (!cams.length) { waitBox(`Couldn't find a live camera near ${esc(place.name)} that works. Keep the radar, or paste one you know.`, true); return; }
      box.innerHTML = cams.map((c, k) => `<button type="button" class="cam-pick" data-cam="${k}"><img alt="" src="${esc(c.thumb)}" referrerpolicy="no-referrer" onerror="this.closest('.cam-pick').remove()">
        <span><b>${esc(c.title)}</b>${c.where ? `<i>${esc(c.where)}</i>` : ""}<em>${c.kind === "youtube" ? "Live video" : "Webcam picture"}</em></span></button>`).join("")
        + `<button type="button" class="cam-pick radar" data-cam="radar"><span><b>Weather radar</b><em>No camera</em></span></button>`;
      box.querySelectorAll("[data-cam]").forEach((b) => b.addEventListener("click", () => {
        const c = b.dataset.cam === "radar" ? null : cams[+b.dataset.cam];
        setMorningSettings({ ...morningSettings(), cam: c ? c.url : "" });
        $("#set-mo-cam", wrap).value = c ? c.url : "";
        box.querySelectorAll("[data-cam]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        affirm(st2, c ? `Your weather card now shows ${c.title}.` : "Your weather card shows the radar.");
        render({ top: false });
      }));
    } catch (err) { done(); waitBox(esc(err.message || "Couldn't look right now. Try again in a bit."), true); }
  });
  $("#set-mo-save", wrap)?.addEventListener("click", async () => {
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
  $("#set-study-save", wrap)?.addEventListener("click", () => {
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
  $("#set-song-url-copy", wrap)?.addEventListener("click", async () => {
    const st2 = $("#set-more-st", wrap);
    try { await navigator.clipboard.writeText($("#set-song-url", wrap).textContent); say(st2, "Address copied."); } catch { say(st2, "Couldn't copy; select it and copy."); }
  });
  wrap.querySelectorAll("[data-stories]").forEach((b) => b.addEventListener("click", () => {
    setFlag("edition.storiesAuto", b.dataset.stories === "1");
    wrap.querySelectorAll("[data-stories]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
  $("#set-rem-time", wrap)?.addEventListener("change", async (ev) => {
    const t = ev.target.value;
    if (!/^\d{2}:\d{2}$/.test(t)) return;
    try { localStorage.setItem("edition.remindTime", t); } catch { /* storage blocked */ }
    // Reminders already waiting move to the new time.
    const waiting = state.items.filter((i) => i.status === STATUS.ASIDE && i.until && i.reminder);
    for (const it of waiting) { dropReminder(it); await scheduleReminder(byId(it.id)); }
    say($("#set-rem-st", wrap), `Reminders come at ${remindLabel(t)}${waiting.length ? `; ${waiting.length} moved` : ""}.`);
  });
  wrap.querySelectorAll("[data-stats]").forEach((b) => b.addEventListener("click", () => {
    setStatsOn(b.dataset.stats === "1");
    wrap.querySelectorAll("[data-stats]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
  $("#set-usage", wrap)?.addEventListener("toggle", (ev) => { if (ev.currentTarget.open) showUsage($("#set-usage-box", wrap)); });
  $("#set-mail-check", wrap)?.addEventListener("click", () => checkInbox({ statusEl: $("#set-mail-st", wrap) }));
  $("#set-mail-copy", wrap)?.addEventListener("click", async () => {
    const a = $("#set-mail-addr", wrap)?.textContent || "";
    try { await navigator.clipboard.writeText(a); toast("Address copied."); } catch { say($("#set-mail-st", wrap), a); }
  });
  $("#set-mail-make", wrap)?.addEventListener("click", async (e) => {
    const st = $("#set-mail-st", wrap), name = $("#set-mail-name", wrap)?.value.trim() || "";
    if (!name) { say(st, "Type a first part, like your first name.", true); $("#set-mail-name", wrap)?.focus(); return; }
    e.target.disabled = true; say(st, "Making your address…");
    try {
      const res = await withTimeout(fetch(`${ai.relayBase()}/inbox/address`, { method: "POST", headers: { "x-inbox-key": inboxKey(), "content-type": "application/json", ...staffHeaders() }, body: JSON.stringify({ name }) }), 15000);
      const d = await res.json();
      if (!res.ok || !d.address) throw new Error(d?.error?.message || "No address came back.");
      localStorage.setItem("edition.inboxAddress", d.address);
      track("inbox_address");
      openSettings("email");
      toast(`Your address: ${d.address}`);
    } catch (err) { say(st, err.message || "Couldn't reach the relay.", true); e.target.disabled = false; }
  });
  const edSt = $("#set-ed-st", wrap);
  wrap.querySelectorAll("[data-feat]").forEach((b) => b.addEventListener("click", () => showFeature(b.dataset.feat)));
  $("#set-replay", wrap)?.addEventListener("click", () => {
    [ONBOARDED, SHARE_OFF, PINNED, "edition.searched"].forEach((k) => setFlag(k, false));
    coach.reset();
    state.heroSpot = false;
    track("onboard_replay");
    closeSheet();
    state.tab = "today";
    render({ top: true });
  });
  $("#set-rebuild", wrap)?.addEventListener("click", async () => {
    say(edSt, ai.settings.enabled() ? "Ranking your queue…" : "Rebuilding…");
    try {
      await ensureEdition({ force: true });
      closeSheet(); render(); toast("Today is rebuilt.");
    } catch (e) { say(edSt, e.message || "Could not rebuild.", true); }
  });
  $("#set-discover", wrap)?.addEventListener("click", () => findNew(st).then((n) => { refreshProblems(wrap); if (n) render(); }));
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
  if ($("#set-me-choose", wrap)) bindAvatarSettings(wrap);
  $("#set-erase", wrap)?.addEventListener("click", () => confirmErase());
  wrap.querySelectorAll("[data-palette]").forEach((b) => b.addEventListener("click", () => {
    setPalette(b.dataset.palette);
    wrap.querySelectorAll("[data-palette]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
  wrap.querySelectorAll("[data-look]").forEach((b) => b.addEventListener("click", () => {
    setThemeChoice(b.dataset.look);
    wrap.querySelectorAll("[data-look]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
  wrap.querySelectorAll("[data-sound]").forEach((b) => b.addEventListener("click", () => {
    setSound(b.dataset.sound === "1");
    wrap.querySelectorAll("[data-sound]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    if (soundOn()) { unlock(); tick(true); }
  }));
  $("#set-export", wrap)?.addEventListener("click", async () => {
    const blob = new Blob([await db.exportJson()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `shoebox-backup-${dayKey()}.json`;
    a.click();
    affirm($("#set-bk-st", wrap), NATIVE ? "Backup made. Choose where to keep it." : "Backup saved to your downloads.");
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  const importInput = $("#set-import-file", wrap);
  $("#set-import", wrap)?.addEventListener("click", () => importInput.click());
  importInput?.addEventListener("change", async () => {
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
  openSettings("learned");
  const t = $("#set-tags");
  if (t) t.scrollIntoView({ block: "start" });
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
  const real = realProblems(), last = real[real.length - 1], net = problems.length - real.length;
  n.textContent = real.length
    ? `${real.length} logged on this phone. Latest: ${last.where}: ${last.msg}`
    : net ? "Nothing wrong. A few things waited for a better connection." : "Nothing logged.";
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
  endSpot(false);
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
  if (foot) {
    panel.appendChild(foot);
    // A footer can hide what's below; when there is more, say so and let a tap scroll to it.
    const hint = document.createElement("button");
    hint.type = "button"; hint.className = "more-hint"; hint.setAttribute("aria-label", "More below");
    hint.innerHTML = `<span>More below</span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;
    hint.addEventListener("click", () => body.scrollBy({ top: body.clientHeight * 0.7, behavior: reduced() ? "auto" : "smooth" }));
    foot.prepend(hint);
    const check = () => panel.classList.toggle("more-below", body.scrollTop + body.clientHeight < body.scrollHeight - 12);
    body.addEventListener("scroll", check, { passive: true });
    new MutationObserver(() => requestAnimationFrame(check)).observe(body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "style", "class"] });
    new ResizeObserver(check).observe(body);
    requestAnimationFrame(check);
  }
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
  if (state.staleToday && state.tab === "today" && !$(".reader")) { state.staleToday = false; render({ top: false }); }
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

/*
 * Every change in a sheet answers back: the status line under it lights up
 * with a check, the button that did it reads "Saved" for a moment, and the
 * phone gives a light tap. Errors stay red with no tap; "…" means working.
 */
let lastSheetButton = null;
document.addEventListener("click", (e) => {
  const b = e.target.closest?.(".sheet button");
  if (!b) return;
  lastSheetButton = b;
  if (b.closest(".seg") && b.getAttribute("aria-pressed") !== "true") { buzz(5); toNative({ type: "haptic" }); } // a switch moved: a light tap
}, true);
function affirm(el, msg, err = false) {
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("err", !!err);
  el.classList.remove("ok");
  if (err || !msg || /…$/.test(msg)) return;
  void el.offsetWidth;
  el.classList.add("ok");
  buzz(8);
  toNative({ type: "haptic" });
  const b = lastSheetButton;
  if (b && b.isConnected && b.classList.contains("btn") && b.closest(".sheet") === el.closest(".sheet") && !b.closest(".seg") && !b._flash) {
    const html = b.innerHTML;
    b._flash = true;
    b.classList.add("flash");
    b.innerHTML = `${I.done}<span>${/save/i.test(b.textContent) ? "Saved" : "Done"}</span>`;
    setTimeout(() => { if (b.isConnected) { b.innerHTML = html; b.classList.remove("flash"); } b._flash = false; }, 1600);
  }
  el.scrollIntoView?.({ block: "nearest", behavior: reduced() ? "auto" : "smooth" });
}

function toast(msg, { action, onAction, onExpire, high = false, sticky = false } = {}) {
  expireToast();
  clearTimeout(toastTimer);
  const el = document.createElement("div");
  el.className = "toast" + (high || state.reader ? " high" : "");
  // The very first message sits a third of the way down, where the eye already is; the rest a little below the middle.
  if (!flag("edition.toastSeen")) { el.classList.add("first"); setFlag("edition.toastSeen", true); }
  el.setAttribute("role", "status");
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action)}</button>` : ""}`;
  el._onExpire = onExpire || null;
  if (action) $("button", el).addEventListener("click", () => { el._onExpire = null; el.remove(); onAction && onAction(); });
  document.body.appendChild(el);
  // Long enough to read at a glance (about 1.2 s plus 55 ms a letter: 2 to 4.5 s), plus 1.5 s to reach Undo
  // when there is one (5 s at most). Held while a finger or the keyboard is on it; a tap on the words closes it.
  const ms = Math.min(action ? 5000 : 4500, Math.max(2000, 1200 + 55 * String(msg).length) + (action ? 1500 : 0));
  const arm = () => { clearTimeout(toastTimer); if (!sticky) toastTimer = setTimeout(() => expireToast(el), ms); };
  $("span", el)?.addEventListener("click", () => { clearTimeout(toastTimer); expireToast(el); });
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
    if (document.visibilityState === "hidden") {
      const t = $(".toast"); if (t && t._onExpire) expireToast(t);
      for (const key of Object.keys(state.foldSeen || {})) if (autoFold(key)) state.foldedAway = true;
      state.foldSeen = {};
      return;
    }
    if (state.songOpened) { state.songOpened = false; if (autoFold("song")) state.foldedAway = true; }
    if (state.foldedAway) { state.foldedAway = false; if (state.tab === "today" && !state.reader && !$(".sheet-wrap")) render({ top: false }); else state.staleToday = true; }
    if (document.visibilityState !== "visible") return;
    const before = state.items.length;
    const day = state.edition && state.edition.date;
    await importShares();
    const woke = await wakeDue();
    refreshCalendar();
    loadMorning();
    checkInbox();
    maybeAskSong();
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
