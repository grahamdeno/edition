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
