/*
 * Visuals that cost nothing: a colour per topic, a drawn cover for items
 * without a picture, and the main colour of a picture (for tinting its card).
 * All of it is worked out on the phone; nothing is fetched.
 */

/* Eight muted colours of similar weight, so no topic shouts louder than another. */
export const TOPIC_COLORS = ["#C98A4B", "#4F9A94", "#5A86B8", "#9A6BA8", "#B86B78", "#8C9A55", "#7A8696", "#B5653F"];

const KIND_TOPIC = { quote: "words", note: "thoughts", photo: "pictures", video: "watching", audio: "listening", pdf: "documents", text: "documents", file: "files", link: "reading" };

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** The topic a card is coloured by: its first tag, else what kind of thing it is. */
export function topicOf(item) {
  return String((item.tags && item.tags[0]) || KIND_TOPIC[item.kind] || "reading").toLowerCase();
}

/** The same topic always gets the same colour. */
export function topicColor(item) {
  return TOPIC_COLORS[hash(topicOf(item)) % TOPIC_COLORS.length];
}

/**
 * A drawn cover: rings spreading from a corner chosen by the item, in its
 * topic's colour. Deterministic, so a card looks the same every time.
 */
export function coverSvg(item) {
  const color = topicColor(item);
  const h = hash(String(item.id || item.title || "edition"));
  const cx = [10, 90, 20, 80][h % 4], cy = [15, 20, 85, 90][(h >> 3) % 4];
  const step = 9 + (h >> 7) % 6;
  const rings = Array.from({ length: 16 }, (_, i) => {
    const r = step * (i + 1);
    const o = (0.32 - i * 0.017).toFixed(3);
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-opacity="${o}" stroke-width="${i % 3 === 0 ? 0.9 : 0.45}"/>`;
  }).join("");
  return `<svg class="cover" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${rings}</svg>`;
}

/**
 * The main colour of a picture, as #rrggbb, or null if it can't be read (a
 * picture from a site that doesn't allow it). Skips near-black, near-white and
 * grey pixels so the result is the picture's colour, not its background.
 */
export function dominantColor(src) {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return; }
    const img = new Image();
    if (!/^(blob:|data:)/.test(src)) img.crossOrigin = "anonymous";
    const done = (v) => { img.onload = img.onerror = null; resolve(v); };
    img.onerror = () => done(null);
    img.onload = () => {
      try {
        const n = 24;
        const c = document.createElement("canvas");
        c.width = n; c.height = n;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(img, 0, 0, n, n);
        const d = g.getImageData(0, 0, n, n).data;
        const buckets = new Map();
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], gr = d[i + 1], b = d[i + 2];
          const max = Math.max(r, gr, b), min = Math.min(r, gr, b);
          if (max < 40 || min > 225 || max - min < 22) continue; // too dark, too light, too grey
          const key = ((r >> 5) << 6) | ((gr >> 5) << 3) | (b >> 5);
          const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
          e.n++; e.r += r; e.g += gr; e.b += b;
          buckets.set(key, e);
        }
        let best = null;
        for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
        if (!best) { done(null); return; }
        const hex = (v) => Math.round(v / best.n).toString(16).padStart(2, "0");
        done(`#${hex(best.r)}${hex(best.g)}${hex(best.b)}`);
      } catch {
        done(null); // the picture's site doesn't allow reading it
      }
    };
    img.src = src;
  });
}

/**
 * A picture's colour, ready to tint its post: the hex itself when valid, or
 * null. The faint wash is mixed in CSS, so it suits light and dark alike.
 */
export function tintInks(hex) {
  return /^#[0-9a-f]{6}$/i.test(String(hex || "")) ? { t: hex.toLowerCase() } : null;
}

/* ---- Where a picture's subject is ----
 * Pictures are cropped to fit their card. Instead of always keeping the
 * middle, Shoebox finds the part worth keeping, the way smartcrop.js does:
 * edges (detail), skin tones (people) and strong colour, scored on a small
 * copy of the picture, then the best window wins. Worked out on the phone.
 */

