# Edition

A personal media app. Not social media. A finite daily edition of the things you saved for yourself.

You capture links, documents, and thoughts. They scatter into notes, open tabs, and messages to yourself. Edition brings a small ration of them back, weighted toward what you have been avoiding, and asks for a verdict. The pile shrinks. Saving something is not a commitment to keep it forever.

Built the same way as [Scales](https://github.com/grahamdeno/scales) and [Tabs](https://github.com/grahamdeno/tabs): single-file lean vanilla JS, offline-first PWA, localStorage only, no accounts, no server, GitHub Pages.

## Core idea

Your problem is not capture. It is return. The app is built around coming back, with capture as one tap.

## Design principles

- **Finite feed, not infinite scroll.** A daily ration of 5–7 items you can actually finish.
- **Resurfacing over storage.** Items come back on a schedule. You never go looking.
- **Forced decisions.** Every card gets a verdict so the pile shrinks instead of growing.
- **Let things die.** Items skipped too many times auto-archive. Saving is not a promise to read.

## How it works

| Stage | What happens |
|---|---|
| Capture | iOS share sheet shortcut, paste a link, or type a quick thought. Writes to a private inbox. |
| Enrich | Auto title, preview image, one-line AI summary of why it might matter. |
| Feed | Daily set of cards, weighted toward older and frequently skipped items (Scales mechanic). |
| Verdict | Read now / Later / Done / Let go. |
| Promote | A thought worth keeping goes to Scales as a principle. A link tied to an interest logs to Threads. |

## Navigation & interaction

Seamless, phone-native, almost no chrome.

- Full-screen cards. Swipe vertically for the next item in today’s ration.
- **Corner dial** (from Tabs): hold the bottom-right corner and sweep your thumb along an arc of glowing ticks to select a verdict or adjust weighting. The value glows as it changes. Relative motion, no jump on press.
- Bottom dock appears only when needed.
- Glass surfaces, copper/amber accent, serif titles, system fonts. Dark metallic with soft glow, inspired by instrument clusters and rotary controls.

## Technical decisions

- Offline-first PWA. Data stays on the device.
- Capture needs a small inbox the share-sheet shortcut can write to and the PWA can read. Recommended: private GitHub Gist (or repo JSON). Consistent with how Scales keeps private content out of the public repo.
- Optional Anthropic API key (stored locally) for enrichment summaries. Built-in fallbacks so the app works fully offline.
- No accounts. No analytics.

## Themes

Inherits the Scales/Tabs system: Auto, Moss, Linen, Ink, Dusk, Return (copper). CSS custom properties. Dark metallic default with amber glow on the dial.

## Project layout (planned)

```
index.html              the app
core.js                 pure logic: weighting, selection, decay, version
sw.js                   service worker
manifest.webmanifest    home screen
styles.css              glass, dial, cards
icons/
docs/                   architecture, screenshots, concept notes
tests/
```

## Status

Concept and repository initialized. Next: capture shortcut + private inbox, then the daily feed with dial navigation.

MIT.
