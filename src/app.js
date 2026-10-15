/*
 * Edition app shell: views, gestures and the glue between capture,
 * storage, the model and the AI. Rendering is plain template strings;
 * every value from an item goes through esc().
 */

import {
  VERDICT, STATUS, KIND, dayKey, applyVerdict, restore, buildEdition, editionView,
  interestProfile, estimateMinutes, counts, migrateLegacy, createItem, EDITION_SIZE,
} from "./model.js";
import * as db from "./db.js";
import { captureText, captureFile, captureTransfer, captureClipboard, captureShares } from "./capture.js";
import * as ai from "./ai.js";

export const VERSION = "2.0.0";

const KIND_LABEL = { link: "Link", note: "Note", photo: "Photo", pdf: "PDF", text: "Text", video: "Video", audio: "Audio", file: "File" };
const ICON = {
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><path d="M14 4v6M6 14v6"/></svg>',
  paste: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8v3H8zM6 6H4v15h16V6h-2"/><path d="M8 12h8M8 16h5"/></svg>',
  photo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h4l2-3h6l2 3h4v13H3z"/><circle cx="12" cy="13" r="4"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/></svg>',
};

const state = {
  items: [],
  edition: null,
  view: "edition",
  libFilter: "queued",
  libQuery: "",
  enriching: new Set(),
  currentPage: 0,
};

const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");
const urls = new Map(); // blob id -> object URL

/* ---------------- Boot ---------------- */

async function boot() {
  applyTheme(await db.meta.get("theme", "auto"));
  const migrated = await db.migrateFromLocalStorage(migrateLegacy).catch(() => 0);
  state.items = await db.items.all();
  state.edition = await db.meta.get("edition", null);
  await importShares();
  await importFromUrl();
  await ensureEdition();
  render();
  if (migrated) toast(`Brought over ${migrated} saved item${migrated === 1 ? "" : "s"} from the old version.`);
  wireGlobal();
  enrichPending();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

/** Today's edition, rebuilt on a new day (ranked by the AI first when a key is set). */
async function ensureEdition({ force = false } = {}) {
  const today = dayKey();
  const isNewDay = !state.edition || state.edition.date !== today;
  if ((isNewDay || force) && ai.settings.enabled()) {
    await rankQueue().catch(() => {});
  }
  const next = buildEdition(state.items, force ? null : state.edition);
  if (next !== state.edition) {
    state.edition = next;
    await db.meta.set("edition", next);
  }
}

/**
 * Items queued during the day join today's edition while it has room,
 * so the first day (or a quiet one) isn't empty. Pages are never removed
 * or reordered, which keeps the edition stable while you read it.
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
  const byId = new Map(ranks.map((r) => [r.id, r]));
  const changed = [];
  state.items = state.items.map((i) => {
    const r = byId.get(i.id);
    if (!r) return i;
    const next = { ...i, ai: { score: r.score, why: r.why, at: now } };
    changed.push(next);
    return next;
  });
  await db.items.putMany(changed);
}

/* ---------------- Data helpers ---------------- */

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

/* ---------------- Capture ---------------- */

async function afterCapture(list) {
  list = list.filter(Boolean);
  if (!list.length) return;
  list.forEach((it) => { state.items = [it, ...state.items.filter((i) => i.id !== it.id)]; });
  closeSheet();
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
    const it = await captureText(text, "link");
    if (it) { state.items = [it, ...state.items]; state.view = "inbox"; }
  }
  if ([...p.keys()].length) history.replaceState(null, "", location.pathname);
}

/* ---------------- AI work ---------------- */

let enrichRunning = false;
async function enrichPending() {
  if (enrichRunning || !ai.settings.enabled()) return;
  enrichRunning = true;
  try {
    for (;;) {
      const next = state.items.find((i) => !i.enrichedAt && (i.enrichTries || 0) < 2 && (i.status === STATUS.INBOX || i.status === STATUS.QUEUED));
      if (!next) break;
      state.enriching.add(next.id);
      refreshIfShowing(next.id);
      try {
        const blob = next.blobId && [KIND.PHOTO, KIND.PDF, KIND.TEXT].includes(next.kind) ? await db.blobs.get(next.blobId) : null;
        const out = await ai.enrich(next, blob);
        const cur = byId(next.id);
        if (cur) {
          await saveItem({
            ...cur,
            title: cur.titleEdited ? cur.title : out.title || cur.title,
            summary: out.summary || cur.summary,
            tags: out.tags.length ? out.tags : cur.tags,
            minutes: out.minutes || cur.minutes,
            enrichedAt: Date.now(),
          });
        }
      } catch (e) {
        const cur = byId(next.id);
        if (cur) await saveItem({ ...cur, enrichTries: (cur.enrichTries || 0) + 1 });
        if (e.status === 401 || e.message === "No API key set.") { toast(e.message); break; }
      } finally {
        state.enriching.delete(next.id);
        refreshIfShowing(next.id);
      }
    }
  } finally {
    enrichRunning = false;
  }
}

