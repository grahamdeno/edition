import { test } from "node:test";
import assert from "node:assert/strict";
import relay, { appleKey, appleJwt, b64u } from "../relay/perplexity-relay.js";

async function p8() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString("base64").match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
  return { pem, pub: pair.publicKey };
}
const part = (t, i) => JSON.parse(new TextDecoder().decode(b64u.dec(t.split(".")[i])));

test("Apple tokens are ES256, signed with the .p8, with the right header and claims", async () => {
  const { pem, pub } = await p8();
  const key = await appleKey(pem);
  const t = await appleJwt(key, { kid: "79QU7DSTN9", id: "7MHDTK68M2.com.example.weather" }, { iss: "7MHDTK68M2", iat: 1, exp: 2, sub: "com.example.weather" });
  assert.deepEqual(part(t, 0), { alg: "ES256", kid: "79QU7DSTN9", id: "7MHDTK68M2.com.example.weather" });
  assert.equal(part(t, 1).sub, "com.example.weather");
  const [h, b, s] = t.split(".");
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64u.dec(s), new TextEncoder().encode(`${h}.${b}`)));
});

function fakeKv() {
  const m = new Map();
  return { m, async get(k, t) { const v = m.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); }, async list() { return { keys: [], list_complete: true }; } };
}

test("song of the day: the app gets a key, the Shortcut posts with it, the app reads the match", async () => {
  const { pem } = await p8();
  const env = { SHOEBOX: fakeKv(), APPLE_P8: pem };
  const origin = "https://grahamdeno.github.io", inbox = "i".repeat(30);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.music.apple.com/")) {
      assert.match(init.headers.authorization, /^Bearer ey/);
      return new Response(JSON.stringify({ results: { songs: { data: [{ id: "1", attributes: { name: "Wagon Wheel", artistName: "Old Crow Medicine Show", albumName: "O.C.M.S.", url: "https://music.apple.com/us/song/1", previews: [{ url: "https://audio.test/p.m4a" }], artwork: { url: "https://art.test/{w}x{h}.jpg" }, releaseDate: "2004-01-01" } }] } } }));
    }
    return realFetch(url, init);
  };
  try {
    const app = (path) => relay.fetch(new Request(`https://relay.test${path}`, { headers: { origin, "x-inbox-key": inbox } }), env);
    const first = await (await app("/apple/song")).json();
    assert.equal(first.song, null);
    assert.ok(first.songKey);
    const shortcut = (key) => relay.fetch(new Request("https://relay.test/song", { method: "POST", headers: { "x-song-key": key, "content-type": "application/json" },
      body: JSON.stringify({ title: "Wagon Wheel", artist: "Old Crow Medicine Show", lastPlayed: "2023-04-02" }) }), env);
    assert.equal((await shortcut("wrong")).status, 403);
    assert.equal((await shortcut(first.songKey)).status, 200);
    const got = await (await app("/apple/song")).json();
    assert.equal(got.song.title, "Wagon Wheel");
    assert.equal(got.match.preview, "https://audio.test/p.m4a");
    assert.equal(got.match.artwork, "https://art.test/600x600.jpg");
  } finally { globalThis.fetch = realFetch; }
});
