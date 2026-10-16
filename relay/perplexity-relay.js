/*
 * Relay for Edition: a Cloudflare Worker. Two jobs:
 *
 *   POST /v1/agent      forwards Perplexity calls (below)
 *   GET  /preview?url=  reads a page's preview image, title and description
 *                       (its Open Graph tags), so link cards can show a picture;
 *                       with &text=1 also the page's readable text, for a summary
 *   GET  /photo?q=      finds openly licensed photos for a few words (Openverse),
 *                       for cards that have no picture of their own
 *
 * Perplexity relay for Edition.
 *
 * Perplexity's API refuses calls made straight from a web page, so Edition
 * sends them here and this Worker forwards them. It holds no secrets: the
 * key stays in Edition on your phone and travels in the Authorization header,
 * which is passed through untouched. Only Edition's own address may use it,
 * and only the Agent API endpoint is forwarded.
 *
 * Deploy: see relay/README.md.
 */

const ALLOWED_ORIGINS = ["https://grahamdeno.github.io"];
const UPSTREAM = "https://api.perplexity.ai";
const PATHS = new Set(["/v1/agent"]);

function allowed(origin) {
  return ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": allowed(origin) ? origin : ALLOWED_ORIGINS[0],
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-expose-headers": "retry-after",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function json(status, message, headers) {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { ...headers, "content-type": "application/json" } });
}

export default {
  async fetch(request) {
    const origin = request.headers.get("origin") || "";
    const cors = corsHeaders(origin);
    if (!allowed(origin)) return json(403, "This relay only serves Edition.", cors);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const { pathname, searchParams } = new URL(request.url);
    if (request.method === "GET" && pathname === "/preview") return preview(searchParams.get("url"), cors, searchParams.get("text") === "1");
    if (request.method === "GET" && pathname === "/photo") return photo(searchParams.get("q"), cors);
    if (request.method !== "POST" || !PATHS.has(pathname)) return json(404, "Not found.", cors);
    const auth = request.headers.get("authorization");
    if (!auth) return json(401, "No Perplexity key was sent.", cors);

    let upstream;
    try {
      upstream = await fetch(UPSTREAM + pathname, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: await request.text(),
      });
    } catch {
      return json(502, "The relay couldn't reach Perplexity.", cors);
    }
    const headers = new Headers(cors);
    headers.set("content-type", upstream.headers.get("content-type") || "application/json");
    const retry = upstream.headers.get("retry-after");
    if (retry) headers.set("retry-after", retry);
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};

/* ---- Link previews ----
 * Fetch the page (first 400 KB is plenty for the <head>), read its Open Graph
 * and Twitter card tags, and return { image, title, description, site }.
 * Only public http(s) addresses; private and local hosts are refused.
 */
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i;

