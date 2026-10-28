/*
 * Song of the day, followed up. When you tap Play, Shoebox notes the song
 * and how often you'd played it. Coming back to the app 10 minutes or more
 * later, it checks with Music whether you heard it through (Music counts a
 * play when a song finishes) and asks how it landed. Your answers shape
 * what comes next: a Rediscovered playlist for the ones you loved, and the
 * ones you didn't take to stay out of the picks.
 */
export const ASK_AFTER = 10 * 60e3;
const ASK_WITHIN = 3 * 864e5, LATER_DAYS = 90, KEEP = 200;

export function logPlay(log, song, now = Date.now()) {
  const entry = { id: String(song.id), title: song.title || "", artist: song.artist || "", playedAt: now, prevPlays: song.plays || 0, prevLast: song.lastPlayed || 0 };
  return [entry, ...(log || []).filter((e) => !(e.id === entry.id && !e.verdict))].slice(0, KEEP);
}

/** The play to ask about now, if any: the latest one not yet asked, 10 minutes to 3 days old. */
export function pendingAsk(log, now = Date.now()) {
  const e = (log || []).find((x) => !x.asked);
  return e && now - e.playedAt >= ASK_AFTER && now - e.playedAt <= ASK_WITHIN ? e : null;
}

/** Did they hear it through? Music adds a play, or moves Last Played past the tap. */
export function heardIt(entry, check) {
  if (!entry || !check) return false;
  return (check.plays || 0) > (entry.prevPlays || 0) || (check.lastPlayed || 0) > entry.playedAt - 60e3;
}

export function answer(log, id, verdict, extra = {}, now = Date.now()) {
  return (log || []).map((e) => (e.id === id && !e.verdict ? { ...e, ...extra, verdict, asked: true, answeredAt: now } : e));
}
export function markAsked(log, id, extra = {}) {
  return (log || []).map((e) => (e.id === id && !e.asked ? { ...e, ...extra, asked: true } : e));
}

/** Songs to leave out of the picks: "not for me" for good, "skip for now" for 90 days. */
export function skipIds(log, now = Date.now()) {
  return [...new Set((log || []).filter((e) => e.verdict === "never" || (e.verdict === "later" && now - (e.answeredAt || e.playedAt) < LATER_DAYS * 864e5)).map((e) => e.id))];
}

/** What the card can say: songs brought back (heard through) in the last 30 days, and how many you loved. */
export function songStats(log, now = Date.now()) {
  const month = (log || []).filter((e) => e.heard && now - e.playedAt < 30 * 864e5);
  return { month: new Set(month.map((e) => e.id)).size, loved: (log || []).filter((e) => e.verdict === "loved").length };
}

export function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
