/*
 * Edition app shell: the five screens (Edition, Inbox, Capture, Reader,
 * Library), their wheels, and the glue between capture, storage, the model
 * and the AI. Rendering is plain template strings; every value from an item
 * goes through esc(). Wheels are created after each render and update only
 * the part of the screen they drive, so a turn is never interrupted.
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
import { createWheel, createDial } from "./wheel.js";
import { tick, unlock, soundOn, setSound } from "./feel.js";

export const VERSION = "2.2.0";

const KIND_LABEL = { link: "Link", note: "Note", quote: "Quote", photo: "Photo", pdf: "PDF", text: "Text", video: "Video", audio: "Audio", file: "File" };
const GEAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><path d="M14 4v6M6 14v6"/></svg>';

// The bottom verdict wheel on edition pages, and the corner dial in triage.
const WHEEL_VERDICTS = [
  { label: "Let go", v: VERDICT.LET_GO },
  { label: "Later", v: VERDICT.LATER },
  { label: "Read", v: VERDICT.READ_NOW },
  { label: "Done", v: VERDICT.DONE },
];
const DIAL_VERDICTS = [
  { label: "Let go", v: VERDICT.LET_GO },
  { label: "Later", v: VERDICT.LATER },
  { label: "Done", v: VERDICT.DONE },
  { label: "Read", v: VERDICT.READ_NOW },
];
const INTENT_LABEL = { read: "To read", watch: "To watch", listen: "To listen", reference: "Reference", idea: "Idea", task: "Task" };
const LIB_STATUS = [
  { label: "Inbox", id: STATUS.INBOX },
  { label: "Queue", id: STATUS.QUEUED },
  { label: "Done", id: STATUS.DONE },
  { label: "Let go", id: STATUS.ARCHIVED },
  { label: "All", id: "all" },
];
const LIB_KIND = [
  { label: "All", kinds: null },
  { label: "Links", kinds: [KIND.LINK] },
  { label: "Notes", kinds: [KIND.NOTE, KIND.TEXT] },
  { label: "Quotes", kinds: [KIND.QUOTE] },
  { label: "Video", kinds: [KIND.VIDEO] },
  { label: "Photos", kinds: [KIND.PHOTO] },
  { label: "PDFs", kinds: [KIND.PDF] },
  { label: "Files", kinds: [KIND.FILE, KIND.AUDIO] },
];

const state = {
  items: [],
  edition: null,
  view: "edition",
  back: "edition",          // where Capture returns to
  edPage: 0,                // index into today's open pages
  edVerdict: 2,             // Read
  dialVerdict: 3,           // Read
  capText: "",              // what is in the capture box
  capFiles: [],             // files staged in the capture box: { file, url }
  lastSaved: null,
  libStatus: 1,             // Queue
  libKind: 0,               // All
  libQuery: "",
  showFind: false,
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
    state.edPage = 0;
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
  state.lastSaved = list[list.length - 1];
  tick(true);
  render();
  const st = $("#cap-st");
  if (st) { st.classList.remove("err"); st.textContent = `Saved ${list.length === 1 ? "1 item" : list.length + " items"} to your inbox.`; }
  toast(`Saved ${list.length === 1 ? "1 item" : list.length + " items"} to your inbox.`, {
    action: "Undo",
    onAction: async () => { await removeItems(list); state.lastSaved = null; render(); },
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

/** Redraw just the card if it is the item being shown, leaving wheels alone. */
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
  render();
  if (verdict === VERDICT.READ_NOW) { openReader(after); return; }
  const words = {
    [VERDICT.LET_GO]: after.washedOut ? "Washed out." : "Let go.",
    [VERDICT.LATER]: stage === "inbox" ? "Queued for a future edition." : after.washedOut ? "Deferred too often. Washed out." : "Moved to a later edition.",
    [VERDICT.DONE]: "Marked done.",
  };
  toast(words[verdict], { action: "Undo", onAction: async () => { await saveItem(before); render(); } });
}

/* ================= Rendering ================= */

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

function statusBar(left, right) {
  return `<div class="status mono"><span>${left}</span><span class="right"><span>${right}</span>
    <button class="icon-btn" type="button" data-act="settings" aria-label="Settings">${GEAR}</button></span></div>`;
}

