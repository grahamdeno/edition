/*
 * Edition app shell.
 *
 * Two screens:
 *   Front page  today's edition laid out like a front page (lead, two-up,
 *               rows), a time filter, the themes you keep circling and the
 *               queue items that have waited longest. It scrolls.
 *   Reader      full screen, one item at a time, like stories. Swipe for the
 *               next or previous item; the verdict pill sits in the bottom
 *               right corner and dims after a few idle seconds.
 * Everything else (Add, Library, Settings) is a sheet from the corner button.
 *
 * Rendering is plain template strings; every value from an item goes through
 * esc(). Icons come from icons.js only.
 */

import {
  VERDICT, STATUS, KIND, dayKey, applyVerdict, restore, buildEdition, editionView,
  interestProfile, estimateMinutes, counts, migrateLegacy, createItem, EDITION_SIZE,
  detectText, draftFromFile, describeDraft, fitToTime, circling, fading, isFaded, FADE_DAYS, youtubeId,
  SUGGESTIONS_PER_DAY, WHY_NOT, WHY_NOT_LABEL, emptySuggestProfile, learnFromSuggestion, suggestionGuide,
  screenSuggestions, suggestMaxMinutes,
} from "./model.js";
import * as db from "./db.js";
import { captureText, captureFile, captureTransfer, readClipboard, captureShares } from "./capture.js";
import { sampleItems, SAMPLES_VERSION } from "./samples.js";
import * as ai from "./ai.js";
import { tick, unlock, soundOn, setSound } from "./feel.js";
import { I } from "./icons.js";
import { problems, noteError as logError, onFirstProblem, clearProblems, formatProblem } from "./problems.js";

export const VERSION = "3.7.1";
const noteError = (e, opts = {}) => logError(e, { ...opts, version: VERSION });

const KIND_LABEL = { link: "Link", note: "Note", quote: "Quote", photo: "Photo", pdf: "PDF", text: "Text", video: "Video", audio: "Audio", file: "File" };
const TIME = [
  { label: "All", min: 0 },
  { label: "I have 10 min", min: 10 },
  { label: "30 min", min: 30 },
  { label: "An evening", min: 120 },
];
const LIB_FILTERS = [
  { label: "Queue", id: STATUS.QUEUED },
  { label: "Inbox", id: STATUS.INBOX },
  { label: "Done", id: STATUS.DONE },
  { label: "Let go", id: STATUS.ARCHIVED },
  { label: "All", id: "all" },
];
const IDLE_MS = 3000;

const state = {
  items: [],
  edition: null,
  time: 0,
  capText: "",
  capFiles: [],
  libFilter: 4,
  libQuery: "",
  enriching: new Set(),
  reader: null,      // { mode: "edition" | "inbox" | "single", ids: [], index }
  feed: null,        // { ids: [], index, total, turned: Set, tally }
  suggest: null,     // what your answers to suggestions taught (see model.js)
  capWhy: "",
};

const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");
const urls = new Map(); // blob id -> object URL

/* ================= Boot ================= */

async function boot() {
  const migrated = await db.migrateFromLocalStorage(migrateLegacy).catch(() => 0);
  state.items = await db.items.all();
  state.edition = await db.meta.get("edition", null);
  state.suggest = await db.meta.get("suggest", null) || emptySuggestProfile();
  const seeded = await seedSamples();
  const shared = await importShares();
  const linked = await importFromUrl();
  await ensureEdition();
  renderFront();
  if (migrated) toast(`Brought over ${migrated} saved item${migrated === 1 ? "" : "s"} from the old version.`);
  else if (seeded) toast(`Loaded ${seeded} sample items. Remove them in Settings.`);
  wireGlobal();
  openFeed(); // new saves (including anything just shared) come first in the feed
  startCoin();
  enrichPending();
  registerWorker();
}

/*
 * Updates, as in Tabs. When a new release has been saved in the background,
 * offer to switch to it now ("Update ready · Reload"); otherwise it's used on
 * the next launch. Coming back to the app checks for a release too, since an
 * installed app that's only resumed never reloads the page.
 */
