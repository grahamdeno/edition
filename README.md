# Shoebox

*Keep it. Come back to it.*

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

**Today** is the opening screen. At the top, the **Today strip**: a greeting, what's left, and a circle for each of today's six that fills with a check as you settle it (tap one to jump to its post); when everything is settled it becomes a gold *Cleared* badge. Below it, a timeline in three parts:

1. **New**: what you saved since you last looked, newest first. Each post is yours: your photo, when you saved it ("last Tuesday"), and your reason in your own words. Keep sends it to your queue; Done and Let go settle it.
2. **Today's six**: chosen from your queue once a day and never reshuffled. Later moves one to another day.
3. **Top stories**: at most two a day, newest first, written by Shoebox, with Keep or Not for me.

When everything is settled, the end of Today shows what you cleared as a collage with a tally. There's nothing more to scroll until tomorrow.

**All saves** has search across everything (titles, notes, replies, tags, text in photos), filters (Kept, New, Loved, Done, Let go, Everything) and **Fading**: saves untouched for three weeks or moved later eight times, waiting for Keep or Let go. Nothing is let go without your verdict.

**On every post**

- **Done**, **Later** (Keep, for a new save) and **Let go**, always in view, with Undo.
- **Love** with the heart, or double-tap a photo. Loved things count toward what Shoebox learns you like, and have their own filter.
- **Reply** to yourself. Replies hang under the post as a thread, so your thinking builds over time.
- **⋯** opens Edit: title, link, why you saved it, notes, tags, minutes, the picture, and Delete for good.
- Tap the picture or title to open it full screen, with the summary, key points and a link to the original.

**Pictures.** Photos run edge to edge. A link shows a picture from its own page: the relay reads every photo on the page, Shoebox drops anything small, strip-shaped or broken, and the AI picks the one that best represents it (or the first, without a key). When you save a link in Add, the candidates show as a picker so you can choose, use your own photo, or have no picture at all. Edit offers the same picker later. Each picture tints its post faintly with its main colour. Pictures are cropped around their subject, not their middle: the phone finds it (detail, skin tones and strong colour, as smartcrop.js does), and with an Anthropic key Claude looks at each link's picture and its answer is used instead. Pictures from sites that block reading go through the relay's `/image` (redeploy the relay). A post with no picture of its own (a note, a file, a link whose page had none worth using) gets one found for it: openly licensed photos for its subject through the relay, with Claude picking the best, credited under the photo. Choosing No picture in Edit is respected.

