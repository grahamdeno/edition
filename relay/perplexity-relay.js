/*
 * Perplexity relay for Edition: a Cloudflare Worker.
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
    "access-control-allow-methods": "POST, OPTIONS",
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
    const { pathname } = new URL(request.url);
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