function navBar(active, { find = false } = {}) {
  const c = counts(state.items);
  const b = (view, name, extra = "") => `<button class="btn" type="button" data-go="${view}" ${active === view ? 'aria-current="page"' : ""}>${name}${extra}</button>`;
  return `<nav class="nav" aria-label="Sections">
    ${b("edition", "Edition")}
    ${b("inbox", "Inbox", c.inbox ? `<span class="count">${c.inbox}</span>` : "")}
    ${b("library", "Library")}
    ${find
      ? `<button class="btn" type="button" data-act="find" aria-pressed="${state.showFind}" style="font:500 12px var(--mono)">Find</button>`
      : `<button class="btn add" type="button" data-go="capture" aria-label="Add something">+</button>`}
  </nav>`;
}

function bindCommon(root = app) {
  root.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));
  root.querySelectorAll('[data-act="settings"]').forEach((b) => b.addEventListener("click", openSettings));
  const disc = $('[data-act="discover"]', root);
  if (disc) disc.addEventListener("click", () => { disc.disabled = true; findNew($("#discover-st")).finally(() => { disc.disabled = false; }); });
  const more = $('[data-act="one-more"]', root);
  if (more) more.addEventListener("click", oneMore);
}

function dateLabel() {
  const d = new Date();
  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
}

/* ---------- G1 · Edition ---------- */

function renderEdition() {
  const v = editionView(state.items, state.edition);
  const c = counts(state.items);
  const open = v.open;
  state.edPage = Math.max(0, Math.min(state.edPage, open.length - 1));

  if (!open.length) {
    let body;
    if (!v.total) {
      body = `<div class="state">
        <span class="mono accent">${c.queued || c.inbox ? "Nothing set yet" : "Start here"}</span>
        <h1 class="headline">${c.inbox ? "Triage first." : "Drop something in."}</h1>
        <p>${c.inbox ? "New saves wait in your inbox. Each one you keep comes back here as a page of your daily edition." : "Tap + to save a link, a thought, a photo or a file. It goes to your inbox for a verdict, then comes back here."}</p>
        <div class="stack">${c.inbox
          ? `<button class="btn primary" type="button" data-go="inbox">Triage inbox <span>${c.inbox}</span></button>`
          : `<button class="btn primary" type="button" data-go="capture">Add something <span>+</span></button>`}</div></div>`;
    } else {
      const done = v.pages.filter((p) => p.status === STATUS.DONE).length;
      const gone = v.pages.filter((p) => p.status === STATUS.ARCHIVED).length;
      body = `<div class="state">
        <span class="mono accent">Edition complete · ${v.total} / ${v.total}</span>
        <h1 class="headline">Done.</h1>
        <p>${done} read, ${gone} let go, ${v.total - done - gone} moved later. The next edition is set tomorrow.</p>
        <div class="stack">
          ${c.inbox ? `<button class="btn" type="button" data-go="inbox">Triage inbox <span class="accent">${c.inbox}</span></button>` : ""}
          ${c.queued ? `<button class="btn" type="button" data-act="one-more">Read one more <span class="mono">From queue</span></button>` : ""}
          ${ai.settings.enabled() ? `<button class="btn primary" type="button" data-act="discover">Find something new <span class="mono">AI</span></button><span class="st" id="discover-st" role="status"></span>` : ""}
        </div></div>`;
    }
    app.innerHTML = `<div class="screen s-edition idle" style="grid-template-rows:auto minmax(0,1fr) auto">
      ${statusBar(`EDN / ${esc(dateLabel())}`, v.total ? `<span class="dot"></span>${pad(v.settled)} / ${pad(v.total)}` : "")}
      <section class="panel brackets card">${body}</section>
      ${navBar("edition")}
    </div>`;
    bindCommon();
    return;
  }

  const minutes = open.reduce((s, p) => s + estimateMinutes(p), 0);
  const item = open[state.edPage];
  app.innerHTML = `<div class="screen s-edition">
    ${statusBar(`EDN / ${esc(dateLabel())}`, `<span class="dot"></span><span id="ed-count">${pad(pageNo(item))} / ${pad(v.total)}</span> · ${minutes} MIN`)}
    <div class="edition-main">
      <article class="panel brackets card" data-card="${esc(item.id)}" id="ed-card">${cardBody(item)}</article>
      <div class="vwheel" id="page-wheel"></div>
    </div>
    <div class="verdict-row">
      <div class="hwheel" id="verdict-wheel"><span class="notch" aria-hidden="true"></span><span class="fade" aria-hidden="true"></span></div>
      <button class="btn primary press" type="button" id="press">Press<small>To set</small></button>
    </div>
    ${navBar("edition")}
  </div>`;
  bindCommon();
  hydrate($("#ed-card"));

  createWheel($("#page-wheel"), {
    id: "page-wheel",
    items: open.map((p) => ({ label: pad(pageNo(p)) })),
    index: state.edPage,
    axis: "y",
    spacing: 58,
    label: "Pages in today's edition",
    onChange: (i) => {
      state.edPage = i;
      const it = open[i];
      const card = $("#ed-card");
      card.dataset.card = it.id;
      card.innerHTML = cardBody(it);
      hydrate(card);
      $("#ed-count").textContent = `${pad(pageNo(it))} / ${pad(v.total)}`;
    },
  });
  const vw = createWheel($("#verdict-wheel"), {
    items: WHEEL_VERDICTS,
    index: state.edVerdict,
    axis: "x",
    spacing: 76,
    label: "Verdict",
    onChange: (i) => { state.edVerdict = i; },
    onCommit: (i) => giveVerdict(open[state.edPage].id, WHEEL_VERDICTS[i].v, "edition"),
  });
  $("#press").addEventListener("click", () => {
    tick(true);
    giveVerdict(open[state.edPage].id, WHEEL_VERDICTS[vw.index].v, "edition");
  });
}

