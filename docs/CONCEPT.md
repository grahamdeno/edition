# Edition concept notes

## Name

Edition: the morning paper of your own mind. A finite, curated daily ration rather than an infinite pile.

Alternatives considered: Commonplace, Undertow, Gleanings.

## Scroll wheels & seamless navigation

The primary physical metaphor is the instrument cluster dial / corner dial already proven in Tabs (`dial.js`).

- Bottom-right corner: hold and sweep thumb along an arc of ticks.
- Ticks glow amber/copper as the value changes.
- Relative motion only (dead zone so a press does not jump).
- Use for: selecting the verdict (Read now / Later / Done / Let go), adjusting daily ration size, or scrubbing through today's set.

Secondary gestures:
- Vertical swipe: next/previous card in the finite feed.
- Tap card: expand full content or open original link.
- Long-press: promote to Scales (as principle) or mark interest for Threads.

Chrome is almost absent. Full-bleed cards. Glass overlay for the dial and any dock. Safe-area aware. Works one-handed.

## Visual language

Inherited from Tabs and Scales:
- Dark metallic default (`--bg: #0c0d0f`)
- Copper/amber accent (`--accent: #eda27f`)
- Glass surfaces with inset highlight and soft shadow
- Serif for titles (`New York` / ui-serif)
- System sans for body
- Soft radial glow at top
- Dial ticks with Gaussian blur glow filter

Inspired by the close-up of a glowing amber "2×" on a curved dark bezel: precision, restraint, instrument-like rather than app-like.

## Data model (sketch)

```js
{
  id, type: 'link' | 'thought' | 'doc',
  title, url, text, summary, image,
  created, lastSeen, skips, reads,
  status: 'active' | 'later' | 'done' | 'archived',
  weight: 1 + 0.5 * skips, // capped
  promotedTo: null | 'scales' | 'threads'
}
```

Daily selection: weighted random from active items, prefer older + higher skip count, max 5–7, cooldown so the same item does not repeat immediately.

## Capture inbox

Share-sheet shortcut (Shortcuts app) → private Gist JSON array.
PWA polls the Gist (or uses a simple fetch) and merges new items, then clears them from the Gist.
Alternative later: Firebase if real-time becomes necessary. Clipboard-only is too much friction.

## Decay

After N skips (e.g. 8) without a positive verdict, auto-archive. Surfaces the Scales principle: avoidance is information.
