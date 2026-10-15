/*
 * Sample items, so a fresh install shows what Edition does: links, YouTube
 * videos, quotes, notes and photos across the inbox, queue, done and let go.
 * Each carries `sample: true`; Settings › Samples removes them in one tap.
 * Photos are free stock images served by picsum.photos.
 */

import { createItem, draftFromUrl, STATUS, KIND } from "./model.js";

const DAY = 86400000;

// [status, days ago saved, draft, enrichment]
const SAMPLES = [
  // ---- Inbox: waiting for a first verdict ----
  [STATUS.INBOX, 0, draftFromUrl("https://www.youtube.com/watch?v=UF8uR6Z6KLc"), {
    title: "Steve Jobs' 2005 Stanford commencement address",
    summary: "Three short stories on connecting the dots, love and loss, and death. Fifteen minutes that hold up.",
    tags: ["career", "talks"], minutes: 15,
  }],
  [STATUS.INBOX, 0, { kind: KIND.QUOTE, text: "Plans are worthless, but planning is everything.", author: "Dwight D. Eisenhower" }, {
    title: "Plans are worthless, but planning is everything",
    summary: "The value is in the thinking the plan forces, not the document it produces.",
    tags: ["planning", "leadership"], minutes: 1,
  }],
  [STATUS.INBOX, 1, draftFromUrl("https://scrumguides.org/scrum-guide.html"), {
    title: "The 2020 Scrum Guide",
    summary: "The source text, thirteen pages. Worth a reread before the next retro on how the team is adapting it.",
    tags: ["scrum", "agile"], minutes: 25,
  }],
  [STATUS.INBOX, 1, { kind: KIND.PHOTO, imageUrl: "https://picsum.photos/seed/edition-one/1200/800" }, {
    title: "Saved photo",
    summary: "A stock sample. With an API key, Edition looks at each photo, describes it and titles it for you.",
    tags: ["photos"], minutes: 1,
  }],

  // ---- Queue: kept for a future edition ----
  [STATUS.QUEUED, 6, draftFromUrl("https://paulgraham.com/greatwork.html"), {
    title: "How to do great work",
    summary: "A long essay on choosing what to work on, following curiosity, and staying with hard problems.",
    tags: ["career", "craft"], minutes: 45,
  }],
  [STATUS.QUEUED, 9, draftFromUrl("https://www.youtube.com/watch?v=PUv66718DII"), {
    title: "Bret Victor: Inventing on Principle",
    summary: "A talk on building tools around a guiding principle, with live demos of immediate feedback.",
    tags: ["design", "tools", "talks"], minutes: 54,
  }],
  [STATUS.QUEUED, 4, draftFromUrl("https://martinfowler.com/articles/is-quality-worth-cost.html"), {
    title: "Is high quality software worth the cost?",
    summary: "Fowler's case that internal quality lowers cost within weeks, useful when trading off tech debt in planning.",
    tags: ["software", "planning"], minutes: 18,
  }],
  [STATUS.QUEUED, 3, { kind: KIND.QUOTE, text: "How we spend our days is, of course, how we spend our lives.", author: "Annie Dillard" }, {
    title: "How we spend our days",
    summary: "From The Writing Life. A short reminder about where attention goes.",
    tags: ["time", "attention"], minutes: 1,
  }],
  [STATUS.QUEUED, 2, { kind: KIND.NOTE, text: "Retro idea: ask each person for one thing they would stop doing if no one would notice. Compare the list against the sprint goal and see what survives." }, {
    title: "Retro idea: what would you stop doing?",
    summary: "A prompt for the next retrospective that surfaces low-value work.",
    tags: ["scrum", "retros"], minutes: 1,
  }],
  [STATUS.QUEUED, 12, draftFromUrl("https://www.youtube.com/watch?v=u4ZoJKF_VuA"), {
    title: "Simon Sinek: Start with why",
    summary: "The golden circle talk. Useful framing for a product vision statement.",
    tags: ["leadership", "product", "talks"], minutes: 18,
  }],
  [STATUS.QUEUED, 7, draftFromUrl("https://basecamp.com/shapeup"), {
    title: "Shape Up",
    summary: "Basecamp's free book on six-week cycles and shaping work before betting on it. A useful contrast to sprints.",
    tags: ["product", "agile", "planning"], minutes: 120,
  }],
  [STATUS.QUEUED, 5, { kind: KIND.PHOTO, imageUrl: "https://picsum.photos/seed/edition-two/1200/800" }, {
    title: "Saved photo",
    summary: "A stock sample. Photos of whiteboards, pages and signs get their text transcribed so you can search them.",
    tags: ["photos"], minutes: 1,
  }],

  // ---- Done and let go: the history Edition learns from ----
  [STATUS.DONE, 10, { kind: KIND.QUOTE, text: "Waste no more time arguing what a good man should be. Be one.", author: "Marcus Aurelius" }, {
    title: "Waste no more time arguing",
    summary: "Meditations, book ten.",
    tags: ["philosophy"], minutes: 1,
  }],
  [STATUS.DONE, 14, draftFromUrl("https://mcfunley.com/choose-boring-technology"), {
    title: "Choose boring technology",
    summary: "Dan McKinley on spending a small budget of innovation tokens where they matter.",
    tags: ["software", "strategy"], minutes: 20,
  }],
  [STATUS.DONE, 8, draftFromUrl("https://agilemanifesto.org/"), {
    title: "The Agile Manifesto",
    summary: "Four values and twelve principles. Short enough to reread whenever the process gets heavy.",
    tags: ["agile"], minutes: 5,
  }],
  [STATUS.ARCHIVED, 20, draftFromUrl("https://en.wikipedia.org/wiki/Non-fungible_token"), {
    title: "Non-fungible tokens",
    summary: "Background reading saved during a tokenomics rabbit hole.",
    tags: ["crypto"], minutes: 15,
  }],
];

/** Build the sample items relative to now. */
export function sampleItems(now = Date.now()) {
  return SAMPLES.map(([status, daysAgo, draft, extra], i) => {
    const created = now - daysAgo * DAY - i * 60000;
    const item = createItem({ ...draft, ...extra }, { id: `sample-${i + 1}`, now: created, source: "sample" });
    item.sample = true;
    item.enrichedAt = created;
    item.status = status;
    if (status === STATUS.QUEUED) item.queuedAt = created + 3600000;
    if (status === STATUS.DONE) item.doneAt = created + DAY;
    if (status === STATUS.ARCHIVED) item.archivedAt = created + DAY;
    return item;
  });
}
