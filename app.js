import { load, save, selectEdition, applyVerdict, createItem, VERDICTS, todayKey } from "./core.js";
import { analyzeItem } from "./analyze.js";

const app = document.getElementById("app");
let data = load();

function getKey() {
  return localStorage.getItem("edition-anthropic-key") || "";
}
function setKey(k) {
  if (k) localStorage.setItem("edition-anthropic-key", k);
  else localStorage.removeItem("edition-anthropic-key");
}

function render() {
  const edition = selectEdition(data.items);
  const doneCount = data.items.filter(function (i) { return i.status === "done" && isToday(i.doneAt); }).length;
  const total = edition.length + doneCount;

  if (edition.length === 0) {
    app.innerHTML = '<div class="done-screen"><h1>You\'re done.</h1><p>Today\'s edition is finished.</p></div><button class="add-btn" aria-label="Add">+</button>';
    app.querySelector(".add-btn").onclick = function () { openCapture(); };
    return;
  }

  const lead = edition[0];
  const rest = edition.slice(1);
  let html = '';
  html += '<div class="mast"><span class="date">' + formatDate() + '</span><span class="count">' + edition.length + ' items</span></div>';
  html += '<h1 class="title">The Edition</h1>';
  html += '<p class="sub">Today\'s front page, built from your saves. Finish it and you\'re done.</p>';
  html += '<button class="lead" data-id="' + lead.id + '">';
  html += '<div class="kicker">' + (lead.category || lead.type || "item").toUpperCase() + ' · saved ' + daysAgo(lead.created) + ' days ago</div>';
  html += '<div class="preview">[preview image]</div>';
  html += '<h2>' + escapeHtml(lead.title) + '</h2>';
  html += '<p class="summary">' + escapeHtml(lead.summary) + '</p></button>';
  if (rest.length) {
    html += '<div class="grid">' + rest.slice(0, 2).map(card).join("") + '</div>';
  }
  if (rest.slice(2).length) {
    html += '<div class="list">' + rest.slice(2).map(row).join("") + '</div>';
  }
  html += '<div class="progress"><div class="bar"><span style="width:' + (doneCount / Math.max(total, 1) * 100) + '%"></span></div>';
  html += '<div class="label">' + doneCount + ' of ' + total + ' read</div></div>';
  html += '<button class="add-btn" aria-label="Add">+</button>';
  app.innerHTML = html;

  app.querySelectorAll("[data-id]").forEach(function (el) {
    el.addEventListener("click", function () { openTriage(el.dataset.id); });
  });
  app.querySelector(".add-btn").onclick = function () { openCapture(); };
}

function card(item) {
  const label = (item.category || item.type || "item").toUpperCase();
  return '<button class="card" data-id="' + item.id + '"><div class="kicker">' + label + ' · ' + item.minutes + ' min</div><h3>' + escapeHtml(item.title) + '</h3></button>';
}

function row(item) {
  return '<button class="row" data-id="' + item.id + '"><span class="t">' + escapeHtml(item.title) + '</span><span class="meta">' + (item.category || item.type) + '</span></button>';
}

function openCapture(prefill) {
  const existing = document.querySelector(".sheet");
  if (existing) existing.remove();

  const isUrl = prefill && /^https?:\/\//i.test(prefill.trim());
  const titleGuess = isUrl ? "" : (prefill || "").slice(0, 80);
  const bodyGuess = isUrl ? prefill.trim() : (prefill || "");
  const hasKey = !!getKey();

  const sheet = document.createElement("div");
  sheet.className = "sheet";
  let html = '<div class="sheet-head"><h2>Capture</h2><button class="back" aria-label="Close">×</button></div>';
  if (prefill) html += '<div class="clip-note">Found on the clipboard. Edit and save, or dismiss.</div>';
  html += '<div class="field"><label>Title</label><input id="cap-title" placeholder="What is this?" /></div>';
  html += '<div class="field"><label>Link or text</label><textarea id="cap-body" placeholder="Paste a URL or a thought"></textarea></div>';
  html += '<div class="field"><label>Note (optional)</label><input id="cap-note" placeholder="Why it might matter" /></div>';
  html += '<div class="field"><label>Anthropic API key ' + (hasKey ? "(saved)" : "") + '</label><input id="cap-key" type="password" placeholder="sk-ant-..." /></div>';
  html += '<div id="cap-status" class="clip-note" style="display:none"></div>';
  html += '<div class="sheet-actions"><button class="btn" id="cap-paste">Paste</button><button class="btn primary" id="cap-save">Save</button></div>';
  sheet.innerHTML = html;
  document.body.appendChild(sheet);

  sheet.querySelector("#cap-title").value = titleGuess;
  sheet.querySelector("#cap-body").value = bodyGuess;
  sheet.querySelector("#cap-key").value = getKey();

  sheet.querySelector(".back").onclick = function () { sheet.remove(); };
  sheet.querySelector("#cap-paste").onclick = async function () {
    const text = await readClip();
    if (text) {
      sheet.querySelector("#cap-body").value = text;
      if (!sheet.querySelector("#cap-title").value && !/^https?:\/\//i.test(text)) {
        sheet.querySelector("#cap-title").value = text.slice(0, 80);
      }
    }
  };
  sheet.querySelector("#cap-save").onclick = async function () {
    const title = sheet.querySelector("#cap-title").value.trim();
    const body = sheet.querySelector("#cap-body").value.trim();
    const note = sheet.querySelector("#cap-note").value.trim();
    const key = sheet.querySelector("#cap-key").value.trim();
    if (!title && !body) return;
    setKey(key);

    const status = sheet.querySelector("#cap-status");
    const saveBtn = sheet.querySelector("#cap-save");
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";

    let analysis = null;
    if (key) {
      status.style.display = "block";
      status.textContent = "Analyzing...";
      analysis = await analyzeItem({ title: title, body: body, note: note, apiKey: key });
      if (!analysis) status.textContent = "Analysis failed. Saved without it.";
    }

    const isLink = /^https?:\/\//i.test(body);
    const item = createItem({
      title: (analysis && analysis.title) || title || undefined,
      summary: (analysis && analysis.summary) || note,
      url: isLink ? body : undefined,
      text: isLink ? undefined : body,
      type: analysis && analysis.type,
    });
    if (analysis) {
      item.category = analysis.category;
      item.minutes = analysis.minutes || item.minutes;
      item.tags = analysis.tags || item.tags;
      item.analyzed = true;
    }
    data.items.unshift(item);
    if (prefill) data.lastClip = prefill;
    save(data);
    sheet.remove();
    render();
  };
}

