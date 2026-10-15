# Architecture

## Principles

- **The model is pure.** Everything that decides what an item is, what a verdict does and what goes into an edition is in `src/model.js`, with no DOM, storage or network, and is covered by `tests/model.test.js`.
- **Files are stored as files.** Photos, PDFs and documents go into IndexedDB as Blobs, not strings in localStorage. Photos also get a downscaled thumbnail for fast pages.
- **The edition is stable.** It is chosen once per local calendar day and never reordered. Items queued during the day fill any empty slots (up to six), so the first day isn't blank.
- **AI is additive.** With no key the app is complete: local scoring orders the queue. With a key, the AI enriches, ranks and suggests, and every failure is reported, not swallowed.

## Item

```js
{
  id,                       // UUID
  kind,                     // link | note | photo | pdf | text | video | audio | file
  title, text, url,
  fileName, mime, size,
  blobId, thumbId,          // keys into the blobs store
  summary,                  // one line on why it might matter (AI or none)
  tags, minutes,
  source,                   // drop | paste | share | link | ai | legacy
  suggested,                // true for AI discoveries
  status,                   // inbox | queued | done | archived
  created, queuedAt, doneAt, archivedAt, deferredAt,
  skips, washedOut, readNow,
  history: [{ v, at, stage }],
  ai: { score, why, at },   // latest ranking
  enrichedAt, enrichTries,
}
```

## Verdicts

| Verdict | In the inbox | On an edition page |
| --- | --- | --- |
| Let go | archived | archived |
| Later | queued | deferred: `skips + 1`, leaves today's edition; at 8 it washes out |
| Done | done | done |
| Read now | done, opens the reader | done, opens the reader |

## Ranking

`score = 0.6 × ai.score/100 + 0.4 × local`, or `local` alone without a key.

`local = 0.35 × age + 0.25 × deferrals + 0.4 × affinity`, where age saturates at 21 days, deferrals at 4, and affinity comes from the reader's own verdicts on items sharing tags and kind (`interestProfile`).

## Storage

IndexedDB database `edition`, version 1: `items`, `blobs`, `meta` (edition, theme), `shares` (posted by the share target, drained on launch). The service worker opens the same database, so its upgrade code must match `src/db.js`.

The first version kept everything in `localStorage['edition-v0']`. On first launch it is imported (sample items skipped, photos converted to Blobs) and removed.

## Capture routes

| Route | Where it works |
| --- | --- |
| Drop sheet: type or paste, Paste tile, Photo tile, File tile | Everywhere |
| Paste anywhere outside a text field | Desktop, iPad with keyboard |
| Drag and drop onto the window | Desktop |
| Share target (`manifest.share_target` → `sw.js`) | Android, desktop Chrome |
| `?url=` / `?text=` / `?title=` query | Bookmarklets, desktop shortcuts |

iOS Safari has no Web Share Target, and home-screen apps don't share storage with Safari, so on iPhone the drop sheet is the way in.

## Not yet

- A shared inbox (private Gist or Firebase) so an iOS Shortcut can capture without opening the app.
- Reading a link's page text for enrichment (the browser can't fetch most pages; needs a small proxy or a server-side fetch tool).
- Promote to Scales and Threads.
