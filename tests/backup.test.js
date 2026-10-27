import { test } from "node:test";
import assert from "node:assert/strict";
import { packBackup, unpackBackup, settingsSnapshot, blobToBase64, base64ToBlob } from "../src/db.js";

function fakeStorage(map) {
  const keys = Object.keys(map);
  return { length: keys.length, key: (i) => keys[i], getItem: (k) => map[k] };
}

test("settings snapshot keeps edition keys and skips caches", () => {
  const s = settingsSnapshot(fakeStorage({ "edition.theme": "dark", "edition.calCache": "x", "other": "y", "edition.apiKey": "k" }));
  assert.deepEqual(s, { "edition.theme": "dark", "edition.apiKey": "k" });
});

test("blobs survive base64 round trip, including binary bytes", async () => {
  const bytes = new Uint8Array(70000).map((_, i) => i % 256);
  const b = await base64ToBlob(await blobToBase64(new Blob([bytes], { type: "image/jpeg" })), "image/jpeg");
  assert.equal(b.type, "image/jpeg");
  assert.deepEqual(new Uint8Array(await b.arrayBuffer()), bytes);
});

test("version 2 backup round trips items, files, meta and settings", async () => {
  const packed = await packBackup({
    items: [{ id: "a", title: "A", blobId: "f1" }],
    meta: [{ key: "suggest", value: { topics: {} } }],
    blobs: [{ id: "f1", blob: new Blob(["hello"], { type: "text/plain" }) }, null],
    settings: { "edition.theme": "dark" },
  });
  const back = unpackBackup(JSON.parse(JSON.stringify(packed)));
  assert.equal(packed.version, 2);
  assert.equal(back.items[0].id, "a");
  assert.equal(back.files.length, 1);
  assert.equal(await back.files[0].blob.text(), "hello");
  assert.deepEqual(back.meta, [{ key: "suggest", value: { topics: {} } }]);
  assert.deepEqual(back.settings, { "edition.theme": "dark" });
});

test("version 1 backups still import, with items only", () => {
  const back = unpackBackup({ app: "edition", version: 1, items: [{ id: "x" }] });
  assert.equal(back.items.length, 1);
  assert.deepEqual(back.files, []);
  assert.deepEqual(back.settings, {});
});

test("rejects files that are not Shoebox backups", () => {
  assert.throws(() => unpackBackup({ app: "other", items: [] }), /isn't a Shoebox backup/);
});
