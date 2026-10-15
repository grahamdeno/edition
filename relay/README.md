# Edition relay

This Cloudflare Worker does two jobs a web page can't do on its own: it forwards Perplexity calls (Perplexity refuses calls made straight from a web page), and it reads a link's preview image and title so link cards can show a picture. It's free on Cloudflare's plan for this volume, holds no secrets (your key stays in Edition and passes through), and only answers Edition's own address.

## Deploy (about five minutes, no tools needed)

1. Sign in at dash.cloudflare.com (a free account is fine).
2. Go to **Workers & Pages**, then **Create**, then **Create Worker** (or **Start with Hello World**). Name it `edition-relay` and select **Deploy**.
3. Select **Edit code**. Replace everything in the editor with the contents of `perplexity-relay.js`, then select **Deploy**.
4. Copy the Worker's address, for example `https://edition-relay.yourname.workers.dev`.
5. In Edition, open Settings. Under Discovery (Perplexity API), paste it into **Relay address**, then select **Save and test**.

## Notes

- `POST /v1/agent` is forwarded to Perplexity. `GET /preview?url=` returns a page's preview image, title and description; it only fetches public http(s) pages. Anything else gets a 404.
- **Updating:** when this file changes, open the Worker in Cloudflare, Edit code, paste the new version and Deploy. The address stays the same.
- Requests from any address other than `https://grahamdeno.github.io` (or localhost while developing) get a 403. If Edition moves, change `ALLOWED_ORIGINS`.
- If your key is ever exposed, rotate it at console.perplexity.ai and paste the new one into Edition.