function registerWorker() {
  if (!("serviceWorker" in navigator)) return;
  const hadWorker = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadWorker) toast("Update ready", { action: "Reload", onAction: () => location.reload(), sticky: true });
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
  const rest = state.items.filter((i) => !inEdition.has(i.id) && !(hasSuggestion && i.suggested));
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
  // New saves show up in the feed right where you are.
  if (state.feed) {
    const f = state.feed;
    f.ids.splice(f.index, 0, ...list.map((i) => i.id));
    f.total += list.length;
  }
  tick(true);
  refresh();
  toast(`Saved ${list.length === 1 ? "1 item" : list.length + " items"} to your inbox.`, {
    action: "Undo",
    onAction: async () => { await removeItems(list); refresh(); },
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

let enrichRunning = false;
async function enrichPending() {
  if (enrichRunning || !ai.settings.enabled()) return;
  enrichRunning = true;
  try {
    for (;;) {
      const next = state.items.find((i) => !i.enrichedAt && (i.enrichTries || 0) < 2 && (i.status === STATUS.INBOX || i.status === STATUS.QUEUED));
      if (!next) break;
      state.enriching.add(next.id);
      try {
        const blob = next.blobId && [KIND.PHOTO, KIND.PDF, KIND.TEXT].includes(next.kind) ? await db.blobs.get(next.blobId) : null;
        const out = await ai.enrich(next, blob);
        const cur = byId(next.id);
        if (cur) {
          const upd = {
            ...cur,
            title: cur.editedAt ? cur.title : out.title || cur.title,
            summary: out.summary || cur.summary,
            tags: out.tags.length ? out.tags : cur.tags,
            minutes: out.minutes || cur.minutes,
            intent: out.intent || cur.intent,
            points: out.points.length ? out.points : cur.points,
            transcript: out.transcript || cur.transcript,
            enrichedAt: Date.now(),
          };
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
        if (cur) await saveItem({ ...cur, enrichTries: (cur.enrichTries || 0) + 1 });
        if (e.status === 401 || e.message === "No API key set.") { toast(e.message); break; }
      } finally {
        state.enriching.delete(next.id);
        // Refresh the story only if it is the one on screen, so reading is never interrupted.
        if (state.reader && state.reader.ids[state.reader.index] === next.id) renderStory();
        if (state.feed && state.feed.ids[state.feed.index] === next.id && !feedDrag) renderFeed();
      }
    }
  } finally {
    enrichRunning = false;
    if (!state.reader && !$(".sheet-wrap")) renderFront();
  }
}

async function findNew(statusEl) {
  const set = (msg, err) => { if (statusEl) { statusEl.textContent = msg; statusEl.classList.toggle("err", !!err); } };
  if (!ai.settings.canDiscover()) { set("Add a Perplexity or Anthropic key in Settings first.", true); return; }
  set(ai.settings.pplxEnabled() ? "Searching Perplexity for something worth your time…" : "Searching for something worth your time…");
  try {
    const known = new Set(state.items.map((i) => i.url).filter(Boolean));
    const picks = await ai.discover(interestProfile(state.items), { known, guide: suggestionGuide(state.suggest) });
    const fresh = screenSuggestions(picks.filter((p) => !known.has(p.url)), state.suggest);
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
    if (fresh.length) { closeSheet(); renderFront(); }
  } catch (e) {
    noteError(e, { quiet: true, where: ai.settings.pplxEnabled() ? "discover (Perplexity)" : "discover (Claude)" });
    set(e.message || "Search failed.", true);
  }
}

/* ================= Front page ================= */

function refresh() {
  if (state.reader) renderStory();
  if (state.feed) renderFeed();
  renderFront();
}

function renderFront() {
  topUpEdition();
  const scrollTop = $(".front")?.scrollTop || 0;
  const v = editionView(state.items, state.edition);
  const c = counts(state.items);
  const open = v.open;
  const fit = fitToTime(open, TIME[state.time].min);
  const left = open.length - fit.length;
  const minutes = open.reduce((s, p) => s + estimateMinutes(p), 0);

  let paper = "";
  if (fit.length) {
    const [lead, ...rest] = fit;
    paper = leadStory(lead)
      + (rest.length ? `<div class="pair">${rest.slice(0, 2).map(miniStory).join("")}</div>` : "")
      + (rest.length > 2 ? `<div class="rows">${rest.slice(2).map(rowStory).join("")}</div>` : "")
      + (left ? `<p class="more-note">${left} more when you have longer.</p>` : "");
  } else if (open.length) {
    paper = `<div class="empty-front"><h2>Nothing that short.</h2><p>Everything left today takes longer than ${TIME[state.time].min} minutes.</p>
      <button class="pill-btn ghost" type="button" data-time="0">Show all</button></div>`;
  } else if (v.total) {
    const done = v.pages.filter((p) => p.status === STATUS.DONE).length;
    const gone = v.pages.filter((p) => p.status === STATUS.ARCHIVED).length;
    paper = `<div class="empty-front"><h2>You're done.</h2>
      <p>${done} read, ${gone} let go, ${v.total - done - gone} moved later. Tomorrow's edition is set in the morning.</p>
      ${c.queued ? `<button class="pill-btn ghost" type="button" data-act="one-more">Read one more</button>` : ""}
      ${ai.settings.canDiscover() ? `<button class="pill-btn ghost" type="button" data-act="discover">Find something new</button><span class="st" id="discover-st" role="status"></span>` : ""}</div>`;
  } else {
    paper = `<div class="empty-front"><h2>${c.inbox ? "Sort your inbox first." : "Nothing here yet."}</h2>
      <p>${c.inbox ? "The saves you keep come back here as today's edition." : "Save a link, a thought, a photo or a file. It goes to your inbox first, then comes back here."}</p>
      ${c.inbox ? `<button class="pill-btn" type="button" data-act="sort">Sort ${c.inbox} new</button>` : `<button class="pill-btn" type="button" data-act="add">Add something</button>`}</div>`;
  }

  const themes = circling(state.items);
  const maxCount = Math.max(1, ...themes.map((t) => t.count));
  const risingTheme = themes.find((t) => t.rising);
  const waiting = fading(state.items, state.edition);

  app.innerHTML = `<main class="front" id="front">
    <div class="mast">
      <span class="label">${esc(dateLabel())}</span>
      <span class="label accent">${open.length ? `${open.length} item${open.length === 1 ? "" : "s"} · ${minutes} min` : v.total ? "Done for today" : ""}</span>
    </div>
    <header class="masthead">
      <h1>The Edition</h1>
      <p>Today's front page, built from your saves. Finish it and you're done.</p>
      <button class="pill-btn feed-btn" type="button" data-act="feed">${I.read}Back to the feed</button>
    </header>
    ${c.inbox ? `<button class="banner" type="button" data-act="sort"><span class="dot"></span><span class="t">${c.inbox} new save${c.inbox === 1 ? "" : "s"} to sort</span>${I.next}</button>` : ""}
    ${open.length > 1 ? `<div class="chips" role="group" aria-label="Time you have">${TIME.map((t, i) => `<button class="chip" type="button" data-time="${i}" aria-pressed="${state.time === i}">${t.label}</button>`).join("")}</div>` : ""}
    ${paper}
    ${v.total ? `<div class="progress"><div class="bar"><span style="width:${Math.round((v.settled / v.total) * 100)}%"></span></div><span class="n">${v.settled} of ${v.total} read</span></div>` : ""}
    ${themes.length >= 2 ? `<section class="sec">
      <span class="label">Circling</span>
      <h2>What you've been circling</h2>
      <div class="bubbles">${themes.map((t, i) => {
        const d = Math.round(64 + 50 * (t.count / maxCount));
        return `<button class="bubble t${i}" type="button" data-theme="${esc(t.tag)}" style="width:${d}px;height:${d}px"><b>${esc(cap(t.tag))}</b><span>${t.count}</span></button>`;
      }).join("")}</div>
      ${risingTheme ? `<p class="rising"><b>${esc(cap(risingTheme.tag))}</b> keeps coming up in the last two weeks.</p>` : ""}
    </section>` : ""}
    ${waiting.length ? `<section class="sec">
      <span class="label">Tideline</span>
      <h2>Fading</h2>
      <p class="rising">Untouched for ${FADE_DAYS / 7} weeks, a save fades out of your editions. It waits here until you decide.</p>
      ${tideHtml(waiting)}
    </section>` : ""}
  </main>
  <div class="corner" id="corner">
    <button class="fab" type="button" id="fab" aria-label="Menu: tap, or hold and slide" aria-expanded="${ringEl ? "true" : "false"}">${I.plus}</button>
  </div>`;
  const front = $("#front");
  front.scrollTop = scrollTop;
  hydrate(front);
  bindFront();
}

/** Tideline rows: faded saves wait for Keep or Let go; ones close to fading offer Read today. */
function tideHtml(waiting) {
  return `<div class="tide">${waiting.map(({ item, left, faded }) => `<div class="tide-row ${faded ? "faded" : ""}">
    <span class="bar" style="opacity:${faded ? 0.18 : Math.max(0.3, left / 7).toFixed(2)}"></span>
    <button class="txt" type="button" data-open="${esc(item.id)}"><span class="t">${esc(headline(item))}</span>
      <span class="s">${faded ? "Faded. Your call." : `Fades in ${left} day${left === 1 ? "" : "s"}`}</span></button>
    ${faded
      ? `<button class="rescue ghost" type="button" data-letgo="${esc(item.id)}">Let go</button><button class="rescue" type="button" data-keep="${esc(item.id)}">Keep</button>`
      : `<button class="rescue" type="button" data-rescue="${esc(item.id)}">Read today</button>`}</div>`).join("")}</div>`;
}

function bindTide(root, rerender) {
  root.querySelectorAll("[data-rescue]").forEach((b) => b.addEventListener("click", async () => {
    await addToEdition(b.dataset.rescue);
    tick(true);
    rerender();
    toast("Added to today's edition.");
  }));
  root.querySelectorAll("[data-keep]").forEach((b) => b.addEventListener("click", async () => {
    const before = byId(b.dataset.keep);
    await saveItem(restore(before));
    tick(true);
    rerender();
    toast("Kept. Back in your queue for three more weeks.", { action: "Undo", onAction: async () => { await saveItem(before); rerender(); } });
  }));
  root.querySelectorAll("[data-letgo]").forEach((b) => b.addEventListener("click", async () => {
    const before = byId(b.dataset.letgo);
    await saveItem(applyVerdict(before, VERDICT.LET_GO, { stage: "edition" }));
    tick(true);
    rerender();
    toast("Let go.", { action: "Undo", onAction: async () => { await saveItem(before); rerender(); } });
  }));
}

function leadStory(item) {
  const pic = picFor(item);
  return `<button class="lead" type="button" data-read="${esc(item.id)}">
    ${pic ? `<div class="pic">${pic}</div>` : ""}
    <span class="kicker">Lead · ${esc(KIND_LABEL[item.kind] || "Item")} · saved ${esc(ago(item.created))}</span>
    <h2>${esc(headline(item))}</h2>
    ${item.ai?.why || item.summary ? `<p class="why">${esc(item.ai?.why || item.summary)}</p>` : ""}
  </button>`;
}

function miniStory(item) {
  return `<button class="mini" type="button" data-read="${esc(item.id)}">
    <span class="kicker">${esc(KIND_LABEL[item.kind] || "Item")} · ${estimateMinutes(item)} min</span>
    <h3>${esc(headline(item))}</h3></button>`;
}

function rowStory(item) {
  return `<button class="rowlink" type="button" data-read="${esc(item.id)}"><span class="t">${esc(headline(item))}</span><span class="m">${estimateMinutes(item)} min</span></button>`;
}

/** What to show as a headline: a quote or note shows its own words. */
function headline(item) {
  if ((item.kind === KIND.QUOTE || item.kind === KIND.NOTE) && item.text) {
    const t = item.text.trim();
    return item.kind === KIND.QUOTE ? `“${t.length > 140 ? t.slice(0, 137) + "…" : t}”` : t.length > 140 ? t.slice(0, 137) + "…" : t;
  }
  return item.title;
}

function picFor(item) {
  const gone = `onerror="this.closest('.pic')?.remove()"`;
  if (item.kind === KIND.PHOTO) {
    if (item.blobId) return `<img alt="" ${gone} data-blob="${esc(item.thumbId || item.blobId)}">`;
    if (item.imageUrl) return `<img alt="" ${gone} src="${esc(item.imageUrl)}" loading="lazy">`;
  }
  if (item.kind === KIND.VIDEO && item.imageUrl) return `<img alt="" ${gone} src="${esc(item.imageUrl)}" loading="lazy"><span class="play">${I.play}</span>`;
  return "";
}

function bindFront() {
  const front = $("#front");
  front.querySelectorAll("[data-read]").forEach((b) => b.addEventListener("click", () => openStories("edition", b.dataset.read)));
  front.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openStories("single", b.dataset.open)));
  front.querySelectorAll("[data-time]").forEach((b) => b.addEventListener("click", () => { state.time = +b.dataset.time; renderFront(); }));
  front.querySelectorAll("[data-theme]").forEach((b) => b.addEventListener("click", () => { state.libQuery = b.dataset.theme; state.libFilter = 4; openLibrary(); }));
  bindTide(front, renderFront);
  const more = $('[data-act="one-more"]', front);
  if (more) more.addEventListener("click", oneMore);
  const disc = $('[data-act="discover"]', front);
  if (disc) disc.addEventListener("click", () => { disc.disabled = true; findNew($("#discover-st")).finally(() => { disc.disabled = false; }); });
  app.querySelectorAll('[data-act="sort"]').forEach((b) => b.addEventListener("click", () => { closeMenu(); openStories("inbox"); }));
  app.querySelectorAll('[data-act="add"]').forEach((b) => b.addEventListener("click", () => { closeMenu(); openAdd(); }));
  app.querySelectorAll('[data-act="library"]').forEach((b) => b.addEventListener("click", () => { closeMenu(); state.libQuery = ""; openLibrary(); }));
  app.querySelectorAll('[data-act="settings"]').forEach((b) => b.addEventListener("click", () => { closeMenu(); openSettings(); }));
  app.querySelectorAll('[data-act="front"]').forEach((b) => b.addEventListener("click", () => { closeMenu(); closeFeed(); }));
  app.querySelectorAll('[data-act="feed"]').forEach((b) => b.addEventListener("click", () => { closeMenu(); openFeed(); }));

  // The corner button: tap for the ring, or hold and slide; it dims while you scroll and after a few idle seconds.
  bindFab($("#fab"));
  front.addEventListener("scroll", () => { if (!ringEl) sleepCorner(); }, { passive: true });
  wakeCorner();
}

/*
 * The + button catches the light now and then, like a coin spinning to a stop
 * on a counter: once on launch, then every six seconds while the front page is
 * open. It brightens for the spin without resetting the corner's sleep, so the
 * menu still dims between spins. Skipped with reduced motion or a hidden page.
 */
const COIN_EVERY_MS = 6000;
let coinTimer = 0;
function spinCoin() {
  const fab = $("#fab"), corner = $("#corner");
  if (!fab || state.reader || $(".sheet-wrap") || ringEl) return;
  if (document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  fab.classList.remove("spin");
  void fab.offsetWidth; // restart the animation
  fab.classList.add("spin");
  corner.classList.add("glinting");
  fab.addEventListener("animationend", () => { fab.classList.remove("spin"); corner.classList.remove("glinting"); }, { once: true });
}
function startCoin() {
  clearInterval(coinTimer);
  setTimeout(spinCoin, 900);
  coinTimer = setInterval(spinCoin, COIN_EVERY_MS);
}

let cornerTimer = 0;
function wakeCorner() {
  const corner = $("#corner");
  if (!corner) return;
  corner.classList.remove("asleep");
  clearTimeout(cornerTimer);
  cornerTimer = setTimeout(sleepCorner, IDLE_MS);
}
function sleepCorner() {
  const corner = $("#corner");
  if (corner && !ringEl) corner.classList.add("asleep");
}
/*
 * The + ring, as on Tabs' Play button. Tap + and a ring of controls opens
 * around it: tap one. Or hold + and slide your thumb to one and let go.
 * Inner arc: what you can do with the card on screen (Read, Done, Keep or
 * Later, Let go). Outer arc: Add, Search, Front page or Feed, Settings.
 * Both arcs run from straight left of + to straight up, where a right thumb reaches.
 */
const RING_HOLD_MS = 400;
const RING_R = [140, 226];
const RING_FROM = 196; // degrees: just above straight left, so the lowest controls clear the bottom edge
let ringEl = null;

function ringItems() {
  const f = state.feed;
  const id = f && !state.reader ? f.ids[f.index] : null;
  const item = id && byId(id);
  const inner = [];
  if (item) {
    const keep = item.status === STATUS.INBOX || isFaded(item);
    // Listed left to up: Read sits straight up, nearest the thumb's natural sweep.
    inner.push(
      { id: "letgo", label: item.suggested ? "Not for me" : "Let go", icon: I.letGo, run: () => feedVerdict(id, VERDICT.LET_GO) },
      { id: "later", label: keep ? "Keep" : "Later", icon: keep ? I.keep : I.later, run: () => feedVerdict(id, VERDICT.LATER) },
      { id: "done", label: "Done", icon: I.done, run: () => feedVerdict(id, VERDICT.DONE) },
      { id: "read", label: "Read", icon: I.read, primary: true, run: () => openStories("single", id) },
    );
  }
  const outer = [
    { id: "settings", label: "Settings", icon: I.settings, run: openSettings },
    { id: "library", label: "Search", icon: I.search, run: () => { state.libQuery = ""; openLibrary(); } },
    f ? { id: "front", label: "Front page", icon: I.edition, run: closeFeed } : { id: "feed", label: "Feed", icon: I.read, run: openFeed },
    { id: "add", label: "Add", icon: I.plus, primary: !item, run: openAdd },
  ];
  if (item) outer.splice(1, 0, { id: "edit", label: "Edit", icon: I.edit, run: () => openEdit(id) });
  return inner.length ? [inner, outer] : [outer];
}

function openRing(live) {
  closeRing(true);
  const fab = $("#fab");
  if (!fab) return;
  $(".toast")?.remove(); // nothing sits over the ring
  wakeCorner();
  const r = fab.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const arcs = ringItems();
  const all = arcs.flat();
  let buttons = "";
  arcs.forEach((list, ai) => list.forEach((it, k) => {
    const deg = RING_FROM + (list.length === 1 ? 270 - RING_FROM : ((270 - RING_FROM) * k) / (list.length - 1));
    const a = (deg * Math.PI) / 180, rad = RING_R[ai];
    // Inner arc: labels sit inside the arc, toward +, where there's room. Outer arc: under each control.
    const lab = ai === 0
      ? `<span class="in" style="left:calc(50% + ${(-Math.cos(a) * 46).toFixed(1)}px);top:calc(50% + ${(-Math.sin(a) * 46).toFixed(1)}px)">${esc(it.label)}</span>`
      : `<span>${esc(it.label)}</span>`;
    buttons += `<button class="ri${it.primary ? " primary" : ""}" type="button" data-r="${it.id}" aria-label="${esc(it.label)}" style="left:${(cx + rad * Math.cos(a)).toFixed(1)}px;top:${(cy + rad * Math.sin(a)).toFixed(1)}px">${it.icon}${lab}</button>`;
  }));
  const el = document.createElement("div");
  el.className = "ringx";
  el.dataset.live = live ? "1" : "0";
  el.setAttribute("role", "menu");
  el.innerHTML = `<div class="ring-bg ${arcs.length > 1 ? "wide" : ""}" style="left:${cx}px;top:${cy}px"></div>${buttons}`;
  document.body.appendChild(el);
  ringEl = el;
  fab.setAttribute("aria-expanded", "true");
  $("#corner")?.classList.add("open");
  requestAnimationFrame(() => el.classList.add("on"));
  el.querySelectorAll(".ri").forEach((b) => b.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const it = all.find((x) => x.id === b.dataset.r);
    closeRing();
    it?.run();
  }));
  el.addEventListener("click", (e) => { if (e.target === el || e.target.classList.contains("ring-bg")) closeRing(); });
  el._items = all;
  tick();
}

