/*
 * Edition app shell: four screens (Edition, Inbox, Library, Add) plus the
 * reader and settings, and the glue between capture, storage, the model and
 * the AI. Rendering is plain template strings; every value from an item goes
 * through esc(). Icons come from icons.js only, never text glyphs.
 *
 * Layout rule for every screen: top bar, one content pane, one action bar,
 * tab bar. Every verdict is one tap.
 */

import {
  VERDICT, STATUS, KIND, dayKey, applyVerdict, restore, buildEdition, editionView,
  interestProfile, estimateMinutes, counts, migrateLegacy, createItem, EDITION_SIZE,
  detectText, draftFromFile, describeDraft,
} from "./model.js";
import * as db from "./db.js";
import { captureText, captureFile, captureTransfer, readClipboard, captureShares } from "./capture.js";
import { sampleItems } from "./samples.js";
import * as ai from "./ai.js";
import { tick, unlock, soundOn, setSound } from "./feel.js";
import { I } from "./icons.js";

export const VERSION = "2.3.0";

const KIND_LABEL = { link: "Link", note: "Note", quote: "Quote", photo: "Photo", pdf: "PDF", text: "Text", video: "Video", audio: "Audio", file: "File" };
const INTENT_LABEL = { read: "To read", watch: "To watch", listen: "To listen", reference: "Reference", idea: "Idea", task: "Task" };
const LIB_FILTERS = [
  { label: "Queue", id: STATUS.QUEUED },
  { label: "Inbox", id: STATUS.INBOX },
  { label: "Done", id: STATUS.DONE },
  { label: "Let go", id: STATUS.ARCHIVED },
  { label: "All", id: "all" },
];

const state = {
  items: [],
  edition: null,
  view: "edition",
  back: "edition",          // where Add returns to
  capText: "",              // what is in the capture box
  capFiles: [],             // files staged in the capture box: { file, url }
  libFilter: 0,
  libQuery: "",
  enriching: new Set(),
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
  await importShares();
  await importFromUrl();
  await ensureEdition();
  render();
  if (migrated) toast(`Brought over ${migrated} saved item${migrated === 1 ? "" : "s"} from the old version.`);
  else if (seeded) toast(`Loaded ${seeded} sample items. Remove them in Settings.`);
  wireGlobal();
  enrichPending();
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
  if ((isNewDay || force) && ai.settings.enabled()) await rankQueue().catch(() => {});
  const next = buildEdition(state.items, force ? null : state.edition);
  if (next !== state.edition) {
    state.edition = next;
    await db.meta.set("edition", next);
  }
}

/**
 * Items queued during the day join today's edition while it has room, so
 * the first day isn't empty. Pages are never removed or reordered.
 */
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
  render();
  toast(`Saved ${list.length === 1 ? "1 item" : list.length + " items"} to your inbox.`, {
    action: "Undo",
    onAction: async () => { await removeItems(list); render(); },
  });
  enrichPending();
}

async function importShares() {
  const shares = await db.drainShares().catch(() => []);
  if (!shares.length) return;
  const list = await captureShares(shares);
  list.forEach((it) => { state.items = [it, ...state.items]; });
  if (list.length) state.view = "inbox";
}

/** ?text= / ?url= / ?title= capture, for bookmarklets and shortcuts. Clears itself. */
async function importFromUrl() {
  const p = new URLSearchParams(location.search);
  if (p.has("share")) state.view = "inbox";
  const text = [p.get("title"), p.get("text"), p.get("url")].filter(Boolean).join(" ").trim();
  if (text) {
    const list = await captureText(text, "link");
    if (list.length) { state.items = [...list, ...state.items]; state.view = "inbox"; }
  }
  if ([...p.keys()].length) history.replaceState(null, "", location.pathname);
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
      refreshCard(next.id);
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
        const cur = byId(next.id);
        if (cur) await saveItem({ ...cur, enrichTries: (cur.enrichTries || 0) + 1 });
        if (e.status === 401 || e.message === "No API key set.") { toast(e.message); break; }
      } finally {
        state.enriching.delete(next.id);
        refreshCard(next.id);
      }
    }
  } finally {
    enrichRunning = false;
  }
}

/** Redraw just the card if it is the item being shown. */
function refreshCard(id) {
  const card = $(`[data-card="${CSS.escape(id)}"]`);
  if (!card || document.querySelector(".sheet-wrap, .reader")) return;
  const item = byId(id);
  if (!item) return;
  card.innerHTML = cardBody(item);
  hydrate(card);
}