function refreshIfShowing(id) {
  if (document.querySelector(".sheet-wrap, .reader")) return;
  if (state.view === "inbox" && $(`.tcard[data-id="${CSS.escape(id)}"]`)) render();
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
    if (fresh.length) { closeSheet(); state.view = "inbox"; render(); toast(`${fresh.length} AI suggestion${fresh.length === 1 ? "" : "s"} in your inbox.`); }
  } catch (e) {
    set(e.message || "Search failed.", true);
  }
}

/* ---------------- Verdicts ---------------- */

async function giveVerdict(id, verdict, stage) {
  const before = byId(id);
  if (!before) return;
  const after = applyVerdict(before, verdict, { stage });
  await saveItem(after);
  if (verdict === VERDICT.READ_NOW) {
    render();
    openReader(after);
    return;
  }
  render();
  const words = {
    [VERDICT.LET_GO]: after.washedOut ? "Washed out." : "Let go.",
    [VERDICT.LATER]: stage === "inbox" ? "Queued for a future edition." : after.washedOut ? "Deferred too often. Washed out." : "Deferred.",
    [VERDICT.DONE]: "Done.",
  };
  toast(words[verdict], { action: "Undo", onAction: async () => { await saveItem(before); render(); } });
}

/* ---------------- Rendering ---------------- */

function render() {
  topUpEdition();
  const c = counts(state.items);
  app.innerHTML = `
    <header class="head">${headFor(c)}</header>
    <main class="main" id="main">${mainFor(c)}</main>
    <nav class="dock" aria-label="Sections">
      ${tab("edition", "Edition", editionCountLabel())}
      ${tab("inbox", "Inbox", c.inbox ? String(c.inbox) : "0")}
      ${tab("library", "Library", String(c.queued))}
      <button class="add" type="button" data-act="drop" aria-label="Add something">+</button>
    </nav>`;
  bindMain();
  hydrate(app);
}

function tab(view, name, count) {
  return `<button type="button" data-view="${view}" ${state.view === view ? 'aria-current="page"' : ""}>
    <span class="tab-name">${name}</span><span class="tab-count">${esc(count)}</span></button>`;
}

function editionCountLabel() {
  const v = editionView(state.items, state.edition);
  return v.total ? `${v.settled}/${v.total}` : "–";
}

function headFor(c) {
  const now = new Date();
  const date = `${now.toLocaleDateString("en-US", { weekday: "short" })} ${now.getDate()} ${now.toLocaleDateString("en-US", { month: "short" })}`;
  let left = "", right = "", extra = "";
  if (state.view === "edition") {
    const v = editionView(state.items, state.edition);
    left = `Edition · ${date}`;
    right = v.total ? `${v.settled} of ${v.total} settled` : "";
    if (v.total) {
      extra = `<div class="progress" style="grid-template-columns:repeat(${v.total},minmax(0,1fr))" aria-hidden="true">${v.pages
        .map((p) => `<span class="${v.open.includes(p) ? "" : "on"}"></span>`).join("")}</div>`;
    }
  } else if (state.view === "inbox") {
    left = "Inbox · triage";
    right = c.inbox ? `${c.inbox} waiting` : "";
  } else {
    left = "Library";
    right = `${state.items.length} items`;
  }
  return `<div class="head-row"><span class="label">${esc(left)}</span>
    <span class="right"><span class="label accent">${esc(right)}</span>
    <button class="icon-btn" type="button" data-act="settings" aria-label="Settings">${ICON.settings}</button></span></div>${extra}`;
}

function mainFor(c) {
  if (state.view === "inbox") return inboxView(c);
  if (state.view === "library") return libraryView();
  return editionMain(c);
}

/* ----- Edition ----- */