/** Pixels of a small copy of a picture, or null if its site doesn't allow reading it. */
export function readPixels(src, n = 64) {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return; }
    const img = new Image();
    if (!/^(blob:|data:)/.test(src)) img.crossOrigin = "anonymous";
    const done = (v) => { img.onload = img.onerror = null; resolve(v); };
    img.onerror = () => done(null);
    img.onload = () => {
      try {
        const s = n / Math.max(img.naturalWidth, img.naturalHeight);
        const w = Math.max(8, Math.round(img.naturalWidth * s)), h = Math.max(8, Math.round(img.naturalHeight * s));
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(img, 0, 0, w, h);
        done({ data: g.getImageData(0, 0, w, h).data, w, h });
      } catch {
        done(null);
      }
    };
    img.src = src;
  });
}

/**
 * The point to keep in view, as percentages { x, y } (50, 50 is the middle),
 * from RGBA pixels. Pure, so it can be tested.
 */
export function focusFromPixels(data, w, h) {
  const n = w * h, lum = new Float32Array(n), score = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    lum[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }
  let total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
      // Detail: how much this pixel differs from its neighbours.
      const nb = (dx, dy) => lum[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))];
      const edge = Math.abs(4 * lum[i] - nb(-1, 0) - nb(1, 0) - nb(0, -1) - nb(0, 1));
      // Skin: close in hue to a skin tone, at a skin-like brightness.
      const mag = Math.hypot(r, g, b) || 1;
      const skinDist = Math.hypot(r / mag - 0.78, g / mag - 0.57, b / mag - 0.44);
      const skin = skinDist < 0.11 && lum[i] > 0.2 && lum[i] < 1 ? (0.11 - skinDist) / 0.11 : 0;
      // Colour: saturated, neither near black nor near white.
      const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
      const sat = max === min ? 0 : l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
      const satScore = l > 0.08 && l < 0.92 ? Math.max(0, sat - 0.35) : 0;
      score[i] = edge * 2 + skin * 1.8 + satScore * 0.5;
      total += score[i];
    }
  }
  if (total < 1e-3 * n) return { x: 50, y: 50 };
  // Summed-area table, then slide a window half the picture's size and keep the best.
  const sum = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    sum[(y + 1) * (w + 1) + x + 1] = score[y * w + x] + sum[y * (w + 1) + x + 1] + sum[(y + 1) * (w + 1) + x] - sum[y * (w + 1) + x];
  const area = (x0, y0, x1, y1) => sum[y1 * (w + 1) + x1] - sum[y0 * (w + 1) + x1] - sum[y1 * (w + 1) + x0] + sum[y0 * (w + 1) + x0];
  const ww = Math.max(2, Math.round(w / 2)), wh = Math.max(2, Math.round(h / 2));
  let best = -1, bx = (w - ww) / 2, by = (h - wh) / 2;
  for (let y = 0; y <= h - wh; y++) {
    for (let x = 0; x <= w - ww; x++) {
      // A slight pull to the middle, so a flat picture stays centred.
      const off = Math.hypot((x + ww / 2) / w - 0.5, (y + wh / 2) / h - 0.5);
      const s = area(x, y, x + ww, y + wh) * (1 - 0.35 * off);
      if (s > best) { best = s; bx = x; by = y; }
    }
  }
  const pct = (v) => Math.round(Math.min(100, Math.max(0, v * 100)));
  return { x: pct((bx + ww / 2) / w), y: pct((by + wh / 2) / h) };
}

/** Where a picture's subject is, or null when the picture can't be read. Tries the relay for sites that block reading. */
export async function focusOf(src, { relay = "" } = {}) {
  let px = await readPixels(src);
  if (!px && relay && /^https?:/.test(src)) px = await readPixels(`${relay}/image?url=${encodeURIComponent(src)}`);
  return px ? focusFromPixels(px.data, px.w, px.h) : null;
}
