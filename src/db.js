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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
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

/** Backup of everything except file bytes, as a JSON string. */
export async function exportJson() {
  const list = await items.all();
  return JSON.stringify({ app: "edition", version: 1, exported: new Date().toISOString(), items: list }, null, 2);
}

export async function importJson(text) {
  const data = JSON.parse(text);
  if (data.app !== "edition" || !Array.isArray(data.items)) throw new Error("That file isn't a Shoebox backup.");
  await items.putMany(data.items);
  return data.items.length;
}
