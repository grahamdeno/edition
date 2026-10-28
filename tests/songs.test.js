import { test } from "node:test";
import assert from "node:assert/strict";
import { logPlay, pendingAsk, heardIt, answer, markAsked, skipIds, songStats, ordinal } from "../src/songs.js";

const T = Date.parse("2026-10-27T20:00:00Z"), M = 60e3, D = 864e5;
const song = { id: "42", title: "Harvest Moon", artist: "Neil Young", plays: 14, lastPlayed: T - 400 * D };

test("a play is asked about after 10 minutes, once, within 3 days", () => {
  let log = logPlay([], song, T);
  assert.equal(pendingAsk(log, T + 5 * M), null);
  assert.equal(pendingAsk(log, T + 11 * M).id, "42");
  assert.equal(pendingAsk(log, T + 4 * D), null);
  log = markAsked(log, "42", { heard: true });
  assert.equal(pendingAsk(log, T + 20 * M), null);
});

test("heard it through when Music counted a play", () => {
  const [e] = logPlay([], song, T);
  assert.equal(heardIt(e, { plays: 15, lastPlayed: T + 4 * M }), true);
  assert.equal(heardIt(e, { plays: 14, lastPlayed: T - 400 * D }), false);
});

test("answers shape the picks and the tally", () => {
  let log = logPlay([], song, T);
  log = answer(markAsked(log, "42", { heard: true }), "42", "loved", {}, T + 20 * M);
  log = logPlay(log, { id: "7", plays: 1 }, T + D);
  log = answer(log, "7", "later", {}, T + D);
  log = logPlay(log, { id: "9", plays: 2 }, T + 2 * D);
  log = answer(log, "9", "never", {}, T + 2 * D);
  assert.deepEqual(skipIds(log, T + 3 * D).sort(), ["7", "9"]);
  assert.deepEqual(skipIds(log, T + 100 * D), ["9"], "skip-for-now ends after 90 days");
  assert.deepEqual(songStats(log, T + 3 * D), { month: 1, loved: 1 });
  assert.equal(ordinal(1), "1st"); assert.equal(ordinal(2), "2nd"); assert.equal(ordinal(3), "3rd"); assert.equal(ordinal(11), "11th"); assert.equal(ordinal(22), "22nd");
});

test("cover tint: the most vivid colour wins over a bigger grey area", async () => {
  const { coverTint } = await import("../src/songs.js");
  const px = (n, rgb) => Array.from({ length: n }, () => [...rgb, 255]).flat();
  assert.equal(coverTint(new Uint8ClampedArray([...px(200, [128, 128, 128]), ...px(56, [230, 40, 40])])), "rgb(230, 40, 40)");
  assert.equal(coverTint(new Uint8ClampedArray(px(10, [100, 100, 100]))), "rgb(100, 100, 100)", "grey cover: plain average");
});
