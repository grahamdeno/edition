import { load, save, selectEdition, applyVerdict, VERDICTS, todayKey } from "./core.js";

const app = document.getElementById("app");
let data = load();

function render() {
  const edition = selectEdition(data.items);
  const doneCount = data.items.filter((i) => i.status === "done" && isToday(i.doneAt)).length;
  const total = edition.length + doneCount;

  if (edition.length === 0) {
    app.innerHTML = `
      <div class="done-screen">
        <h1>You're done.</h1>
        <p>Today's edition is finished.</p>
      </div>`;
    return;
  }

  const lead = edition[0];
  const rest = edition.slice(1);

  app.innerHTML = `
    <div class="mast">
      <span class="date">${formatDate()}</span>
      <span class="count">${edition.length} items · ${totalMinutes(edition)} min</span>
    </div>
    <h1 class="title">The Edition</h1>
    <p class="sub">Today's front page, built from your saves. Finish it and you're done.</p>

    <button class="lead" data-id="${lead.id}">
      <div class="kicker">Lead · saved ${daysAgo(lead.created)} days ago</div>
      <div class="preview">[preview image]</div>
      <h2>${escape(lead.title)}</h2>
      <p class="summary">${escape(lead.summary)}</p>
    </button>

    ${rest.length ? `<div class="grid">${rest.slice(0, 2).map(card).join("")}</div>` : ""}

    ${rest.slice(2).length ? `<div class="list">${rest.slice(2).map(row).join("")}</div>` : ""}

    <div class="progress">
      <div class="bar"><span style="width:${(doneCount / Math.max(total, 1)) * 100}%"></span></div>
      <div class="label">${doneCount} of ${total} read</div>
    </div>
  `;

  app.querySelectorAll("[data-id]").forEach((el) => {
    el.addEventListener("click", () => openTriage(el.dataset.id));
  });
}

function card(item) {
  return `<button class="card" data-id="${item.id}">
    <div class="kicker">${item.type} · ${item.minutes} min</div>
    <h3>${escape(item.title)}</h3>
  </button>`;
}

function row(item) {
  return `<button class="row" data-id="${item.id}">
    <span class="t">${escape(item.title)}</span>
    <span class="meta">Below the fold</span>
  </button>`;
}

function openTriage(id) {
  const item = data.items.find((i) => i.id === id);
  if (!item) return;

  const overlay = document.createElement("div");
  overlay.className = "triage";
  overlay.innerHTML = `
    <div class="triage-head">
      <button class="back" aria-label="Close">×</button>
      <span>Triage · ${item.skips || 0} skipped</span>
      <span></span>
    </div>
    <div class="stack">
      <div class="tcard" id="tcard">
        <div class="preview">[preview]</div>
        <div class="kicker">${item.type} · saved ${daysAgo(item.created)} days ago</div>
        <h2>${escape(item.title)}</h2>
        <p class="summary">${escape(item.summary)}</p>
        <div class="tags">
          <span class="tag">${item.minutes} min</span>
          ${item.tags?.[0] ? `<span class="tag">${item.tags[0]}</span>` : ""}
        </div>
      </div>
    </div>
    <div class="actions">
      <button class="btn" data-v="${VERDICTS.LET_GO}">Let go</button>
      <button class="btn" data-v="${VERDICTS.LATER}">Later</button>
      <button class="btn" data-v="${VERDICTS.DONE}">Done</button>
      <button class="btn primary" data-v="${VERDICTS.READ_NOW}">Read now</button>
    </div>
    <div class="hint">Swipe left to let go, right to read, up for later</div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector(".back").onclick = () => overlay.remove();

  overlay.querySelectorAll("[data-v]").forEach((btn) => {
    btn.onclick = () => verdict(item, btn.dataset.v, overlay);
  });

  const card = overlay.querySelector("#tcard");
  let startX = 0, startY = 0, dx = 0, dy = 0;
  card.addEventListener("pointerdown", (e) => {
    startX = e.clientX; startY = e.clientY;
    card.setPointerCapture(e.pointerId);
  });
  card.addEventListener("pointermove", (e) => {
    if (!startX) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 20}deg)`;
  });
  card.addEventListener("pointerup", () => {
    const absX = Math.abs(dx), absY = Math.abs(dy);
    if (absX > 80 && absX > absY) {
      verdict(item, dx > 0 ? VERDICTS.READ_NOW : VERDICTS.LET_GO, overlay);
    } else if (dy < -60 && absY > absX) {
      verdict(item, VERDICTS.LATER, overlay);
    } else {
      card.style.transform = "";
    }
    startX = 0; dx = 0; dy = 0;
  });
}

function verdict(item, v, overlay) {
  const next = applyVerdict(item, v);
  data.items = data.items.map((i) => (i.id === item.id ? next : i));
  save(data);
  overlay.remove();
  if (v === VERDICTS.READ_NOW && item.url) window.open(item.url, "_blank");
  render();
}

function formatDate() {
  return new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).toUpperCase();
}
function daysAgo(ts) {
  return Math.floor((Date.now() - ts) / 86400000);
}
function totalMinutes(items) {
  return items.reduce((s, i) => s + (i.minutes || 0), 0);
}
function isToday(ts) {
  return ts && new Date(ts).toISOString().slice(0, 10) === todayKey();
}
function escape(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&",
    "<": "<",
    ">": ">",
    '"': """,
    "'": "&#39;"
  }[c]));
}

render();
