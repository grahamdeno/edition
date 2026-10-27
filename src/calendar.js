/*
 * Your calendar, read from its private iCal address (through your relay,
 * since calendar servers don't let web pages read them directly). Today's
 * events show at the top of Today and are gone tomorrow. Nothing is saved
 * as an item: they can't be kept, let go or removed.
 *
 * A small reader for what calendars actually send: one-off and all-day
 * events, time zones, and repeating events (daily, weekly, monthly, yearly,
 * with intervals, weekdays, counts, end dates, skipped and moved dates).
 */

const DAY = 864e5;
const WD = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/* Outlook sends Windows zone names; the common ones, mapped. */
const WIN_TZ = {
  "Eastern Standard Time": "America/New_York", "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver", "US Mountain Standard Time": "America/Phoenix",
  "Pacific Standard Time": "America/Los_Angeles", "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu", "GMT Standard Time": "Europe/London",
  "W. Europe Standard Time": "Europe/Berlin", "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris", "UTC": "UTC", "Korea Standard Time": "Asia/Seoul",
  "Tokyo Standard Time": "Asia/Tokyo",
};

function zoneOf(tzid) {
  if (!tzid) return null;
  const z = WIN_TZ[tzid] || tzid.replace(/^\/[^/]+\/[^/]+\//, ""); // "/mozilla.org/.../America/New_York"
  try { new Intl.DateTimeFormat("en-US", { timeZone: z }); return z; } catch { return null; }
}

/** Wall-clock parts in a zone, for an instant. */
function partsIn(ts, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

/** The instant a wall-clock time in a zone falls on (null zone: this phone's zone). */
export function wallToUtc({ y, m, d, h = 0, mi = 0, s = 0 }, tz) {
  if (!tz) return new Date(y, m - 1, d, h, mi, s).getTime();
  if (tz === "UTC") return Date.UTC(y, m - 1, d, h, mi, s);
  let t = Date.UTC(y, m - 1, d, h, mi, s);
  for (let k = 0; k < 3; k++) {
    const p = partsIn(t, tz);
    const diff = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Date.UTC(y, m - 1, d, h, mi, s);
    if (!diff) break;
    t -= diff;
  }
  return t;
}

/** Lines, unfolded, as { name, params, value }. */
function lines(text) {
  return String(text || "").replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/).filter(Boolean).map((line) => {
    const c = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const head = c < 0 ? line : line.slice(0, c), value = c < 0 ? "" : line.slice(c + 1);
    const [name, ...ps] = head.split(";");
    const params = {};
    for (const p of ps) { const i = p.indexOf("="); if (i > 0) params[p.slice(0, i).toUpperCase()] = p.slice(i + 1).replace(/^"|"$/g, ""); }
    return { name: name.toUpperCase(), params, value };
  });
}

const unescape = (v) => String(v || "").replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();

/** A DTSTART-like value: { date: {y,m,d,h,mi,s}, allDay, tz, utc } */
function parseWhen(value, params) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const allDay = params.VALUE === "DATE" || !m[4];
  const date = { y: +m[1], m: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) };
  const tz = m[7] ? "UTC" : allDay ? null : zoneOf(params.TZID);
  return { date, allDay, tz };
}

