# Perplexity relay

Perplexity's API refuses calls made straight from a web page, so Edition can't reach it on its own. This Cloudflare Worker sits in between and forwards the call. It's free on Cloudflare's plan for this volume, holds no secrets (your key stays in Edition and passes through), and only answers Edition's own address.

## Deploy (about five minutes, no tools needed)

1. Sign in at dash.cloudflare.com (a free account is fine).
2. Go to **Workers & Pages**, then **Create**, then **Create Worker** (or **Start with Hello World**). Name it `edition-relay` and select **Deploy**.
3. Select **Edit code**. Replace everything in the editor with the contents of `perplexity-relay.js`, then select **Deploy**.
4. Copy the Worker's address, for example `https://edition-relay.yourname.workers.dev`.
5. In Edition, open Settings. Under Discovery (Perplexity API), paste it into **Relay address**, then select **Save and test**.

## Notes

- Only `POST /v1/agent` is forwarded. Anything else gets a 404.
- Requests from any address other than `https://grahamdeno.github.io` (or localhost while developing) get a 403. If Edition moves, change `ALLOWED_ORIGINS`.
- If your key is ever exposed, rotate it at console.perplexity.ai and paste the new one into Edition.
