# Shoebox: App Review notes and privacy labels

> **Before you press Submit on this release:** in App Store Connect › App Privacy, remove **Location › Coarse location**. Shoebox no longer asks for location. Then paste the new description from `app-store.md`.

## Notes for App Review (App Store Connect › App Review Information › Notes)

Shoebox is a personal feed of things the user chooses to save: links, notes, photos, files and email they forward. Saved items come back a few at a time, and the feed ends when they're done. No account is needed.

The app is built on a web view of inmyshoebox.com, plus native features that only the iPhone app has:

1. **Share extension.** In Safari or any app, tap Share › Shoebox. The item appears at the top of Today.
2. **Home Screen widget.** Long-press the Home Screen › + › Shoebox. It shows what's left today.
3. **Files and iCloud Drive backups.** A backup is written to Files › On My iPhone › Shoebox › Backups each day, with a copy in iCloud Drive › Shoebox. Settings › Backup › Import restores it.
4. **Local notifications.** When an item is set aside until a day (Later › This weekend), a reminder arrives that morning.

Shoebox does not use location, and this version does not ask for Calendar or Apple Music access.

To try it: open the app, tap Get started and answer the AI question, then tap + to save a note. It appears on Today. Tap Later on it to pick a day.

AI features use Anthropic's Claude through Shoebox's own server, only after the user turns AI on. Nothing is used to train models.

Support: support@inmyshoebox.com · Privacy: https://inmyshoebox.com/privacy

## App Privacy labels (App Store Connect › App Privacy)

Data used to track you: **None.**

Data not linked to you:

| Category | Type | Why | Notes |
|---|---|---|---|
| User Content | Emails or text messages | App functionality | Mail sent to the user's Shoebox address is held up to 30 days until the app collects it. |
| User Content | Other user content | App functionality | Text of saved items, sent for AI only when AI is on; not kept by the server. |
| User Content | Photos | App functionality | Only photos the user adds, sent for AI only when AI is on; not kept. |
| Usage Data | Product interaction | Analytics | Anonymous daily counts; can be turned off in Settings › Privacy. |
| Diagnostics | Other diagnostic data | Analytics | Kinds of problem, counted; no details. |
| Identifiers | Device ID | App functionality | A random install number for the AI allowance; not linked to the person. |

Not collected: location, contact info, health, financial info, browsing history, search history, contacts, purchases.