function editionMain(c) {
  const v = editionView(state.items, state.edition);
  if (!v.total) {
    return `<section class="state">
      <h1>${c.queued || c.inbox ? "Nothing set yet." : "Start here."}</h1>
      <p>${c.inbox ? "New saves wait in your inbox. Give each one a verdict; the ones you keep become your daily edition." : "Tap + to drop in a link, a thought, a photo or a file. It lands in your inbox for triage, then comes back to you here."}</p>
      <div class="stack">${c.inbox ? `<button class="btn primary" type="button" data-view="inbox">Triage inbox <span class="label">${c.inbox}</span></button>` : `<button class="btn primary" type="button" data-act="drop">Add something <span class="label">+</span></button>`}</div>
    </section>`;
  }
  if (!v.open.length) {
    const done = v.pages.filter((p) => p.status === STATUS.DONE).length;
    const gone = v.pages.filter((p) => p.status === STATUS.ARCHIVED).length;
    const later = v.total - done - gone;
    return `<section class="state">
      <h1>Done.</h1>
      <p>That was today's edition: ${done} read, ${gone} let go, ${later} deferred. A new one is set tomorrow.</p>
      <div class="stack">
        ${c.inbox ? `<button class="btn" type="button" data-view="inbox">Triage inbox <span class="label">${c.inbox}</span></button>` : ""}
        ${c.queued > 0 ? `<button class="btn" type="button" data-act="one-more">Read one more <span class="label">from queue</span></button>` : ""}
        ${ai.settings.enabled() ? `<button class="btn primary" type="button" data-act="discover">Find something new <span class="label">AI</span></button><span class="status" id="discover-status"></span>` : ""}
      </div>
    </section>`;
  }
  const pages = v.open.map((item) => pageFor(item, state.edition.ids.indexOf(item.id), v.total)).join("");
  const rail = v.pages.map((p, i) => {
    const open = v.open.includes(p);
    return `<button type="button" data-jump="${esc(p.id)}" class="${open ? "" : "settled"}" ${open ? "" : "disabled"} aria-label="Page ${i + 1}${open ? "" : ", settled"}">${pad(i + 1)}</button>`;
  }).join("");
  return `<div class="pages" id="pages">${pages}</div><nav class="rail" aria-label="Pages">${rail}</nav>`;
}

function pageFor(item, index, total) {
  const why = item.summary || "";
  const today = item.ai && item.ai.why ? `<p class="why"><span class="label accent">Why today</span> ${esc(item.ai.why)}</p>` : "";
  return `<article class="page" data-page="${esc(item.id)}" aria-label="${esc(item.title)}">
    <div class="page-top">
      <span class="label">${pad(index + 1)} / ${pad(total)} · ${KIND_LABEL[item.kind] || "Item"}</span>
      <span class="label ${item.suggested ? "accent" : "muted"}">${item.suggested ? "AI pick" : `${estimateMinutes(item)} min · ${ago(item.created)}`}</span>
    </div>
    <div class="page-body">
      ${bodyFor(item, why)}
      ${today}
      ${tagsFor(item)}
    </div>
    ${verdictBar(item.id, "edition")}
  </article>`;
}

/** Each kind of thing is set differently on its page. */
function bodyFor(item, why) {
  const whyP = why ? `<p class="why">${esc(why)}</p>` : "";
  switch (item.kind) {
    case KIND.NOTE: {
      const t = item.text || item.title;
      const size = t.length < 140 ? "s" : t.length < 420 ? "m" : "l";
      return `<blockquote class="quote ${size} ${t.length > 700 ? "fade" : ""}">${esc(t)}</blockquote>${item.url ? linkButton(item.url) : ""}`;
    }
    case KIND.PHOTO:
      return `<div class="figure"><img alt="${esc(item.title)}" data-blob="${esc(item.thumbId || item.blobId)}"></div>
        <h2 style="font-size:24px;line-height:25px">${esc(item.title)}</h2>${whyP}`;
    case KIND.VIDEO:
      return `<div class="figure"><video controls playsinline preload="metadata" data-blob="${esc(item.blobId)}"></video></div>
        <h2 style="font-size:24px;line-height:25px">${esc(item.title)}</h2>${whyP}`;
    case KIND.LINK:
      return `<span class="host">${esc(host(item.url))}</span><h2>${esc(item.title)}</h2>${whyP}
        ${item.text ? `<p class="why">${esc(item.text)}</p>` : ""}${linkButton(item.url)}`;
    default: {
      const glyph = item.kind === KIND.PDF ? "PDF" : item.kind === KIND.TEXT ? "TXT" : item.kind === KIND.AUDIO ? "AUD" : ext(item.fileName);
      return `<div class="slab"><span class="label">${esc(item.fileName || "")}${item.size ? " · " + size(item.size) : ""}</span><span class="glyph">${esc(glyph)}</span></div>
        <h2 style="font-size:26px;line-height:27px">${esc(item.title)}</h2>${whyP}`;
    }
  }
}

function linkButton(url) {
  return `<a class="open-link" href="${esc(url)}" target="_blank" rel="noopener">Open original <span class="label">${esc(host(url))} ↗</span></a>`;
}

