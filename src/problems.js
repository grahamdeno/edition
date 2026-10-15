/*
 * Problems log, as in Tabs. Errors are kept on this phone (the last 20) so
 * Settings > Copy diagnostics can report them. Nothing is ever sent anywhere,
 * and nothing private is kept: no titles, notes, links or keys.
 */

const ERR_KEY = "edition.problems.v1";
const MAX = 20;

export const problems = (() => { try { return JSON.parse(localStorage.getItem(ERR_KEY)) || []; } catch { return []; } })();

let onFirst = null;
let noted = false;
/** Called once per session for the first problem that isn't quiet. */
export function onFirstProblem(fn) { onFirst = fn; }

export function noteError(e, { quiet = false, where = "", version = "" } = {}) {
  const err = e?.reason ?? e?.error ?? e;
  const msg = scrub(String(err?.message || e?.message || err || "Unknown error")).slice(0, 300);
  if (/ResizeObserver loop|^Script error\.?$/.test(msg)) return;
  problems.push({
    at: new Date().toISOString(),
    v: version,
    where: where || "app",
    msg,
    status: err?.status || undefined,
    stack: scrub(String(err?.stack || "").split("\n").slice(0, 6).join("\n")).slice(0, 800),
  });
  problems.splice(0, problems.length - MAX);
  save();
  if (quiet || noted) return;
  noted = true;
  if (onFirst) onFirst();
}

export function clearProblems() { problems.splice(0); save(); }

function save() { try { localStorage.setItem(ERR_KEY, JSON.stringify(problems)); } catch { /* storage full */ } }

/** Strip anything that looks like an API key before it is stored. */
export function scrub(s) { return String(s).replace(/(sk-ant-|pplx-)[\w-]+/g, "$1…").replace(/Bearer\s+\S+/g, "Bearer …"); }

/** One problem as a line (and its stack, indented) for the diagnostics text. */
export function formatProblem(p) {
  return `- ${p.at} v${p.v} ${p.where}${p.status ? ` (${p.status})` : ""}: ${p.msg}${p.stack ? "\n  " + p.stack.replace(/\n/g, "\n  ") : ""}`;
}