export function parseMeta(html, base) {
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const val = (tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (key && val != null && !(key.toLowerCase() in meta)) meta[key.toLowerCase()] = decode(val.trim());
  }
  const titleTag = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
  const pick = (...keys) => keys.map((k) => meta[k]).find(Boolean) || "";
  let image = pick("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src");
  if (image) { try { image = new URL(image, base).href; } catch { image = ""; } }
  if (image && !/^https?:\/\//.test(image)) image = "";
  return {
    image: image || null,
    title: (pick("og:title", "twitter:title") || decode((titleTag || "").trim())).slice(0, 200) || null,
    description: pick("og:description", "twitter:description", "description").slice(0, 300) || null,
    site: pick("og:site_name").slice(0, 80) || null,
  };
}

function decode(s) {
  return String(s).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

async function preview(target, cors, wantText = false) {
  const out = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json", "cache-control": "public, max-age=86400" } });
  let url;
  try { url = new URL(target); } catch { return out(400, { error: { message: "Not a link." } }); }
  if (!/^https?:$/.test(url.protocol) || PRIVATE_HOST.test(url.hostname)) return out(400, { error: { message: "Only public web links." } });
  let res;
  try {
    res = await fetch(url.href, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; EditionPreview/1.0; +https://grahamdeno.github.io/edition/)", accept: "text/html,application/xhtml+xml" },
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
  } catch {
    return out(200, { image: null, title: null, description: null, site: null });
  }
  if (!res.ok || !/html/i.test(res.headers.get("content-type") || "")) return out(200, { image: null, title: null, description: null, site: null });
  // Read only the start of the page.
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let html = "";
  // Read the <head>; keep going into the article when there's text to read or no preview picture yet.
  let headOnly = !wantText;
  while (html.length < 1500000) {
    const { done, value } = await reader.read();
    if (done) break;
    html += dec.decode(value, { stream: true });
    if (headOnly && /<\/head>/i.test(html)) {
      if (parseMeta(html, url.href).image) break;
      headOnly = false;
    }
  }
  try { reader.cancel(); } catch { /* already closed */ }
  const base = res.url || url.href;
  const meta = parseMeta(html, base);
  // No preview picture: the article's own first large image, before anything found elsewhere.
  if (!meta.image) meta.image = articleImage(html, base);
  return out(200, wantText ? { ...meta, text: pageText(html) } : meta);
}

/*
 * The first large image in the article (or main, or body). Skips icons, logos,
 * avatars, badges, sprites, tracking pixels, ads and anything marked small, and
 * takes the largest size a srcset offers. Returns an absolute address or null.
 */
const NOT_A_PHOTO = /(logo|icon|favicon|sprite|avatar|gravatar|badge|emoji|spinner|loader|pixel|spacer|blank|1x1|tracking|beacon|placeholder|button|banner|advert|\bads?\b|doubleclick|adserver|share|social|facebook|twitter|linkedin|pinterest)/i;

export function articleImage(html, base) {
  const h = String(html).replace(/<(script|style|noscript|nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
  const pick = (tag) => { const m = h.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")); return m ? m[1] : ""; };
  const scope = pick("article") || pick("main") || pick("body") || h;
  const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i")) || [])[1] || "";
  for (const tag of scope.match(/<img\b[^>]*>/gi) || []) {
    const w = parseInt(attr(tag, "width"), 10), hgt = parseInt(attr(tag, "height"), 10);
    if ((w && w < 300) || (hgt && hgt < 200)) continue;
    const cls = `${attr(tag, "class")} ${attr(tag, "id")} ${attr(tag, "alt")}`;
    if (NOT_A_PHOTO.test(cls) || attr(tag, "role") === "presentation" || attr(tag, "aria-hidden") === "true") continue;
    // The largest srcset entry, else the lazy-load source, else src.
    const set = (attr(tag, "srcset") || attr(tag, "data-srcset")).split(",").map((p) => p.trim().split(/\s+/))
      .filter((p) => p[0]).map(([u, d]) => ({ u, n: parseFloat(d) || 0 })).sort((a, b) => b.n - a.n);
    let src = (set[0] && set[0].u) || attr(tag, "data-src") || attr(tag, "data-original") || attr(tag, "data-lazy-src") || attr(tag, "src");
    if (!src || /^data:/i.test(src) || /\.svg(\?|$)/i.test(src) || /\.gif(\?|$)/i.test(src) || NOT_A_PHOTO.test(src)) continue;
    try { src = new URL(decode(src), base).href; } catch { continue; }
    if (/^https?:\/\//.test(src)) return src;
  }
  return null;
}

/**
 * The readable text of a page: its article (or main, or body), without
 * scripts, menus, headers, footers and asides, as paragraphs. Max 15,000 chars.
 */
export function pageText(html) {
  let h = String(html)
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const pick = (tag) => { const m = h.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")); return m ? m[1] : ""; };
  const scope = pick("article") || pick("main") || pick("body") || h;
  const paras = [];
  const re = /<(p|h[1-4]|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(scope)) && paras.join("\n\n").length < 15000) {
    const t = decode(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (t.length >= 30 || /^h/i.test(m[1]) && t.length > 3) paras.push(t);
  }
  const text = paras.length ? paras.join("\n\n") : decode(scope.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return text.slice(0, 15000) || null;
}

/* ---- Photos for cards without one: Openverse (openly licensed, no key) ----
 * Returns up to 8 candidates, largest-usable first, each with its credit and
 * licence so the card can show them as the licence asks.
 */
async function photo(q, cors) {
  const out = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json", "cache-control": "public, max-age=86400" } });
  const query = String(q || "").trim().slice(0, 100);
  if (!query) return out(400, { error: { message: "No search words." } });
  let res;
  try {
    res = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=20&mature=false`, {
      headers: { "user-agent": "EditionRelay/1.0 (personal reading app)", accept: "application/json" },
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
  } catch {
    return out(200, { photos: [] });
  }
  const data = await res.json().catch(() => ({}));
  return out(200, { photos: pickPhotos(data.results || []) });
}

/** Keep photos big enough to fill a phone screen; prefer upright and square ones. */
export function pickPhotos(results) {
  return results
    .filter((r) => r && (r.url || r.thumbnail) && (r.width || 0) >= 500)
    .map((r) => ({
      src: (r.width || 0) <= 2600 && r.url ? r.url : r.thumbnail,
      thumb: r.thumbnail || r.url,
      credit: [r.creator, r.provider].filter(Boolean).join(" · ") || null,
      license: r.license ? `CC ${String(r.license).toUpperCase()}${r.license_version ? " " + r.license_version : ""}`.replace("CC CC0", "CC0").replace("CC PDM", "Public domain") : null,
      link: r.foreign_landing_url || null,
      tall: (r.height || 0) >= (r.width || 1) * 0.9,
    }))
    .sort((a, b) => Number(b.tall) - Number(a.tall))
    .slice(0, 8);
}