function closeRing(now = false) {
  if (!ringEl) return;
  const el = ringEl;
  ringEl = null;
  el.classList.remove("on");
  if (now) el.remove(); else setTimeout(() => el.remove(), 150);
  $("#fab")?.setAttribute("aria-expanded", "false");
  $("#corner")?.classList.remove("open");
  wakeCorner();
}
const closeMenu = () => closeRing();

/** While the thumb is down after a hold: light the control nearest it. */
function pickRing(x, y) {
  if (!ringEl) return null;
  let best = null, gap = 44;
  ringEl.querySelectorAll(".ri").forEach((b) => {
    const r = b.getBoundingClientRect();
    const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
    if (d < gap) { gap = d; best = b; }
  });
  ringEl.querySelectorAll(".ri").forEach((b) => b.classList.toggle("on", b === best));
  if (best && ringEl.dataset.lit !== best.dataset.r) tick();
  ringEl.dataset.lit = best ? best.dataset.r : "";
  return best;
}

let fabHold = { timer: 0, x: 0, y: 0, opened: false };
function bindFab(fab) {
  fab.addEventListener("pointerdown", (e) => {
    fabHold.opened = false; fabHold.x = e.clientX; fabHold.y = e.clientY;
    clearTimeout(fabHold.timer);
    fabHold.timer = setTimeout(() => { fabHold.opened = true; openRing(true); }, RING_HOLD_MS);
  });
  // After a hold, the click that follows isn't a toggle.
  fab.addEventListener("click", (e) => {
    clearTimeout(fabHold.timer);
    if (fabHold.opened) { e.preventDefault(); fabHold.opened = false; return; }
    if (ringEl) closeRing(); else openRing(false);
  });
  fab.addEventListener("contextmenu", (e) => e.preventDefault());
}