async function readClip() {
  try {
    if (!navigator.clipboard || !navigator.clipboard.readText) return "";
    return (await navigator.clipboard.readText()).trim();
  } catch (e) {
    return "";
  }
}

async function checkClipboard() {
  const text = await readClip();
  if (!text || text.length < 8) return;
  if (text === data.lastClip) return;
  const exists = data.items.some(function (i) { return i.url === text || i.text === text || i.title === text; });
  if (exists) {
    data.lastClip = text;
    save(data);
    return;
  }
  data.lastClip = text;
  save(data);
  openCapture(text);
}

function openTriage(id) {
  const item = data.items.find(function (i) { return i.id === id; });
  if (!item) return;

  const overlay = document.createElement("div");
  overlay.className = "triage";
  let html = '<div class="triage-head"><button class="back" aria-label="Close">×</button><span>Triage</span><span></span></div>';
  html += '<div class="stack"><div class="tcard" id="tcard">';
  html += '<div class="preview">[preview]</div>';
  html += '<div class="kicker">' + (item.category || item.type || "item").toUpperCase() + '</div>';
  html += '<h2>' + escapeHtml(item.title) + '</h2>';
  html += '<p class="summary">' + escapeHtml(item.summary) + '</p>';
  html += '<div class="tags"><span class="tag">' + item.minutes + ' min</span></div>';
  html += '</div></div>';
  html += '<div class="actions">';
  html += '<button class="btn" data-v="' + VERDICTS.LET_GO + '">Let go</button>';
  html += '<button class="btn" data-v="' + VERDICTS.LATER + '">Later</button>';
  html += '<button class="btn" data-v="' + VERDICTS.DONE + '">Done</button>';
  html += '<button class="btn primary" data-v="' + VERDICTS.READ_NOW + '">Read now</button>';
  html += '</div><div class="hint">Swipe left to let go, right to read, up for later</div>';
  overlay.innerHTML = html;
  document.body.appendChild(overlay);

  overlay.querySelector(".back").onclick = function () { overlay.remove(); };
  overlay.querySelectorAll("[data-v]").forEach(function (btn) {
    btn.onclick = function () { verdict(item, btn.dataset.v, overlay); };
  });

  const cardEl = overlay.querySelector("#tcard");
  let startX = 0, dx = 0, dy = 0;
  cardEl.addEventListener("pointerdown", function (e) {
    startX = e.clientX;
    cardEl.setPointerCapture(e.pointerId);
  });
  cardEl.addEventListener("pointermove", function (e) {
    if (!startX) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    cardEl.style.transform = "translate(" + dx + "px, " + dy + "px) rotate(" + (dx / 20) + "deg)";
  });
  cardEl.addEventListener("pointerup", function () {
    const absX = Math.abs(dx), absY = Math.abs(dy);
    if (absX > 80 && absX > absY) {
      verdict(item, dx > 0 ? VERDICTS.READ_NOW : VERDICTS.LET_GO, overlay);
    } else if (dy < -60 && absY > absX) {
      verdict(item, VERDICTS.LATER, overlay);
    } else {
      cardEl.style.transform = "";
    }
    startX = 0; dx = 0; dy = 0;
  });
}

function verdict(item, v, overlay) {
  const next = applyVerdict(item, v);
  data.items = data.items.map(function (i) { return i.id === item.id ? next : i; });
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
function isToday(ts) {
  return ts && new Date(ts).toISOString().slice(0, 10) === todayKey();
}
function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = String(s || "");
  return div.innerHTML;
}

render();
setTimeout(checkClipboard, 400);
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible") checkClipboard();
});
