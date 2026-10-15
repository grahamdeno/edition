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

1. **Drop.** Tap **+** and paste, type, take a photo, or pick files. On a computer, paste or drag anywhere in the window. On Android and desktop Chrome, Edition appears in the share sheet. One step, no form.
2. **Triage.** Everything new lands in the inbox first, one card at a time. Swipe left to let go, right to read now, up to keep for later, or use the verdict bar.
3. **Read the edition.** Kept items come back as full-screen pages, each set for its kind: notes as large type, photos full-bleed, links as headlines, files as a slab with the file type. The numbered rail on the right jumps between pages and strikes through the ones you've settled.
4. **Let things go.** "Later" on an edition page defers it. Defer it eight times and it washes out of the queue. Everything stays in the Library, searchable, and can be requeued.

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

Set in **Index**: paper ground, black ink, hairline rules, mono labels, one electric-blue accent. Square corners, borders instead of shadows. Paper (light) and Ink (dark) themes follow the system or can be set in Settings.

MIT.
