/*
 * The morning set on Today: weather for your ZIP with a radar or camera
 * picture, last night's games for your teams, a Jung quote, something from
 * this day in your past saves, and a few CPMAI practice questions.
 * Read fresh each day (weather every hour); nothing here is saved as an item.
 */

const DAY = 864e5;

/* ---- Weather (Open-Meteo: free, no key, readable from a web page) ---- */

export const PLACES = { "28409": { name: "Wilmington", lat: 34.163, lon: -77.872, radar: "KLTX", tide: "8658163" } };

/**
 * A ZIP code or town, turned into a place: Open-Meteo's free geocoder for
 * where it is, then the National Weather Service for the nearest radar.
 * US only for now. Returns { name, lat, lon, radar } or null.
 */
export async function lookupPlace(query, fetchImpl = fetch) {
  const q = String(query || "").trim();
  if (q.length < 3) return null;
  if (PLACES[q]) return { ...PLACES[q], zip: q };
  const geo = await fetchImpl(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json&countryCode=US`);
  if (!geo.ok) throw new Error(`Place lookup failed (${geo.status}).`);
  const hit = ((await geo.json()).results || [])[0];
  if (!hit) return null;
  const place = { name: hit.name, lat: +hit.latitude.toFixed(3), lon: +hit.longitude.toFixed(3), radar: "", zip: /^\d{5}$/.test(q) ? q : "" };
  try {
    const pt = await fetchImpl(`https://api.weather.gov/points/${place.lat},${place.lon}`, { headers: { accept: "application/geo+json" } });
    if (pt.ok) {
      const pr = (await pt.json()).properties || {};
      place.radar = pr.radarStation || "";
      const city = pr.relativeLocation?.properties?.city;
      if (city && /^\d/.test(place.name)) place.name = city;
    }
  } catch { /* radar is a bonus */ }
  return place;
}

