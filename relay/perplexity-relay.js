/*
 * Relay for Edition: a Cloudflare Worker. Two jobs:
 *
 *   POST /v1/agent      forwards Perplexity calls (below)
 *   GET  /preview?url=  reads a page's preview image, title and description
 *                       (its Open Graph tags), so link cards can show a picture
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
    if (request.method === "GET" && pathname === "/preview") return preview(searchParams.get("url"), cors);
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

async function preview(target, cors) {
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
  while (html.length < 400000) {
    const { done, value } = await reader.read();
    if (done) break;
    html += dec.decode(value, { stream: true });
    if (/<\/head>/i.test(html)) break;
  }
  try { reader.cancel(); } catch { /* already closed */ }
  return out(200, parseMeta(html, res.url || url.href));
}