function tagsFor(item) {
  const tags = (item.tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join("");
  const ai = item.suggested ? '<span class="chip ai">Suggested</span>' : "";
  return tags || ai ? `<div class="tags">${ai}${tags}</div>` : "";
}

function verdictBar(id, stage) {
  return `<div class="verdicts" role="group" aria-label="Verdict">
    <button type="button" data-verdict="${VERDICT.LET_GO}" data-id="${esc(id)}" data-stage="${stage}">Let go</button>
    <button type="button" data-verdict="${VERDICT.LATER}" data-id="${esc(id)}" data-stage="${stage}">Later</button>
    <button type="button" data-verdict="${VERDICT.DONE}" data-id="${esc(id)}" data-stage="${stage}">Done</button>
    <button type="button" data-verdict="${VERDICT.READ_NOW}" data-id="${esc(id)}" data-stage="${stage}">Read now</button>
  </div>`;
}

/* ----- Inbox ----- */

function inboxView() {
  const inbox = state.items.filter((i) => i.status === STATUS.INBOX).sort((a, b) => a.created - b.created);
  if (!inbox.length) {
    return `<section class="state"><h1>Inbox zero.</h1>
      <p>New saves land here first. Each gets one verdict: let go, keep for later, already done, or read it now.</p>
      <div class="stack"><button class="btn primary" type="button" data-act="drop">Add something <span class="label">+</span></button>
      <button class="btn" type="button" data-view="edition">Back to the edition <span class="label">→</span></button></div></section>`;
  }
  const item = inbox[0];
  const busy = state.enriching.has(item.id);
  const why = busy ? '<p class="why label accent">Reading it…</p>' : item.summary ? `<p class="why">${esc(item.summary)}</p>` : "";
  let figure = "";
  if (item.kind === KIND.PHOTO) figure = `<div class="figure"><img alt="${esc(item.title)}" data-blob="${esc(item.thumbId || item.blobId)}"></div>`;
  else if (item.kind === KIND.NOTE) figure = `<blockquote class="quote ${(item.text || "").length < 140 ? "s" : "l"} fade" style="flex:1;overflow:hidden">${esc(item.text || item.title)}</blockquote>`;
  else if (item.kind !== KIND.LINK) figure = `<div class="slab"><span class="label">${esc(item.fileName || KIND_LABEL[item.kind])}${item.size ? " · " + size(item.size) : ""}</span><span class="glyph">${esc(item.kind === KIND.PDF ? "PDF" : ext(item.fileName))}</span></div>`;
  return `<section class="deck">
    <div class="page-top"><span class="label">${pad(1)} / ${pad(inbox.length)} · ${KIND_LABEL[item.kind]}</span>
      <span class="label ${item.suggested ? "accent" : "muted"}">${item.suggested ? "AI pick" : `${sourceLabel(item.source)} · ${ago(item.created)}`}</span></div>
    <div class="deck-area">
      ${inbox.length > 1 ? '<div class="under" aria-hidden="true"></div>' : ""}
      <article class="tcard" data-id="${esc(item.id)}">
        <span class="stamp" aria-hidden="true"></span>
        ${item.kind === KIND.LINK ? `<span class="host">${esc(host(item.url))}</span>` : ""}
        ${item.kind === KIND.NOTE ? "" : `<h2>${esc(item.title)}</h2>`}
        ${figure}
        ${why}
        ${tagsFor(item)}
        ${item.kind === KIND.LINK ? linkButton(item.url) : ""}
      </article>
    </div>
    ${verdictBar(item.id, "inbox")}
    <p class="hint label muted">← Let go · Later ↑ · Read now →</p>
  </section>`;
}

/* ----- Library ----- */

function libraryView() {
  const q = state.libQuery.trim().toLowerCase();
  const f = state.libFilter;
  const list = state.items
    .filter((i) => f === "all" || i.status === f)
    .filter((i) => !q || [i.title, i.text, i.url, i.summary, i.fileName, ...(i.tags || [])].some((s) => s && s.toLowerCase().includes(q)))
    .sort((a, b) => (b.doneAt || b.archivedAt || b.created) - (a.doneAt || a.archivedAt || a.created));
  const segs = [["queued", "Queue"], ["done", "Done"], ["archived", "Let go"], ["all", "All"]]
    .map(([k, n]) => `<button type="button" data-filter="${k}" aria-pressed="${f === k}">${n}</button>`).join("");
  const rows = list.map((i) => {
    const restoreBtn = i.status === STATUS.DONE || i.status === STATUS.ARCHIVED
      ? `<button class="act" type="button" data-restore="${esc(i.id)}">Requeue</button>` : "";
    return `<div class="row"><span class="label muted">${KIND_LABEL[i.kind]}</span>
      <button type="button" data-open="${esc(i.id)}" style="text-align:left"><span class="t">${esc(i.title)}</span><span class="s">${esc(i.status === STATUS.ARCHIVED && i.washedOut ? "Washed out · " : "")}${ago(i.created)}${i.tags && i.tags.length ? " · " + esc(i.tags.join(", ")) : ""}</span></button>
      ${restoreBtn}</div>`;
  }).join("");
  return `<section class="lib">
    <label class="sr-only" for="lib-q">Search</label>
    <input class="search" id="lib-q" type="search" placeholder="Search everything you saved" value="${esc(state.libQuery)}">
    <div class="seg" role="group" aria-label="Filter">${segs}</div>
    ${rows || '<p class="empty-line">Nothing here.</p>'}
  </section>`;
}

/* ---------------- Binding ---------------- */

function bindMain() {
  app.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => { state.view = b.dataset.view; render(); }));
  app.querySelectorAll("[data-verdict]").forEach((b) => b.addEventListener("click", () => giveVerdict(b.dataset.id, b.dataset.verdict, b.dataset.stage)));
  app.querySelectorAll('[data-act="drop"]').forEach((b) => b.addEventListener("click", openDrop));
  app.querySelectorAll('[data-act="settings"]').forEach((b) => b.addEventListener("click", openSettings));
  const disc = $('[data-act="discover"]', app);
  if (disc) disc.addEventListener("click", () => { disc.disabled = true; findNew($("#discover-status")).finally(() => { disc.disabled = false; }); });
  const more = $('[data-act="one-more"]', app);
  if (more) more.addEventListener("click", oneMore);

  if (state.view === "edition") bindPages();
  if (state.view === "inbox") bindSwipe();
  if (state.view === "library") {
    const q = $("#lib-q");
    q.addEventListener("input", () => {
      state.libQuery = q.value;
      const pos = q.selectionStart;
      render();
      const nq = $("#lib-q"); nq.focus(); nq.setSelectionRange(pos, pos);
    });
    app.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => { state.libFilter = b.dataset.filter; render(); }));
    app.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openReader(byId(b.dataset.open))));
    app.querySelectorAll("[data-restore]").forEach((b) => b.addEventListener("click", async () => {
      await saveItem(restore(byId(b.dataset.restore)));
      render();
      toast("Back in the queue.");
    }));
  }
}