/** A YouTube video or live stream id from any of its link shapes, or "". */
export function youtubeId(url) {
  let u;
  try { u = new URL(String(url || "").trim()); } catch { return ""; }
  const host = u.hostname.replace(/^(www\.|m\.)/, "");
  let id = "";
  if (host === "youtu.be") id = u.pathname.slice(1);
  else if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
    id = u.searchParams.get("v") || (u.pathname.match(/^\/(?:live|embed|shorts)\/([^/?#]+)/) || [])[1] || "";
  }
  return /^[\w-]{6,20}$/.test(id) ? id : "";
}

const WMO = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Freezing fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Showers", 81: "Showers", 82: "Heavy showers",
  85: "Snow showers", 86: "Snow showers", 95: "Thunderstorms", 96: "Thunderstorms, hail", 99: "Thunderstorms, hail",
};
export const weatherWord = (code) => WMO[code] || "—";
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

export async function fetchWeather(place) {
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  Object.entries({
    latitude: place.lat, longitude: place.lon, timezone: "auto", forecast_days: 1,
    temperature_unit: "fahrenheit", wind_speed_unit: "mph", precipitation_unit: "inch",
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,wind_gusts_10m_max",
  }).forEach(([k, v]) => u.searchParams.set(k, v));
  const res = await fetch(u);
  if (!res.ok) throw new Error(`Weather service said ${res.status}.`);
  const d = await res.json();
  const c = d.current || {}, y = d.daily || {};
  const w = {
    now: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature), word: weatherWord(c.weather_code),
    wind: Math.round(c.wind_speed_10m), windFrom: compass(c.wind_direction_10m || 0),
    hi: Math.round(y.temperature_2m_max?.[0]), lo: Math.round(y.temperature_2m_min?.[0]), today: weatherWord(y.weather_code?.[0]),
    rain: y.precipitation_probability_max?.[0] ?? null, gusts: Math.round(y.wind_gusts_10m_max?.[0] || 0),
    sunrise: y.sunrise?.[0] || null, sunset: y.sunset?.[0] || null, at: Date.now(),
  };
  if (place.tide) {
    try {
      const t = new URL("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter");
      Object.entries({ product: "predictions", station: place.tide, date: "today", datum: "MLLW", interval: "hilo", units: "english", time_zone: "lst_ldt", format: "json", application: "Shoebox" })
        .forEach(([k, v]) => t.searchParams.set(k, v));
      const tr = await fetch(t);
      const td = tr.ok ? await tr.json() : {};
      w.tides = (td.predictions || []).map((p) => ({ t: p.t, type: p.type === "H" ? "High" : "Low" }));
    } catch { /* tides are a bonus */ }
  }
  return w;
}

/* ---- Hockey: last night's games for your teams ---- */

export const TEAMS = { CAR: "Hurricanes", WSH: "Capitals" };

export function gamesFor(data, teams) {
  const out = [];
  for (const g of data?.games || []) {
    const home = g.homeTeam || {}, away = g.awayTeam || {};
    for (const abbr of teams) {
      if (home.abbrev !== abbr && away.abbrev !== abbr) continue;
      const us = home.abbrev === abbr ? home : away, them = home.abbrev === abbr ? away : home;
      const done = /^(OFF|FINAL)$/.test(g.gameState || "");
      const end = g.gameOutcome?.lastPeriodType || g.periodDescriptor?.periodType || "REG";
      const site = (p) => (p ? (/^https?:/.test(p) ? p : `https://www.nhl.com${p.startsWith("/") ? "" : "/"}${p}`) : null);
      out.push({
        team: abbr, name: TEAMS[abbr] || us.name?.default || abbr,
        opp: them.name?.default || them.abbrev, oppAbbr: them.abbrev, home: us === home,
        us: us.score ?? null, them: them.score ?? null, done, end: end === "REG" ? "" : end,
        won: done && (us.score ?? 0) > (them.score ?? 0),
        recap: site(g.threeMinRecap) || site(g.condensedGame) || null,
        center: site(g.gameCenterLink),
        scorers: (g.goals || []).filter((x) => x.teamAbbrev?.default === abbr || x.teamAbbrev === abbr)
          .map((x) => x.name?.default || [x.firstName?.default, x.lastName?.default].filter(Boolean).join(" ")).filter(Boolean),
        start: g.startTimeUTC || null,
      });
    }
  }
  return out;
}

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

/* ---- Apple Weather (WeatherKit, through the relay) ---- */

const cToF = (c) => (c == null ? null : Math.round(c * 9 / 5 + 32));
const kmhToMph = (k) => (k == null ? null : Math.round(k * 0.621371));
/** "MostlyCloudy" → "Mostly cloudy" */
export const conditionWord = (code) => String(code || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()).replace(/ (.)/g, (m, c) => ` ${c.toLowerCase()}`) || "—";

/** Apple Weather's answer, in the same shape as the free source's, plus the next hour. */
export function fromWeatherKit(d, now = Date.now()) {
  const c = d?.currentWeather || {}, day = d?.forecastDaily?.days?.[0] || {};
  const w = {
    now: cToF(c.temperature), feels: cToF(c.temperatureApparent), word: conditionWord(c.conditionCode),
    wind: kmhToMph(c.windSpeed), windFrom: compass(c.windDirection || 0),
    hi: cToF(day.temperatureMax), lo: cToF(day.temperatureMin), today: conditionWord(day.conditionCode),
    rain: day.precipitationChance != null ? Math.round(day.precipitationChance * 100) : null,
    gusts: kmhToMph(day.windGustSpeedMax || c.windGust || 0),
    sunrise: day.sunrise || null, sunset: day.sunset || null, at: Date.now(), source: "apple",
  };
  const sum = d?.forecastNextHour?.summary || [];
  const wet = sum.find((p) => p && p.condition && p.condition !== "clear");
  if (wet) {
    const kind = wet.condition === "precipitation" ? "Rain" : conditionWord(wet.condition);
    const t = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const start = Date.parse(wet.startTime);
    w.nextHour = start <= now + 60e3
      ? `${kind} now${wet.endTime ? `, easing around ${t(wet.endTime)}` : " for the next hour"}`
      : `${kind} starting around ${t(wet.startTime)}`;
  } else if (sum.length) w.nextHour = "No rain in the next hour";
  return w;
}

export async function fetchTides(station) {
  const t = new URL("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter");
  Object.entries({ product: "predictions", station, date: "today", datum: "MLLW", interval: "hilo", units: "english", time_zone: "lst_ldt", format: "json", application: "Shoebox" })
    .forEach(([k, v]) => t.searchParams.set(k, v));
  const tr = await fetch(t);
  const td = tr.ok ? await tr.json() : {};
  return (td.predictions || []).map((p) => ({ t: p.t, type: p.type === "H" ? "High" : "Low" }));
}
