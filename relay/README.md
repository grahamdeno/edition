# Shoebox relay

A small Cloudflare Worker that does what a web page can't do on its own:

- **Link pictures and text.** Reads a link's page for its photos, title and text (`/preview`), and passes pictures through so the phone can find their subject (`/image`).
- **Perplexity.** Forwards Top stories calls (Perplexity refuses calls made straight from a web page). Your key stays in Shoebox and passes through.
- **Notifications.** Keeps your set-aside reminders and sends them to your phone at 9:00 on the day (`/push/*`, `/remind`, and a Cron Trigger every 15 minutes).

It only answers Shoebox's own address, and it's free: a personal app uses a tiny fraction of Cloudflare's free plan (100,000 requests a day; this uses about a hundred).

## Deploy (one button, about three minutes)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/grahamdeno/edition/tree/main/relay)

1. Tap the button. Sign in to Cloudflare (or create a free account) and connect GitHub when asked.
2. Keep the name `shoebox-relay`. Cloudflare creates the storage for reminders and the 15-minute schedule for you. Select **Create and deploy**.
3. When it's done, copy the address it shows, like `https://shoebox-relay.yourname.workers.dev`.
4. In Shoebox: **Settings › Relay**, paste it into **Relay address**, then **Save and test**.
5. **Settings › Notifications › Turn on**, and allow notifications. A test arrives in a few seconds. On iPhone, do this in Shoebox opened from your Home Screen.

The button copies this folder into a new repository on your GitHub, and Cloudflare redeploys whenever that repository changes.

## Updating

When this folder changes, copy `perplexity-relay.js` over the one in your `shoebox-relay` repository (or ask Claude to). Cloudflare redeploys on its own. The address stays the same.

## Notes

- Requests from any address other than `https://grahamdeno.github.io` (or localhost while developing) get a 403. If the app moves, change `ALLOWED_ORIGINS`.
- Notifications are encrypted for your phone (Web Push, RFC 8291). The relay makes its own key pair the first time and keeps it in its storage; there is nothing to set up.
- A reminder is kept only until it's sent (or for a week after its time, if the phone can't be reached). Bring back now, a new date, or Delete cancels it.
- Free plan limits that matter here: 100,000 requests a day, 1,000 storage writes a day (one per reminder), 5 Cron Triggers (this uses one).
- If your Perplexity key is ever exposed, rotate it at console.perplexity.ai and paste the new one into Shoebox.