function bindPages() {
  const pages = $("#pages");
  if (!pages) return;
  const rail = app.querySelectorAll(".rail [data-jump]");
  const mark = (id) => rail.forEach((b) => b.setAttribute("aria-current", String(b.dataset.jump === id)));
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) mark(e.target.dataset.page); });
  }, { root: pages, threshold: 0.6 });
  pages.querySelectorAll(".page").forEach((p) => io.observe(p));
  rail.forEach((b) => b.addEventListener("click", () => {
    const target = pages.querySelector(`[data-page="${CSS.escape(b.dataset.jump)}"]`);
    if (target) target.scrollIntoView({ behavior: "smooth" });
  }));
  const first = pages.querySelector(".page");
  if (first) mark(first.dataset.page);
}

/** Swipe the triage card: left lets go, right reads now, up keeps for later. */
function bindSwipe() {
  const card = $(".tcard", app);
  if (!card) return;
  const stamp = $(".stamp", card);
  let x0 = 0, y0 = 0, dx = 0, dy = 0, active = false;
  const decide = () => {
    if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy)) return dx > 0 ? VERDICT.READ_NOW : VERDICT.LET_GO;
    if (dy < -90 && Math.abs(dy) > Math.abs(dx)) return VERDICT.LATER;
    return null;
  };
  const words = { [VERDICT.READ_NOW]: "Read now", [VERDICT.LET_GO]: "Let go", [VERDICT.LATER]: "Later" };
  card.addEventListener("pointerdown", (e) => {
    if (e.target.closest("a, button, video")) return;
    active = true; x0 = e.clientX; y0 = e.clientY; dx = dy = 0;
    card.classList.add("dragging");
    card.setPointerCapture(e.pointerId);
  });
  card.addEventListener("pointermove", (e) => {
    if (!active) return;
    dx = e.clientX - x0; dy = e.clientY - y0;
    card.style.transform = `translate(${dx}px, ${Math.min(dy, 40)}px) rotate(${dx / 24}deg)`;
    const v = decide();
    stamp.textContent = v ? words[v] : "";
    stamp.style.opacity = v ? "1" : "0";
    stamp.style.color = v === VERDICT.READ_NOW ? "var(--accent)" : v === VERDICT.LET_GO ? "var(--signal)" : "var(--ink)";
  });
  const end = () => {
    if (!active) return;
    active = false;
    card.classList.remove("dragging");
    const v = decide();
    if (!v) { card.style.transform = ""; stamp.style.opacity = "0"; return; }
    const fly = v === VERDICT.LATER ? "translate(0, -120%)" : `translate(${dx > 0 ? 140 : -140}%, ${dy}px) rotate(${dx / 12}deg)`;
    card.style.transform = fly;
    card.style.opacity = "0";
    setTimeout(() => giveVerdict(card.dataset.id, v, "inbox"), 180);
  };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", () => { active = false; card.classList.remove("dragging"); card.style.transform = ""; stamp.style.opacity = "0"; });
}

