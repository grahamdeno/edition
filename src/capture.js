/*
 * Capture. Every route in ends here: the capture box, paste anywhere,
 * drag and drop, the attach picker, and the share target.
 * Each route hands over text or File objects; this decides what they are
 * (link, YouTube video, quote, note, photo, PDF...), stores the bytes, and
 * puts new items in the inbox. The person never picks a type.
 */

import { detectText, draftFromText, draftFromFile, createItem, KIND } from "./model.js";
import { items, blobs, newId } from "./db.js";

const THUMB_EDGE = 1200;

/**
 * Save text: a link, several links, a YouTube URL, a quote or a thought.
 * Returns the new items (one per thing found).
 */
export async function captureText(text, source = "drop") {
  const out = [];
  for (const draft of detectText(text)) {
    if (draft.videoId) await nameVideo(draft);
    const item = createItem(draft, { id: newId(), source });
    await items.put(item);
    out.push(item);
  }
  return out;
}

/**
 * YouTube's own title and channel, from a public oEmbed proxy that allows
 * browser requests. Best effort: a slow or blocked lookup leaves the draft as it is.
 */
async function nameVideo(draft) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3500);
    const res = await fetch(`https://noembed.com/embed?url=${encodeURIComponent("https://www.youtube.com/watch?v=" + draft.videoId)}`, { signal: ctl.signal });
    clearTimeout(timer);
    const data = await res.json();
    if (data && data.title && !data.error) {
      if (!draft.text) draft.title = data.title;
      draft.author = data.author_name || undefined;
    }
  } catch { /* offline or blocked: keep the default title */ }
}

/** Save one file of any type. */
export async function captureFile(file, source = "drop") {
  const draft = draftFromFile(file);
  draft.blobId = newId();
  await blobs.put(draft.blobId, file);
  const item = createItem(draft, { id: newId(), source });
  if (item.kind === KIND.PHOTO) {
    const thumb = await thumbnail(file);
    if (thumb) {
      item.thumbId = newId();
      await blobs.put(item.thumbId, thumb);
    }
  }
  await items.put(item);
  return item;
}

/** Save everything in a DataTransfer (paste or drop). Returns the new items. */
export async function captureTransfer(dt, source = "drop") {
  const out = [];
  const files = Array.from(dt.files || []);
  for (const f of files) out.push(await captureFile(f, source));
  if (!files.length) {
    const uri = dt.getData("text/uri-list");
    const text = dt.getData("text/plain") || uri;
    out.push(...await captureText(text, source));
  }
  return out;
}

/**
 * Read the clipboard on a tap without saving, so the capture box can show
 * what it found first. Images come back as files, everything else as text.
 * Throws NotAllowedError where the browser refuses.
 */
export async function readClipboard() {
  const out = { text: "", files: [] };
  if (navigator.clipboard && navigator.clipboard.read) {
    try {
      const entries = await navigator.clipboard.read();
      for (const entry of entries) {
        const imageType = entry.types.find((t) => t.startsWith("image/"));
        if (imageType) {
          const blob = await entry.getType(imageType);
          const ext = imageType.split("/")[1] || "png";
          out.files.push(new File([blob], `Pasted image.${ext}`, { type: imageType }));
          continue;
        }
        const textType = entry.types.includes("text/plain") ? "text/plain" : entry.types.includes("text/uri-list") ? "text/uri-list" : null;
        if (textType) out.text += (out.text ? "\n" : "") + (await (await entry.getType(textType)).text());
      }
      return out;
    } catch (e) {
      if (e && e.name === "NotAllowedError") throw e;
    }
  }
  if (navigator.clipboard && navigator.clipboard.readText) out.text = await navigator.clipboard.readText();
  return out;
}

/** Items posted by the share target (Android, desktop Chrome). */
export async function captureShares(list) {
  const out = [];
  for (const s of list) {
    for (const f of s.files || []) out.push(await captureFile(f, "share"));
    if ((s.files || []).length) continue;
    if (s.url) {
      const draft = draftFromText(s.url);
      if (s.title) draft.title = s.title;
      if (s.text && s.text !== s.url) draft.text = s.text;
      const item = createItem(draft, { id: newId(), source: "share" });
      await items.put(item);
      out.push(item);
    } else {
      out.push(...await captureText([s.title, s.text].filter(Boolean).join("\n"), "share"));
    }
  }
  return out;
}

async function thumbnail(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, THUMB_EDGE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 400000) return null;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.82));
  } catch {
    return null;
  }
}
