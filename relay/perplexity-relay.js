/*
 * Relay for Edition: a Cloudflare Worker. Two jobs:
 *
 *   POST /v1/agent      forwards Perplexity calls (below)
 *   GET  /preview?url=  reads a page's title, description and pictures: its
 *                       preview picture plus the article's own photos, so the
 *                       app can offer a choice; with &text=1 also the page's
 *                       readable text, for a summary
 *   GET  /image?url=    a picture from another site, passed through so the
 *                       app may read its pixels (to find its subject)
 *   GET  /push/key      the public key phones subscribe to notifications with
 *   POST /push/test     send a test notification to a subscription now
 *   POST /remind        keep a reminder: { id, token, at, title, body, url, sub }
 *   DELETE /remind/:id  forget one (?token= must match)
 *   (every 15 minutes)  send the reminders that are due, then forget them
 *   GET  /photo?q=      Openverse photo search (kept for older app versions;
 *                       Shoebox no longer uses it)
 *
 * Perplexity relay for Shoebox (formerly Edition).
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
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
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
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDue(env));
  },
  async fetch(request, env = {}) {
    const origin = request.headers.get("origin") || "";
    const cors = corsHeaders(origin);
    if (!allowed(origin)) return json(403, "This relay only serves Shoebox.", cors);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const { pathname, searchParams } = new URL(request.url);
    if (request.method === "GET" && pathname === "/preview") return preview(searchParams.get("url"), cors, searchParams.get("text") === "1");
    if (request.method === "GET" && pathname === "/image") return image(searchParams.get("url"), cors);
    if (pathname === "/push/key" || pathname === "/push/test" || pathname.startsWith("/remind")) return pushRoute(request, env, pathname, searchParams, cors);
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
  const abs = (u) => { try { u = new URL(u, base).href; } catch { return ""; } return /^https?:\/\//.test(u) ? u : ""; };
  const tw = pick("twitter:image", "twitter:image:src");
  return {
    image: image || null,
    imageW: parseInt(meta["og:image:width"], 10) || null,
    imageH: parseInt(meta["og:image:height"], 10) || null,
    imageAlt: pick("og:image:alt", "twitter:image:alt").slice(0, 160) || null,
    twitterImage: tw ? abs(tw) || null : null,
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
  // Read up to 1.5 MB: past the <head> and into the article, so its photos can be offered too.
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let html = "";
  while (html.length < 1500000) {
    const { done, value } = await reader.read();
    if (done) break;
    html += dec.decode(value, { stream: true });
  }
  try { reader.cancel(); } catch { /* already closed */ }
  const base = res.url || url.href;
  const meta = parseMeta(html, base);
  const images = pageImages(html, base, meta);
  // No preview picture: the article's own first large image.
  if (!meta.image) meta.image = images[0] ? images[0].src : null;
  const { imageW, imageH, imageAlt, twitterImage, ...rest } = meta;
  const body = { ...rest, images };
  return out(200, wantText ? { ...body, text: pageText(html) } : body);
}

/*
 * The first large image in the article (or main, or body). Skips icons, logos,
 * avatars, badges, sprites, tracking pixels, ads and anything marked small, and
 * takes the largest size a srcset offers. Returns an absolute address or null.
 */
const NOT_A_PHOTO = /(logo|icon|favicon|sprite|avatar|gravatar|badge|emoji|spinner|loader|pixel|spacer|blank|1x1|tracking|beacon|placeholder|button|banner|advert|\bads?\b|doubleclick|adserver|share|social|facebook|twitter|linkedin|pinterest)/i;

export function articleImage(html, base) {
  const first = articleImages(html, base, 1)[0];
  return first ? first.src : null;
}

