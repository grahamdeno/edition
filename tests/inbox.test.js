import { test } from "node:test";
import assert from "node:assert/strict";
import relay, { parseMail, htmlToText } from "../relay/perplexity-relay.js";

const raw = [
  'From: "Myrtle Grove Middle" <news@nhcs.net>',
  "Subject: =?UTF-8?Q?This_week_at_Myrtle_Grove_=E2=80=93_Oct_26?=",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Band concert Thursday at 7 PM in the gym. Students arrive by 6:30 in concer=",
  "t black. Details: https://example.org/concert",
  "--b1",
  "Content-Type: text/html; charset=utf-8",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from('<p>Band concert <b>Thursday</b></p><a href="https://example.org/concert">Details</a><a href="https://x.list-manage.com/unsubscribe">Unsubscribe</a>').toString("base64"),
  "--b1--",
  "",
].join("\r\n");

test("a forwarded newsletter is read: subject, sender, text, links", () => {
  const m = parseMail(raw);
  assert.equal(m.subject, "This week at Myrtle Grove – Oct 26");
  assert.equal(m.fromName, "Myrtle Grove Middle");
  assert.match(m.text, /arrive by 6:30 in concert black/);
  assert.deepEqual(m.links, ["https://example.org/concert"]);
});

test("HTML-only mail becomes readable text with its links", () => {
  assert.equal(htmlToText('<p>Hi</p><ul><li>One</li></ul><a href="https://a.test">here</a>'), "Hi\n\n• One\nhere (https://a.test)");
});

function fakeKv() {
  const m = new Map();
  return { m, async get(k, t) { const v = m.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; } };
}

test("mail waits for the phone that owns the inbox, then is acknowledged away", async () => {
  const env = { SHOEBOX: fakeKv() };
  const stream = new Response(raw).body;
  await relay.email({ raw: stream, from: "news@nhcs.net", setReject() {} }, env);
  const origin = "https://grahamdeno.github.io";
  const call = (method, path, key, body) => relay.fetch(new Request(`https://relay.test${path}`, { method, headers: { origin, "x-inbox-key": key, "content-type": "application/json" }, body: body && JSON.stringify(body) }), env);
  const mine = "k".repeat(30), other = "z".repeat(30);
  const got = await (await call("GET", "/inbox", mine)).json();
  assert.equal(got.mails.length, 1);
  assert.equal(got.mails[0].subject, "This week at Myrtle Grove – Oct 26");
  assert.equal((await call("GET", "/inbox", other)).status, 403);
  await call("POST", "/inbox/ack", mine, { ids: [got.mails[0].id] });
  assert.equal((await (await call("GET", "/inbox", mine)).json()).mails.length, 0);
});

import { readFileSync, readdirSync } from "node:fs";

test("the relay lets the app send every custom header it uses", async () => {
  const sent = new Set();
  for (const f of readdirSync(new URL("../src/", import.meta.url))) {
    for (const m of readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").matchAll(/"(x-[a-z-]+)"/g)) sent.add(m[1]);
  }
  sent.delete("x-api-key"); // sent straight to Anthropic by older versions, never to the relay
  const pre = await relay.fetch(new Request("https://w.test/inbox", { method: "OPTIONS", headers: { origin: "https://shoebox.tangomike.app" } }), {});
  const allowed = pre.headers.get("access-control-allow-headers").split(",").map((h) => h.trim());
  for (const h of sent) assert.ok(allowed.includes(h), `relay must allow ${h}`);
});

/* ---- Attachments ---- */
const b64 = (s) => Buffer.from(s).toString("base64");
const bigImage = b64("x".repeat(30000));
const MAIL = [
  "From: Ducks <news@nhcs.net>", "Subject: Duck Weekly", 'Content-Type: multipart/mixed; boundary="B1"', "", "--B1",
  "Content-Type: text/plain; charset=utf-8", "", "Band concert Thursday. See the flyer.", "--B1",
  'Content-Type: application/pdf; name="Flyer.pdf"', 'Content-Disposition: attachment; filename="Flyer.pdf"', "Content-Transfer-Encoding: base64", "", b64("%PDF-1.4 flyer"), "--B1",
  'Content-Type: image/png; name="logo.png"', "Content-Transfer-Encoding: base64", "", b64("tiny"), "--B1",
  'Content-Type: image/jpeg; name="poster.jpg"', 'Content-Disposition: inline; filename="poster.jpg"', "Content-Transfer-Encoding: base64", "", bigImage, "--B1--", "",
].join("\r\n");

test("mail keeps its PDFs and real pictures, skips tiny logos", () => {
  const m = parseMail(MAIL);
  assert.equal(m.text.trim(), "Band concert Thursday. See the flyer.");
  assert.deepEqual(m.files.map((f) => [f.name, f.type]), [["Flyer.pdf", "application/pdf"], ["poster.jpg", "image/jpeg"]]);
  assert.equal(Buffer.from(m.files[0].data, "base64").toString(), "%PDF-1.4 flyer");
});

test("attachments wait on the relay, are fetched one by one, and go when the mail is collected", async () => {
  const store = new Map();
  const kv = { get: async (k, t) => (store.has(k) ? (t === "json" ? JSON.parse(store.get(k)) : store.get(k)) : null), put: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); },
    list: async ({ prefix }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) };
  const env = { SHOEBOX: kv };
  await relay.email({ raw: new Blob([MAIL]).stream(), from: "news@nhcs.net", setReject: () => { throw new Error("rejected"); } }, env);
  const origin = "https://shoebox.tangomike.app", key = "k".repeat(30);
  const h = { origin, "x-inbox-key": key };
  const list = await (await relay.fetch(new Request("https://w.test/inbox", { headers: h }), env)).json();
  const mail = list.mails[0];
  assert.deepEqual(mail.attachments.map((a) => a.name), ["Flyer.pdf", "poster.jpg"]);
  assert.equal(mail.files, undefined);
  const f = await (await relay.fetch(new Request(`https://w.test/inbox/file?id=${mail.id}&n=0`, { headers: h }), env)).json();
  assert.equal(Buffer.from(f.data, "base64").toString(), "%PDF-1.4 flyer");
  await relay.fetch(new Request("https://w.test/inbox/ack", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ ids: [mail.id] }) }), env);
  assert.equal([...store.keys()].filter((k) => k.startsWith("a:") || k.startsWith("m:")).length, 0);
});

