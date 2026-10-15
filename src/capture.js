/*
 * Capture. Every route in ends here: the drop sheet, paste anywhere,
 * drag and drop, the photo and file pickers, and the share target.
 * Each route hands over text or File objects; this decides what they are,
 * stores the bytes, and puts a new item in the inbox. No forms.
 */

import { draftFromText, draftFromFile, createItem, KIND } from "./model.js";
import { items, blobs, newId } from "./db.js";

const THUMB_EDGE = 1200;

/** Save text (a link, a thought, a pasted paragraph). Returns the new item, or null. */
export async function captureText(text, source = "drop") {
  const draft = draftFromText(text);
  if (!draft) return null;
  const item = createItem(draft, { id: newId(), source });
  await items.put(item);
  return item;
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
    const item = await captureText(text, source);
    if (item) out.push(item);
  }
  return out;
}

/**
 * Read the clipboard on a tap. Images come through as files; text as text.
 * Falls back to plain text where the richer API isn't available.
 */
export async function captureClipboard() {
  const out = [];
  if (navigator.clipboard && navigator.clipboard.read) {
    try {
      const entries = await navigator.clipboard.read();
      for (const entry of entries) {
        const imageType = entry.types.find((t) => t.startsWith("image/"));
        if (imageType) {
          const blob = await entry.getType(imageType);
          const ext = imageType.split("/")[1] || "png";
          out.push(await captureFile(new File([blob], `Pasted image.${ext}`, { type: imageType }), "paste"));
          continue;
        }
        const textType = entry.types.includes("text/uri-list") ? "text/uri-list" : entry.types.includes("text/plain") ? "text/plain" : null;
        if (textType) {
          const item = await captureText(await (await entry.getType(textType)).text(), "paste");
          if (item) out.push(item);
        }
      }
      return out;
    } catch (e) {
      if (e && e.name === "NotAllowedError") throw e;
    }
  }
  if (navigator.clipboard && navigator.clipboard.readText) {
    const item = await captureText(await navigator.clipboard.readText(), "paste");
    if (item) out.push(item);
  }
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
      const item = await captureText([s.title, s.text].filter(Boolean).join("\n"), "share");
      if (item) out.push(item);
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
