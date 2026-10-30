/*
 * The morning set on Today: something from this day in your past saves, and
 * a few CPMAI practice questions. Read fresh each day;
 * nothing here is saved as an item.
 */

const DAY = 864e5;

export function dayOfYear(now = Date.now()) {
  const d = new Date(now), start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - start) / DAY);
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
