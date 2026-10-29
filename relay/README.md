# Shoebox relay

A small Cloudflare Worker that does what a web page can't do on its own:

- **Link pictures and text.** Reads a link's page for its photos, title and text (`/preview`), and passes pictures through so the phone can find their subject (`/image`).
- **Perplexity.** Forwards Top stories calls (Perplexity refuses calls made straight from a web page). Your key stays in Shoebox and passes through.
- **Your calendar.** Reads your calendar's private iCal address so today's events can show on Today (`/ical`). Passed straight through; nothing is kept.
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

## Your Shoebox email address (optional)

Forward any email to your own address (for example `shoebox@yourdomain.com`) and it becomes posts in Shoebox; school newsletters become school posts. Cloudflare only receives mail for a domain you have on Cloudflare (a domain costs about $10 a year; Cloudflare sells them at cost).

1. In Cloudflare, add your domain (or buy one under **Domain Registration**).
2. Open the domain › **Email** › **Email Routing** › **Get started**, and let it add its DNS records.
3. **Routing rules** › **Create address**: custom address `shoebox`, action **Send to a Worker**, Worker **shoebox-relay**. Save.
4. Open the Worker › **Settings** › **Variables and Secrets** › add a text variable `EMAIL_ADDRESS` = `shoebox@yourdomain.com` (so Shoebox can show it). Deploy.
5. In Shoebox: **Settings › Email in › Check for email now**. The first phone to check owns the inbox.

Mail waits at the relay for up to 30 days until Shoebox collects it, then it's deleted there.

## Your Apple key (Song of the day)

The relay signs Apple's access tokens with your key. Its Key ID (79QU7DSTN9) and Team ID (7MHDTK68M2) are built in; only the key file itself is secret.

1. In Cloudflare, open the Worker › **Settings** › **Variables and Secrets** › **Add**.
2. Type **Secret**, name `APPLE_P8`, value: open your `AuthKey_79QU7DSTN9.p8` in a text editor and paste everything, including the BEGIN and END lines. Save.
3. Deploy. In Shoebox, Settings › Relay › Save and test.

**Song of the day Shortcut** (Shortcuts app on your iPhone):

1. New Shortcut › **Find Music** › Filter: *Play Count* is greater than 0 › Sort by *Last Played*, *Oldest First* › Limit 1.
2. **Get Contents of URL**: your relay address + `/song`, Method **POST**, Header `x-song-key` = the Song key from Shoebox (Settings › Daily cards), Request Body **JSON** with `title` = Music's *Name*, `artist` = *Artist*, `lastPlayed` = *Last Played*.
3. Automation › **Time of Day** 6:00 AM, Daily › Run Immediately › run this Shortcut.

## Updating

When this folder changes, copy `perplexity-relay.js` over the one in your `shoebox-relay` repository (or ask Claude to). Cloudflare redeploys on its own. The address stays the same.

## Notes

- Requests from any address other than `https://grahamdeno.github.io` (or localhost while developing) get a 403. If the app moves, change `ALLOWED_ORIGINS`.
- Notifications are encrypted for your phone (Web Push, RFC 8291). The relay makes its own key pair the first time and keeps it in its storage; there is nothing to set up.
- A reminder is kept only until it's sent (or for a week after its time, if the phone can't be reached). Bring back now, a new date, or Delete cancels it.
- Free plan limits that matter here: 100,000 requests a day, 1,000 storage writes a day (one per reminder), 5 Cron Triggers (this uses one).
- If your Perplexity key is ever exposed, rotate it at console.perplexity.ai and paste the new one into Shoebox.

## AI (version 6)

The relay now makes every Claude call with Shoebox's own key, so the app never asks for one.

- Secret `ANTHROPIC_API_KEY` (required for AI).
- Optional variables: `AI_DEVICE_DAILY_CENTS` (per install per day, default 25), `AI_DAILY_CENTS` (whole relay per day, default 500), `AI_OWNER_DEVICES` (install ids with no per-install limit; the app shows its id in Settings › AI once it has used AI).
- **AI is for the iPhone app.** The relay's AI answers only installs that proved themselves with Apple's App Attest (the iPhone app does this on its own) and the ids in `AI_OWNER_DEVICES`. The web app has no AI unless the browser is one of yours. `AI_ATTEST=off` opens AI to every existing install again, as an escape hatch.

## Version 26

Weather, NHL scores, the live camera finder and the MapKit token are gone (`/apple/weather`, `/nhl`, `/ai/cams`, `/apple/maps-token`). If the Worker has an `APPLE_WEATHER_SERVICE_ID` variable, it can be deleted.

Updates deploy on their own from GitHub (`.github/workflows/relay.yml`) once the repo has `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and the `SHOEBOX_KV_ID` variable.
