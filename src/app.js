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
  detectText, draftFromFile, describeDraft, fitToTime, circling, fading, isFaded, FADE_DAYS,
} from "./model.js";
import * as db from "./db.js";
import { captureText, captureFile, captureTransfer, readClipboard, captureShares } from "./capture.js";
import { sampleItems } from "./samples.js";
import * as ai from "./ai.js";
import { tick, unlock, soundOn, setSound } from "./feel.js";
import { I } from "./icons.js";
import { problems, noteError as logError, onFirstProblem, clearProblems, formatProblem } from "./problems.js";

export const VERSION = "3.3.0";
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
};

const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");
const urls = new Map(); // blob id -> object URL

/* ================= Boot ================= */

async function boot() {
  const migrated = await db.migrateFromLocalStorage(migrateLegacy).catch(() => 0);
  state.items = await db.items.all();
  state.edition = await db.meta.get("edition", null);
  const seeded = await seedSamples();
  const shared = await importShares();
  const linked = await importFromUrl();
  await ensureEdition();
  renderFront();
  if (migrated) toast(`Brought over ${migrated} saved item${migrated === 1 ? "" : "s"} from the old version.`);
  else if (seeded) toast(`Loaded ${seeded} sample items. Remove them in Settings.`);
  wireGlobal();
  startCoin();
  enrichPending();
  if (shared || linked) openStories("inbox");
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

/** Sample items, loaded once per device so a new install has something to show. */
async function seedSamples({ force = false } = {}) {
  if (!force && await db.meta.get("samplesLoaded", false)) return 0;
  const have = new Set(state.items.map((i) => i.id));
  const fresh = sampleItems().filter((i) => !have.has(i.id));
  if (fresh.length) await db.items.putMany(fresh);
  await db.meta.set("samplesLoaded", true);
  state.items = [...fresh, ...state.items];
  if (fresh.length && state.edition && state.edition.date === dayKey() && !state.edition.ids.length) state.edition = null;
  return fresh.length;
}

async function removeSamples() {
  const list = state.items.filter((i) => i.sample);
  await removeItems(list);
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
            title: out.title || cur.title,
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
    const picks = await ai.discover(interestProfile(state.items), { known });
    const fresh = picks.filter((p) => !known.has(p.url));
    for (const p of fresh) {
      const item = createItem(
        { kind: KIND.LINK, url: p.url, title: p.title, summary: p.why, tags: p.tags, minutes: p.minutes },
        { id: db.newId(), source: "ai" },
      );
      item.enrichedAt = Date.now();
      await saveItem(item);
    }
    set(fresh.length ? `${fresh.length} suggestion${fresh.length === 1 ? "" : "s"} added to your inbox.` : "Nothing new turned up. Try again later.");
    if (fresh.length) { closeSheet(); renderFront(); }
  } catch (e) {
    noteError(e, { quiet: true, where: ai.settings.pplxEnabled() ? "discover (Perplexity)" : "discover (Claude)" });
    set(e.message || "Search failed.", true);
  }
}

/* ================= Front page ================= */

function refresh() {
  if (state.reader) renderStory();
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
      <div class="tide">${waiting.map(({ item, days, left, faded }) => `<div class="tide-row ${faded ? "faded" : ""}">
        <span class="bar" style="opacity:${faded ? 0.18 : Math.max(0.3, left / 7).toFixed(2)}"></span>
        <button class="txt" type="button" data-open="${esc(item.id)}"><span class="t">${esc(headline(item))}</span>
          <span class="s">${faded ? "Faded. Your call." : `Fades in ${left} day${left === 1 ? "" : "s"}`}</span></button>
        ${faded
          ? `<button class="rescue ghost" type="button" data-letgo="${esc(item.id)}">Let go</button><button class="rescue" type="button" data-keep="${esc(item.id)}">Keep</button>`
          : `<button class="rescue" type="button" data-rescue="${esc(item.id)}">Read today</button>`}</div>`).join("")}</div>
    </section>` : ""}
  </main>
  <div class="corner" id="corner">
    <div class="fan" id="fan">
      <button type="button" class="primary" data-act="add">${I.plus}Add</button>
      <button type="button" data-act="sort">${I.inbox}Sort inbox${c.inbox ? ` <span class="count">${c.inbox}</span>` : ""}</button>
      <button type="button" data-act="library">${I.search}Search</button>
      <button type="button" data-act="settings">${I.settings}Settings</button>
    </div>
    <button class="fab" type="button" id="fab" aria-label="Menu" aria-expanded="false">${I.plus}</button>
  </div>`;
  const front = $("#front");
  front.scrollTop = scrollTop;
  hydrate(front);
  bindFront();
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
  front.querySelectorAll("[data-rescue]").forEach((b) => b.addEventListener("click", async () => {
    await addToEdition(b.dataset.rescue);
    tick(true);
    renderFront();
    toast("Added to today's edition.");
  }));
  front.querySelectorAll("[data-keep]").forEach((b) => b.addEventListener("click", async () => {
    const before = byId(b.dataset.keep);
    await saveItem(restore(before));
    tick(true);
    renderFront();
    toast("Kept. Back in your queue for three more weeks.", { action: "Undo", onAction: async () => { await saveItem(before); renderFront(); } });
  }));
  front.querySelectorAll("[data-letgo]").forEach((b) => b.addEventListener("click", async () => {
    const before = byId(b.dataset.letgo);
    await saveItem(applyVerdict(before, VERDICT.LET_GO, { stage: "edition" }));
    tick(true);
    renderFront();
    toast("Let go.", { action: "Undo", onAction: async () => { await saveItem(before); renderFront(); } });
  }));
  const more = $('[data-act="one-more"]', front);
  if (more) more.addEventListener("click", oneMore);
  const disc = $('[data-act="discover"]', front);
  if (disc) disc.addEventListener("click", () => { disc.disabled = true; findNew($("#discover-st")).finally(() => { disc.disabled = false; }); });
  app.querySelectorAll('[data-act="sort"]').forEach((b) => b.addEventListener("click", () => { closeMenu(); openStories("inbox"); }));
  app.querySelectorAll('[data-act="add"]').forEach((b) => b.addEventListener("click", () => { closeMenu(); openAdd(); }));
  app.querySelectorAll('[data-act="library"]').forEach((b) => b.addEventListener("click", () => { closeMenu(); state.libQuery = ""; openLibrary(); }));
  app.querySelectorAll('[data-act="settings"]').forEach((b) => b.addEventListener("click", () => { closeMenu(); openSettings(); }));

  // The corner button: tap to open the menu; it dims while you scroll and after a few idle seconds.
  const corner = $("#corner"), fab = $("#fab");
  fab.addEventListener("click", () => (corner.classList.contains("open") ? closeMenu() : openMenu()));
  front.addEventListener("scroll", () => { if (!corner.classList.contains("open")) sleepCorner(); }, { passive: true });
  wakeCorner();
}