/* ---- Personal addresses ---- */
import { mailBox } from "../relay/perplexity-relay.js";

test("each phone gets its own address and only sees its own mail; the shared address still reaches its owner", async () => {
  const env = { SHOEBOX: fakeKv(), EMAIL_ADDRESS: "shoebox@tangomike.app", EMAIL_ALIASES: "1" };
  const origin = "https://shoebox.tangomike.app";
  const call = (method, path, key, body) => relay.fetch(new Request(`https://relay.test${path}`, { method, headers: { origin, "x-inbox-key": key, "content-type": "application/json" }, body: body && JSON.stringify(body) }), env);
  const owner = "o".repeat(30), tester = "t".repeat(30);
  await env.SHOEBOX.put("inbox-key", owner);
  const a = await (await call("GET", "/inbox", owner)).json();
  const b = await (await call("GET", "/inbox", tester)).json();
  assert.match(a.address, /^sb-[a-z2-9]{10}@tangomike\.app$/);
  assert.match(b.address, /^sb-[a-z2-9]{10}@tangomike\.app$/);
  assert.notEqual(a.address, b.address);
  assert.equal(a.shared, "shoebox@tangomike.app");
  assert.equal(b.shared, null);
  const again = await (await call("GET", "/inbox", tester)).json();
  assert.equal(again.address, b.address, "the address stays put");
  // Mail to the tester's address, to the shared one, and to a stranger.
  const send = (to) => relay.email({ raw: new Response(raw).body, from: "news@nhcs.net", to, setReject(r) { this.rejected = r; } }, env);
  await send(b.address);
  await send("shoebox@tangomike.app");
  const stray = { raw: new Response(raw).body, from: "x@y.z", to: "sb-nobodyhere@tangomike.app", setReject(r) { this.rejected = r; } };
  await relay.email(stray, env);
  assert.ok(stray.rejected, "unknown addresses bounce");
  const ownerMail = await (await call("GET", "/inbox", owner)).json();
  const testerMail = await (await call("GET", "/inbox", tester)).json();
  assert.equal(ownerMail.mails.length, 1, "owner sees only the shared-address mail");
  assert.equal(testerMail.mails.length, 1, "tester sees only their own");
  await call("POST", "/inbox/ack", owner, { ids: [testerMail.mails[0].id] });
  assert.equal((await (await call("GET", "/inbox", tester)).json()).mails.length, 1, "nobody can clear another phone's mail");
  await call("POST", "/inbox/ack", tester, { ids: [testerMail.mails[0].id] });
  assert.equal((await (await call("GET", "/inbox", tester)).json()).mails.length, 0);
  // A new address retires the old one.
  const fresh = await (await call("POST", "/inbox/address", tester)).json();
  assert.notEqual(fresh.address, b.address);
  assert.equal(await mailBox(env, b.address), null);
  assert.ok(await mailBox(env, fresh.address));
});

test("before personal addresses are on, nothing changes", async () => {
  const env = { SHOEBOX: fakeKv(), EMAIL_ADDRESS: "shoebox@tangomike.app" };
  const origin = "https://shoebox.tangomike.app";
  const call = (key) => relay.fetch(new Request("https://relay.test/inbox", { headers: { origin, "x-inbox-key": key } }), env);
  const first = await (await call("a".repeat(30))).json();
  assert.equal(first.address, "shoebox@tangomike.app");
  assert.equal((await call("b".repeat(30))).status, 403);
  assert.equal(await mailBox(env, "sb-abcdefghjk@tangomike.app"), null);
});