function pageNo(item) {
  return (state.edition?.ids || []).indexOf(item.id) + 1;
}

/** The inside of a card: tags, headline, body set for the kind, and facts. */
function cardBody(item) {
  const busy = state.enriching.has(item.id);
  const len = (item.title || "").length;
  const hClass = len > 60 ? "headline s" : len > 34 ? "headline m" : "headline";
  const tags = [
    `<span class="tag kind">${KIND_LABEL[item.kind] || "Item"}</span>`,
    `<span class="tag">${estimateMinutes(item)} min</span>`,
    item.url ? `<span class="tag">${esc(host(item.url))}</span>` : item.fileName ? `<span class="tag">${esc(ext(item.fileName))}${item.size ? " · " + size(item.size) : ""}</span>` : "",
    item.intent && INTENT_LABEL[item.intent] ? `<span class="tag">${INTENT_LABEL[item.intent]}</span>` : "",
    item.suggested ? '<span class="tag ai">AI pick</span>' : "",
    item.sample ? '<span class="tag">Sample</span>' : "",
  ].join("");
  const points = item.points && item.points.length ? `<ul class="points">${item.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : "";
  const summary = busy ? '<p class="lede mono accent">Reading it…</p>' : item.summary ? `<p class="lede">${esc(item.summary)}</p>` : "";
  let body = "";
  switch (item.kind) {
    case KIND.NOTE: {
      const t = item.text || item.title;
      body = `<blockquote class="quote ${t.length > 220 ? "l" : ""}">${esc(t)}</blockquote>${summary}${item.url ? linkOut(item.url) : ""}`;
      break;
    }
    case KIND.QUOTE: {
      const t = item.text || item.title;
      body = `<blockquote class="quote ${t.length > 220 ? "l" : ""}">${esc(t)}</blockquote>${item.author ? `<p class="cite mono">${esc(item.author)}</p>` : ""}${summary}`;
      break;
    }
    case KIND.LINK:
      body = `<h1 class="${hClass}">${esc(item.title)}</h1>${summary}${item.text ? `<p class="lede">${esc(item.text)}</p>` : ""}${points}${linkOut(item.url)}`;
      break;
    case KIND.PHOTO:
      body = `<div class="figure">${imgTag(item, true)}</div><h1 class="headline s">${esc(item.title)}</h1>${summary}`;
      break;
    case KIND.VIDEO:
      body = item.blobId
        ? `<div class="figure"><video controls playsinline preload="metadata" data-blob="${esc(item.blobId)}"></video></div><h1 class="headline s">${esc(item.title)}</h1>${summary}`
        : `<div class="figure poster">${item.imageUrl ? `<img alt="" src="${esc(item.imageUrl)}" loading="lazy">` : ""}<span class="play" aria-hidden="true"></span></div>
           <h1 class="headline s">${esc(item.title)}</h1>${item.author ? `<p class="cite mono">${esc(item.author)}</p>` : ""}${summary}${item.url ? linkOut(item.url, item.videoId ? "Watch" : "Open source") : ""}`;
      break;
    default: {
      const glyph = item.kind === KIND.PDF ? "PDF" : item.kind === KIND.TEXT ? "TXT" : item.kind === KIND.AUDIO ? "AUD" : ext(item.fileName);
      body = `<div class="slab"><span class="mono muted">${esc(item.fileName || "")}</span><span class="glyph">${esc(glyph)}</span></div><h1 class="${hClass}">${esc(item.title)}</h1>${summary}${points}`;
    }
  }
  const facts = [
    item.ai && item.ai.why ? `<dt>Why today</dt><dd>${esc(item.ai.why)}</dd>` : "",
    `<dt>Saved</dt><dd>${ago(item.created)}${item.skips ? ` · moved later ${item.skips}×` : ""}</dd>`,
    item.tags && item.tags.length ? `<dt>Tags</dt><dd>${esc(item.tags.join(", "))}</dd>` : "",
  ].join("");
  return `<div class="card-body"><div class="tags">${tags}</div>${body}<dl class="facts">${facts}</dl></div>`;
}

function linkOut(url, label = "Open source") {
  return `<a class="link-out" href="${esc(url)}" target="_blank" rel="noopener">${label} <span class="mono muted">${esc(host(url))} ↗</span></a>`;
}

/** An <img> for a photo item: a stored file (hydrated later) or a web image. */
function imgTag(item, thumb = false) {
  if (item.blobId) return `<img alt="${esc(item.title)}" data-blob="${esc(thumb ? item.thumbId || item.blobId : item.blobId)}">`;
  return item.imageUrl ? `<img alt="${esc(item.title)}" src="${esc(item.imageUrl)}" loading="lazy">` : "";
}

/* ---------- G2 · Inbox triage ---------- */

function renderInbox() {
  const inbox = state.items.filter((i) => i.status === STATUS.INBOX).sort((a, b) => a.created - b.created);
  if (!inbox.length) {
    app.innerHTML = `<div class="screen s-inbox idle" style="grid-template-rows:auto minmax(0,1fr) auto">
      ${statusBar("Inbox / triage", "0 waiting")}
      <section class="panel brackets card"><div class="state">
        <span class="mono accent">Inbox zero</span>
        <h1 class="headline">All clear.</h1>
        <p>New saves land here first. Each gets one verdict: let go, keep for later, already done, or read it now.</p>
        <div class="stack"><button class="btn primary" type="button" data-go="capture">Add something <span>+</span></button>
        <button class="btn" type="button" data-go="edition">Back to the edition <span>→</span></button></div>
      </div></section>
      ${navBar("inbox")}
    </div>`;
    bindCommon();
    return;
  }
  const item = inbox[0];
  app.innerHTML = `<div class="screen s-inbox">
    ${statusBar("Inbox / triage", `<span class="accent">01</span> / ${pad(inbox.length)} waiting`)}
    <article class="panel brackets card tcard" data-card="${esc(item.id)}" data-id="${esc(item.id)}">${cardBody(item)}</article>
    <div class="inbox-foot">
      <div class="stack-nav">
        <span class="mono muted" style="font-size:10px;line-height:1.5;margin-bottom:2px">Turn the dial.<br>Press set.</span>
        <button class="btn" type="button" data-go="edition">Edition</button>
        <button class="btn" type="button" data-go="inbox" aria-current="page">Inbox <span class="accent">${inbox.length}</span></button>
        <button class="btn" type="button" data-go="library">Library</button>
        <button class="btn" type="button" data-go="capture">+ Add</button>
      </div>
      <div id="dial"></div>
    </div>
  </div>`;
  bindCommon();
  hydrate(app);
  createDial($("#dial"), {
    items: DIAL_VERDICTS,
    index: state.dialVerdict,
    onChange: (i) => { state.dialVerdict = i; },
    onCommit: (i) => giveVerdict(item.id, DIAL_VERDICTS[i].v, "inbox"),
  });
  bindSwipe();
}

/** Swipe the triage card: left lets go, right reads now, up keeps for later. */
function bindSwipe() {
  const card = $(".tcard", app);
  if (!card) return;
  const stamp = document.createElement("span");
  stamp.className = "stamp";
  stamp.setAttribute("aria-hidden", "true");
  card.appendChild(stamp);
  let x0 = 0, y0 = 0, dx = 0, dy = 0, active = false;
  const decide = () => {
    if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy)) return dx > 0 ? VERDICT.READ_NOW : VERDICT.LET_GO;
    if (dy < -90 && Math.abs(dy) > Math.abs(dx)) return VERDICT.LATER;
    return null;
  };
  const words = { [VERDICT.READ_NOW]: "Read", [VERDICT.LET_GO]: "Let go", [VERDICT.LATER]: "Later" };
  card.addEventListener("pointerdown", (e) => {
    if (e.target.closest("a, button, video, input")) return;
    active = true; x0 = e.clientX; y0 = e.clientY; dx = dy = 0;
    card.classList.add("dragging");
  });
  card.addEventListener("pointermove", (e) => {
    if (!active) return;
    dx = e.clientX - x0; dy = e.clientY - y0;
    if (Math.abs(dx) > 8 && !card.hasPointerCapture(e.pointerId)) card.setPointerCapture(e.pointerId);
    card.style.transform = `translate(${dx}px, ${Math.min(dy, 30)}px) rotate(${dx / 26}deg)`;
    const v = decide();
    stamp.textContent = v ? words[v] : "";
    stamp.style.opacity = v ? "1" : "0";
    stamp.style.color = v === VERDICT.READ_NOW ? "var(--accent)" : v === VERDICT.LET_GO ? "var(--warn)" : "var(--text)";
  });
  const end = () => {
    if (!active) return;
    active = false;
    card.classList.remove("dragging");
    const v = decide();
    if (!v) { card.style.transform = ""; stamp.style.opacity = "0"; return; }
    tick(true);
    card.style.transform = v === VERDICT.LATER ? "translate(0, -120%)" : `translate(${dx > 0 ? 140 : -140}%, ${dy}px) rotate(${dx / 12}deg)`;
    card.style.opacity = "0";
    setTimeout(() => giveVerdict(card.dataset.id, v, "inbox"), 180);
  };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", () => { active = false; card.classList.remove("dragging"); card.style.transform = ""; stamp.style.opacity = "0"; });
}

/* ---------- G3 · Capture ---------- */

/*
 * One box takes anything. Type, paste or drop a link, a YouTube URL, a
 * quote, a thought, a photo or a file; Edition works out what each one is
 * and shows it before saving. Attach opens the system picker, which on a
 * phone already offers the photo library, the camera and files.
 */
const CLIP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/></svg>';
const PASTE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3"/></svg>';

function renderCapture() {
  const c = counts(state.items);
  app.innerHTML = `<div class="screen s-capture">
    <div class="status mono"><span>Capture · to inbox${c.inbox ? ` · <span class="accent">${c.inbox}</span> waiting` : ""}</span>
      <button class="icon-btn" type="button" id="cap-close" aria-label="Close" style="font:500 15px var(--body)">✕</button></div>
    <section class="panel brackets capture-panel" id="cap-panel">
      <label class="mono accent" for="cap-text">Drop anything</label>
      <textarea id="cap-text" placeholder="Paste a link, a YouTube URL or a quote. Type a thought. Attach photos or files.">${esc(state.capText)}</textarea>
      <div class="tray" id="cap-tray"></div>
      <ul class="detect" id="cap-detect" aria-live="polite"></ul>
      <span class="st" id="cap-st" role="status"></span>
    </section>
    <div class="shutter-row">
      <button class="square tool" type="button" id="cap-paste" aria-label="Paste from clipboard">${PASTE}<span class="mono">Paste</span></button>
      <button class="shutter" type="button" id="shutter" aria-label="Save to inbox"><span></span></button>
      <button class="square tool" type="button" id="cap-attach" aria-label="Attach photos or files">${CLIP}<span class="mono">Attach</span></button>
    </div>
    <div class="hint mono" id="cap-hint" style="font-size:10px">Edition sorts it for you</div>
    <input type="file" id="in-any" multiple hidden>
  </div>`;
  bindCommon();
  const ta = $("#cap-text");
  ta.addEventListener("input", () => { state.capText = ta.value; updateDetect(); });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) shutter(); });
  ta.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (!files.length) return;
    e.preventDefault();
    stageFiles(files);
  });
  $("#shutter").addEventListener("click", shutter);
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
  list.innerHTML = drafts.map((d) => `<li><span class="arrow">→</span><span class="what">${esc(describeDraft(d))}</span><span class="title">${esc(d.kind === KIND.NOTE || d.kind === KIND.QUOTE ? "" : d.fileName || (d.videoId ? "" : d.url) || "")}</span></li>`).join("");
  const hint = $("#cap-hint");
  if (hint) hint.textContent = drafts.length > 1 ? `Saves as ${drafts.length} items` : drafts.length ? "Press to save" : "Edition sorts it for you";
  $("#shutter").classList.toggle("ready", drafts.length > 0);
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
      ${f.url ? `<img alt="" src="${f.url}">` : `<span class="glyph mono">${esc(ext(f.file.name))}</span>`}
      <button type="button" data-unstage="${i}" aria-label="Remove ${esc(f.file.name)}">✕</button></div>`).join("");
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
      const ta = $("#cap-text");
      state.capText = state.capText.trim() ? `${state.capText.trim()}\n${text}` : text;
      ta.value = state.capText;
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

