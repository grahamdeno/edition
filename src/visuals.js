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
