# Edition

A personal media app that is the opposite of social media. You drop in the links, notes, photos, PDFs and files you mean to come back to. Each one gets a verdict, and the ones you keep return as a finite daily edition: six pages, then you're done.

Built like [Scales](https://github.com/grahamdeno/scales) and [Tabs](https://github.com/grahamdeno/tabs): vanilla JavaScript modules, no build step, offline-first PWA, data on the device, hosted on GitHub Pages.

## How it works

```
 Drop  ──►  Inbox  ──►  verdict  ──►  Queue  ──►  Today's edition  ──►  verdict
 (any       (triage     Let go          (AI       (6 pages, ranked,      Done / Read now
  type)      deck)      Later ──────►    ranked)   stable for the day)   Later = defer
                        Done                                              8 deferrals = washes out
                        Read now
```

Two screens and no tab bar. The front page scrolls; the reader is full screen. Add, Search and Settings open as sheets from one corner button, which dims after three idle seconds so the page is all reading space.

1. **Front page.** Today's edition set like a newspaper: a lead story, two smaller ones, then rows. Tap *I have 10 min*, *30 min* or *An evening* and it shows only what fits. Below it: the themes you keep circling (tap one to see everything on it) and the items that have waited longest in your queue, each with *Read today*.
2. **Sort.** When new saves arrive, a line at the top says how many. Tap it and they open full screen, one at a time. Tap Let go, Keep or Done in the bottom-right pill. Swipe left or right to skip ahead or go back.
3. **Read.** Tap any story on the front page to read it full screen. The same pill gives Let go, Later or Done, and the next story slides in. The pill and the close button dim while you read and wake when you touch the screen.
4. **Add.** Corner button, then Add. One box takes a link, a YouTube URL, a quote or a thought; Paste and Attach sit either side of Save, and Edition lists what it found before saving. On a computer, paste or drag anywhere.
5. **Fading.** A save left untouched for three weeks, or moved later eight times, fades: it stops appearing in editions and waits in the Tideline at the bottom of the front page. Nothing is let go without your verdict: tap Keep for three more weeks, or Let go. Items within a week of fading show the days left and a *Read today* button.
6. **Back.** In the reader, pull down from the top and release to go back to the front page, as in Tabs. Sheets close with a plain drag down.

## AI (optional)

Add an Anthropic API key in Settings. It stays in this browser's storage and is sent only to `api.anthropic.com`.

| Job | When | What it sends |
| --- | --- | --- |
| Enrich | Each new save | The item's text or URL; photos as a downscaled image; PDFs as the document. Returns a title, why it matters, tags, time, what it was saved for (read, watch, reference, idea, task), up to three key points, any text in a photo, and turns a note that is really a quotation into a quote |
| Rank | First open each day, or Settings › Rebuild | Titles and tags of your queue, plus what you finished and let go |
| Discover | Settings or the end of an edition | With a Perplexity key: three search queries built from your top interests go to Perplexity's Search API (`api.perplexity.ai/search`, last month only), and Claude picks the best fits if its key is set. Without one: your interests and recent reads go to Claude, which searches the web |

Your verdicts are the learning signal: finished and read-now items raise their tags; let-go items lower them. Ranking blends the AI score (60%) with a local score (40%) built from age, deferrals and those tag affinities, so the app still orders sensibly with no key at all. AI suggestions are labeled, go through triage like anything else, and are capped at one per edition.

Optional Perplexity key, also in Settings, sent only to Perplexity. Discovery works with either key on its own. Perplexity's API can't read your Perplexity history; share answers or articles from Perplexity into Edition and your verdicts on them steer later searches.

Model: `claude-haiku-5-5`. Every AI action is a paid API call on your account.

## Samples

A fresh install loads sixteen sample items (links, YouTube talks, quotes, a note and stock photos) across the inbox, queue and history so every screen has something to show. Settings › Samples removes them, or loads them again. Your own items are never touched.

## Install

Open the GitHub Pages URL in Safari, then Share › Add to Home Screen.

**iPhone note:** iOS doesn't let web apps receive the share sheet, and a home-screen app has its own storage separate from Safari. On iPhone, capture happens inside the app: copy something, open Edition, tap **+**, then **Paste**.

## Project layout

```
index.html            shell
styles.css            Index design system tokens and components
src/app.js            views, gestures, wiring
src/model.js          pure logic: capture parsing, verdicts, ranking, edition selection
src/db.js             IndexedDB storage, migration from v1, backup
src/capture.js        every way in: text, files, clipboard, drag-drop, share target
src/samples.js        example items for a fresh install
src/ai.js             Anthropic API: enrich, rank, discover
src/icons.js          the icon set (SVG only, no text glyphs)
src/feel.js           soft click on verdicts and saves (audio, and vibration where supported)
sw.js                 offline shell and share target
tests/                node --test unit tests for the model
docs/ARCHITECTURE.md  data model and decisions
```

## Develop

```
python3 -m http.server     # then open http://localhost:8000
npm test                   # model unit tests (Node 20+)
```

Bump `VERSION` in `sw.js` and `src/app.js` with each release so installed copies pick up the new shell.

## Design

Near-black ground, warm off-white text and one copper accent. Instrument Serif for headlines, Geist for reading and labels. One SVG icon set at a single stroke weight.

The page itself never scrolls, pans or zooms: only the front page column, the story and sheets scroll inside it; text fields use 16px type so iOS doesn't zoom on focus; double-tap zoom is off.

MIT.
