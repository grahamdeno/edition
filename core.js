/* Edition core logic. Pure functions, localStorage wrapper, sample data. */

const STORAGE_KEY = "edition-v0";

export const VERDICTS = {
  LET_GO: "let-go",
  LATER: "later",
  DONE: "done",
  READ_NOW: "read-now",
};

export const sampleItems = [
  {
    id: "s1",
    type: "link",
    title: "Long-read you saved from Safari",
    url: "https://example.com/long-read",
    summary: "Why this might matter to you now, one sentence.",
    created: Date.now() - 19 * 86400000,
    skips: 1,
    status: "active",
    minutes: 22,
    tags: ["lead"],
  },
  {
    id: "s2",
    type: "thought",
    title: "Text to self you sent last Tuesday",
    text: "A thought you jotted in Notes and never opened again.",
    summary: "Still true?",
    created: Date.now() - 6 * 86400000,
    skips: 0,
    status: "active",
    minutes: 2,
    tags: ["thought"],
  },
  {
    id: "s3",
    type: "doc",
    title: "Doc saved from Files",
    summary: "12-page PDF. Saved the week you started the new job.",
    created: Date.now() - 12 * 86400000,
    skips: 2,
    status: "active",
    minutes: 18,
    tags: ["pdf"],
  },
  {
    id: "s4",
    type: "link",
    title: "Video · 9 min",
    summary: "Short. You opened the tab last week.",
    created: Date.now() - 7 * 86400000,
    skips: 0,
    status: "active",
    minutes: 9,
    tags: ["video"],
  },
  {
    id: "s5",
    type: "link",
    title: "Open tab from last week",
    summary: "Still open in Safari. Worth closing?",
    created: Date.now() - 8 * 86400000,
    skips: 3,
    status: "active",
    minutes: 5,
    tags: ["tab"],
  },
  {
    id: "s6",
    type: "link",
    title: "Article about platform team design",
    summary: "You saved this the week you started the new job. Is it still the question you're asking?",
    created: Date.now() - 20 * 86400000,
    skips: 3,
    status: "active",
    minutes: 8,
    tags: ["work"],
  },
];

export function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { items: structuredClone(sampleItems), editionDate: todayKey() };
    const data = JSON.parse(raw);
    return data;
  } catch {
    return { items: structuredClone(sampleItems), editionDate: todayKey() };
  }
}

export function save(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function weight(item) {
  return Math.min(4, 1 + 0.5 * (item.skips || 0));
}

export function selectEdition(items, max = 6) {
  const active = items.filter((i) => i.status === "active");
  if (active.length <= max) return active;
  const scored = active.map((i) => ({
    ...i,
    score: weight(i) * (1 + (Date.now() - i.created) / 86400000 / 30),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max);
}

export function applyVerdict(item, verdict) {
  const next = { ...item };
  if (verdict === VERDICTS.LET_GO) {
    next.status = "archived";
  } else if (verdict === VERDICTS.LATER) {
    next.skips = (next.skips || 0) + 1;
    next.lastDeferred = Date.now();
  } else if (verdict === VERDICTS.DONE) {
    next.status = "done";
    next.doneAt = Date.now();
  } else if (verdict === VERDICTS.READ_NOW) {
    next.status = "done";
    next.doneAt = Date.now();
    next.readNow = true;
  }
  return next;
}
