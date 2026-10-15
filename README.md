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

Every control sits in the bottom half of the screen or on the right edge, so the whole app works with one thumb. Choices are made with scroll wheels that click as they pass each option; a tap on any option selects it directly.

1. **Capture.** Tap **+**. A camera-style mode wheel picks Note, Paste, Camera, Photos or Files, and the round shutter saves. On a computer, paste or drag anywhere in the window. On Android and desktop Chrome, Edition appears in the share sheet.
2. **Triage.** Everything new lands in the inbox first, one card at a time. Sweep your thumb across the corner dial to choose Let go, Later, Done or Read, then press Set. Swiping the card left, right or up works too.
3. **Read the edition.** Kept items come back as today's pages. The knurled wheel on the right edge rolls between them; the verdict wheel at the bottom sets what happens next, and Press confirms.
4. **Read.** The reader's right-edge wheel shows progress and scrolls the text when you turn it, with the time left at the top.
5. **Library.** Two drum pickers, status and kind, filter everything you have saved. Find searches it.
6. **Let things go.** "Later" on an edition page moves it to a future edition. Do that eight times and it washes out of the queue. Nothing is deleted; the Library can requeue it.

## AI (optional)

Add an Anthropic API key in Settings. It stays in this browser's storage and is sent only to `api.anthropic.com`.

| Job | When | What it sends |
| --- | --- | --- |
| Enrich | Each new save | The item's text or URL; photos as a downscaled image; PDFs as the document |
| Rank | First open each day, or Settings › Rebuild | Titles and tags of your queue, plus what you finished and let go |
| Discover | Settings or the end of an edition | Your top interests and recent reads; the model searches the web |

Your verdicts are the learning signal: finished and read-now items raise their tags; let-go items lower them. Ranking blends the AI score (60%) with a local score (40%) built from age, deferrals and those tag affinities, so the app still orders sensibly with no key at all. AI suggestions are labeled, go through triage like anything else, and are capped at one per edition.

Default model: `claude-haiku-5-5`, changeable in Settings. Every AI action is a paid API call on your account.

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
src/ai.js             Anthropic API: enrich, rank, discover
src/wheel.js          scroll wheels, drum pickers and the corner dial
src/feel.js           detent clicks (audio, and vibration where supported)
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

Tech tactical: matte graphite surfaces, titanium-gray text and one safety-orange accent, with condensed uppercase headlines (Barlow Condensed), a readable body face (Barlow) and monospace spec labels (IBM Plex Mono). Depth comes from knurled wheel textures and corner brackets, not shadows. One deliberate dark look.

iPhone web apps can't vibrate, so each wheel detent plays a short synthesized click instead. Settings › Wheel clicks turns it off.

MIT.
