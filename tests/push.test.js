import { test } from "node:test";
import assert from "node:assert/strict";
import relay, { encryptPush, vapidAuth, b64u, validSub, sendDue } from "../relay/perplexity-relay.js";

const subtle = crypto.subtle;
async function hkdf(salt, ikm, info, n) {
  const k = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, n * 8));
}
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

/** A phone's side: make a subscription, and decrypt what it receives (RFC 8291). */
async function phone() {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub = { endpoint: "https://web.push.apple.com/QAbc", keys: { p256dh: b64u.enc(pub), auth: b64u.enc(auth) } };
  const decrypt = async (body) => {
    const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
    const asKey = await subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: asKey }, pair.privateKey, 256));
    const e = new TextEncoder();
    const ikm = await hkdf(auth, shared, cat(e.encode("WebPush: info\0"), pub, asPub), 32);
    const cek = await hkdf(salt, ikm, e.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, e.encode("Content-Encoding: nonce\0"), 12);
    const k = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, k, ct));
    assert.equal(plain[plain.length - 1], 2);
    return new TextDecoder().decode(plain.slice(0, -1));
  };
  return { sub, decrypt };
}

function fakeKv() {
  const m = new Map();
  return {
    m,
    async get(k, t) { const v = m.get(k); return v == null ? null : t === "json" ? JSON.parse(v.value) : v.value; },
    async put(k, value, opts = {}) { m.set(k, { value, metadata: opts.metadata }); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name, metadata: m.get(name).metadata })), list_complete: true }; },
  };
}

test("a pushed message decrypts on the phone", async () => {
  const { sub, decrypt } = await phone();
  const body = await encryptPush(sub, JSON.stringify({ title: "Back in Shoebox", body: "Pottery class" }));
  assert.equal(new DataView(body.buffer).getUint32(16), 4096);
  assert.deepEqual(JSON.parse(await decrypt(body)), { title: "Back in Shoebox", body: "Pottery class" });
});

test("the VAPID token is signed by the relay's key, for the push service's origin", async () => {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const keys = { privateJwk: await subtle.exportKey("jwk", pair.privateKey), publicKey: b64u.enc(await subtle.exportKey("raw", pair.publicKey)) };
  const h = await vapidAuth("https://web.push.apple.com/QAbc", keys);
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h);
  assert.equal(k, keys.publicKey);
  const [a, b, sig] = jwt.split(".");
  assert.equal(JSON.parse(new TextDecoder().decode(b64u.dec(b))).aud, "https://web.push.apple.com");
  assert.ok(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, b64u.dec(sig), new TextEncoder().encode(`${a}.${b}`)));
});

test("only real push services are accepted", () => {
  assert.ok(validSub({ endpoint: "https://web.push.apple.com/x", keys: { p256dh: "a", auth: "b" } }));
  assert.ok(!validSub({ endpoint: "https://evil.example/x", keys: { p256dh: "a", auth: "b" } }));
  assert.ok(!validSub({ endpoint: "http://web.push.apple.com/x", keys: { p256dh: "a", auth: "b" } }));
});

test("reminders are kept, sent when due, then forgotten", async () => {
  const kv = fakeKv(), env = { SHOEBOX: kv };
  const { sub, decrypt } = await phone();
  const origin = "https://grahamdeno.github.io";
  const call = (method, path, body) => relay.fetch(new Request(`https://relay.test${path}`, { method, headers: { origin, "content-type": "application/json" }, body: body && JSON.stringify(body) }), env);
  const key = await (await call("GET", "/push/key")).json();
  assert.ok(b64u.dec(key.key).length === 65);
  const now = Date.now();
  assert.equal((await call("POST", "/remind", { id: "item1", token: "t".repeat(20), at: now + 3600e3, title: "Back in Shoebox", body: "Pottery", sub })).status, 200);
  assert.equal((await call("POST", "/remind", { id: "item2", token: "u".repeat(20), at: now - 1, title: "Due", body: "Now", sub })).status, 200);
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push({ url, init }); return new Response(null, { status: 201 }); };
  try { assert.equal(await sendDue(env, now), 1); } finally { globalThis.fetch = realFetch; }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, sub.endpoint);
  assert.match(sent[0].init.headers.authorization, /^vapid t=/);
  assert.deepEqual(JSON.parse(await decrypt(sent[0].init.body)), { title: "Due", body: "Now", url: "" });
  assert.ok(kv.m.has("r:item1") && !kv.m.has("r:item2"));
  await call("DELETE", "/remind/item1?token=wrong");
  assert.ok(kv.m.has("r:item1"));
  await call("DELETE", `/remind/item1?token=${"t".repeat(20)}`);
  assert.ok(!kv.m.has("r:item1"));
});
