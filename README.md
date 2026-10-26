# Shoebox

<img src="icons/logo.svg" alt="" width="72" align="right">

Personal media, not social media. Shoebox is where the links, photos, quotes, notes and files you mean to come back to go, and it gives them back as a timeline that feels like a feed but is written by you: your face on every post, your reason for saving it at the top, the page's own picture underneath. Each day it's finite. Clear it and you're done until tomorrow.

Formerly **Edition**. The web address and your saved items carry over unchanged.

Built like [Scales](https://github.com/grahamdeno/scales) and [Tabs](https://github.com/grahamdeno/tabs): vanilla JavaScript modules, no build step, offline-first PWA, data on the device, hosted on GitHub Pages.

## How it works

```
 Save  ──►  New  ──►  Keep / Done / Let go  ──►  Queue  ──►  Today's six  ──►  Done / Later / Let go
 (any       (top of                                (AI       (stable for         Later 8 times, or
  type)      Today)                                 ranked)   the day)           3 weeks untouched = Fading
```

**Today** is the opening screen, a timeline in three parts:

1. **New**: what you saved since you last looked, newest first. Each post is yours: your photo, when you saved it ("last Tuesday"), and your reason in your own words. Keep sends it to your queue; Done and Let go settle it.
2. **Today's six**: chosen from your queue once a day and never reshuffled. Later moves one to another day.
3. **From outside your saves**: at most two suggestions a day, written by Shoebox, with Keep or Not for me.

When everything is settled, the end of Today shows what you cleared as a collage with a tally. There's nothing more to scroll until tomorrow.

**All saves** has search across everything (titles, notes, replies, tags, text in photos), filters (Kept, New, Loved, Done, Let go, Everything) and **Fading**: saves untouched for three weeks or moved later eight times, waiting for Keep or Let go. Nothing is let go without your verdict.

**On every post**

- **Done**, **Later** (Keep, for a new save) and **Let go**, always in view, with Undo.
- **Love** with the heart, or double-tap a photo. Loved things count toward what Shoebox learns you like, and have their own filter.
- **Reply** to yourself. Replies hang under the post as a thread, so your thinking builds over time.
- **⋯** opens Edit: title, link, why you saved it, notes, tags, minutes, the picture, and Delete for good.
- Tap the picture or title to open it full screen, with the summary, key points and a link to the original.

**Pictures.** Photos run edge to edge. A link shows a picture from its own page: the relay reads every photo on the page, Shoebox drops anything small, strip-shaped or broken, and the AI picks the one that best represents it (or the first, without a key). When you save a link in Add, the candidates show as a picker so you can choose, use your own photo, or have no picture at all. Edit offers the same picker later. Each picture tints its post faintly with its main colour. Stock photos are no longer searched for.

**Your photo.** Settings › Your photo sets the face on your posts. It stays on the phone.

**Updates**, as in Tabs: when a new release has downloaded in the background, Shoebox shows *Update ready* with a Reload button.

## AI (optional)

Add an Anthropic API key in Settings. It stays in this browser's storage and is sent only to `api.anthropic.com`.

| Job | When | What it sends |
| --- | --- | --- |
| Enrich | Each new save | The item's text or URL (and the page's text, through the relay); photos as a downscaled image; PDFs as the document. Returns a title, why it matters, tags, time, what it was saved for, up to three key points (shown as Quick read), any text in a photo, alt text for a photo, a one-line description for posts you didn't give a reason for, and turns a note that is really a quotation into a quote |
| Pick picture | Each new link, after Enrich | Up to four of the page's usable pictures (as URLs) with the title and summary. Returns which one represents it best, or none, with alt text |
| Rank | First open each day, or Settings › Rebuild today | Titles and tags of your queue, plus what you finished, let go and loved |
| Tag | A suggestion arrives untagged, or Re-tag with AI in Edit | Titles, reasons and links, with your tag list |
| Discover | Find something new | With a Perplexity key: your top interests go to Perplexity's Agent API through your relay. Without one: the same goes to Claude, which searches the web |

Your verdicts are the learning signal: finished and loved items raise their tags; let-go items lower them. Ranking blends the AI score (60%) with a local score (40%) built from age, deferrals and those tag affinities, so the app orders sensibly with no key at all.

The **relay** (`relay/`, a free Cloudflare Worker, about five minutes to deploy) reads link pages for their pictures and text, and forwards Perplexity calls. **This release changes the relay**: redeploy it so the picture picker gets every photo on a page. With the old relay, links still get the page's single preview picture.

Model: `claude-haiku-5-5`. Every AI action is a paid API call on your account.

## Problems

Errors are kept on the phone (the last 20). Settings › Problems shows the latest, and **Copy diagnostics** copies a report (version, device, item counts, which keys are set, the problems) with no titles, notes, links or keys.

## Samples

A fresh install loads sample items so Today isn't empty. When `src/samples.js` changes, each phone swaps its old samples for the new set on the next launch (your own saves are untouched), unless you removed samples in Settings.

## Install

Open the GitHub Pages URL in Safari, then Share › Add to Home Screen. If Edition is already on your Home Screen, it updates itself to Shoebox; to see the new icon and name, remove it and add it again (your saves stay, since the address is the same).

**iPhone note:** iOS doesn't let web apps receive the share sheet, and a home-screen app has its own storage separate from Safari. On iPhone, copy something, open Shoebox, tap **+**, then paste.

## Project layout

```
index.html            shell
styles.css            Shoebox tokens and components, light and dark
src/app.js            timeline, reader, sheets, wiring
src/model.js          pure logic: capture parsing, verdicts, ranking, today's six, when-labels, picture checks
src/db.js             IndexedDB storage (database name "edition", kept so saves carry over), backup
src/capture.js        every way in: text, files, clipboard, drag-drop, share target
src/samples.js        example items for a fresh install
src/ai.js             Anthropic API: enrich, pick picture, rank, discover
src/icons.js          the icon set and the Shoebox mark (SVG only, no text glyphs)
src/visuals.js        topic colours and picture tints, worked out on the phone
src/feel.js           soft click on verdicts and saves
relay/                Cloudflare Worker: page pictures and text, Perplexity forwarding
icons/                app icons, favicon and logo.svg
sw.js                 offline shell and share target
tests/                node --test unit tests
docs/ARCHITECTURE.md  data model and decisions
```

## Develop

```
python3 -m http.server     # then open http://localhost:8000
npm test                   # unit tests (Node 20+)
```

Bump `VERSION` in `sw.js` and `src/app.js` with each release so installed copies pick up the new shell.

## Design

A bright white page, warm brown-black ink and one brick-red signature (`#C2362B`); dark mode is a warm near-black with a coral red. Photos carry the rest of the colour. Instrument Serif for your own words and headlines, Geist for everything else. The mark is a photo tucked into an open box.

Accessibility: all text meets 4.5:1 contrast in both themes; every control is at least 44px; type follows the phone's text size; photos carry alt text (from the AI when a key is set); sheets are dialogs that hold focus, close with Escape and return focus; Undo stays for seven seconds and pauses while touched; love has a button as well as the double-tap; motion respects Reduce Motion.

The page itself never scrolls, pans or zooms: only the timeline, the reader and sheets scroll inside it; text fields use 16px type or larger so iOS doesn't zoom on focus.

MIT.