async function oneMore() {
  const ids = new Set(state.edition.ids);
  const extra = buildEdition(state.items.filter((i) => !ids.has(i.id)), null, { size: 1 });
  if (!extra.ids.length) { toast("The queue is empty."); return; }
  state.edition = { ...state.edition, ids: [...state.edition.ids, extra.ids[0]] };
  await db.meta.set("edition", state.edition);
  render();
}

/* ---------------- Drop sheet ---------------- */

function openDrop() {
  const wrap = sheet(`
    <div class="sheet-head"><h2>Drop it in.</h2><button class="icon-btn" type="button" data-close aria-label="Close">✕</button></div>
    <label class="sr-only" for="drop-text">Link or note</label>
    <textarea class="drop-field" id="drop-text" placeholder="Paste a link, type a thought, or drop a file anywhere"></textarea>
    <div class="drop-tiles">
      <button class="tile" type="button" data-pick="paste">${ICON.paste}<span>Paste</span></button>
      <button class="tile" type="button" data-pick="photo">${ICON.photo}<span>Photo</span></button>
      <button class="tile" type="button" data-pick="file">${ICON.file}<span>File</span></button>
    </div>
    <input type="file" id="pick-photo" accept="image/*,video/*" multiple hidden>
    <input type="file" id="pick-file" multiple hidden>
    <span class="status" id="drop-status" role="status"></span>
    <button class="btn primary" type="button" id="drop-save" disabled>Save to inbox <span class="label">↵</span></button>
    <p class="note">Links, notes, photos, PDFs, documents, video. Anything goes to your inbox first.</p>`);
  const ta = $("#drop-text", wrap);
  const saveBtn = $("#drop-save", wrap);
  const status = $("#drop-status", wrap);
  ta.focus();
  ta.addEventListener("input", () => { saveBtn.disabled = !ta.value.trim(); });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveBtn.click(); });
  ta.addEventListener("paste", async (e) => {
    if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length) {
      e.preventDefault();
      afterCapture(await captureTransfer(e.clipboardData, "paste"));
    }
  });
  saveBtn.addEventListener("click", async () => {
    const it = await captureText(ta.value, "drop");
    afterCapture([it]);
  });
  $('[data-pick="paste"]', wrap).addEventListener("click", async () => {
    try {
      const list = await captureClipboard();
      if (list.length) afterCapture(list);
      else { status.textContent = "The clipboard is empty."; status.classList.add("err"); }
    } catch {
      status.textContent = "Clipboard access was blocked. Long-press in the box and choose Paste.";
      status.classList.add("err");
      ta.focus();
    }
  });
  const photo = $("#pick-photo", wrap), file = $("#pick-file", wrap);
  $('[data-pick="photo"]', wrap).addEventListener("click", () => photo.click());
  $('[data-pick="file"]', wrap).addEventListener("click", () => file.click());
  const onFiles = async (input) => {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    status.classList.remove("err");
    status.textContent = `Saving ${files.length}…`;
    const out = [];
    for (const f of files) out.push(await captureFile(f, "drop"));
    afterCapture(out);
  };
  photo.addEventListener("change", () => onFiles(photo));
  file.addEventListener("change", () => onFiles(file));
}