function bindRingGlobal() {
  window.addEventListener("pointermove", (e) => {
    if (!ringEl) {
      if (fabHold.timer && Math.hypot(e.clientX - fabHold.x, e.clientY - fabHold.y) > 12) { clearTimeout(fabHold.timer); fabHold.timer = 0; }
      return;
    }
    if (ringEl.dataset.live === "1") pickRing(e.clientX, e.clientY);
  });
  const up = () => {
    clearTimeout(fabHold.timer); fabHold.timer = 0;
    if (!ringEl || ringEl.dataset.live !== "1") return;
    ringEl.dataset.live = "0";
    const sel = ringEl.querySelector(".ri.on");
    if (!sel) return; // let go without choosing: the ring stays open to tap
    const it = ringEl._items.find((x) => x.id === sel.dataset.r);
    closeRing();
    it?.run();
  };
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

async function oneMore() {
  const ids = new Set(state.edition.ids);
  const extra = buildEdition(state.items.filter((i) => !ids.has(i.id)), null, { size: 1 });
  if (!extra.ids.length) { toast("The queue is empty."); return; }
  await addToEdition(extra.ids[0]);
  renderFront();
  openStories("edition", extra.ids[0]);
}

/* ================= Reader (stories) ================= */

function openStories(mode, startId) {
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
  bindPull({ scroller: $("#story", el), target: $("#story", el), host: $(".reader-inner", el), label: state.feed ? "Release to go back" : "Release for the front page", onBack: closeReader });
  el.addEventListener("pointerdown", wakeReader, true);
  renderStory();
  wakeReader();
}

function closeReader() {
  $(".reader")?.remove();
  state.reader = null;
  clearTimeout(readerTimer);
  renderFront();
  if (state.feed) renderFeed();
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
      <button class="pill-btn" type="button" data-end>Back to the front page</button></div>`;
    verdicts.innerHTML = "";
    $("#reader-edit", el).hidden = true;
    $("[data-end]", story).addEventListener("click", closeReader);
    return;
  }
  $("#reader-edit", el).hidden = false;
  $("#where", el).textContent = [KIND_LABEL[item.kind], item.url ? host(item.url) : ""].filter(Boolean).join(" · ");
  story.innerHTML = storyBody(item);
  story.scrollTop = 0;
  hydrate(story);
  updateTimeLeft(item);

  const open = item.status === STATUS.QUEUED || item.status === STATUS.INBOX;
  const b = (v, label, icon, primary) => `<button type="button" class="${primary ? "primary" : ""}" data-v="${v}">${icon}<span>${label}</span></button>`;
  if (open) {
    const keep = item.status === STATUS.INBOX || isFaded(item);
    verdicts.innerHTML = b(VERDICT.LET_GO, "Let go", I.letGo) + b(VERDICT.LATER, keep ? "Keep" : "Later", keep ? I.keep : I.later) + b(VERDICT.DONE, "Done", I.done, true);
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
    case KIND.LINK: content = item.text ? `<div class="prose">${esc(item.text)}</div>` : ""; break;
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
    ${content}
    ${busy ? '<p class="summary accent">Reading it…</p>' : item.summary ? `<p class="summary">${esc(item.summary)}</p>` : ""}
    ${item.points && item.points.length ? `<ul class="points">${item.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
    ${item.transcript ? `<span class="label">Text in the image</span><div class="prose">${esc(item.transcript)}</div>` : ""}
    ${item.note ? `<div class="prose mine-note">${esc(item.note)}</div>` : ""}
    ${source}
    ${item.ai && item.ai.why ? `<p class="why-line"><b>Why today</b>${esc(item.ai.why)}</p>` : ""}`;
}

function imgFull(item) {
  const gone = `onerror="this.closest('.media')?.remove()"`;
  if (item.blobId) return `<div class="media"><img alt="${esc(item.title)}" ${gone} data-blob="${esc(item.blobId)}"></div>`;
  return item.imageUrl ? `<div class="media"><img alt="${esc(item.title)}" ${gone} src="${esc(item.imageUrl)}"></div>` : "";
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
  if (before.suggested) {
    state.suggest = learnFromSuggestion(state.suggest, before, verdict, whyNot);
    await db.meta.set("suggest", state.suggest);
  }
  tick(true);
  return {
    after, stage, whyNot,
    undo: async () => {
      await saveItem(before);
      if (before.suggested) { state.suggest = prevSuggest; await db.meta.set("suggest", prevSuggest); }
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
  const r = state.reader;
  const before = byId(id);
  if (!r || !before) return;
  // Opened from the feed: the verdict closes the reader and the feed moves on.
  if (r.mode === "single" && state.feed && state.feed.ids.includes(id)) {
    $(".reader")?.remove();
    state.reader = null;
    clearTimeout(readerTimer);
    renderFront();
    feedVerdict(id, verdict);
    return;
  }
  const rec = await recordVerdict(before, verdict);
  if (!rec) return;
  const { after, stage } = rec;
  const at = r.ids.indexOf(id);
  r.ids.splice(at, 1);
  if (r.index >= r.ids.length) r.index = Math.max(0, r.ids.length - (r.ids.length ? 1 : 0));
  if (!r.ids.length) r.index = 0;
  const story = $("#story");
  if (story) { story.style.opacity = "0"; story.style.transform = verdict === VERDICT.LET_GO ? "translateX(-40px)" : "translateY(-24px)"; }
  setTimeout(renderStory, 140);
  const words = {
    [VERDICT.LET_GO]: "Let go.",
    [VERDICT.LATER]: stage === "inbox" ? "Kept for a future edition." : after.fadedAt ? "Moved later eight times. It's waiting in the Tideline." : "Moved to a later edition.",
    [VERDICT.DONE]: "Marked done.",
  };
  toast(words[verdict], {
    high: true,
    action: "Undo",
    onAction: async () => {
      await rec.undo();
      if (state.reader === r) { r.ids.splice(at, 0, id); r.index = at; renderStory(); }
      else renderFront();
    },
  });
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

/* ================= Feed (the opening screen) =================
 * The app opens on a feed: one card at a time, new saves first, then today's
 * edition, then a finish card. Each card starts face down on why you saved it
 * (your words when you gave them) and turns over with a tap. Swipe up for the
 * next card and down for the one before; on the first card, pull down for the
 * front page. The verdicts are in the + ring (hold + and slide, or tap +).
 */

const FEED_STEP = 70;
let feedDrag = false, dragEndedAt = 0;

/** Your own new saves, then today's edition, then at most two suggestions: AI picks never cut in line. */
function feedIds() {
  const inboxAll = state.items.filter((i) => i.status === STATUS.INBOX).sort((a, b) => a.created - b.created);
  const mine = inboxAll.filter((i) => !i.suggested).map((i) => i.id);
  const today = editionView(state.items, state.edition).open.map((i) => i.id).filter((id) => !mine.includes(id));
  const suggested = inboxAll.filter((i) => i.suggested && !today.includes(i.id)).slice(0, SUGGESTIONS_PER_DAY).map((i) => i.id);
  return [...mine, ...today, ...suggested];
}

function openFeed() {
  topUpEdition();
  const ids = feedIds();
  state.feed = { ids, index: 0, total: ids.length, turned: new Set(), tally: { done: 0, later: 0, letGo: 0 } };
  $(".feed")?.remove();
  const el = document.createElement("div");
  el.className = "feed";
  el.innerHTML = `<div class="feed-inner">
    <div class="segs" id="feed-segs" aria-hidden="true"></div>
    <div class="feed-top"><span class="where" id="feed-where"></span><span class="left" id="feed-left"></span></div>
    <div class="feed-card" id="feed-card"></div>
    <div class="pull-tip" id="feed-tip" aria-hidden="true">${I.down}<span>Release for the front page</span></div>
  </div>`;
  document.body.appendChild(el);
  bindFeedGestures(el);
  renderFeed();
  renderFront(); // the menu now offers the front page
}

function closeFeed() {
  $(".feed")?.remove();
  state.feed = null;
  renderFront();
}

/** What a face-down card says: your reason first, else what you saved it for. */
function hookFor(item) {
  const what = {
    read: "Something you meant to read.", watch: "Something you meant to watch.", listen: "Something you meant to listen to.",
    reference: "Something you kept for reference.", idea: "An idea you wanted to come back to.", task: "Something you meant to act on.",
  };
  const byKind = {
    quote: "Words you wanted to keep.", note: "A thought you wrote down.", photo: "A picture you kept.", video: what.watch,
    audio: what.listen, pdf: "A document you saved.", text: "A document you saved.", file: "A file you saved.", link: what.read,
  };
  if (item.suggested) {
    const because = item.suggestReason || item.summary || "";
    return { kicker: "Suggested for you", lead: because ? "" : "Something Edition found for you.", big: because || "A new find, picked from what you finish.", mine: false, sub: "", suggestion: true };
  }
  const since = item.status === STATUS.INBOX ? (ago(item.created) === "today" ? "Saved today" : `Saved ${ago(item.created)}`) : `From ${ago(item.created)}`;
  const sub = item.ai?.why || item.summary || "";
  if (item.why) return { kicker: since, lead: "You wrote when you saved it:", big: `“${item.why}”`, mine: true, sub };
  return { kicker: since, lead: "", big: what[item.intent] || byKind[item.kind] || "Something you saved.", mine: false, sub };
}

function feedMeta(item) {
  return [KIND_LABEL[item.kind] || "Item", `${estimateMinutes(item)} min`, item.url ? host(item.url) : item.author || ""].filter(Boolean).join(" · ");
}

function renderFeed() {
  if (ringEl) closeRing(true);
  const f = state.feed;
  const el = $(".feed");
  if (!f || !el) return;
  const card = $("#feed-card", el);
  const settled = f.total - f.ids.length;
  $("#feed-segs", el).innerHTML = f.total > 1 ? Array.from({ length: f.total }, (_, i) => `<span class="${i < settled + f.index + 1 ? "on" : ""}"></span>`).join("") : "";
  const id = f.ids[f.index];
  const item = id && byId(id);
  card.style.transition = "none";
  card.style.transform = "";
  card.style.opacity = "";

  if (!item) {
    $("#feed-where", el).textContent = dateLabel();
    $("#feed-left", el).textContent = "";
    card.className = "feed-card end-card";
    card.innerHTML = feedEnd();
    bindFeedEnd(card);
    return;
  }

  const inbox = item.status === STATUS.INBOX;
  const left = f.ids.slice(f.index).reduce((s, x) => s + estimateMinutes(byId(x) || {}), 0);
  $("#feed-where", el).textContent = item.suggested ? "Suggested" : inbox ? "New save" : "Today's edition";
  $("#feed-left", el).textContent = `${settled + f.index + 1} of ${f.total} · ${left} min left`;

  const turned = f.turned.has(id);
  const h = hookFor(item);
  const pic = picFor(item);
  const words = item.kind === KIND.QUOTE || item.kind === KIND.NOTE;
  card.className = "feed-card" + (turned ? " turned" : "") + (item.suggested ? " suggested" : "");
  card.innerHTML = `<div class="flip">
    <div class="face hook-face" data-turn role="button" tabindex="${turned ? -1 : 0}" aria-label="Turn the card over">
      <span class="kicker">${esc(h.kicker)}</span>
      ${h.lead ? `<span class="lead-in">${esc(h.lead)}</span>` : ""}
      <span class="big ${h.mine ? "mine" : ""}">${esc(h.big)}</span>
      ${h.sub ? `<span class="sub">${esc(h.sub)}</span>` : ""}
      <span class="meta">${esc(feedMeta(item))}</span>
      <span class="turn">Tap to turn ${I.requeue}</span>
    </div>
    <div class="face card-face" data-open-card role="button" tabindex="${turned ? 0 : -1}" aria-label="Open ${esc(headline(item))}">
      ${pic ? `<span class="pic">${pic}</span>` : ""}
      <span class="kicker">${esc(feedMeta(item))}</span>
      ${words
        ? `<span class="said ${String(item.text || "").length > 160 ? "long" : ""}">${esc(headline(item))}</span>${item.author ? `<span class="who">${esc(item.author)}</span>` : ""}`
        : `<span class="ttl">${esc(item.title)}</span>`}
      ${item.summary && !words ? `<span class="sub">${esc(item.summary)}</span>` : ""}
      ${item.suggested
        ? `<span class="mine-line sug"><span class="k">Suggested because</span><span class="w">${esc(item.suggestReason || "it fits what you finish")}</span></span>`
        : item.why
          ? `<span class="mine-line"><span class="k">Why you saved it</span><span class="w">“${esc(item.why)}”</span></span>`
          : `<button class="add-why" type="button" data-add-why>${I.plus}Add why you saved it</button>`}
      <span class="open-hint">Tap to open ${I.next}</span>
    </div>
  </div>`;
  hydrate(card);
  requestAnimationFrame(() => { card.style.transition = ""; });

}

/** Add or change your reason for a save; it becomes the face of its card. */
function askWhy(id) {
  const item = byId(id);
  if (!item) return;
  const wrap = sheet(`
    <div class="sheet-head"><h2>Why you saved it</h2><button class="x" type="button" data-close aria-label="Close">${I.close}</button></div>
    <p class="note">${esc(headline(item))}</p>
    <div class="field"><label for="why-in">In your words</label>
      <input id="why-in" type="text" autocomplete="off" maxlength="140" placeholder="Read this before the roadmap review" value="${esc(item.why || "")}"></div>
    <button class="btn primary" type="button" id="why-save">Save</button>`, { label: "Why you saved it" });
  const input = $("#why-in", wrap);
  const save = async () => {
    const why = input.value.trim().slice(0, 140);
    await saveItem({ ...byId(id), why });
    closeSheet();
    renderFeed();
    if (why) toast("Saved. You'll see it first next time.");
  };
  $("#why-save", wrap).addEventListener("click", save);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  input.focus();
}

function turnCard() {
  const f = state.feed;
  const id = f && f.ids[f.index];
  if (!id) return;
  f.turned.add(id);
  const card = $("#feed-card");
  card.classList.add("turned");
  card.querySelector("[data-turn]")?.setAttribute("tabindex", "-1");
  card.querySelector("[data-open-card]")?.removeAttribute("tabindex");
  tick();
}

function feedEnd() {
  const f = state.feed;
  const c = counts(state.items);
  const t = f.tally;
  const waiting = fading(state.items, state.edition);
  if (!state.items.length) {
    return `<div class="end-inner"><h1>Nothing here yet.</h1>
      <p class="summary">Save a link, a thought, a photo or a file, and say why if you like. It comes back here as a card.</p>
      <button class="pill-btn" type="button" data-end="add">Add something</button></div>`;
  }
  const said = [t.done && `${t.done} done`, t.later && `${t.later} kept for later`, t.letGo && `${t.letGo} let go`].filter(Boolean).join(", ");
  return `<div class="end-inner">
    <span class="label">${esc(dateLabel())}</span>
    <h1>${f.total ? "You're done." : "Nothing new today."}</h1>
    <p class="summary">${said ? `${cap(said)}. ` : ""}${f.total ? "That's today's feed. Tomorrow's is set in the morning." : "Your edition is clear and nothing new is waiting."}</p>
    ${waiting.length ? `<section class="end-sec"><span class="label">Fading</span>
      <p class="note">Untouched for ${FADE_DAYS / 7} weeks, a save fades out of your editions. It waits here until you decide.</p>
      ${tideHtml(waiting)}</section>` : ""}
    <div class="end-acts">
      ${c.queued ? `<button class="pill-btn" type="button" data-end="more">Read one more</button>` : ""}
      ${ai.settings.canDiscover() ? `<button class="pill-btn ghost" type="button" data-end="discover">Find something new</button>` : ""}
      <button class="pill-btn ghost" type="button" data-end="front">Front page</button>
    </div>
    <span class="st" id="feed-st" role="status"></span>
  </div>`;
}

function bindFeedEnd(card) {
  bindTide(card, renderFeed);
  card.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openStories("single", b.dataset.open)));
  card.querySelector('[data-end="add"]')?.addEventListener("click", openAdd);
  card.querySelector('[data-end="front"]')?.addEventListener("click", closeFeed);
  card.querySelector('[data-end="more"]')?.addEventListener("click", async () => {
    const ids = new Set(state.edition.ids);
    const extra = buildEdition(state.items.filter((i) => !ids.has(i.id)), null, { size: 1 });
    if (!extra.ids.length) { toast("The queue is empty."); return; }
    await addToEdition(extra.ids[0]);
    const f = state.feed;
    f.ids.push(extra.ids[0]);
    f.total += 1;
    renderFeed();
  });
  const disc = card.querySelector('[data-end="discover"]');
  if (disc) disc.addEventListener("click", async () => {
    disc.disabled = true;
    const before = new Set(state.items.map((i) => i.id));
    await findNew($("#feed-st"));
    disc.disabled = false;
    const f = state.feed;
    const shown = f ? f.ids.filter((x) => byId(x)?.suggested).length : 0;
    const fresh = state.items.filter((i) => !before.has(i.id)).map((i) => i.id).slice(0, Math.max(0, SUGGESTIONS_PER_DAY - shown));
    if (fresh.length && f) { f.ids.push(...fresh); f.total += fresh.length; renderFeed(); }
  });
}

async function feedVerdict(id, verdict) {
  const f = state.feed;
  const before = byId(id);
  if (!f || !before) return;
  const rec = await recordVerdict(before, verdict);
  if (!rec || state.feed !== f) return;
  const { after, stage } = rec;
  const key = verdict === VERDICT.DONE ? "done" : verdict === VERDICT.LET_GO ? "letGo" : "later";
  f.tally[key]++;
  const at = f.ids.indexOf(id);
  if (at >= 0) f.ids.splice(at, 1);
  if (f.index > f.ids.length) f.index = f.ids.length;
  slideFeed(verdict === VERDICT.LET_GO ? "left" : "up");
  const words = {
    [VERDICT.LET_GO]: rec.whyNot ? `Let go. ${{ topic: "Fewer like it.", known: "Deeper ones next time.", long: "Shorter ones next time.", site: "That site is blocked." }[rec.whyNot]}` : "Let go.",
    [VERDICT.LATER]: stage === "inbox" ? "Kept for a future edition." : after.fadedAt ? "Moved later eight times. It's waiting under Fading." : "Moved to a later edition.",
    [VERDICT.DONE]: "Marked done.",
  };
  toast(words[verdict], {
    action: "Undo",
    onAction: async () => {
      await rec.undo();
      f.tally[key]--;
      if (state.feed === f) { f.ids.splice(at, 0, id); f.index = at; renderFeed(); }
      renderFront();
    },
  });
  renderFront();
}

/** Animate the current card away, then show whatever card is now current. */
function slideFeed(dir) {
  const card = $("#feed-card");
  if (!card) { renderFeed(); return; }
  card.style.transition = "transform 0.16s ease, opacity 0.16s ease";
  card.style.opacity = "0";
  card.style.transform = dir === "left" ? "translateX(-60px)" : dir === "down" ? "translateY(80px)" : "translateY(-80px)";
  setTimeout(() => {
    renderFeed();
    const next = $("#feed-card");
    if (!next) return;
    next.style.transition = "none";
    next.style.opacity = "0";
    next.style.transform = dir === "down" ? "translateY(-50px)" : "translateY(50px)";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      next.style.transition = "transform 0.2s ease, opacity 0.2s ease";
      next.style.opacity = "";
      next.style.transform = "";
    }));
  }, 150);
}

function stepFeed(step) {
  const f = state.feed;
  if (!f) return false;
  const to = f.index + step;
  if (to < 0 || to > f.ids.length) return false;
  f.index = to;
  slideFeed(step > 0 ? "up" : "down");
  return true;
}

/*
 * Vertical swipes, TikTok style: up for next, down for the one before. On the
 * first card a pull down lights "Release for the front page" past 90px. Taps
 * on a card turn it (face down) or open it (face up), unless the finger moved.
 */
function bindFeedGestures(el) {
  const card = $("#feed-card", el), tip = $("#feed-tip", el);
  let y0 = null, x0 = 0, t0 = 0, dy = 0, lit = false, moved = false;
  const reset = () => {
    y0 = null; feedDrag = false; lit = false;
    tip.style.opacity = ""; tip.classList.remove("go");
  };
  card.addEventListener("pointerdown", (e) => {
    if (!state.feed || e.button > 0) return;
    if (card.classList.contains("end-card") && card.scrollTop > 0) return;
    if (e.target.closest(".rescue, .pill-btn, .tide-row button, .add-why, iframe, video, audio")) return;
    y0 = e.clientY; x0 = e.clientX; t0 = Date.now(); dy = 0; moved = false;
  });
  card.addEventListener("pointermove", (e) => {
    if (y0 == null) return;
    dy = e.clientY - y0;
    const dx = e.clientX - x0;
    if (!moved && Math.abs(dy) < 8) return;
    if (!moved && Math.abs(dx) > Math.abs(dy)) { reset(); return; }
    if (!moved) { moved = true; feedDrag = true; try { card.setPointerCapture(e.pointerId); } catch { /* capture can fail mid-gesture */ } }
    const f = state.feed;
    const atStart = f.index === 0, atEnd = f.index >= f.ids.length;
    const resist = (dy > 0 && atStart) || (dy < 0 && atEnd) ? 0.45 : 1;
    card.style.transition = "none";
    card.style.transform = `translateY(${dy * resist}px)`;
    if (atStart && dy > 0) {
      tip.style.opacity = String(Math.min(1, dy / PULL));
      const go = dy >= PULL;
      if (go && !lit) tick();
      lit = go;
      tip.classList.toggle("go", go);
    }
  });
  const end = () => {
    if (y0 == null) return;
    const f = state.feed;
    const fast = Math.abs(dy) > 30 && Math.abs(dy) / Math.max(1, Date.now() - t0) > 0.5;
    const wasMoved = moved, d = dy, go = lit;
    reset();
    if (!wasMoved) return;
    card.style.transition = "transform 0.2s ease";
    card.style.transform = "";
    dragEndedAt = Date.now(); // the click that follows a drag must not turn or open the card
    if (f.index === 0 && go) { closeFeed(); return; }
    if (d < -FEED_STEP || (fast && d < 0)) stepFeed(1);
    else if (d > FEED_STEP || (fast && d > 0)) stepFeed(-1);
  };
  card.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.target.closest("button")) return;
    if (e.target.closest("[data-turn]")) turnCard();
    else if (e.target.closest("[data-open-card]")) { const id = state.feed?.ids[state.feed.index]; if (id) openStories("single", id); }
  });
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", () => { reset(); card.style.transform = ""; });
  card.addEventListener("click", (e) => {
    if (Date.now() - dragEndedAt < 350) return;
    if (e.target.closest("[data-add-why]")) { const id = state.feed?.ids[state.feed.index]; if (id) askWhy(id); return; }
    if (e.target.closest("[data-turn]")) turnCard();
    else if (e.target.closest("[data-open-card]")) { const id = state.feed?.ids[state.feed.index]; if (id) openStories("single", id); }
  });
}

/* ================= Edit and delete =================
 * Edit: one sheet with only the fields that kind of item has. Delete is for
 * good (Let go keeps the item in your history so Edition learns from it), so
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
    ${words ? f("text", item.kind === KIND.QUOTE ? "Quote" : "Note", item.text, { area: true }) : f("title", "Title", item.title)}
    ${item.kind === KIND.QUOTE || item.kind === KIND.VIDEO ? f("author", item.kind === KIND.QUOTE ? "Who said it" : "Channel", item.author) : ""}
    ${hasUrl ? f("url", "Link", item.url, { type: "url", ph: "https://" }) : ""}
    ${f("why", "Why you saved it", item.why, { hint: "the face of its card", ph: "Read this before the roadmap review" })}
    ${!words ? f("note", "Your note", item.kind === KIND.LINK ? item.text : item.note, { area: true, ph: "Anything you want to remember about it" }) : ""}
    <div class="two">
      ${f("tags", "Tags", (item.tags || []).join(", "), { ph: "scrum, ai" })}
      ${f("minutes", "Minutes", estimateMinutes(item), { type: "number" })}
    </div>
    <span class="st" id="ed-st" role="status"></span>
    <button class="btn primary" type="button" id="ed-save">Save</button>
    <div class="danger">
      <button class="btn ghost-danger" type="button" id="ed-delete">${I.trash}Delete for good</button>
      <p class="note">Removes it${item.blobId ? " and its file" : ""} from this phone. To keep it in your history so Edition learns from it, use Let go instead.</p>
    </div>`, { tall: true, label: "Edit" });

  const val = (k) => $(`#ed-${k}`, wrap)?.value;
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
    next.why = (val("why") || "").trim().slice(0, 140);
    next.tags = (val("tags") || "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 6);
    const m = Math.round(+val("minutes"));
    next.minutes = Number.isFinite(m) && m > 0 ? Math.min(m, 600) : cur.minutes;
    await saveItem(next);
    tick(true);
    closeSheet();
    refresh();
    toast("Saved.");
  };
  $("#ed-save", wrap).addEventListener("click", save);
  wrap.querySelectorAll("input").forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); }));
  $("#ed-delete", wrap).addEventListener("click", () => { closeSheet(); deleteItem(id); });
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
  const f = state.feed, fAt = f ? f.ids.indexOf(id) : -1;
  if (fAt >= 0) { f.ids.splice(fAt, 1); f.total -= 1; if (f.index > f.ids.length) f.index = f.ids.length; }
  const r = state.reader, rAt = r ? r.ids.indexOf(id) : -1;
  if (rAt >= 0) {
    r.ids.splice(rAt, 1); r.total -= 1;
    if (r.mode === "single" || !r.ids.length) closeReader();
    else { if (r.index >= r.ids.length) r.index = r.ids.length - 1; renderStory(); }
  }
  tick(true);
  if (f && fAt >= 0 && !state.reader) slideFeed("left"); else if (state.feed) renderFeed();
  renderFront();
  let undone = false;
  const purge = setTimeout(async () => {
    if (undone) return;
    if (item.blobId) await db.blobs.remove(item.blobId);
    if (item.thumbId) await db.blobs.remove(item.thumbId);
  }, 7000);
  toast("Deleted.", {
    action: "Undo",
    onAction: async () => {
      undone = true;
      clearTimeout(purge);
      await saveItem(item);
      if (edAt >= 0 && state.edition) { const ids = [...state.edition.ids]; ids.splice(edAt, 0, id); state.edition = { ...state.edition, ids }; await db.meta.set("edition", state.edition); }
      if (state.feed === f && fAt >= 0) { f.ids.splice(fAt, 0, id); f.total += 1; f.index = fAt; }
      refresh();
    },
  });
}

