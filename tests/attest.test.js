import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import relay, { verifyAttestation, cborDecode, attestRequired } from "../relay/perplexity-relay.js";

// Real attestations from Apple devices, from github.com/uebelack/node-app-attest (MIT).
const fixture = (env) => JSON.parse(readFileSync(new URL(`./fixtures/appattest-${env}.json`, import.meta.url)));
const dec = (s) => Uint8Array.from(Buffer.from(s, "base64"));
const SAMPLE_APP = ["V8H6LQ9448.io.uebelacker.AppAttestExample"];
const WHEN = Date.parse("2024-03-01T00:00:00Z"); // inside the sample certificates' validity

function memKv() {
  const m = new Map();
  return {
    m,
    get: async (k, t) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)) : m.get(k)) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
  };
}

for (const env of ["development", "production"]) {
  test(`a real ${env} attestation from Apple passes every check`, async () => {
    const d = fixture(env);
    const out = await verifyAttestation({ attestation: dec(d.attestation), challenge: dec(d.challenge), keyId: d.keyId, appIds: SAMPLE_APP, now: WHEN });
    assert.deepEqual(out, { environment: env, appId: SAMPLE_APP[0] });
  });
}

test("an attestation fails for another app, another challenge, another key, or out of date", async () => {
  const d = fixture("production");
  const base = { attestation: dec(d.attestation), challenge: dec(d.challenge), keyId: d.keyId, appIds: SAMPLE_APP, now: WHEN };
  await assert.rejects(verifyAttestation({ ...base, appIds: ["7MHDTK68M2.com.grahamdeno.shoebox"] }), /not Shoebox/);
  await assert.rejects(verifyAttestation({ ...base, challenge: new TextEncoder().encode("other") }), /nonce/);
  await assert.rejects(verifyAttestation({ ...base, keyId: Buffer.alloc(32, 1).toString("base64") }), /key id/);
  await assert.rejects(verifyAttestation({ ...base, now: Date.parse("2030-01-01") }), /out of date/);
});

test("a forged chain is refused: the intermediate must be signed by Apple's root", async () => {
  const d = fixture("production");
  const raw = Buffer.from(dec(d.attestation));
  const mid = Buffer.from(cborDecode(dec(d.attestation)).attStmt.x5c[1]);
  raw[raw.indexOf(mid) + mid.length - 3] ^= 0xff; // a byte of its signature
  await assert.rejects(verifyAttestation({ attestation: new Uint8Array(raw), challenge: dec(d.challenge), keyId: d.keyId, appIds: SAMPLE_APP, now: WHEN }), /signed|der/);
});

test("AI is closed to unproven installs, open to owner devices and attested iPhones", async () => {
  const kv = memKv();
  const env = { SHOEBOX: kv, ANTHROPIC_API_KEY: "sk" };
  const origin = "https://inmyshoebox.com";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 1 } }), { status: 200 });
  const body = JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
  const ask = (device, token) => relay.fetch(new Request("https://w.test/ai/messages", { method: "POST", headers: { origin, "x-shoebox-device": device, "x-shoebox-token": token }, body }), env);
  try {
    const { device, token } = await (await relay.fetch(new Request("https://w.test/ai/register", { method: "POST", headers: { origin } }), env)).json();
    const web = await ask(device, token);
    assert.equal(web.status, 403);
    assert.equal((await web.json()).error.code, "attest");
    // Usage still answers, so Settings can show the state.
    assert.equal((await relay.fetch(new Request("https://w.test/ai/usage", { headers: { origin, "x-shoebox-device": device, "x-shoebox-token": token } }), env)).status, 200);
    env.AI_OWNER_DEVICES = device;
    assert.equal((await ask(device, token)).status, 200);
    delete env.AI_OWNER_DEVICES;
    // An install the relay marked attested.
    const rec = JSON.parse(kv.m.get(`aid:${device}`));
    kv.m.set(`aid:${device}`, JSON.stringify({ ...rec, attested: true }));
    assert.equal((await ask(device, token)).status, 200);
    // The escape hatch.
    kv.m.set(`aid:${device}`, JSON.stringify(rec));
    env.AI_ATTEST = "off";
    assert.equal((await ask(device, token)).status, 200);
    assert.equal(attestRequired({}), true);
  } finally { globalThis.fetch = realFetch; }
});

test("challenge then attest: a challenge is used once, and a bad attestation gets no AI", async () => {
  const kv = memKv();
  const env = { SHOEBOX: kv, ANTHROPIC_API_KEY: "sk" };
  const origin = "https://inmyshoebox.com";
  const post = (path, b) => relay.fetch(new Request(`https://w.test${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(b || {}) }), env);
  const { challenge } = await (await post("/ai/challenge")).json();
  assert.equal(dec(challenge).length, 32);
  const d = fixture("production");
  // The sample is for another app and another challenge, so it's refused, and the challenge is spent.
  const bad = await post("/ai/attest", { challenge, keyId: d.keyId, attestation: d.attestation });
  assert.equal(bad.status, 403);
  assert.equal((await bad.json()).error.code, "attest");
  const again = await post("/ai/attest", { challenge, keyId: d.keyId, attestation: d.attestation });
  assert.equal(again.status, 401);
  assert.equal([...kv.m.keys()].filter((k) => k.startsWith("aid:")).length, 0);
});