async function findNew(statusEl) {
  const set = (msg, err) => { if (statusEl) { statusEl.textContent = msg; statusEl.classList.toggle("err", !!err); } };
  if (!ai.settings.enabled()) { set("Add an API key in Settings first.", true); return; }
  set("Searching for something worth your time…");
  try {
    const picks = await ai.discover(interestProfile(state.items));
    const known = new Set(state.items.map((i) => i.url).filter(Boolean));
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
    if (fresh.length) { closeSheet(); go("inbox"); toast(`${fresh.length} AI suggestion${fresh.length === 1 ? "" : "s"} in your inbox.`); }
  } catch (e) {
    set(e.message || "Search failed.", true);
  }
}

/* ================= Verdicts ================= */

async function giveVerdict(id, verdict, stage) {
  const before = byId(id);
  if (!before) return;
  const after = applyVerdict(before, verdict, { stage });
  await saveItem(after);
  tick(true);
  render();
  if (verdict === VERDICT.READ_NOW) { openReader(after); return; }
  const words = {
    [VERDICT.LET_GO]: after.washedOut ? "Washed out." : "Let go.",
    [VERDICT.LATER]: stage === "inbox" ? "Kept for a future edition." : after.washedOut ? "Moved later too often. Washed out." : "Moved to a later edition.",
    [VERDICT.DONE]: "Marked done.",
  };
  toast(words[verdict], { action: "Undo", onAction: async () => { await saveItem(before); render(); } });
}

/* ================= Shared pieces ================= */

function go(view) {
  if (view === "capture" && state.view !== "capture") state.back = state.view;
  state.view = view;
  render();
}

function render() {
  topUpEdition();
  const views = { edition: renderEdition, inbox: renderInbox, capture: renderCapture, library: renderLibrary };
  (views[state.view] || renderEdition)();
}

function topBar(title, { sub = "", count = "", settings = true, lead = "", trail = "" } = {}) {
  return `<header class="top">
    ${lead}
    <h1>${esc(title)}</h1>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}
    <span class="right">${count ? `<span class="count">${count}</span>` : ""}${trail}
      ${settings ? `<button class="icon-btn" type="button" data-act="settings" aria-label="Settings">${I.settings}</button>` : ""}</span>
  </header>`;
}

function tabBar(active) {
  const c = counts(state.items);
  const t = (view, name, icon, badge = 0) => `<button class="tab" type="button" data-go="${view}" ${active === view ? 'aria-current="page"' : ""}>
      ${icon}<span>${name}</span>${badge ? `<span class="badge" aria-label="${badge} waiting">${badge > 99 ? "99+" : badge}</span>` : ""}</button>`;
  return `<nav class="tabs" aria-label="Sections">
    ${t("edition", "Edition", I.edition)}
    ${t("inbox", "Inbox", I.inbox, c.inbox)}
    ${t("library", "Library", I.library)}
    <button class="add" type="button" data-go="capture" aria-label="Add something">${I.plus}</button>
  </nav>`;
}

/** The one-tap verdict bar used by Edition, Inbox and the reader. */
function actionBar(id, stage) {
  const a = (v, label, icon, primary = false) =>
    `<button class="act ${primary ? "primary" : ""}" type="button" data-verdict="${v}" data-id="${esc(id)}" data-stage="${stage}">${icon}<span>${label}</span></button>`;
  return `<div class="actions" role="group" aria-label="Verdict">
    ${a(VERDICT.LET_GO, "Let go", I.letGo)}
    ${a(VERDICT.LATER, "Later", I.later)}
    ${a(VERDICT.DONE, "Done", I.done)}
    ${a(VERDICT.READ_NOW, "Read", I.read, true)}
  </div>`;
}

function bindCommon(root = app) {
  root.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));
  root.querySelectorAll('[data-act="settings"]').forEach((b) => b.addEventListener("click", openSettings));
  root.querySelectorAll("[data-verdict]").forEach((b) => b.addEventListener("click", () => giveVerdict(b.dataset.id, b.dataset.verdict, b.dataset.stage)));
  const disc = $('[data-act="discover"]', root);
  if (disc) disc.addEventListener("click", () => { disc.disabled = true; findNew($("#discover-st")).finally(() => { disc.disabled = false; }); });
  const more = $('[data-act="one-more"]', root);
  if (more) more.addEventListener("click", oneMore);
}