**Add.** Paste or type into the box, or use **Paste** and **Photo or file** under it. Once Shoebox knows what it is, the same fields as Edit appear: Picture (a row of the page's photos), Title (filled in from the page), Why you're saving it, and Your note. The AI tags it and estimates the time, reading your reason and note first; fix either in Edit if needed. A title you type, the AI leaves alone. Several things at once share the reason. Save stays pinned at the bottom.

**Set aside until a date.** In Add (or ⋯ › Edit later), *Show it* offers Now, Tomorrow, This weekend, Next week, In a month or Pick a date. A set-aside item is out of sight (All saves › Set aside lists them, with Bring back now) and comes back as new at the top of Today that morning, marked *Back today*. **Remind me that morning** sends a notification at 9:00 through your relay (Settings › Notifications), or, with notifications off, hands your phone a calendar file with a 9:00 alert. Tapping the notification opens Shoebox on that post.

**School newsletter.** On Mondays and Fridays, Today asks *Newsletter from Myrtle Grove Middle?* Paste the link (Outlook Safe Links are unwrapped) or the newsletter's text, and Shoebox keeps only what matters for your son (8th grade, band, soccer, lacrosse, and school-wide dates). It doesn't summarise: each piece becomes its own short, catchy post from the school, with its details and date. Each post finds a photo (the newsletter page's own, else openly licensed photos through the relay, credited), and Claude picks one and writes a line about Gunner that fits it, shown large over the photo. *None this time* puts the question away until the next Monday or Friday. Settings › School newsletter sets the school, the name, what matters, and *Add one now*. Needs an Anthropic key; a link also needs the relay.

**Your calendar.** Settings › Calendar takes your calendar's private iCal address (Google: Secret address in iCal format; iPhone: Public Calendar share link; Outlook: published ICS link), one per line. Today's events show at the top of Today under *On your calendar*: all-day first, then by time, with *Now* and *Ended*. They're read through the relay, never saved as items, can't be kept or removed, and are gone at midnight. Repeating events, time zones, skipped and moved dates are handled on the phone (`src/calendar.js`).

**Your photo.** Settings › Your photo sets the face on your posts. It stays on the phone.

**Appearance.** Settings › Appearance: Match phone (default), Light or Dark. The choice is applied before the first paint, so the app never flashes the other look.

**Updates**, as in Scales: when a new release has downloaded and taken over, a bar at the top says *Shoebox was updated* with **Reload**. It stays until you tap Reload; no other message replaces it. Returning to the app checks for a release.

## AI (optional)

Add an Anthropic API key in Settings. It stays in this browser's storage and is sent only to `api.anthropic.com`.

| Job | When | What it sends |
| --- | --- | --- |
| Enrich | Each new save | The item's text or URL (and the page's text, through the relay); photos as a downscaled image; PDFs as the document. Returns a title, why it matters, tags, time, what it was saved for, up to three key points (shown as Quick read), any text in a photo, alt text for a photo, a one-line description for posts you didn't give a reason for, and turns a note that is really a quotation into a quote |
| Pick picture | Each new link, after Enrich | Up to four of the page's usable pictures (as URLs) with the title and summary. Returns which one represents it best, or none, with alt text |
| Rank | First open each day, or Settings › Rebuild today | Titles and tags of your queue, plus what you finished, let go and loved |
| Tag | A suggestion arrives untagged, or Re-tag with AI in Edit | Titles, reasons and links, with your tag list. Re-tag (and Enrich) also read your reason, your note and your replies, including what you just typed in Edit, and tag by what it's for first: a pottery class you noted as a date idea gets *date ideas* before *pottery* |
| Top stories | Get top stories | Your top interests and recent finishes. Asks for the biggest stories of the last three days in those areas, one per event, original reporting from established outlets, biggest first; no opinion, listicles, aggregators or social sites (or sites you marked untrusted). With a Perplexity key it goes to Perplexity's Agent API through your relay, with the search held to the last three days; without one, to Claude's web search |

Your verdicts are the learning signal: finished and loved items raise their tags; let-go items lower them. Ranking blends the AI score (60%) with a local score (40%) built from age, deferrals and those tag affinities, so the app orders sensibly with no key at all.

The **relay** (`relay/`, a free Cloudflare Worker, one Deploy to Cloudflare button) reads link pages for their pictures and text, forwards Perplexity calls, and sends set-aside reminders as notifications. **This release changes the relay**: redeploy it so the picture picker gets every photo on a page. With the old relay, links still get the page's single preview picture.

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
src/push.js           notifications through the relay: subscribe, remind, cancel
src/calendar.js       reads iCal files: today's events, repeats, time zones
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

**Grape soda.** A lavender-white page, deep grape ink and one violet signature (`#7B3FF2`) for buttons, tabs and the mark. Dark mode is a deep plum (`#1B1033`), not black, with the same violet. Your own words carry a soft gold underline. Later and Let go are tinted chips; Done is a solid violet pill. The + button is gold (`#FFD23F`), so it never blends with the violet buttons scrolling under it. Photos carry the rest of the colour, and each tints its post faintly. Instrument Serif for your own words and headlines, Geist for everything else. The mark is a box with its lid lifted and things standing inside; the app opens on a loading screen with the mark, the name and *Keep it. Come back to it.*

On iPhone, the installed app blurs a band under the status bar; the header, sheets and reader all start below it.

Accessibility: all text meets 4.5:1 contrast in both themes; every control is at least 44px; type follows the phone's text size; photos carry alt text (from the AI when a key is set); sheets are dialogs that hold focus, close with Escape and return focus; Undo stays for seven seconds and pauses while touched; love has a button as well as the double-tap; motion respects Reduce Motion.

The page itself never scrolls, pans or zooms: only the timeline, the reader and sheets scroll inside it; text fields use 16px type or larger so iOS doesn't zoom on focus.

MIT.
