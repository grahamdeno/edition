/*
 * Onboarding: what's taught when. Pure helpers, so they can be tested;
 * app.js draws the screens.
 *
 * Act 1, Build my morning: topics, your day, AI, then Today fills in.
 * Act 2, first save by doing: a card that walks through the share sheet.
 * Coach marks: one sentence the first time a feature applies, one per session.
 */

/** The topic chips in Build my morning. Each becomes a followed topic for top stories. */
export const TOPICS = ["World", "US", "Tech", "Science", "Business", "Sports", "History", "Health", "Arts", "Local"];

/** How much a chosen topic weighs, next to what finishing a suggestion teaches (+1.5). */
export const FOLLOW_WEIGHT = 3;

/**
 * Add chosen topics to the suggestion profile (they show under Settings ›
 * What Shoebox learned › More of). A chip un-picked on a second run is
 * dropped, unless what you did since has moved it off the chip's weight.
 */
export function followTopics(suggest, topics) {
  const out = { ...suggest, topics: { ...(suggest?.topics || {}) } };
  const picked = new Set((topics || []).map((t) => String(t).trim().toLowerCase()));
  for (const t of TOPICS) { const k = t.toLowerCase(); if (!picked.has(k) && out.topics[k] === FOLLOW_WEIGHT) delete out.topics[k]; }
  for (const t of topics || []) {
    const k = String(t).trim().toLowerCase();
    if (k) out.topics[k] = Math.max(out.topics[k] || 0, FOLLOW_WEIGHT);
  }
  return out;
}

/** Topics already followed, as chip labels, so Build my morning can show them picked. */
export function followedTopics(suggest) {
  const on = new Set(Object.entries(suggest?.topics || {}).filter(([, v]) => v > 0).map(([k]) => k));
  return TOPICS.filter((t) => on.has(t.toLowerCase()));
}

/**
 * The interest profile top stories search from, with followed topics added.
 * A new person has no saves yet, so without this there is nothing to search for.
 * "local" becomes news near their weather place, when there is one.
 */
export function withFollows(profile, suggest, { place = "" } = {}) {
  const tags = { ...(profile?.tags || {}) };
  for (const [k, v] of Object.entries(suggest?.topics || {})) {
    if (!(v > 0)) continue;
    const name = k === "local" ? (place ? `local news in ${place}` : "") : k;
    if (name) tags[name] = (tags[name] || 0) + v;
  }
  return { ...profile, tags };
}

/**
 * Coach marks: each shown once, and at most one per session, so nobody gets
 * a pile of tips. `store` is localStorage or anything with get/setItem.
 */
export const COACH_KEY = "edition.coached";
export function makeCoach(store) {
  let shownThisSession = false;
  const read = () => { try { return JSON.parse(store.getItem(COACH_KEY) || "{}") || {}; } catch { return {}; } };
  const write = (v) => { try { store.setItem(COACH_KEY, JSON.stringify(v)); } catch { /* storage blocked */ } };
  return {
    seen: (k) => Boolean(read()[k]),
    /** Mark a feature as known (shown, or used before the tip came up). */
    see(k, now = Date.now()) { const v = read(); if (!v[k]) { v[k] = now; write(v); } },
    /** May this tip show now? */
    can(k) { return !shownThisSession && !read()[k]; },
    /** Show it: counts for this session and for good. Returns false if it may not show. */
    take(k, now = Date.now()) {
      if (shownThisSession || read()[k]) return false;
      shownThisSession = true;
      this.see(k, now);
      return true;
    },
    /** Let one tip show again (Help › Things Shoebox can do › Show me). */
    forget(k) { const v = read(); delete v[k]; write(v); },
    reset() { shownThisSession = false; write({}); },
  };
}

/**
 * Which step of "save from anywhere" to show at the top of Today, or "".
 * native: the iPhone app. standalone: the web app on the Home Screen.
 */
export function shareStep({ native = false, standalone = false, shared = false, pinned = false, dismissed = false, saves = 0 } = {}) {
  if (dismissed) return "";
  if (native) return !shared ? "share" : !pinned ? "pin" : "";
  if (!standalone) return "home";
  return saves ? "" : "first";
}

/*
 * The first week: one "Did you know" card a morning, from day 2, in order of
 * value. A tip for something already in use is skipped; each shows for one
 * day, or until acted on or dismissed. Days are "YYYY-MM-DD" keys.
 */
export const DAY_TIPS = ["email", "more", "newsletters", "later", "find", "backup"];
export function pickTip({ today, startDay = "", used = new Set(), log = {} } = {}) {
  if (!startDay || !today || today <= startDay) return { key: "", log };
  const done = { ...(log.done || {}) };
  if (log.day === today) return { key: log.key && !done[log.key] ? log.key : "", log };
  if (log.key) done[log.key] = 1; // yesterday's tip had its day
  const key = DAY_TIPS.find((k) => !done[k] && !used.has(k)) || "";
  return { key, log: { done, day: today, key } };
}
export function tipDone(log, key) {
  return { ...log, done: { ...(log?.done || {}), [key]: 1 } };
}