function dateLabel() {
  return new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/* ================= Edition ================= */

function renderEdition() {
  const v = editionView(state.items, state.edition);
  const c = counts(state.items);
  const item = v.open[0];
  const progress = v.total
    ? `<div class="progress" aria-hidden="true">${v.pages.map((p) => `<span class="${v.open.includes(p) ? "" : "on"}"></span>`).join("")}</div>`
    : "";

  if (!item) {
    let body;
    if (!v.total) {
      body = `<div class="state">
        <h2>${c.inbox ? "Triage your inbox first." : "Nothing here yet."}</h2>
        <p>${c.inbox ? "New saves wait in your inbox. The ones you keep come back here as today's edition." : "Tap + to save a link, a thought, a photo or a file. It goes to your inbox first, then comes back here."}</p>
        <div class="stack">${c.inbox
          ? `<button class="btn primary" type="button" data-go="inbox">Open inbox ${I.arrow}</button>`
          : `<button class="btn primary" type="button" data-go="capture">Add something ${I.plus}</button>`}</div></div>`;
    } else {
      const done = v.pages.filter((p) => p.status === STATUS.DONE).length;
      const gone = v.pages.filter((p) => p.status === STATUS.ARCHIVED).length;
      body = `<div class="state">
        <h2>You're done for today.</h2>
        <p>${done} read, ${gone} let go, ${v.total - done - gone} moved later. Tomorrow's edition is set in the morning.</p>
        <div class="stack">
          ${c.inbox ? `<button class="btn" type="button" data-go="inbox">Triage inbox (${c.inbox}) ${I.arrow}</button>` : ""}
          ${c.queued ? `<button class="btn" type="button" data-act="one-more">Read one more ${I.arrow}</button>` : ""}
          ${ai.settings.enabled() ? `<button class="btn" type="button" data-act="discover">Find something new ${I.search}</button><span class="st" id="discover-st" role="status"></span>` : ""}
        </div></div>`;
    }
    app.innerHTML = `<div class="screen no-actions">
      <div>${topBar("Edition", { sub: dateLabel(), count: v.total ? `${v.settled} of ${v.total}` : "" })}${progress}</div>
      <section class="card"><div class="card-body">${body}</div></section>
      ${tabBar("edition")}
    </div>`;
    bindCommon();
    return;
  }

  app.innerHTML = `<div class="screen">
    <div>${topBar("Edition", { sub: dateLabel(), count: `${pageNo(item)} of ${v.total}` })}${progress}</div>
    <article class="card" data-card="${esc(item.id)}">${cardBody(item)}</article>
    ${actionBar(item.id, "edition")}
    ${tabBar("edition")}
  </div>`;
  bindCommon();
  hydrate(app);
}

function pageNo(item) {
  return (state.edition?.ids || []).indexOf(item.id) + 1;
}

/** The inside of a card: one meta line, the title, the body for its kind, and why it's here. */
function cardBody(item) {
  const busy = state.enriching.has(item.id);
  const where = item.url ? host(item.url) : item.fileName ? ext(item.fileName) : "";
  const meta = [
    KIND_LABEL[item.kind] || "Item",
    where,
    `${estimateMinutes(item)} min`,
    item.intent && INTENT_LABEL[item.intent],
    item.suggested && "AI pick",
    item.sample && "Sample",
  ].filter(Boolean).map(esc).join(" · ");
  const summary = busy ? '<p class="summary accent">Reading it…</p>' : item.summary ? `<p class="summary">${esc(item.summary)}</p>` : "";
  const points = item.points && item.points.length ? `<ul class="points">${item.points.slice(0, 4).map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : "";
  let body = "";
  switch (item.kind) {
    case KIND.NOTE: {
      const t = item.text || item.title;
      body = `<blockquote class="quote ${t.length > 220 ? "long" : ""}">${esc(t)}</blockquote>${summary}${item.url ? linkRow(item.url) : ""}`;
      break;
    }
    case KIND.QUOTE: {
      const t = item.text || item.title;
      body = `<blockquote class="quote ${t.length > 220 ? "long" : ""}">${esc(t)}</blockquote>${item.author ? `<p class="cite">${esc(item.author)}</p>` : ""}${summary}`;
      break;
    }
    case KIND.LINK:
      body = `<h2 class="title">${esc(item.title)}</h2>${summary}${item.text ? `<p class="summary">${esc(item.text)}</p>` : ""}${points}${linkRow(item.url)}`;
      break;
    case KIND.PHOTO:
      body = `<div class="media">${imgTag(item, true)}</div><h2 class="title">${esc(item.title)}</h2>${summary}`;
      break;
    case KIND.VIDEO:
      body = item.blobId
        ? `<div class="media"><video controls playsinline preload="metadata" data-blob="${esc(item.blobId)}"></video></div><h2 class="title">${esc(item.title)}</h2>${summary}`
        : `<div class="media wide">${item.imageUrl ? `<img alt="" onerror="this.remove()" src="${esc(item.imageUrl)}" loading="lazy">` : ""}<span class="play">${I.play}</span></div>
           <h2 class="title">${esc(item.title)}</h2>${item.author ? `<p class="cite">${esc(item.author)}</p>` : ""}${summary}${item.url ? linkRow(item.url, item.videoId ? "Watch" : "Open") : ""}`;
      break;
    default:
      body = `<h2 class="title">${esc(item.title)}</h2>
        <div class="file-tag"><span class="ext">${esc(item.kind === KIND.PDF ? "PDF" : ext(item.fileName))}</span><span class="name">${esc(item.fileName || "")}${item.size ? " · " + size(item.size) : ""}</span></div>
        ${summary}${points}`;
  }
  const why = item.ai && item.ai.why ? `<p class="why"><b>Why today</b>${esc(item.ai.why)}</p>` : "";
  return `<div class="card-body"><span class="meta">${meta}</span>${body}${why}</div>`;
}

function linkRow(url, label = "Open") {
  return `<a class="link-row" href="${esc(url)}" target="_blank" rel="noopener">${I.open}<span>${label}</span><span class="host">${esc(host(url))}</span></a>`;
}

/** An <img> for a photo item: a stored file (hydrated later) or a web image. */
function imgTag(item, thumb = false) {
  // A picture that can't load (offline, moved) removes its frame instead of showing a broken box.
  const gone = `onerror="this.closest('.media')?.remove()"`;
  if (item.blobId) return `<img alt="${esc(item.title)}" ${gone} data-blob="${esc(thumb ? item.thumbId || item.blobId : item.blobId)}">`;
  return item.imageUrl ? `<img alt="${esc(item.title)}" ${gone} src="${esc(item.imageUrl)}" loading="lazy">` : "";
}

/* ================= Inbox ================= */

function renderInbox() {
  const inbox = state.items.filter((i) => i.status === STATUS.INBOX).sort((a, b) => a.created - b.created);
  const item = inbox[0];
  if (!item) {
    app.innerHTML = `<div class="screen no-actions">
      ${topBar("Inbox", { count: "0 waiting" })}
      <section class="card"><div class="card-body"><div class="state">
        <h2>Inbox clear.</h2>
        <p>New saves land here first. Each gets one tap: let go, later, done or read.</p>
        <div class="stack"><button class="btn primary" type="button" data-go="capture">Add something ${I.plus}</button>
        <button class="btn" type="button" data-go="edition">Go to today's edition ${I.arrow}</button></div>
      </div></div></section>
      ${tabBar("inbox")}
    </div>`;
    bindCommon();
    return;
  }
  app.innerHTML = `<div class="screen">
    ${topBar("Inbox", { count: `1 of ${inbox.length}` })}
    <article class="card tcard" data-card="${esc(item.id)}" data-id="${esc(item.id)}">${cardBody(item)}</article>
    ${actionBar(item.id, "inbox")}
    ${tabBar("inbox")}
  </div>`;
  bindCommon();
  hydrate(app);
  bindSwipe();
}

/** Swipe the triage card: left lets go, right reads, up keeps for later. */
function bindSwipe() {
  const card = $(".tcard", app);
  if (!card) return;
  const stamp = document.createElement("span");
  stamp.className = "stamp";
  stamp.setAttribute("aria-hidden", "true");
  card.appendChild(stamp);
  let x0 = 0, y0 = 0, dx = 0, dy = 0, active = false;
  const decide = () => {
    if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.5) return dx > 0 ? VERDICT.READ_NOW : VERDICT.LET_GO;
    if (dy < -110 && Math.abs(dy) > Math.abs(dx) * 1.5) return VERDICT.LATER;
    return null;
  };
  const words = { [VERDICT.READ_NOW]: "Read", [VERDICT.LET_GO]: "Let go", [VERDICT.LATER]: "Later" };
  card.addEventListener("pointerdown", (e) => {
    if (e.target.closest("a, button, video, input")) return;
    active = true; x0 = e.clientX; y0 = e.clientY; dx = dy = 0;
  });
  card.addEventListener("pointermove", (e) => {
    if (!active) return;
    dx = e.clientX - x0; dy = e.clientY - y0;
    // Only follow the finger once the gesture is clearly a swipe, so scrolling the card stays smooth.
    if (Math.abs(dx) < 12 && dy > -12) return;
    if (!card.hasPointerCapture(e.pointerId)) { card.setPointerCapture(e.pointerId); card.classList.add("dragging"); }
    card.style.transform = `translate(${dx}px, ${Math.min(0, dy)}px) rotate(${dx / 30}deg)`;
    const v = decide();
    stamp.textContent = v ? words[v] : "";
    stamp.style.opacity = v ? "1" : "0";
    stamp.style.color = v === VERDICT.READ_NOW ? "var(--accent)" : v === VERDICT.LET_GO ? "var(--warn)" : "var(--text)";
  });
  const reset = () => { card.classList.remove("dragging"); card.style.transform = ""; stamp.style.opacity = "0"; };
  card.addEventListener("pointerup", () => {
    if (!active) return;
    active = false;
    const v = decide();
    if (!v) { reset(); return; }
    card.classList.remove("dragging");
    card.style.transform = v === VERDICT.LATER ? "translate(0, -110%)" : `translate(${dx > 0 ? 110 : -110}%, 0) rotate(${dx / 20}deg)`;
    card.style.opacity = "0";
    setTimeout(() => giveVerdict(card.dataset.id, v, "inbox"), 160);
  });
  card.addEventListener("pointercancel", () => { active = false; reset(); });
}

/* ================= Add ================= */

/*
 * One box takes anything. Type, paste or drop a link, a YouTube URL, a
 * quote, a thought, a photo or a file; Edition works out what each one is
 * and lists it before saving. Attach opens the system picker, which on a
 * phone offers the photo library, the camera and files.
 */
function renderCapture() {
  const c = counts(state.items);
  app.innerHTML = `<div class="screen no-actions" style="padding-bottom:calc(var(--safe-b) + 12px)">
    ${topBar("Add", { sub: c.inbox ? `${c.inbox} in inbox` : "", settings: false,
      trail: `<button class="icon-btn" type="button" id="cap-close" aria-label="Close">${I.close}</button>` })}
    <section class="capture">
      <label class="sr-only" for="cap-text">Link, note, quote or anything</label>
      <textarea id="cap-text" placeholder="Paste a link or a quote, or type a thought.">${esc(state.capText)}</textarea>
      <div class="tray" id="cap-tray"></div>
      <ul class="detect" id="cap-detect" aria-live="polite"></ul>
      <span class="st" id="cap-st" role="status"></span>
    </section>
    <div class="cap-bar">
      <button class="tool" type="button" id="cap-paste" aria-label="Paste from clipboard">${I.paste}</button>
      <button class="save" type="button" id="cap-save">Save to inbox</button>
      <button class="tool" type="button" id="cap-attach" aria-label="Attach photos or files">${I.attach}</button>
    </div>
    <input type="file" id="in-any" multiple hidden>
  </div>`;
  const ta = $("#cap-text");
  ta.addEventListener("input", () => { state.capText = ta.value; updateDetect(); });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveCapture(); });
  ta.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (!files.length) return;
    e.preventDefault();
    stageFiles(files);
  });
  $("#cap-save").addEventListener("click", saveCapture);
  $("#cap-close").addEventListener("click", () => go(state.back || "edition"));
  $("#cap-attach").addEventListener("click", () => { unlock(); $("#in-any").click(); });
  $("#cap-paste").addEventListener("click", pasteIntoBox);
  const input = $("#in-any");
  input.addEventListener("change", () => {
    stageFiles(Array.from(input.files || []));
    input.value = "";
  });
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
    return `<li>${I.arrow}<span class="what">${esc(describeDraft(d))}</span><span class="title-sm">${esc(detail)}</span></li>`;
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
  tray.innerHTML = state.capFiles.map((f, i) => `<div class="chip">
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

/** On the Add screen, paste and drop fill the box instead of saving straight away. */
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
  afterCapture(out);
}

/* ================= Reader ================= */

function openReader(item) {
  if (!item) return;
  closeReader();
  const el = document.createElement("div");
  el.className = "reader";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", item.title);
  const open = item.status === STATUS.QUEUED || item.status === STATUS.INBOX;
  let content = "";
  switch (item.kind) {
    case KIND.NOTE: content = `<div class="prose">${esc(item.text || item.title)}</div>`; break;
    case KIND.QUOTE: content = `<blockquote class="quote">${esc(item.text || item.title)}</blockquote>${item.author ? `<p class="cite">${esc(item.author)}</p>` : ""}`; break;
    case KIND.LINK: content = item.text ? `<div class="prose">${esc(item.text)}</div>` : ""; break;
    case KIND.PHOTO: content = `<div class="media">${imgTag(item)}</div>`; break;
    case KIND.VIDEO: content = item.videoId
      ? `<div class="yt"><iframe title="${esc(item.title)}" src="https://www.youtube-nocookie.com/embed/${esc(item.videoId)}?playsinline=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`
      : item.blobId ? `<div class="media"><video controls playsinline data-blob="${esc(item.blobId)}"></video></div>` : ""; break;
    case KIND.AUDIO: content = `<audio controls data-blob="${esc(item.blobId)}"></audio>`; break;
    case KIND.TEXT: content = `<div class="prose" data-textblob="${esc(item.blobId)}">Loading…</div>`; break;
    case KIND.PDF: content = `<iframe class="doc" title="${esc(item.title)}" data-blob="${esc(item.blobId)}"></iframe>`; break;
    default: content = `<div class="file-tag"><span class="ext">${esc(ext(item.fileName))}</span><span class="name">${esc(item.fileName || "")}</span></div>`;
  }
  const sourceHref = item.blobId ? `data-blob="${esc(item.blobId)}" href="#"` : item.url ? `href="${esc(item.url)}"` : "";
  const openBtn = sourceHref
    ? `<a class="act" ${sourceHref} target="_blank" rel="noopener">${I.open}<span>Open</span></a>`
    : `<button class="act" type="button" disabled>${I.open}<span>Open</span></button>`;
  const actions = open
    ? `<button class="act" type="button" data-rv="${VERDICT.LET_GO}">${I.letGo}<span>Let go</span></button>
       <button class="act" type="button" data-rv="${VERDICT.LATER}">${I.later}<span>Later</span></button>
       ${openBtn}
       <button class="act primary" type="button" data-rv="${VERDICT.DONE}">${I.done}<span>Done</span></button>`
    : `<button class="act" type="button" data-requeue>${I.requeue}<span>Requeue</span></button>
       ${openBtn}
       <span></span>
       <button class="act primary" type="button" data-close>${I.done}<span>Close</span></button>`;
  el.innerHTML = `<div class="screen">
    ${topBar(KIND_LABEL[item.kind] || "Item", { settings: false,
      lead: `<button class="icon-btn" type="button" data-close aria-label="Back" style="margin-left:-12px">${I.back}</button>`,
      count: `<span id="time-left"></span>` })}
    <div class="reader-main">
      <div class="reader-scroll" id="reader-scroll">
        <span class="meta">${esc(item.url ? host(item.url) : item.fileName || KIND_LABEL[item.kind])} · ${estimateMinutes(item)} min</span>
        ${item.kind === KIND.QUOTE || item.kind === KIND.NOTE ? "" : `<h2 class="title">${esc(item.title)}</h2>`}
        ${content}
        ${item.summary ? `<p class="summary">${esc(item.summary)}</p>` : ""}
        ${item.points && item.points.length ? `<ul class="points">${item.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
        ${item.transcript ? `<span class="meta">Text in the image</span><div class="prose">${esc(item.transcript)}</div>` : ""}
      </div>
      <div class="rail" id="rail" role="slider" tabindex="0" aria-label="Reading position" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="fill" id="rail-fill"></span></div>
    </div>
    <div class="actions">${actions}</div>
  </div>`;
  document.body.appendChild(el);
  hydrate(el);
  el.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeReader));
  el.querySelectorAll("[data-rv]").forEach((b) => b.addEventListener("click", () => {
    closeReader();
    giveVerdict(item.id, b.dataset.rv, item.status === STATUS.INBOX ? "inbox" : "edition");
  }));
  const rq = $("[data-requeue]", el);
  if (rq) rq.addEventListener("click", async () => { await saveItem(restore(item)); closeReader(); render(); toast("Back in the queue."); });
  bindRail(el, item);
  $("[data-close]", el).focus();
}

/** The thin rail on the reader's right edge: shows progress, and scrolls when dragged. */
function bindRail(el, item) {
  const sc = $("#reader-scroll", el), rail = $("#rail", el), fill = $("#rail-fill", el), left = $("#time-left", el);
  const total = estimateMinutes(item) * 60;
  const update = () => {
    const max = sc.scrollHeight - sc.clientHeight;
    rail.hidden = max <= 4; // nothing to scroll, nothing to show
    const p = max > 0 ? sc.scrollTop / max : 1;
    fill.style.height = `${Math.round(p * 100)}%`;
    rail.setAttribute("aria-valuenow", String(Math.round(p * 100)));
    const s = Math.round(total * (1 - p));
    left.textContent = s > 0 ? `${Math.floor(s / 60)}:${pad(s % 60)} left` : "End";
  };
  sc.addEventListener("scroll", update, { passive: true });
  const seek = (clientY) => {
    const r = rail.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (clientY - r.top) / r.height));
    sc.scrollTop = p * (sc.scrollHeight - sc.clientHeight);
  };
  let dragging = false;
  rail.addEventListener("pointerdown", (e) => { dragging = true; rail.setPointerCapture(e.pointerId); seek(e.clientY); });
  rail.addEventListener("pointermove", (e) => { if (dragging) seek(e.clientY); });
  rail.addEventListener("pointerup", () => { dragging = false; });
  rail.addEventListener("pointercancel", () => { dragging = false; });
  rail.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sc.scrollBy({ top: sc.clientHeight * 0.8, behavior: "smooth" }); }
    if (e.key === "ArrowUp") { e.preventDefault(); sc.scrollBy({ top: -sc.clientHeight * 0.8, behavior: "smooth" }); }
  });
  setTimeout(update, 50);
}

function closeReader() {
  const r = $(".reader");
  if (r) r.remove();
}

/* ================= Library ================= */

function libraryMatches() {
  const status = LIB_FILTERS[state.libFilter].id;
  const q = state.libQuery.trim().toLowerCase();
  return state.items
    .filter((i) => status === "all" || i.status === status)
    .filter((i) => !q || [i.title, i.text, i.url, i.summary, i.fileName, i.author, i.transcript, ...(i.points || []), ...(i.tags || [])].some((s) => s && s.toLowerCase().includes(q)))
    .sort((a, b) => (b.doneAt || b.archivedAt || b.created) - (a.doneAt || a.archivedAt || a.created));
}

function renderLibrary() {
  app.innerHTML = `<div class="screen">
    ${topBar("Library", { count: `<span id="lib-count"></span>` })}
    <div class="list" id="lib-list"></div>
    <div class="lib-tools">
      <div class="find-wrap">${I.search}<label class="sr-only" for="lib-q">Search</label>
        <input class="find" id="lib-q" type="search" placeholder="Search everything" value="${esc(state.libQuery)}" enterkeyhint="search"></div>
      <div class="seg" role="group" aria-label="Show">
        ${LIB_FILTERS.map((f, i) => `<button type="button" data-filter="${i}" aria-pressed="${state.libFilter === i}">${f.label}</button>`).join("")}
      </div>
    </div>
    ${tabBar("library")}
  </div>`;
  bindCommon();
  renderList();
  const q = $("#lib-q");
  q.addEventListener("input", () => { state.libQuery = q.value; renderList(); });
  app.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => {
    state.libFilter = +b.dataset.filter;
    app.querySelectorAll("[data-filter]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderList();
  }));
}

function renderList() {
  const list = libraryMatches();
  $("#lib-count").textContent = `${list.length} of ${state.items.length}`;
  $("#lib-list").innerHTML = list.length
    ? list.map((i) => `<button class="row" type="button" data-open="${esc(i.id)}">
        <span class="t">${esc(i.title)}</span>
        <span class="a">${ago(i.created, true)}</span>
        <span class="k">${esc(KIND_LABEL[i.kind] || "")}${i.washedOut ? " · washed out" : ""}</span></button>`).join("")
    : '<p class="empty">Nothing matches.</p>';
  $("#lib-list").querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openReader(byId(b.dataset.open))));
}

async function oneMore() {
  const ids = new Set(state.edition.ids);
  const extra = buildEdition(state.items.filter((i) => !ids.has(i.id)), null, { size: 1 });
  if (!extra.ids.length) { toast("The queue is empty."); return; }
  state.edition = { ...state.edition, ids: [...state.edition.ids, extra.ids[0]] };
  await db.meta.set("edition", state.edition);
  render();
}

/* ================= Settings ================= */

function openSettings() {
  const c = counts(state.items);
  const wrap = sheet(`
    ${topBar("Settings", { settings: false, trail: `<button class="icon-btn" type="button" data-close aria-label="Close">${I.close}</button>` })}
    <div class="section">
      <h3>AI (Anthropic API)</h3>
      <div class="field"><label for="set-key">API key</label>
        <input id="set-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(ai.settings.key())}"></div>
      <div class="field"><label for="set-model">Model</label>
        <input id="set-model" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(ai.settings.model())}"></div>
      <div class="two">
        <button class="btn primary" type="button" id="set-save">Save and test</button>
        <button class="btn" type="button" id="set-clear">Remove key</button>
      </div>
      <span class="st" id="set-st" role="status"></span>
      <p class="note">The key stays on this device and is sent only to Anthropic. With it, Edition titles and tags each new save (photos and PDFs too), ranks your queue from what you finish and let go, and can search for new reading. Each is a paid API call on your account.</p>
    </div>
    <div class="section">
      <h3>Edition</h3>
      <button class="btn" type="button" id="set-rebuild">Rebuild today's edition ${I.requeue}</button>
      <button class="btn" type="button" id="set-discover" ${ai.settings.enabled() ? "" : "disabled"}>Find something new ${I.search}</button>
      <span class="st" id="set-ed-st" role="status"></span>
    </div>
    <div class="section">
      <h3>Sounds</h3>
      <div class="two seg" role="group" aria-label="Sounds" style="grid-template-columns:repeat(2,minmax(0,1fr))">
        <button type="button" data-sound="1" aria-pressed="${soundOn()}">On</button>
        <button type="button" data-sound="0" aria-pressed="${!soundOn()}">Off</button>
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
    <p class="version">Edition ${VERSION} · ${c.inbox} inbox · ${c.queued} queued · ${c.done} done · ${c.archived} let go</p>`);

  const st = $("#set-st", wrap);
  const say = (el, msg, err) => { el.textContent = msg; el.classList.toggle("err", !!err); };
  $("#set-save", wrap).addEventListener("click", async () => {
    ai.settings.setKey($("#set-key", wrap).value.trim());
    ai.settings.setModel($("#set-model", wrap).value.trim() || ai.DEFAULT_MODEL);
    if (!ai.settings.enabled()) { say(st, "No key saved."); return; }
    say(st, "Testing…");
    try {
      await ai.testKey();
      say(st, "Key works. Reading your saves now.");
      state.items = state.items.map((i) => ({ ...i, enrichTries: 0 }));
      $("#set-discover", wrap).disabled = false;
      enrichPending();
    } catch (e) { say(st, e.message, true); }
  });
  $("#set-clear", wrap).addEventListener("click", () => {
    ai.settings.setKey("");
    $("#set-key", wrap).value = "";
    say(st, "Key removed. Edition works without AI.");
  });
  const edSt = $("#set-ed-st", wrap);
  $("#set-rebuild", wrap).addEventListener("click", async () => {
    say(edSt, ai.settings.enabled() ? "Ranking your queue…" : "Rebuilding…");
    try {
      await ensureEdition({ force: true });
      closeSheet(); go("edition"); toast("Today's edition is rebuilt.");
    } catch (e) { say(edSt, e.message || "Could not rebuild.", true); }
  });
  $("#set-discover", wrap).addEventListener("click", () => findNew(edSt));
  const smSt = $("#set-sm-st", wrap);
  $("#set-samples-load", wrap).addEventListener("click", async () => {
    const n = await seedSamples({ force: true });
    await ensureEdition();
    $("#set-samples-clear", wrap).disabled = false;
    say(smSt, n ? `Loaded ${n} sample items.` : "Samples are already loaded.");
    render();
  });
  $("#set-samples-clear", wrap).addEventListener("click", async () => {
    const n = await removeSamples();
    $("#set-samples-clear", wrap).disabled = true;
    say(smSt, `Removed ${n} sample items.`);
    render();
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
      closeSheet(); render(); toast(`Imported ${n} items.`);
    } catch (e) { say(st, e.message, true); }
  });
}

/* ================= Sheets, toasts, global input ================= */

let lastFocus = null;
function sheet(html) {
  closeSheet();
  lastFocus = document.activeElement;
  const wrap = document.createElement("div");
  wrap.className = "sheet-wrap";
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="Settings">${html}</div>`;
  wrap.addEventListener("click", (e) => { if (e.target === wrap) closeSheet(); });
  wrap.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeSheet));
  document.body.appendChild(wrap);
  return wrap;
}

