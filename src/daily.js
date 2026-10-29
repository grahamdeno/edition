/*
 * The morning set on Today: a Jung quote, something from this day in your
 * past saves, and a few CPMAI practice questions. Read fresh each day;
 * nothing here is saved as an item.
 */

const DAY = 864e5;

/* ---- Jung: one a day, each checked against where he wrote or said it ---- */

export const JUNG = [
  { q: "Your vision will become clear only when you can look into your own heart. Who looks outside, dreams; who looks inside, awakes.", src: "Letter to Fanny Bowditch, 1916" },
  { q: "The meeting of two personalities is like the contact of two chemical substances: if there is any reaction, both are transformed.", src: "Modern Man in Search of a Soul, 1933" },
  { q: "Everything that irritates us about others can lead us to an understanding of ourselves.", src: "Memories, Dreams, Reflections, 1962" },
  { q: "The shoe that fits one person pinches another; there is no recipe for living that suits all cases.", src: "Modern Man in Search of a Soul, 1933" },
  { q: "Loneliness does not come from having no people about one, but from being unable to communicate the things that seem important to oneself.", src: "Memories, Dreams, Reflections, 1962" },
  { q: "One does not become enlightened by imagining figures of light, but by making the darkness conscious.", src: "Alchemical Studies (Collected Works 13)" },
  { q: "Knowing your own darkness is the best method for dealing with the darknesses of other people.", src: "Letter, 1937 (C. G. Jung Letters, Vol. 1)" },
  { q: "The greatest and most important problems of life are all fundamentally insoluble. They can never be solved, but only outgrown.", src: "Commentary on The Secret of the Golden Flower, 1929" },
  { q: "We cannot change anything unless we accept it. Condemnation does not liberate, it oppresses.", src: "Modern Man in Search of a Soul, 1933" },
  { q: "Thoroughly unprepared, we take the step into the afternoon of life.", src: "The Stages of Life, 1930" },
  { q: "The creation of something new is not accomplished by the intellect but by the play instinct acting from inner necessity.", src: "Psychological Types, 1921" },
  { q: "As far as we can discern, the sole purpose of human existence is to kindle a light in the darkness of mere being.", src: "Memories, Dreams, Reflections, 1962" },
  { q: "Where love rules, there is no will to power; and where power predominates, there love is lacking.", src: "On the Psychology of the Unconscious, 1917" },
  { q: "If there is anything that we wish to change in the child, we should first examine it and see whether it is not something that could better be changed in ourselves.", src: "The Integration of the Personality, 1939" },
  { q: "Everyone carries a shadow, and the less it is embodied in the individual's conscious life, the blacker and denser it is.", src: "Psychology and Religion, 1938" },
  { q: "The pendulum of the mind oscillates between sense and nonsense, not between right and wrong.", src: "Memories, Dreams, Reflections, 1962" },
  { q: "Without this playing with fantasy no creative work has ever yet come to birth.", src: "Psychological Types, 1921" },
  { q: "Man needs difficulties; they are necessary for health.", src: "The Transcendent Function (Collected Works 8)" },
];

export function dayOfYear(now = Date.now()) {
  const d = new Date(now), start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - start) / DAY);
}
/** Today's quote, skipping ones you said aren't for you. Returns { ...quote, index } or null when all are retired. */
export function jungFor(now = Date.now(), retired = []) {
  const skip = new Set(retired);
  const start = (dayOfYear(now) + new Date(now).getFullYear()) % JUNG.length;
  for (let k = 0; k < JUNG.length; k++) {
    const i = (start + k) % JUNG.length;
    if (!skip.has(i)) return { ...JUNG[i], index: i };
  }
  return null;
}

/* ---- On this day: something from your past saves ---- */

/** A year ago today, else a month ago, else a week ago: the save you made (or finished) that day. */
export function onThisDay(items, now = Date.now()) {
  const d = new Date(now);
  const sameDay = (ts, y, m, day) => { const x = new Date(ts); return x.getFullYear() === y && x.getMonth() === m && x.getDate() === day; };
  const own = items.filter((i) => !i.sample && !i.school && !i.suggested && i.status !== "aside");
  const tries = [];
  for (let back = 1; back <= 5; back++) tries.push({ label: back === 1 ? "A year ago today" : `${back} years ago today`, y: d.getFullYear() - back, m: d.getMonth(), day: d.getDate() });
  const mAgo = new Date(d.getFullYear(), d.getMonth() - 1, d.getDate());
  if (mAgo.getDate() === d.getDate()) tries.push({ label: "A month ago today", y: mAgo.getFullYear(), m: mAgo.getMonth(), day: mAgo.getDate() });
  const wAgo = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7);
  tries.push({ label: "A week ago today", y: wAgo.getFullYear(), m: wAgo.getMonth(), day: wAgo.getDate() });
  for (const t of tries) {
    const hits = own.filter((i) => sameDay(i.created, t.y, t.m, t.day) || (i.doneAt && sameDay(i.doneAt, t.y, t.m, t.day)));
    if (hits.length) {
      // Loved first, then ones with a reason or a picture, so the memory is worth the look.
      hits.sort((a, b) => (b.loved ? 1 : 0) - (a.loved ? 1 : 0) || (b.why ? 1 : 0) - (a.why ? 1 : 0) || (b.imageUrl || b.blobId ? 1 : 0) - (a.imageUrl || a.blobId ? 1 : 0) || a.created - b.created);
      return { item: hits[0], label: t.label };
    }
  }
  return null;
}
