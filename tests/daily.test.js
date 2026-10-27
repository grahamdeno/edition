import { test } from "node:test";
import assert from "node:assert/strict";
import { gamesFor, onThisDay, jungFor, JUNG, compass, weatherWord } from "../src/daily.js";

test("last night's games for the Hurricanes and Capitals", () => {
  const data = { games: [
    { gameState: "OFF", homeTeam: { abbrev: "CAR", name: { default: "Hurricanes" }, score: 4 }, awayTeam: { abbrev: "NYR", name: { default: "Rangers" }, score: 3 },
      gameOutcome: { lastPeriodType: "OT" }, threeMinRecap: "/video/recap-123", gameCenterLink: "/gamecenter/nyr-vs-car/2026/10/26/2026020100",
      goals: [{ teamAbbrev: { default: "CAR" }, name: { default: "S. Aho" } }, { teamAbbrev: { default: "NYR" }, name: { default: "A. Panarin" } }] },
    { gameState: "FINAL", homeTeam: { abbrev: "BOS", score: 2 }, awayTeam: { abbrev: "WSH", score: 1 } },
    { gameState: "OFF", homeTeam: { abbrev: "TOR", score: 5 }, awayTeam: { abbrev: "MTL", score: 1 } },
  ] };
  const g = gamesFor(data, ["CAR", "WSH"]);
  assert.equal(g.length, 2);
  assert.deepEqual([g[0].name, g[0].us, g[0].them, g[0].won, g[0].end, g[0].home], ["Hurricanes", 4, 3, true, "OT", true]);
  assert.equal(g[0].recap, "https://www.nhl.com/video/recap-123");
  assert.deepEqual(g[0].scorers, ["S. Aho"]);
  assert.deepEqual([g[1].name, g[1].won, g[1].home], ["Capitals", false, false]);
});

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
  assert.equal(compass(225), "SW");
  assert.equal(weatherWord(63), "Rain");
});

import { fromWeatherKit, conditionWord } from "../src/daily.js";
test("Apple Weather maps to the card: Fahrenheit, mph, chance, next hour", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const w = fromWeatherKit({
    currentWeather: { temperature: 18, temperatureApparent: 17.2, conditionCode: "MostlyCloudy", windSpeed: 16, windDirection: 225 },
    forecastDaily: { days: [{ temperatureMax: 23.3, temperatureMin: 15, precipitationChance: 0.4, conditionCode: "Drizzle", sunrise: "2026-10-27T11:26:00Z", sunset: "2026-10-27T22:22:00Z", windGustSpeedMax: 30 }] },
    forecastNextHour: { summary: [{ condition: "clear", startTime: "2026-10-27T12:00:00Z" }, { condition: "precipitation", startTime: "2026-10-27T12:25:00Z", endTime: "2026-10-27T13:00:00Z" }] },
  }, now);
  assert.deepEqual([w.now, w.feels, w.word, w.wind, w.windFrom, w.hi, w.lo, w.rain, w.gusts, w.source], [64, 63, "Mostly cloudy", 10, "SW", 74, 59, 40, 19, "apple"]);
  assert.match(w.nextHour, /^Rain starting around/);
  assert.equal(conditionWord("HeavyRain"), "Heavy rain");
});

import { lookupPlace, youtubeId } from "../src/daily.js";

test("a ZIP code becomes a place with its nearest radar", async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    if (url.includes("geocoding")) return { ok: true, json: async () => ({ results: [{ name: "Burlington", latitude: 44.4759, longitude: -73.2121 }] }) };
    return { ok: true, json: async () => ({ properties: { radarStation: "KCXX", relativeLocation: { properties: { city: "Burlington" } } } }) };
  };
  const p = await lookupPlace("05401", fake);
  assert.deepEqual(p, { name: "Burlington", lat: 44.476, lon: -73.212, radar: "KCXX", zip: "05401" });
  assert.match(calls[1], /api\.weather\.gov\/points\/44\.476,-73\.212/);
  assert.equal((await lookupPlace("28409", fake)).radar, "KLTX");
  assert.equal(await lookupPlace("zz", fake), null);
});

test("a place still works when the radar lookup fails", async () => {
  const fake = async (url) => (url.includes("geocoding")
    ? { ok: true, json: async () => ({ results: [{ name: "Anchorage", latitude: 61.2181, longitude: -149.9003 }] }) }
    : { ok: false, status: 500 });
  const p = await lookupPlace("Anchorage", fake);
  assert.equal(p.name, "Anchorage");
  assert.equal(p.radar, "");
  assert.equal(p.zip, "");
});

test("YouTube links in any shape give the video id; pictures don't", () => {
  for (const u of ["https://www.youtube.com/watch?v=abcDEF12345", "https://youtu.be/abcDEF12345", "https://youtube.com/live/abcDEF12345?si=x", "https://m.youtube.com/embed/abcDEF12345"]) assert.equal(youtubeId(u), "abcDEF12345");
  assert.equal(youtubeId("https://www.vision-environnement.com/live/image/webcam/x.JPG"), "");
  assert.equal(youtubeId("not a link"), "");
});

import { placeFromCoords, kmBetween } from "../src/daily.js";

test("the phone's location becomes a place; the phone's own town name wins", async () => {
  const fake = async () => ({ ok: true, json: async () => ({ properties: { radarStation: "KLTX", relativeLocation: { properties: { city: "Masonboro" } } } }) });
  assert.deepEqual(await placeFromCoords(34.1634, -77.8721, { name: "Wilmington", zip: "28409" }, fake), { name: "Wilmington", lat: 34.163, lon: -77.872, radar: "KLTX", zip: "28409" });
  assert.equal((await placeFromCoords(34.16, -77.87, {}, fake)).name, "Masonboro");
});

test("moving town is told apart from moving across town", () => {
  const home = { lat: 34.163, lon: -77.872 };
  assert.ok(kmBetween(home, { lat: 34.21, lon: -77.89 }) < 15);
  assert.ok(kmBetween(home, { lat: 35.78, lon: -78.64 }) > 150);
});
