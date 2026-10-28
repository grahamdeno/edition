/*
 * Storage. Everything stays on this device in IndexedDB:
 *   items   one record per saved thing (metadata only)
 *   blobs   the original bytes of photos, PDFs and files, plus thumbnails
 *   meta    small settings and state (today's edition, theme)
 *   shares  files posted by the share target, waiting to be imported
 * The service worker opens the same database; keep SCHEMA in step with sw.js.
 */

const DB_NAME = "edition";
const DB_VERSION = 1;
const LEGACY_KEY = "edition-v0";
const LEGACY_SAMPLE_IDS = new Set(["s1", "s2", "s3", "s4", "s5", "s6"]);

let dbPromise;

export function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("items")) {
        const s = db.createObjectStore("items", { keyPath: "id" });
        s.createIndex("status", "status");
      }
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      if (!db.objectStoreNames.contains("shares")) db.createObjectStore("shares", { keyPath: "id", autoIncrement: true });
    };
    req.onsuccess = () => {
      const db = req.result;
      // iOS can close the connection while the app sits in the background; open a fresh one next time.
      const forget = () => { if (dbPromise === mine) dbPromise = null; };
      db.onclose = forget;
      db.onversionchange = () => { try { db.close(); } catch { /* closing */ } forget(); };
      resolve(db);
    };
    req.onerror = () => { if (dbPromise === mine) dbPromise = null; reject(req.error); };
  });
  const mine = dbPromise;
  return dbPromise;
}

/** A connection iOS has closed throws InvalidStateError ("The database connection is closing"). */
const closedConn = (e) => e && (e.name === "InvalidStateError" || /connection is clos/i.test(e.message || ""));

function tx(store, mode, fn, retry = true) {
  return open().then((db) => new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(store, mode); } catch (e) {
      // The connection went stale: drop it and try once more on a new one.
      if (retry && closedConn(e)) { if (dbPromise) dbPromise = null; resolve(tx(store, mode, fn, false)); return; }
      reject(e); return;
    }
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Transaction aborted"));
  }));
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export const items = {
  all: () => tx("items", "readonly", (s) => wrap(s.getAll())),
  get: (id) => tx("items", "readonly", (s) => wrap(s.get(id))),
  put: (item) => tx("items", "readwrite", (s) => { s.put(item); }),
  putMany: (list) => tx("items", "readwrite", (s) => { list.forEach((i) => s.put(i)); }),
  remove: (id) => tx("items", "readwrite", (s) => { s.delete(id); }),
};

export const blobs = {
  get: (id) => tx("blobs", "readonly", (s) => wrap(s.get(id))).then((r) => (r ? r.blob : null)),
  put: (id, blob) => tx("blobs", "readwrite", (s) => { s.put({ id, blob }); }),
  remove: (id) => tx("blobs", "readwrite", (s) => { s.delete(id); }),
};

export const meta = {
  get: (key, fallback = null) => tx("meta", "readonly", (s) => wrap(s.get(key))).then((r) => (r ? r.value : fallback)),
  set: (key, value) => tx("meta", "readwrite", (s) => { s.put({ key, value }); }),
};

/** Files the share target stored while the app was closed. Removes them as it reads. */
export async function drainShares() {
  const list = await tx("shares", "readonly", (s) => wrap(s.getAll()));
  if (list.length) await tx("shares", "readwrite", (s) => { s.clear(); });
  return list;
}

export function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/**
 * One-time import from the first version, which kept everything in
 * localStorage (photos as data URLs). Sample items are skipped.
 */
export async function migrateFromLocalStorage(migrateLegacy) {
  let raw;
  try { raw = localStorage.getItem(LEGACY_KEY); } catch { return 0; }
  if (!raw) return 0;
  let data;
  try { data = JSON.parse(raw); } catch { return 0; }
  const legacy = (data.items || []).filter((i) => !LEGACY_SAMPLE_IDS.has(i.id));
  const out = [];
  for (const old of legacy) {
    const item = migrateLegacy(old);
    if (old.dataUrl) {
      try {
        const blob = await (await fetch(old.dataUrl)).blob();
        item.blobId = newId();
        item.mime = blob.type;
        await blobs.put(item.blobId, blob);
      } catch { /* keep the item without its image */ }
    }
    out.push(item);
  }
  if (out.length) await items.putMany(out);
  const oldKey = localStorage.getItem("edition-anthropic-key");
  if (oldKey && !localStorage.getItem("edition.apiKey")) localStorage.setItem("edition.apiKey", oldKey);
  localStorage.removeItem(LEGACY_KEY);
  localStorage.removeItem("edition-anthropic-key");
  return out.length;
}

/* ---------- Backup ---------- */

// Settings live in localStorage under "edition.*". Caches are rebuilt on their own.
const SETTINGS_PREFIX = "edition.";
const SKIP_SETTINGS = new Set(["edition.calCache", "edition.morningCache"]);

export function settingsSnapshot(storage = localStorage) {
  const out = {};
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith(SETTINGS_PREFIX) && !SKIP_SETTINGS.has(k)) out[k] = storage.getItem(k);
  }
  return out;
}

export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBlob(b64, type = "") {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Builds a version 2 backup: items, files, app state and settings. */
export async function packBackup({ items: list, meta: metaRows, blobs: blobRows, settings }) {
  const files = [];
  for (const r of blobRows) {
    if (!r || !r.blob) continue;
    files.push({ id: r.id, type: r.blob.type || "", data: await blobToBase64(r.blob) });
  }
  return { app: "edition", version: 2, exported: new Date().toISOString(), items: list, meta: metaRows, files, settings };
}

/** Reads a version 1 or 2 backup into plain parts. Throws on anything else. */
export function unpackBackup(data) {
  if (!data || data.app !== "edition" || !Array.isArray(data.items)) throw new Error("That file isn't a Shoebox backup.");
  return {
    items: data.items,
    meta: Array.isArray(data.meta) ? data.meta : [],
    files: Array.isArray(data.files) ? data.files.map((f) => ({ id: f.id, blob: base64ToBlob(f.data, f.type) })) : [],
    settings: data.settings && typeof data.settings === "object" ? data.settings : {},
  };
}

/** Full backup as a JSON string: items, photos and files, app state, settings. */
export async function exportJson() {
  const [list, metaRows, blobRows] = await Promise.all([
    items.all(),
    tx("meta", "readonly", (s) => wrap(s.getAll())),
    tx("blobs", "readonly", (s) => wrap(s.getAll())),
  ]);
  return JSON.stringify(await packBackup({ items: list, meta: metaRows, blobs: blobRows, settings: settingsSnapshot() }));
}

/** Restores a backup over what's here. Returns counts for the message. */
export async function importJson(text) {
  const parts = unpackBackup(JSON.parse(text));
  await items.putMany(parts.items);
  if (parts.files.length) await tx("blobs", "readwrite", (s) => { parts.files.forEach((f) => s.put(f)); });
  if (parts.meta.length) await tx("meta", "readwrite", (s) => { parts.meta.forEach((m) => m && m.key && s.put(m)); });
  for (const [k, v] of Object.entries(parts.settings)) {
    if (k.startsWith(SETTINGS_PREFIX) && typeof v === "string") localStorage.setItem(k, v);
  }
  return { items: parts.items.length, files: parts.files.length, settings: Object.keys(parts.settings).length };
}

/** Delete the whole database: every save, photo and setting kept here. */
export async function eraseAll() {
  if (dbPromise) { try { (await dbPromise).close(); } catch { /* already closed */ } dbPromise = null; }
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