/* ---------------- Reader ---------------- */

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
    case KIND.NOTE: content = `<div class="prose">${esc(item.text || item.title)}</div>${item.url ? linkButton(item.url) : ""}`; break;
    case KIND.LINK: content = `${item.text ? `<div class="prose">${esc(item.text)}</div>` : ""}${linkButton(item.url)}`; break;
    case KIND.PHOTO: content = `<img alt="${esc(item.title)}" data-blob="${esc(item.blobId)}">`; break;
    case KIND.VIDEO: content = `<video controls playsinline data-blob="${esc(item.blobId)}"></video>`; break;
    case KIND.AUDIO: content = `<audio controls data-blob="${esc(item.blobId)}"></audio>`; break;
    case KIND.TEXT: content = `<div class="prose" data-textblob="${esc(item.blobId)}">Loading…</div>`; break;
    case KIND.PDF: content = `<iframe title="${esc(item.title)}" data-blob="${esc(item.blobId)}"></iframe>${fileLink(item, "Open PDF full screen")}`; break;
    default: content = fileLink(item, "Open file");
  }
  el.innerHTML = `
    <div class="head"><div class="head-row"><span class="label">${KIND_LABEL[item.kind]} · ${ago(item.created)}</span>
      <button class="icon-btn" type="button" data-close aria-label="Close">✕</button></div></div>
    <div class="reader-body">
      <h1>${esc(item.title)}</h1>
      ${item.summary ? `<p class="why" style="margin:0;color:var(--muted)">${esc(item.summary)}</p>` : ""}
      ${tagsFor(item)}
      ${content}
    </div>
    <div class="reader-foot">
      ${open
        ? `<button class="btn" type="button" data-rv="${VERDICT.LATER}">Later</button><button class="btn primary" type="button" data-rv="${VERDICT.DONE}">Done</button>`
        : `<button class="btn" type="button" data-close>Close</button>${item.blobId ? fileLink(item, "Open", "btn primary") : item.url ? `<a class="btn primary" href="${esc(item.url)}" target="_blank" rel="noopener">Open ↗</a>` : '<span></span>'}`}
    </div>`;
  document.body.appendChild(el);
  hydrate(el);
  el.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeReader));
  el.querySelectorAll("[data-rv]").forEach((b) => b.addEventListener("click", () => {
    closeReader();
    giveVerdict(item.id, b.dataset.rv, item.status === STATUS.INBOX ? "inbox" : "edition");
  }));
  $("[data-close]", el).focus();
}

function fileLink(item, text, cls = "open-link") {
  return `<a class="${cls}" data-blob="${esc(item.blobId)}" href="#" target="_blank" rel="noopener" download="${esc(item.fileName || "file")}">${esc(text)} <span class="label">${esc(item.fileName ? ext(item.fileName) : "")} ↗</span></a>`;
}

function closeReader() {
  const r = $(".reader");
  if (r) r.remove();
}

/* ---------------- Settings ---------------- */

