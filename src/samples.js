/*
 * Sample items, so a fresh install shows what Shoebox does: links, YouTube
 * videos, quotes and photos, some with the reason they were saved. Most land
 * on Today as new saves; a few are queued so today's six has something in it.
 *
 * SAMPLES_VERSION changes whenever this list changes, and the app then swaps
 * the old samples on each phone for the new ones (your own saves untouched).
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
    tags: ["career", "talks"], minutes: 15, why: "Watch this one with the kids some night.",
  }],
  [STATUS.INBOX, 0, { kind: KIND.QUOTE, text: "Plans are worthless, but planning is everything.", author: "Dwight D. Eisenhower" }, {
    title: "Plans are worthless, but planning is everything",
    summary: "The value is in the thinking the plan forces, not the document it produces.",
    tags: ["planning", "leadership"], minutes: 1,
  }],
  [STATUS.INBOX, 1, draftFromUrl("https://scrumguides.org/scrum-guide.html"), {
    title: "The 2020 Scrum Guide",
    summary: "The source text, thirteen pages. Worth a reread before the next retro on how the team is adapting it.",
    tags: ["scrum", "agile"], minutes: 25, why: "Reread before the next retro. Where are we really bending it?",
  }],
  [STATUS.INBOX, 1, { kind: KIND.PHOTO, imageUrl: "https://picsum.photos/seed/edition-one/1200/1500" }, {
    title: "Saved photo",
    summary: "A stock sample. With an API key, Shoebox looks at each photo, describes it and titles it for you.",
    tags: ["photos"], minutes: 1, why: "Light like this is why I get up early.",
  }],

  // ---- Queue: kept for a future edition ----
  [STATUS.INBOX, 4, draftFromUrl("https://martinfowler.com/articles/is-quality-worth-cost.html"), {
    title: "Is high quality software worth the cost?",
    summary: "Fowler's case that internal quality lowers cost within weeks, useful when trading off tech debt in planning.",
    tags: ["software", "planning"], minutes: 18, why: "Bring this to planning when tech debt comes up again.",
  }],
  [STATUS.INBOX, 7, draftFromUrl("https://basecamp.com/shapeup"), {
    title: "Shape Up",
    summary: "Basecamp's free book on six-week cycles and shaping work before betting on it. A useful contrast to sprints.",
    tags: ["product", "agile", "planning"], minutes: 120,
  }],
  [STATUS.QUEUED, 5, { kind: KIND.PHOTO, imageUrl: "https://picsum.photos/seed/shoebox-two/1200/1500" }, {
    title: "Saved photo",
    summary: "A stock sample photo, kept on Today so the six has a picture in it.",
    tags: ["photos"], minutes: 1, why: "Want to print this one.",
  }],

  [STATUS.INBOX, 0, draftFromUrl("https://sidelineswap.com/shop/hockey/inline-roller/inline-skates/brand-marsblade-inline/o1-2/l400456"), {
    title: "Marsblade O1 inline skates, size 10 (used)",
    summary: "A used pair of Marsblade O1 inline skates, regular width, size 10, listed on SidelineSwap.",
    tags: ["shopping", "hockey"], minutes: 2,
  }],
  [STATUS.QUEUED, 0, draftFromUrl("https://www.instagram.com/reel/DdtbG_7J1Ri/"), {
    title: "Instagram reel",
    summary: "A saved Instagram reel.",
    tags: ["social"], minutes: 1,
  }],
  [STATUS.INBOX, 1, draftFromUrl("https://haveibeenpwned.com/"), {
    title: "Have I Been Pwned",
    summary: "Check whether your email address has been exposed in a data breach.",
    tags: ["security"], minutes: 2,
  }],
  [STATUS.QUEUED, 1, draftFromUrl("https://www.thecordeliawilmington.com/floor-plan/the-eva-6/"), {
    title: "The Eva floor plan at The Cordelia",
    summary: "The Eva floor plan at The Cordelia in Wilmington.",
    tags: ["housing"], minutes: 2,
  }],
  [STATUS.INBOX, 2, draftFromUrl("https://envnis.com/products/verdant-hex-moss-agate-ring"), {
    title: "Moss agate ring with floral accents",
    summary: "An elongated hexagon moss agate ring with floral cluster accents, 14K gold plated sterling silver, from ENVNIS.",
    tags: ["shopping", "gifts"], minutes: 2,
  }],
  [STATUS.QUEUED, 2, draftFromUrl("https://www.bakedbymelissa.com/collections/cupcakes"), {
    title: "Baked by Melissa cupcakes",
    summary: "Bite-size gourmet cupcakes, ordered online and shipped nationwide.",
    tags: ["shopping", "gifts"], minutes: 2,
  }],
  [STATUS.INBOX, 3, draftFromUrl("https://boarderie.com/products/classic-birthday-dessert-board"), {
    title: "Classic birthday dessert board",
    summary: "Boarderie's classic birthday dessert board.",
    tags: ["shopping", "gifts"], minutes: 2,
  }],
  [STATUS.INBOX, 3, draftFromUrl("https://www.hikarustudio.co/products/kintsugi-repair-kit"), {
    title: "Hikaru kintsugi repair kit",
    summary: "A kintsugi kit for repairing broken ceramics, from Hikaru Studio.",
    tags: ["shopping", "crafts"], minutes: 2,
  }],
];

/** A short fingerprint of the list above: any edit to it changes this. */
export const SAMPLES_VERSION = (() => {
  const text = JSON.stringify(SAMPLES);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
})();

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