/*
 * The + button catches the light now and then, like a coin spinning to a stop
 * on a counter: once on launch, then every half minute while the front page
 * sits idle. Skipped when the reader asked for reduced motion.
 */
const COIN_EVERY_MS = 30000;
let coinTimer = 0;
function spinCoin() {
  const fab = $("#fab"), corner = $("#corner");
  if (!fab || state.reader || $(".sheet-wrap") || corner.classList.contains("open")) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  wakeCorner();
  fab.classList.remove("spin");
  void fab.offsetWidth; // restart the animation
  fab.classList.add("spin");
  fab.addEventListener("animationend", () => fab.classList.remove("spin"), { once: true });
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
  if (corner && !corner.classList.contains("open")) corner.classList.add("asleep");
}
function openMenu() {
  const corner = $("#corner");
  corner.classList.add("open");
  corner.classList.remove("asleep");
  $("#fab").setAttribute("aria-expanded", "true");
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.addEventListener("click", closeMenu);
  app.insertBefore(scrim, corner);
}
function closeMenu() {
  const corner = $("#corner");
  if (!corner) return;
  corner.classList.remove("open");
  $("#fab").setAttribute("aria-expanded", "false");
  $(".scrim")?.remove();
  wakeCorner();
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
    </div>
    <span class="stamp" id="stamp" aria-hidden="true"></span>
    <article class="story" id="story"></article>
    <div class="verdicts" id="verdicts" role="group" aria-label="Verdict"></div>
  </div>`;
  document.body.appendChild(el);
  el.querySelector("[data-close]").addEventListener("click", closeReader);
  bindStoryGestures(el);
  bindPull({ scroller: $("#story", el), target: $("#story", el), host: $(".reader-inner", el), label: "Release for the front page", onBack: closeReader });
  el.addEventListener("pointerdown", wakeReader, true);
  renderStory();
  wakeReader();
}

function closeReader() {
  $(".reader")?.remove();
  state.reader = null;
  clearTimeout(readerTimer);
  renderFront();
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
    $("[data-end]", story).addEventListener("click", closeReader);
    return;
  }
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

async function storyVerdict(id, verdict) {
  const r = state.reader;
  const before = byId(id);
  if (!r || !before) return;
  const stage = before.status === STATUS.INBOX ? "inbox" : "edition";
  // Keeping a faded item resets its clock instead of counting another deferral.
  const after = verdict === VERDICT.LATER && isFaded(before) ? restore(before) : applyVerdict(before, verdict, { stage });
  await saveItem(after);
  tick(true);
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
      await saveItem(before);
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

/* ================= Add (sheet) ================= */

function openAdd() {
  const c = counts(state.items);
  const wrap = sheet(`
    <div class="sheet-head"><h2>Add</h2><button class="x" type="button" data-close aria-label="Close">${I.close}</button></div>
    <div class="cap">
      <label class="sr-only" for="cap-text">Link, note, quote or anything</label>
      <textarea id="cap-text" placeholder="Paste a link or a quote, or type a thought.">${esc(state.capText)}</textarea>
    </div>
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
  state.capText = "";
  state.capFiles = [];
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
        <button class="btn" type="button" id="set-samples-load">Load samples</button>
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
    $("#set-samples-clear", wrap).disabled = false;
    say(smSt, n ? `Loaded ${n} sample items.` : "Samples are already loaded.");
    renderFront();
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
  if (s) s.remove();
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
function toast(msg, { action, onAction, high = false } = {}) {
  $(".toast")?.remove();
  clearTimeout(toastTimer);
  const el = document.createElement("div");
  el.className = "toast" + (high || state.reader ? " high" : "");
  el.setAttribute("role", "status");
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action)}</button>` : ""}`;
  if (action) $("button", el).addEventListener("click", () => { el.remove(); onAction && onAction(); });
  document.body.appendChild(el);
  toastTimer = setTimeout(() => el.remove(), action ? 5000 : 2500);
}

function wireGlobal() {
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