/** Every usable photo in the article, in page order, up to `max`, without duplicates. */
export function articleImages(html, base, max = 8) {
  const h = String(html).replace(/<(script|style|noscript|nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
  const pick = (tag) => { const m = h.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")); return m ? m[1] : ""; };
  const scope = pick("article") || pick("main") || pick("body") || h;
  const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i")) || [])[1] || "";
  const out = [];
  for (const tag of scope.match(/<img\b[^>]*>/gi) || []) {
    if (out.length >= max) break;
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
    if (!/^https?:\/\//.test(src) || out.some((o) => o.src === src)) continue;
    out.push({ src, w: w || null, h: hgt || null, alt: decode(attr(tag, "alt")).slice(0, 160) || null, from: "article" });
  }
  return out;
}

/**
 * Picture candidates for the picker: the page's preview picture, its Twitter
 * card picture if different, then the article's own photos. Logos and icons
 * are skipped here; the app drops anything small or oddly shaped once loaded.
 */
export function pageImages(html, base, meta, max = 8) {
  const list = [];
  const add = (c) => { if (c && c.src && !list.some((o) => o.src === c.src) && !NOT_A_PHOTO.test(c.src.split("?")[0].split("/").pop())) list.push(c); };
  if (meta.image) add({ src: meta.image, w: meta.imageW || null, h: meta.imageH || null, alt: meta.imageAlt || null, from: "preview" });
  if (meta.twitterImage) add({ src: meta.twitterImage, w: null, h: null, alt: null, from: "preview" });
  for (const c of articleImages(html, base, max)) add(c);
  return list.slice(0, max);
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

/** Pass a picture through with CORS headers. Pictures only, up to 8 MB. */
export async function image(target, cors) {
  let u;
  try { u = new URL(String(target || "")); } catch { return json(400, "No picture address.", cors); }
  if (!/^https?:$/.test(u.protocol)) return json(400, "No picture address.", cors);
  let res;
  try {
    res = await fetch(u.href, { headers: { "user-agent": "Mozilla/5.0 (ShoeboxRelay)", accept: "image/*" }, cf: { cacheTtl: 86400, cacheEverything: true } });
  } catch { return json(502, "Couldn't fetch the picture.", cors); }
  const type = res.headers.get("content-type") || "";
  const size = +(res.headers.get("content-length") || 0);
  if (!res.ok || !type.startsWith("image/") || size > 8e6) return json(415, "Not a picture.", cors);
  return new Response(res.body, { status: 200, headers: { ...cors, "content-type": type, "cache-control": "public, max-age=86400" } });
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


/* ================= Notifications (Web Push) =================
 * Shoebox on your phone subscribes to notifications and hands this relay its
 * reminders: a time, a title and the subscription to send to. Every 15
 * minutes a Cron Trigger sends the ones that are due, then forgets them.
 * Reminders live in Workers KV (binding SHOEBOX), each only until it's sent.
 *
 * Web Push needs a key pair (VAPID). The relay makes its own the first time
 * and keeps it in KV, so there's nothing to set up. The message itself is
 * encrypted for the phone (RFC 8291), so Apple and Google can't read it.
 */

const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;

function pushJson(status, body, cors) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
}

async function pushRoute(request, env, pathname, params, cors) {
  const kv = env.SHOEBOX;
  if (!kv) return json(501, "Notifications need the relay's KV storage. Redeploy with the Deploy to Cloudflare button.", cors);
  try {
    if (request.method === "GET" && pathname === "/push/key") {
      const v = await vapidKeys(kv);
      return pushJson(200, { key: v.publicKey }, cors);
    }
    if (request.method === "POST" && pathname === "/push/test") {
      const { sub } = await request.json();
      if (!validSub(sub)) return json(400, "That isn't a notification subscription.", cors);
      const res = await sendPush(kv, sub, { title: "Shoebox", body: "Notifications work. You'll hear from Shoebox when something you set aside comes back.", url: "" });
      return res.ok ? pushJson(200, { ok: true }, cors) : json(502, `The push service said ${res.status}.`, cors);
    }
    if (request.method === "POST" && pathname === "/remind") {
      const r = await request.json();
      const at = +r.at;
      if (!/^[\w-]{4,80}$/.test(String(r.id || "")) || !/^[\w-]{16,80}$/.test(String(r.token || ""))) return json(400, "Missing id or token.", cors);
      if (!Number.isFinite(at) || at > Date.now() + 400 * 864e5) return json(400, "Bad time.", cors);
      if (!validSub(r.sub)) return json(400, "That isn't a notification subscription.", cors);
      const value = JSON.stringify({ token: r.token, at, title: String(r.title || "").slice(0, 120), body: String(r.body || "").slice(0, 240), url: String(r.url || "").slice(0, 500), sub: r.sub });
      const ttl = Math.max(60, Math.round((at - Date.now()) / 1000) + 7 * 86400);
      await kv.put(`r:${r.id}`, value, { metadata: { at }, expirationTtl: ttl });
      return pushJson(200, { ok: true }, cors);
    }
    if (request.method === "DELETE" && pathname.startsWith("/remind/")) {
      const id = pathname.slice("/remind/".length);
      const cur = await kv.get(`r:${id}`, "json");
      if (cur && cur.token === params.get("token")) await kv.delete(`r:${id}`);
      return pushJson(200, { ok: true }, cors);
    }
  } catch {
    return json(400, "Bad request.", cors);
  }
  return json(404, "Not found.", cors);
}

export function validSub(sub) {
  try {
    const u = new URL(sub.endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.test(u.hostname) && typeof sub.keys?.p256dh === "string" && typeof sub.keys?.auth === "string";
  } catch { return false; }
}

/** Send what's due. Run by the Cron Trigger; reads only key metadata until something is due. */
export async function sendDue(env, now = Date.now()) {
  const kv = env.SHOEBOX;
  if (!kv) return 0;
  let sent = 0, cursor;
  do {
    const page = await kv.list({ prefix: "r:", cursor });
    for (const k of page.keys) {
      if ((k.metadata?.at || 0) > now) continue;
      const r = await kv.get(k.name, "json");
      if (r) {
        const res = await sendPush(kv, r.sub, { title: r.title, body: r.body, url: r.url }).catch(() => null);
        // Sent, or the phone has unsubscribed (404/410): forget it. Otherwise try again next run.
        if (res && !(res.ok || res.status === 404 || res.status === 410)) continue;
        if (res && res.ok) sent++;
      }
      await kv.delete(k.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return sent;
}

/* ---- VAPID and encryption ---- */

export const b64u = {
  enc(buf) { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  dec(str) { const s = atob(String(str).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(str).length + 3) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); },
};

async function vapidKeys(kv) {
  const have = await kv.get("vapid", "json");
  if (have) return have;
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const keys = {
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
    publicKey: b64u.enc(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
  await kv.put("vapid", JSON.stringify(keys));
  return keys;
}

/** The Authorization header for one push service (RFC 8292). */
export async function vapidAuth(endpoint, keys, now = Date.now()) {
  const enc = new TextEncoder();
  const head = b64u.enc(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u.enc(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: "https://grahamdeno.github.io/edition/" })));
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u.enc(sig)}, k=${keys.publicKey}`;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

/** Encrypt a message for one subscription (RFC 8291, aes128gcm). */
export async function encryptPush(sub, text, { salt = crypto.getRandomValues(new Uint8Array(16)), pair } = {}) {
  const enc = new TextEncoder();
  const uaPublic = b64u.dec(sub.keys.p256dh), authSecret = b64u.dec(sub.keys.auth);
  pair = pair || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, pair.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, cat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, cat(enc.encode(text), new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return cat(header, sealed);
}

async function sendPush(kv, sub, message) {
  const keys = await vapidKeys(kv);
  const body = await encryptPush(sub, JSON.stringify(message));
  return fetch(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidAuth(sub.endpoint, keys),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "86400",
      urgency: "normal",
    },
    body,
  });
}
