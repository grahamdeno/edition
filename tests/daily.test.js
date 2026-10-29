import { test } from "node:test";
import assert from "node:assert/strict";
import { onThisDay, jungFor, JUNG } from "../src/daily.js";

test("on this day prefers a year ago, then a month, then a week", () => {
  const now = new Date(2026, 9, 26, 8).getTime();
  const at = (y, m, d) => new Date(y, m, d, 12).getTime();
  const items = [
    { id: "w", created: at(2026, 9, 19), status: "done" },
    { id: "m", created: at(2026, 8, 26), status: "queued" },
    { id: "y", created: at(2025, 9, 26), status: "done", why: "Read before the offsite" },
    { id: "s", created: at(2025, 9, 26), status: "done", sample: true },
  ];
  assert.deepEqual(onThisDay(items, now), { item: items[2], label: "A year ago today" });
  assert.equal(onThisDay(items.slice(0, 2), now).label, "A month ago today");
  assert.equal(onThisDay(items.slice(0, 1), now).label, "A week ago today");
  assert.equal(onThisDay([], now), null);
});

test("a Jung quote each day, with its source", () => {
  const a = jungFor(new Date(2026, 9, 26).getTime()), b = jungFor(new Date(2026, 9, 27).getTime());
  assert.notEqual(a.q, b.q);
  assert.ok(JUNG.every((j) => j.q && j.src));
});