/** On the capture screen, paste and drop fill the box instead of saving straight away. */
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

async function shutter() {
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

/* ---------- G4 · Reader ---------- */

function openReader(item) {
  if (!item) return;
  closeReader();
  const el = document.createElement("div");
  el.className = "reader";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", item.title);
  const open = item.status === STATUS.QUEUED || item.status === STATUS.INBOX;
  const page = pageNo(item);
  let content = "";
  switch (item.kind) {
    case KIND.NOTE: content = `<div class="prose">${esc(item.text || item.title)}</div>`; break;
    case KIND.QUOTE: content = `<blockquote class="quote">${esc(item.text || item.title)}</blockquote>${item.author ? `<p class="cite mono">${esc(item.author)}</p>` : ""}`; break;
    case KIND.LINK: content = item.text ? `<div class="prose">${esc(item.text)}</div>` : ""; break;
    case KIND.PHOTO: content = imgTag(item); break;
    case KIND.VIDEO: content = item.videoId
      ? `<div class="yt"><iframe title="${esc(item.title)}" src="https://www.youtube-nocookie.com/embed/${esc(item.videoId)}?playsinline=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`
      : item.blobId ? `<video controls playsinline data-blob="${esc(item.blobId)}"></video>` : ""; break;
    case KIND.AUDIO: content = `<audio controls data-blob="${esc(item.blobId)}"></audio>`; break;
    case KIND.TEXT: content = `<div class="prose" data-textblob="${esc(item.blobId)}">Loading…</div>`; break;
    case KIND.PDF: content = `<iframe title="${esc(item.title)}" data-blob="${esc(item.blobId)}"></iframe>`; break;
    default: content = `<div class="slab"><span class="mono muted">${esc(item.fileName || "")}</span><span class="glyph">${esc(ext(item.fileName))}</span></div>`;
  }
  const source = item.blobId
    ? `<a class="btn" data-blob="${esc(item.blobId)}" href="#" target="_blank" rel="noopener">Open ↗</a>`
    : item.url ? `<a class="btn" href="${esc(item.url)}" target="_blank" rel="noopener">Source ↗</a>` : `<button class="btn" type="button" disabled>Source</button>`;
  const actions = open
    ? `<button class="btn" type="button" data-rv="${VERDICT.LET_GO}">Let go</button>
       <button class="btn" type="button" data-rv="${VERDICT.LATER}">Later</button>
       ${source}
       <button class="btn primary" type="button" data-rv="${VERDICT.DONE}" style="font-size:22px">Done</button>`
    : `<button class="btn" type="button" data-close>Close</button>
       <button class="btn" type="button" data-requeue>Requeue</button>
       ${source}
       <button class="btn primary" type="button" data-close style="font-size:22px">${item.status === STATUS.DONE ? "Done ✓" : "Close"}</button>`;
  el.innerHTML = `<div class="screen">
    <div class="status mono">
      <button class="icon-btn" type="button" data-close aria-label="Back" style="width:auto;padding:0 10px;font:500 11px var(--mono)">‹ Back</button>
      <span>${page ? `Reading · ${pad(page)} / ${pad(state.edition.ids.length)}` : esc(KIND_LABEL[item.kind] || "")}</span>
      <span class="accent" id="time-left"></span>
    </div>
    <div class="reader-main">
      <div class="reader-scroll" id="reader-scroll">
        <span class="mono muted">${esc(item.url ? host(item.url) : item.fileName || KIND_LABEL[item.kind])} · ${estimateMinutes(item)} min</span>
        <h1 class="headline">${esc(item.title)}</h1>
        ${item.summary ? `<p class="lede">${esc(item.summary)}</p>` : ""}
        ${item.points && item.points.length ? `<ul class="points">${item.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
        ${content}
        ${item.transcript ? `<span class="mono accent">Text in the image</span><div class="prose">${esc(item.transcript)}</div>` : ""}
      </div>
      <div class="swheel" id="swheel" role="slider" tabindex="0" aria-label="Scroll" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="fill" id="sfill"></span></div>
    </div>
    <div class="reader-actions">${actions}</div>
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
  bindScrollWheel(el, item);
  $("[data-close]", el).focus();
}

/** The knurled wheel on the reader's right edge: shows progress and scrolls when turned. */
function bindScrollWheel(el, item) {
  const sc = $("#reader-scroll", el), wheel = $("#swheel", el), fill = $("#sfill", el), left = $("#time-left", el);
  const total = estimateMinutes(item) * 60;
  let lastStep = 0;
  const update = () => {
    const max = sc.scrollHeight - sc.clientHeight;
    const p = max > 0 ? sc.scrollTop / max : 1;
    fill.style.height = `${Math.round(p * 100)}%`;
    wheel.setAttribute("aria-valuenow", String(Math.round(p * 100)));
    const s = Math.round(total * (1 - p));
    left.textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)} left`;
    const step = Math.floor(p * 12);
    if (step !== lastStep) { lastStep = step; tick(); }
  };
  sc.addEventListener("scroll", update, { passive: true });
  let drag = null;
  wheel.addEventListener("pointerdown", (e) => {
    drag = { y: e.clientY, top: sc.scrollTop };
    wheel.setPointerCapture(e.pointerId);
  });
  wheel.addEventListener("pointermove", (e) => {
    if (!drag) return;
    // Turning the wheel moves the text three times faster than the thumb.
    sc.scrollTop = drag.top + (e.clientY - drag.y) * 3;
  });
  wheel.addEventListener("pointerup", () => { drag = null; });
  wheel.addEventListener("pointercancel", () => { drag = null; });
  wheel.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sc.scrollBy({ top: sc.clientHeight * 0.8, behavior: "smooth" }); }
    if (e.key === "ArrowUp") { e.preventDefault(); sc.scrollBy({ top: -sc.clientHeight * 0.8, behavior: "smooth" }); }
  });
  setTimeout(update, 50);
}

function closeReader() {
  const r = $(".reader");
  if (r) r.remove();
}

/* ---------- G5 · Library ---------- */

function libraryMatches() {
  const status = LIB_STATUS[state.libStatus].id;
  const kinds = LIB_KIND[state.libKind].kinds;
  const q = state.libQuery.trim().toLowerCase();
  return state.items
    .filter((i) => status === "all" || i.status === status)
    .filter((i) => !kinds || kinds.includes(i.kind))
    .filter((i) => !q || [i.title, i.text, i.url, i.summary, i.fileName, i.author, i.transcript, ...(i.points || []), ...(i.tags || [])].some((s) => s && s.toLowerCase().includes(q)))
    .sort((a, b) => (b.doneAt || b.archivedAt || b.created) - (a.doneAt || a.archivedAt || a.created));
}

function renderLibrary() {
  app.innerHTML = `<div class="screen s-library">
    ${statusBar("Library", `<span id="lib-count"></span>`)}
    <div class="list" id="lib-list"></div>
    <div>${state.showFind ? `<label class="sr-only" for="lib-q">Search</label><input class="find" id="lib-q" type="search" placeholder="Search everything you saved" value="${esc(state.libQuery)}">` : ""}</div>
    <div class="drums">
      <div class="drum" id="drum-status"><span class="window" aria-hidden="true"></span><span class="drum-label mono muted" style="font-size:9px">Status</span></div>
      <div class="drum" id="drum-kind"><span class="window" aria-hidden="true"></span><span class="drum-label mono muted" style="font-size:9px">Kind</span></div>
    </div>
    ${navBar("library", { find: true })}
  </div>`;
  bindCommon();
  renderList();
  createWheel($("#drum-status"), {
    items: LIB_STATUS, index: state.libStatus, axis: "y", drum: true, spacing: 40, label: "Status",
    onChange: (i) => { state.libStatus = i; renderList(); },
  });
  createWheel($("#drum-kind"), {
    items: LIB_KIND, index: state.libKind, axis: "y", drum: true, spacing: 40, label: "Kind",
    onChange: (i) => { state.libKind = i; renderList(); },
  });
  $('[data-act="find"]').addEventListener("click", () => {
    state.showFind = !state.showFind;
    if (!state.showFind) state.libQuery = "";
    render();
    if (state.showFind) $("#lib-q").focus();
  });
  const q = $("#lib-q");
  if (q) q.addEventListener("input", () => { state.libQuery = q.value; renderList(); });
}

function renderList() {
  const list = libraryMatches();
  $("#lib-count").innerHTML = `<span class="accent">${list.length}</span> match · ${state.items.length} total`;
  $("#lib-list").innerHTML = list.length
    ? list.map((i) => `<button class="row" type="button" data-open="${esc(i.id)}">
        <span class="k ${i.status === STATUS.QUEUED ? "hot" : ""}">${esc((KIND_LABEL[i.kind] || "").toUpperCase())}</span>
        <span class="t">${esc(i.title)}</span>
        <span class="a">${i.washedOut ? "WASHED · " : ""}${shortAgo(i.created)}</span></button>`).join("")
    : '<p class="empty">Nothing matches. Turn the drums or clear the search.</p>';
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
    <div class="sheet-head"><h2>Settings</h2><button class="icon-btn" type="button" data-close aria-label="Close">✕</button></div>
    <div class="section">
      <span class="mono accent">AI · Anthropic API</span>
      <div class="field"><label class="mono" for="set-key">API key</label>
        <input id="set-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(ai.settings.key())}"></div>
      <div class="field"><label class="mono" for="set-model">Model</label>
        <input id="set-model" type="text" autocomplete="off" spellcheck="false" value="${esc(ai.settings.model())}"></div>
      <div class="two">
        <button class="btn primary" type="button" id="set-save">Save and test</button>
        <button class="btn" type="button" id="set-clear">Remove key</button>
      </div>
      <span class="st" id="set-st" role="status"></span>
      <p class="note">The key stays on this device and is sent only to Anthropic. With it, Edition reads each new save (photos and PDFs too) to title and tag it, ranks your queue from what you finish and let go, and can search for new reading. Each is a paid API call on your account.</p>
    </div>
    <div class="section">
      <span class="mono accent">Edition</span>
      <button class="btn" type="button" id="set-rebuild">Rebuild today's edition</button>
      <button class="btn" type="button" id="set-discover" ${ai.settings.enabled() ? "" : "disabled"}>Find something new</button>
      <span class="st" id="set-ed-st" role="status"></span>
    </div>
    <div class="section">
      <span class="mono accent">Wheel clicks</span>
      <div class="two" role="group" aria-label="Wheel click sound">
        <button class="btn ${soundOn() ? "outline" : ""}" type="button" data-sound="1" aria-pressed="${soundOn()}">Sound on</button>
        <button class="btn ${soundOn() ? "" : "outline"}" type="button" data-sound="0" aria-pressed="${!soundOn()}">Silent</button>
      </div>
      <p class="note">iPhone web apps can't vibrate, so each detent plays a short click instead.</p>
    </div>
    <div class="section">
      <span class="mono accent">Samples</span>
      <div class="two">
        <button class="btn" type="button" id="set-samples-load">Load samples</button>
        <button class="btn" type="button" id="set-samples-clear" ${state.items.some((i) => i.sample) ? "" : "disabled"}>Remove samples</button>
      </div>
      <span class="st" id="set-sm-st" role="status"></span>
      <p class="note">Example links, YouTube videos, quotes, notes and stock photos across the inbox, queue and history. Your own items are never touched.</p>
    </div>
    <div class="section">
      <span class="mono accent">Backup</span>
      <div class="two">
        <button class="btn" type="button" id="set-export">Export</button>
        <button class="btn" type="button" id="set-import">Import</button>
      </div>
      <input type="file" id="set-import-file" accept="application/json,.json" hidden>
      <p class="note">Exports titles, notes, links and history as JSON. Photos and files stay on this device.</p>
    </div>
    <p class="mono muted">Edition ${VERSION} · ${c.inbox} inbox · ${c.queued} queued · ${c.done} done · ${c.archived} let go</p>`);

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
    wrap.querySelectorAll("[data-sound]").forEach((x) => {
      const on = x === b;
      x.classList.toggle("outline", on);
      x.setAttribute("aria-pressed", String(on));
    });
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
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
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
  toastTimer = setTimeout(() => el.remove(), action ? 6000 : 3000);
}

function wireGlobal() {
  // The first touch anywhere unlocks wheel click sounds on iOS.
  window.addEventListener("pointerdown", unlock, { once: true });
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
function ago(ts) {
  const d = Math.floor((Date.now() - ts) / 86400000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}
function shortAgo(ts) { return `${Math.max(0, Math.floor((Date.now() - ts) / 86400000))}D`; }
function host(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }
function ext(name) { const e = String(name || "").split(".").pop(); return e && e !== name ? e.slice(0, 4).toUpperCase() : "FILE"; }
function size(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; }
function withTimeout(p, ms) { return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("Timed out")), ms))]); }

boot().catch((e) => {
  app.innerHTML = `<div class="screen"><div class="state"><h1 class="headline">Something broke.</h1><p>${esc(e && e.message)}</p></div></div>`;
});