const instant = (w) => w.allDay ? new Date(w.date.y, w.date.m - 1, w.date.d).getTime() : wallToUtc(w.date, w.tz);

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v || "").trim());
  if (!m) return null;
  const ms = (((+m[2] || 0) * 7 + (+m[3] || 0)) * 24 * 3600 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

/** Every event in a calendar file. */
export function parseIcs(text) {
  const out = [];
  let ev = null, calName = "", depth = 0;
  for (const { name, params, value } of lines(text)) {
    if (name === "BEGIN" && value === "VEVENT") { ev = { exdates: [] }; continue; }
    if (name === "BEGIN" && ev) { depth++; continue; } // VALARM inside an event
    if (name === "END" && ev && depth) { depth--; continue; }
    if (name === "END" && value === "VEVENT") { if (ev.start) out.push({ ...ev, calendar: calName }); ev = null; continue; }
    if (!ev) { if (name === "X-WR-CALNAME") calName = unescape(value); continue; }
    if (depth) continue;
    switch (name) {
      case "UID": ev.uid = value; break;
      case "SUMMARY": ev.title = unescape(value); break;
      case "LOCATION": ev.location = unescape(value); break;
      case "DESCRIPTION": ev.notes = unescape(value); break;
      case "STATUS": ev.status = value.toUpperCase(); break;
      case "DTSTART": ev.start = parseWhen(value, params); break;
      case "DTEND": ev.end = parseWhen(value, params); break;
      case "DURATION": ev.duration = parseDuration(value); break;
      case "RRULE": ev.rrule = Object.fromEntries(value.split(";").map((kv) => kv.split("=")).map(([k, v]) => [k.toUpperCase(), v])); break;
      case "EXDATE": for (const v of value.split(",")) { const w = parseWhen(v, params); if (w) ev.exdates.push(w); } break;
      case "RECURRENCE-ID": ev.recurrenceId = parseWhen(value, params); break;
      default:
    }
  }
  return out;
}

const dayNum = ({ y, m, d }) => Math.round(Date.UTC(y, m - 1, d) / DAY);
const fromDayNum = (n) => { const t = new Date(n * DAY); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const sameDay = (a, b) => a.y === b.y && a.m === b.m && a.d === b.d;

/** Does day `c` (wall date in the series' zone) belong to the series that starts on `s`? */
function matches(rule, s, c) {
  const freq = rule.FREQ, interval = Math.max(1, +rule.INTERVAL || 1);
  const wd = new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay();
  const byMonth = rule.BYMONTH ? rule.BYMONTH.split(",").map(Number) : null;
  if (byMonth && !byMonth.includes(c.m)) return false;
  const byMonthDay = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(",").map(Number) : null;
  const dim = new Date(Date.UTC(c.y, c.m, 0)).getUTCDate();
  const mdOk = () => byMonthDay.some((n) => (n > 0 ? n : dim + n + 1) === c.d);
  const byDay = rule.BYDAY ? rule.BYDAY.split(",").map((x) => { const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(x); return m ? { n: m[1] ? +m[1] : 0, wd: WD.indexOf(m[2]) } : null; }).filter(Boolean) : null;
  const nthOk = () => byDay.some((b) => {
    if (b.wd !== wd) return false;
    if (!b.n) return true;
    const nth = Math.floor((c.d - 1) / 7) + 1, last = Math.floor((dim - c.d) / 7) + 1;
    return b.n > 0 ? b.n === nth : -b.n === last;
  });
  const days = dayNum(c) - dayNum(s);
  if (days < 0) return false;
  switch (freq) {
    case "DAILY":
      if (days % interval) return false;
      return (!byDay || nthOk()) && (!byMonthDay || mdOk());
    case "WEEKLY": {
      const wkst = WD.indexOf(rule.WKST || "MO");
      const weekStart = (x) => dayNum(x) - ((new Date(Date.UTC(x.y, x.m - 1, x.d)).getUTCDay() - wkst + 7) % 7);
      if (((weekStart(c) - weekStart(s)) / 7) % interval) return false;
      return byDay ? byDay.some((b) => b.wd === wd) : wd === new Date(Date.UTC(s.y, s.m - 1, s.d)).getUTCDay();
    }
    case "MONTHLY": {
      if (((c.y - s.y) * 12 + c.m - s.m) % interval) return false;
      if (byMonthDay) return mdOk();
      if (byDay) {
        if (!nthOk()) return false;
        if (rule.BYSETPOS) { // e.g. last weekday of the month
          const all = [];
          for (let d = 1; d <= dim; d++) { const w = new Date(Date.UTC(c.y, c.m - 1, d)).getUTCDay(); if (byDay.some((b) => b.wd === w)) all.push(d); }
          const pos = +rule.BYSETPOS;
          return all[pos > 0 ? pos - 1 : all.length + pos] === c.d;
        }
        return true;
      }
      return c.d === s.d;
    }
    case "YEARLY":
      if ((c.y - s.y) % interval) return false;
      if (byDay && byMonth) return nthOk();
      if (byMonthDay) return (byMonth || [s.m]).includes(c.m) && mdOk();
      return c.m === s.m && c.d === s.d;
    default:
      return false;
  }
}

/**
 * Today's events across calendars: what overlaps [dayStart, dayStart + 1 day)
 * in this phone's time. Sorted: all-day first, then by start.
 */
export function eventsOn(events, dayStart) {
  const dayEnd = dayStart + DAY;
  const moved = new Map(); // uid -> list of overridden occurrence instants
  for (const e of events) if (e.recurrenceId) {
    const list = moved.get(e.uid) || [];
    list.push(instant(e.recurrenceId));
    moved.set(e.uid, list);
  }
  const out = [];
  const push = (e, start) => {
    const len = e.end ? instant(e.end) - instant(e.start) : e.duration != null ? e.duration : e.start.allDay ? DAY : 0;
    const end = start + Math.max(0, len);
    const overlaps = e.start.allDay ? start < dayEnd && (end > dayStart) : start < dayEnd && (end > dayStart || (len === 0 && start >= dayStart));
    if (overlaps) out.push({ title: e.title || "(No title)", location: e.location || "", notes: e.notes || "", calendar: e.calendar || "", allDay: e.start.allDay, start, end, uid: e.uid || "" });
  };
  for (const e of events) {
    if (e.status === "CANCELLED") continue;
    if (!e.rrule || e.recurrenceId) { push(e, instant(e.start)); continue; }
    const s = e.start.date, tz = e.start.tz;
    const len = e.end ? instant(e.end) - instant(e.start) : e.duration || (e.start.allDay ? DAY : 0);
    const until = e.rrule.UNTIL ? parseWhen(e.rrule.UNTIL, {}) : null;
    const untilAt = until ? (until.tz === "UTC" ? wallToUtc(until.date, "UTC") : until.allDay ? instant({ ...until, allDay: false, tz }) + DAY - 1 : wallToUtc(until.date, tz)) : Infinity;
    const count = +e.rrule.COUNT || Infinity;
    const ex = new Set(e.exdates.map((w) => (w.allDay ? `d${dayNum(w.date)}` : instant({ ...w, tz: w.tz || tz }))));
    const skip = new Set(moved.get(e.uid) || []);
    // Walk the series' days up to today (a day either side for zones), counting for COUNT.
    const first = dayNum(s), last = Math.round(dayEnd / DAY) + 1, from = Math.max(first, Math.round(dayStart / DAY) - Math.ceil(len / DAY) - 2);
    let n = 0;
    for (let k = count === Infinity ? from : first; k <= last; k++) {
      const c = fromDayNum(k);
      if (!matches(e.rrule, s, c) && !sameDay(c, s)) continue;
      const start = e.start.allDay ? new Date(c.y, c.m - 1, c.d).getTime() : wallToUtc({ ...c, h: s.h, mi: s.mi, s: s.s }, tz);
      if (start > untilAt) break;
      n++;
      if (n > count) break;
      if (k < from) continue;
      if (ex.has(e.start.allDay ? `d${k}` : start) || skip.has(start)) continue;
      push(e, start);
    }
  }
  return out.sort((a, b) => (b.allDay - a.allDay) || a.start - b.start || a.title.localeCompare(b.title));
}

/* ---- How an event reads on Today ---- */

/** A link to act on: the event's own, or the first in its notes (a video call, say). */
export function calLink(e) {
  if (e.url && /^https?:\/\//.test(e.url)) return e.url;
  return (String(e.notes || "").match(/https?:\/\/[^\s<>"')]+/) || [])[0] || "";
}

/** "FW: Data Engineering Standup" → "Data Engineering Standup". */
export function cleanEventTitle(t) {
  let s = String(t || "").trim();
  for (let k = 0; k < 3; k++) s = s.replace(/^(fw|fwd|re|following|updated|update|canceled|cancelled|invitation|accepted|tentative)\s*:\s*/i, "");
  return s || "Busy";
}

/** Where an event happens, short: "Teams", "Zoom", or the first part of an address. */
export function eventPlace(e) {
  const loc = String(e.location || "").trim(), link = calLink(e);
  const online = /teams\.microsoft|microsoft teams/i.test(loc + link) ? "Teams" : /zoom\.us|\bzoom\b/i.test(loc + link) ? "Zoom"
    : /meet\.google|google meet/i.test(loc + link) ? "Google Meet" : /webex/i.test(loc + link) ? "Webex" : "";
  if (online) return { text: online, online: true };
  if (!loc || /^https?:\/\//.test(loc)) return { text: link ? "Online" : "", online: Boolean(link) };
  return { text: loc.split(",")[0].trim().slice(0, 60), online: false, full: loc };
}


/* ---- The day bar ---- */

/** Free stretches of at least `min` ms between `from` and `to`, around the timed events. */
export function freeGaps(events, from, to, min = 30 * 60e3) {
  const busy = events.filter((e) => !e.allDay && e.end > from && e.start < to)
    .map((e) => [Math.max(e.start, from), Math.min(Math.max(e.end, e.start), to)]).sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let t = from;
  for (const [s, e] of busy) {
    if (s - t >= min) gaps.push({ start: t, end: s });
    t = Math.max(t, e);
  }
  if (to - t >= min) gaps.push({ start: t, end: to });
  return gaps;
}

/** The hours the bar spans: 7a to 9p, stretched to fit early or late events. */
export function barRange(events, dayStart) {
  const h = 3600e3;
  const timed = events.filter((e) => !e.allDay);
  const first = Math.min(dayStart + 7 * h, ...timed.map((e) => e.start));
  const last = Math.max(dayStart + 21 * h, ...timed.map((e) => e.end));
  const from = Math.max(dayStart, dayStart + Math.floor((first - dayStart) / h) * h);
  const to = Math.min(dayStart + 24 * h, dayStart + Math.ceil((last - dayStart) / h) * h);
  return { from, to };
}