async function openSettings() {
  const theme = await db.meta.get("theme", "auto");
  const c = counts(state.items);
  const wrap = sheet(`
    <div class="sheet-head"><h2>Settings</h2><button class="icon-btn" type="button" data-close aria-label="Close">✕</button></div>
    <div class="section">
      <span class="label">AI · Anthropic API</span>
      <div class="field"><label class="label muted" for="set-key">API key</label>
        <input id="set-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(ai.settings.key())}"></div>
      <div class="field"><label class="label muted" for="set-model">Model</label>
        <input id="set-model" type="text" autocomplete="off" spellcheck="false" value="${esc(ai.settings.model())}"></div>
      <div class="drop-tiles" style="grid-template-columns:repeat(2,minmax(0,1fr))">
        <button class="btn primary" type="button" id="set-save">Save and test</button>
        <button class="btn" type="button" id="set-clear">Remove key</button>
      </div>
      <span class="status" id="set-status" role="status"></span>
      <p class="note">The key stays on this device and is sent only to Anthropic. With it, Edition reads each new save (including photos and PDFs) to title and tag it, ranks your queue from what you finish and let go, and can search for new reading. Each of those is a paid API call on your account.</p>
    </div>
    <div class="section">
      <span class="label">Edition</span>
      <button class="btn" type="button" id="set-rebuild">Rebuild today's edition <span class="label">${ai.settings.enabled() ? "AI ranked" : "local"}</span></button>
      <button class="btn" type="button" id="set-discover" ${ai.settings.enabled() ? "" : "disabled"}>Find something new <span class="label">AI</span></button>
      <span class="status" id="set-ed-status" role="status"></span>
    </div>
    <div class="section">
      <span class="label">Theme</span>
      <div class="seg" role="group" aria-label="Theme" style="grid-template-columns:repeat(3,minmax(0,1fr));margin:0">
        ${[["auto", "Auto"], ["paper", "Paper"], ["ink", "Ink"]].map(([k, n]) => `<button type="button" data-theme-pick="${k}" aria-pressed="${theme === k}">${n}</button>`).join("")}
      </div>
    </div>
    <div class="section">
      <span class="label">Backup</span>
      <div class="drop-tiles" style="grid-template-columns:repeat(2,minmax(0,1fr))">
        <button class="btn" type="button" id="set-export">Export</button>
        <button class="btn" type="button" id="set-import">Import</button>
      </div>
      <input type="file" id="set-import-file" accept="application/json,.json" hidden>
      <p class="note">Exports titles, notes, links and history as JSON. Photos and files stay on this device.</p>
    </div>
    <p class="label muted">Edition ${VERSION} · ${c.inbox} inbox · ${c.queued} queued · ${c.done} done · ${c.archived} let go</p>`);

  const status = $("#set-status", wrap);
  const say = (el, msg, err) => { el.textContent = msg; el.classList.toggle("err", !!err); };
  $("#set-save", wrap).addEventListener("click", async () => {
    ai.settings.setKey($("#set-key", wrap).value.trim());
    ai.settings.setModel($("#set-model", wrap).value.trim() || ai.DEFAULT_MODEL);
    if (!ai.settings.enabled()) { say(status, "No key saved."); return; }
    say(status, "Testing…");
    try {
      await ai.testKey();
      say(status, "Key works. Reading your saves now.");
      state.items = state.items.map((i) => ({ ...i, enrichTries: 0 }));
      enrichPending();
    } catch (e) { say(status, e.message, true); }
  });
  $("#set-clear", wrap).addEventListener("click", () => {
    ai.settings.setKey("");
    $("#set-key", wrap).value = "";
    say(status, "Key removed. Edition works without AI.");
  });
  const edStatus = $("#set-ed-status", wrap);
  $("#set-rebuild", wrap).addEventListener("click", async () => {
    say(edStatus, ai.settings.enabled() ? "Ranking your queue…" : "Rebuilding…");
    try {
      await ensureEdition({ force: true });
      closeSheet(); state.view = "edition"; render(); toast("Today's edition is rebuilt.");
    } catch (e) { say(edStatus, e.message || "Could not rebuild.", true); }
  });
  $("#set-discover", wrap).addEventListener("click", () => findNew(edStatus));
  wrap.querySelectorAll("[data-theme-pick]").forEach((b) => b.addEventListener("click", async () => {
    await db.meta.set("theme", b.dataset.themePick);
    applyTheme(b.dataset.themePick);
    wrap.querySelectorAll("[data-theme-pick]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
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
    } catch (e) { say(status, e.message, true); }
  });
}

function applyTheme(t) {
  if (t === "paper" || t === "ink") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t === "ink" || (t !== "paper" && matchMedia("(prefers-color-scheme: dark)").matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? "#111214" : "#F1F1EE";
}

/* ---------------- Sheets, toasts, global input ---------------- */

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
  if (lastFocus && lastFocus.focus) lastFocus.focus();
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
  // Paste anywhere outside a text field captures straight to the inbox.
  document.addEventListener("paste", async (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (!e.clipboardData) return;
    e.preventDefault();
    afterCapture(await captureTransfer(e.clipboardData, "paste"));
  });
  // Drag files or links onto the window.
  const zone = document.createElement("div");
  zone.className = "dropzone";
  zone.textContent = "Drop to save.";
  document.body.appendChild(zone);
  let depth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; zone.classList.add("on"); });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) zone.classList.remove("on"); });
  window.addEventListener("drop", async (e) => {
    e.preventDefault(); depth = 0; zone.classList.remove("on");
    if (e.dataTransfer) afterCapture(await captureTransfer(e.dataTransfer, "drop"));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeReader(); closeSheet(); }
  });
  // New day or new shares while the app was in the background.
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    const before = state.items.length;
    await importShares();
    const day = state.edition && state.edition.date;
    await ensureEdition();
    if (state.items.length !== before || (state.edition && state.edition.date !== day)) {
      if (!document.querySelector(".sheet-wrap, .reader")) render();
      enrichPending();
    }
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", async () => applyTheme(await db.meta.get("theme", "auto")));
}

/* ---------------- Small formatters ---------------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function pad(n) { return String(n).padStart(2, "0"); }
function ago(ts) {
  const d = Math.floor((Date.now() - ts) / 86400000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
}
function host(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }
function ext(name) { const e = String(name || "").split(".").pop(); return e && e !== name ? e.slice(0, 4).toUpperCase() : "FILE"; }
function size(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; }
function sourceLabel(s) { return { paste: "Pasted", share: "Shared", drop: "Added", link: "Added", legacy: "Imported", ai: "AI pick" }[s] || "Added"; }
function withTimeout(p, ms) { return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("Timed out")), ms))]); }

boot().catch((e) => {
  app.innerHTML = `<section class="state"><h1>Something broke.</h1><p>${esc(e && e.message)}</p></section>`;
});