function closeSheet() {
  const s = $(".sheet-wrap");
  if (s) s.remove();
  if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
}

let toastTimer;
function toast(msg, { action, onAction } = {}) {
  const old = $(".toast");
  if (old) old.remove();
  clearTimeout(toastTimer);
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action)}</button>` : ""}`;
  if (action) $("button", el).addEventListener("click", () => { el.remove(); onAction && onAction(); });
  document.body.appendChild(el);
  toastTimer = setTimeout(() => el.remove(), action ? 5000 : 2500);
}

function wireGlobal() {
  // The first touch anywhere unlocks sounds on iOS.
  window.addEventListener("pointerdown", unlock, { once: true });
  // iOS ignores the viewport's zoom limits; block pinch gestures on the page itself.
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  // Paste anywhere outside a text field captures straight to the inbox.
  document.addEventListener("paste", async (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (!e.clipboardData) return;
    e.preventDefault();
    if (state.view === "capture") { stageTransfer(e.clipboardData); return; }
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
    if (state.view === "capture") { stageTransfer(e.dataTransfer); return; }
    afterCapture(await captureTransfer(e.dataTransfer, "drop"));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if ($(".reader")) closeReader();
    else if ($(".sheet-wrap")) closeSheet();
    else if (state.view === "capture") go(state.back || "edition");
  });
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    const before = state.items.length;
    const day = state.edition && state.edition.date;
    await importShares();
    await ensureEdition();
    if (state.items.length !== before || (state.edition && state.edition.date !== day)) {
      if (!document.querySelector(".sheet-wrap, .reader")) render();
      enrichPending();
    }
  });
}

/* ================= Small formatters ================= */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function pad(n) { return String(n).padStart(2, "0"); }
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
  app.innerHTML = `<div class="screen no-actions"><div class="state"><h2>Something broke.</h2><p>${esc(e && e.message)}</p></div></div>`;
});