/* ================= Add (sheet) ================= */

function openAdd() {
  const c = counts(state.items);
  const wrap = sheet(`
    <div class="sheet-head"><h2>Add</h2><button class="x" type="button" data-close aria-label="Close">${I.close}</button></div>
    <div class="cap">
      <label class="sr-only" for="cap-text">Link, note, quote or anything</label>
      <textarea id="cap-text" placeholder="Paste a link or a quote, or type a thought.">${esc(state.capText)}</textarea>
    </div>
    <div class="field why-field"><label for="cap-why">Why are you saving this? <span>Optional. It's the first thing you'll see when it comes back.</span></label>
      <input id="cap-why" type="text" autocomplete="off" maxlength="140" placeholder="Read this before the roadmap review" value="${esc(state.capWhy)}"></div>
    <div class="tray" id="cap-tray"></div>
    <ul class="detect" id="cap-detect" aria-live="polite"></ul>
    <span class="st" id="cap-st" role="status">${c.inbox ? `${c.inbox} waiting in your inbox.` : ""}</span>
    <div class="cap-bar">
      <button class="round" type="button" id="cap-paste" aria-label="Paste from clipboard">${I.paste}</button>
      <button class="save" type="button" id="cap-save">Save to inbox</button>
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
  const input = $("#in-any", wrap);
  input.addEventListener("change", () => { stageFiles(Array.from(input.files || [])); input.value = ""; });
  renderTray();
  updateDetect();
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
  save.textContent = drafts.length > 1 ? `Save ${drafts.length} items` : "Save to inbox";
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
  state.capText = "";
  state.capFiles = [];
  state.capWhy = "";
  closeSheet();
  afterCapture(out);
}

/* ================= Library (sheet) ================= */

function openLibrary() {
  const wrap = sheet(`
    <div class="sheet-head"><h2>Search</h2><button class="x" type="button" data-close aria-label="Close">${I.close}</button></div>
    <div class="find-wrap">${I.search}<label class="sr-only" for="lib-q">Search</label>
      <input class="find" id="lib-q" type="search" placeholder="Everything you've saved" value="${esc(state.libQuery)}" enterkeyhint="search"></div>
    <div class="chips" role="group" aria-label="Show" style="margin:0;padding:0">
      ${LIB_FILTERS.map((f, i) => `<button class="chip" type="button" data-filter="${i}" aria-pressed="${state.libFilter === i}">${f.label}</button>`).join("")}
    </div>
    <div class="lib-list" id="lib-list"></div>`, { tall: true, label: "Search" });
  const q = $("#lib-q", wrap);
  q.addEventListener("input", () => { state.libQuery = q.value; renderList(); });
  wrap.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => {
    state.libFilter = +b.dataset.filter;
    wrap.querySelectorAll("[data-filter]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderList();
  }));
  renderList();
}

function renderList() {
  const list = $("#lib-list");
  if (!list) return;
  const status = LIB_FILTERS[state.libFilter].id;
  const q = state.libQuery.trim().toLowerCase();
  const rows = state.items
    .filter((i) => status === "all" || i.status === status)
    .filter((i) => !q || [i.title, i.text, i.url, i.summary, i.fileName, i.author, i.transcript, ...(i.points || []), ...(i.tags || [])].some((s) => s && s.toLowerCase().includes(q)))
    .sort((a, b) => (b.doneAt || b.archivedAt || b.created) - (a.doneAt || a.archivedAt || a.created));
  const statusWord = { inbox: "Inbox", queued: "Queue", done: "Done", archived: "Let go" };
  list.innerHTML = rows.length
    ? rows.map((i) => `<button class="lib-row" type="button" data-open="${esc(i.id)}">
        <span class="t">${esc(headline(i))}</span><span class="a">${esc(ago(i.created, true))}</span>
        <span class="k">${esc(KIND_LABEL[i.kind] || "")} · ${isFaded(i) ? "Faded" : statusWord[i.status] || ""}</span></button>`).join("")
    : '<p class="empty">Nothing matches.</p>';
  list.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => { closeSheet(); openStories("single", b.dataset.open); }));
}

/* ================= Settings (sheet) ================= */

function openSettings() {
  const c = counts(state.items);
  const wrap = sheet(`
    <div class="sheet-head"><h2>Settings</h2><button class="x" type="button" data-close aria-label="Close">${I.close}</button></div>
    <div class="section">
      <h3>AI (Anthropic API)</h3>
      <div class="field"><label for="set-key">API key</label>
        <input id="set-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(ai.settings.key())}"></div>
      <div class="two">
        <button class="btn primary" type="button" id="set-save">Save and test</button>
        <button class="btn" type="button" id="set-clear">Remove key</button>
      </div>
      <span class="st" id="set-st" role="status"></span>
      <p class="note">The key stays on this device and is sent only to Anthropic. With it, Edition titles and tags each new save (photos and PDFs too), ranks your queue from what you finish and let go, and can search for new reading. Each is a paid API call on your account.</p>
    </div>
    <div class="section">
      <h3>Discovery (Perplexity API)</h3>
      <div class="field"><label for="set-pplx">API key</label>
        <input id="set-pplx" type="password" autocomplete="off" spellcheck="false" placeholder="pplx-…" value="${esc(ai.settings.pplxKey())}"></div>
      <div class="field"><label for="set-relay">Relay address</label>
        <input id="set-relay" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://edition-relay.you.workers.dev" value="${esc(ai.settings.relay())}"></div>
      <div class="two">
        <button class="btn primary" type="button" id="set-pplx-save">Save and test</button>
        <button class="btn" type="button" id="set-pplx-clear">Remove key</button>
      </div>
      <span class="st" id="set-pplx-st" role="status"></span>
      <p class="note">With this key, Find something new asks Perplexity to search for popular recent articles on what you keep finishing. Perplexity blocks calls made straight from a web app, so they go through your own relay (a free Cloudflare Worker; steps in the repo's relay folder). The key stays on this phone and passes through the relay to Perplexity. Without a Perplexity key, Claude does the searching.</p>
    </div>
    <div class="section">
      <h3>Edition</h3>
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
    <div class="section">
      <h3>Sounds</h3>
      <div class="chips" role="group" aria-label="Sounds" style="margin:0;padding:0">
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
    <p class="version">Edition ${VERSION} · ${c.inbox} inbox · ${c.queued} queued · ${c.done} done · ${c.archived} let go</p>`, { label: "Settings" });

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
    say(st, "Key removed. Edition works without AI.");
  });
  renderSuggestProfile(wrap);
  refreshProblems(wrap);
  $("#set-pr-copy", wrap).addEventListener("click", copyDiagnostics);
  $("#set-pr-clear", wrap).addEventListener("click", () => { clearProblems(); refreshProblems(wrap); });
  const pSt = $("#set-pplx-st", wrap);
  $("#set-pplx-save", wrap).addEventListener("click", async () => {
    ai.settings.setPplxKey($("#set-pplx", wrap).value.trim());
    const relay = ai.relayBase($("#set-relay", wrap).value);
    ai.settings.setRelay(relay);
    $("#set-relay", wrap).value = relay;
    if (!ai.settings.pplxEnabled()) { say(pSt, "No key saved."); return; }
    say(pSt, "Testing…");
    try {
      await ai.testPplxKey();
      say(pSt, "Key and relay work. Find something new now uses Perplexity.");
      $("#set-discover", wrap).disabled = false;
    } catch (e) {
      noteError(e, { quiet: true, where: "settings: Perplexity test" });
      say(pSt, e.message, true);
      refreshProblems(wrap);
    }
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
      closeSheet(); renderFront(); toast("Today's edition is rebuilt.");
    } catch (e) { say(edSt, e.message || "Could not rebuild.", true); }
  });
  $("#set-discover", wrap).addEventListener("click", () => findNew(edSt).finally(() => refreshProblems(wrap)));
  const smSt = $("#set-sm-st", wrap);
  $("#set-samples-load", wrap).addEventListener("click", async () => {
    const n = await seedSamples({ force: true });
    await ensureEdition();
    closeSheet();
    openFeed();
    toast(`Loaded ${n} fresh samples. They're in your feed.`);
  });
  $("#set-samples-clear", wrap).addEventListener("click", async () => {
    const n = await removeSamples();
    $("#set-samples-clear", wrap).disabled = true;
    say(smSt, `Removed ${n} sample items.`);
    renderFront();
  });
  wrap.querySelectorAll("[data-sound]").forEach((b) => b.addEventListener("click", () => {
    setSound(b.dataset.sound === "1");
    wrap.querySelectorAll("[data-sound]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    if (soundOn()) { unlock(); tick(true); }
  }));
  $("#set-export", wrap).addEventListener("click", async () => {
    const blob = new Blob([await db.exportJson()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `edition-backup-${dayKey()}.json`;
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
      closeSheet(); renderFront(); toast(`Imported ${n} items.`);
    } catch (e) { say(st, e.message, true); }
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
    `Edition ${VERSION}, ${new Date().toISOString()}`,
    navigator.userAgent,
    `Home Screen app: ${matchMedia("(display-mode: standalone)").matches || navigator.standalone ? "yes" : "no"}; screen ${innerWidth}x${innerHeight}; offline copy: ${navigator.serviceWorker?.controller ? "yes" : "no"}`,
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
  $(".toast")?.remove(); // a leftover message shouldn't sit over the sheet
  lastFocus = document.activeElement;
  const wrap = document.createElement("div");
  wrap.className = "sheet-wrap";
  wrap.innerHTML = `<div class="sheet ${tall ? "tall" : ""}" role="dialog" aria-modal="true" aria-label="${esc(label)}"><span class="grab" aria-hidden="true"></span>${html}</div>`;
  wrap.addEventListener("click", (e) => { if (e.target === wrap) closeSheet(); });
  wrap.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeSheet));
  document.body.appendChild(wrap);
  const panel = $(".sheet", wrap);
  bindPull({ scroller: panel, target: panel, host: wrap, onBack: closeSheet });
  return wrap;
}

function closeSheet() {
  const s = $(".sheet-wrap");
  if (s) { const cb = s._onClose; s._onClose = null; s.remove(); if (cb) cb(); }
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
function toast(msg, { action, onAction, high = false, sticky = false } = {}) {
  $(".toast")?.remove();
  clearTimeout(toastTimer);
  const el = document.createElement("div");
  el.className = "toast" + (high || state.reader ? " high" : "");
  el.setAttribute("role", "status");
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action)}</button>` : ""}`;
  if (action) $("button", el).addEventListener("click", () => { el.remove(); onAction && onAction(); });
  document.body.appendChild(el);
  if (!sticky) toastTimer = setTimeout(() => el.remove(), action ? 5000 : 2500);
}

function wireGlobal() {
  bindRingGlobal();
  window.addEventListener("error", (e) => noteError(e, { where: "page" }));
  window.addEventListener("unhandledrejection", (e) => noteError(e, { where: "promise" }));
  onFirstProblem(() => toast("Something went wrong. Your saves are safe.", { action: "Copy details", onAction: copyDiagnostics }));
  window.addEventListener("pointerdown", unlock, { once: true });
  // Any touch wakes the corner button on the front page.
  window.addEventListener("pointerdown", () => { if (!state.reader) wakeCorner(); }, true);
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
    // Feed keys on a keyboard: arrows or j/k to move, space to turn the card.
    if (state.feed && !state.reader && !$(".sheet-wrap") && !e.target.closest?.("input, textarea")) {
      if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); stepFeed(1); return; }
      if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); stepFeed(-1); return; }
      if (e.key === " " && !e.target.closest?.("button")) { e.preventDefault(); turnCard(); return; }
    }
    if (e.key !== "Escape") return;
    if ($(".sheet-wrap")) closeSheet();
    else if (state.reader) closeReader();
    else closeMenu();
  });
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    const before = state.items.length;
    const day = state.edition && state.edition.date;
    await importShares();
    await ensureEdition();
    if (state.items.length !== before || (state.edition && state.edition.date !== day)) {
      if (!state.reader && !$(".sheet-wrap")) renderFront();
      enrichPending();
    }
  });
}

/* ================= Small formatters ================= */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function dateLabel() { return new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); }
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
  app.innerHTML = `<main class="front"><div class="empty-front"><h2>Something broke.</h2><p>${esc(e && e.message)}</p></div></main>`;
});
