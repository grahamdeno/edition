/*
 * Service worker: offline app shell, plus the share target.
 * Only same-origin GETs are cached; API calls and fonts go straight to the network.
 * Bump VERSION with each release so phones pick up the new shell.
 */

const VERSION = "2.0.0";
const CACHE = `edition-${VERSION}`;
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "manifest.webmanifest",
  "src/app.js",
  "src/model.js",
  "src/db.js",
  "src/capture.js",
  "src/ai.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("edition-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.origin === location.origin && url.pathname.endsWith("/share")) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // Network first so a deploy shows up on the next launch; cache when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))),
  );
});

/* ---- Share target (Android, desktop Chrome). iOS Safari doesn't support it. ---- */

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((f) => f && typeof f === "object" && f.size > 0);
    await storeShare({
      title: form.get("title") || "",
      text: form.get("text") || "",
      url: form.get("url") || "",
      files,
      at: Date.now(),
    });
  } catch {
    // Fall through to the app either way.
  }
  return Response.redirect("./?share=1", 303);
}

// Same database and schema as src/db.js.
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("edition", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("items")) db.createObjectStore("items", { keyPath: "id" }).createIndex("status", "status");
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      if (!db.objectStoreNames.contains("shares")) db.createObjectStore("shares", { keyPath: "id", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeShare(record) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const t = db.transaction("shares", "readwrite");
    t.objectStore("shares").add(record);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}
