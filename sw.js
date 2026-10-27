/*
 * Service worker: offline app shell, plus the share target.
 * Only same-origin GETs are cached; API calls and fonts go straight to the network.
 * Bump VERSION with each release so phones pick up the new shell.
 */

const VERSION = "4.15.0";
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
  "src/samples.js",
  "src/icons.js",
  "src/visuals.js",
  "src/push.js",
  "src/calendar.js",
  "src/daily.js",
  "src/feel.js",
  "src/problems.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
  "icons/favicon.svg",
  "icons/favicon-32.png",
  "icons/logo.svg",
];

// Install fetches the whole shell fresh from the server (past the browser's
// HTTP cache), so a release is never a mix of old and new files.
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
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
    fetch(e.request, { cache: "no-cache" }) // revalidate, so a reload after an update gets the new files
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

/* Notifications from the relay: show them, and open Shoebox when tapped. */
self.addEventListener("push", (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(m.title || "Shoebox", {
    body: m.body || "Something you set aside is back.",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    data: { url: m.url || self.registration.scope },
    tag: m.url || "shoebox",
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) { await w.focus(); w.postMessage({ type: "open", url }); return; }
    }
    await self.clients.openWindow(url);
  })());
});
