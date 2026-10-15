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

Every screen has the same shape: a top bar, one card, one row of actions and the tab bar. Everything you touch sits in the bottom third, within reach of one thumb, and every verdict is a single tap.

1. **Add.** Tap **+**. One box takes a link, a YouTube URL, a quote or a thought; Paste and Attach sit either side of Save. Edition lists what it found before it saves. On a computer, paste or drag anywhere in the window. On Android and desktop Chrome, Edition appears in the share sheet.
2. **Triage.** New saves land in the Inbox one card at a time. Tap Let go, Later, Done or Read, or swipe the card: left to let go, right to read, up for later.
3. **Read the edition.** The items you keep come back as today's edition, one card at a time, with the same four actions. The bar under the title shows how far through you are.
4. **Read.** The reader shows the whole item with the time left at the top. The thin line on the right edge shows progress; drag it to jump.
5. **Library.** Search everything and filter by Queue, Inbox, Done, Let go or All. Anything let go can be requeued.
6. **Let things go.** "Later" on an edition card moves it to a future edition. Do that eight times and it washes out of the queue. Nothing is deleted.

## AI (optional)

Add an Anthropic API key in Settings. It stays in this browser's storage and is sent only to `api.anthropic.com`.

| Job | When | What it sends |
| --- | --- | --- |
| Enrich | Each new save | The item's text or URL; photos as a downscaled image; PDFs as the document. Returns a title, why it matters, tags, time, what it was saved for (read, watch, reference, idea, task), up to three key points, any text in a photo, and turns a note that is really a quotation into a quote |
| Rank | First open each day, or Settings › Rebuild | Titles and tags of your queue, plus what you finished and let go |
| Discover | Settings or the end of an edition | Your top interests and recent reads; the model searches the web |

Your verdicts are the learning signal: finished and read-now items raise their tags; let-go items lower them. Ranking blends the AI score (60%) with a local score (40%) built from age, deferrals and those tag affinities, so the app still orders sensibly with no key at all. AI suggestions are labeled, go through triage like anything else, and are capped at one per edition.

Default model: `claude-haiku-5-5`, changeable in Settings. Every AI action is a paid API call on your account.

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

Calm tactical: graphite surfaces, warm off-white text and one orange accent kept for the main action. Barlow for text, Barlow Condensed for titles in sentence case, IBM Plex Mono for the small metadata line. One icon set drawn as SVG at a single stroke weight.

The page itself never scrolls, pans or zooms: only the card and lists scroll inside it, text fields use 16px type so iOS doesn't zoom on focus, and double-tap zoom is off.

MIT.
