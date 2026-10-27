/*
 * Notifications: Shoebox subscribes this phone to Web Push through your
 * relay, and hands the relay a reminder when you set something aside. The
 * relay sends it at 9:00 that morning. Nothing is sent anywhere else.
 * On iPhone this works only in the app opened from the Home Screen.
 */

import { relayBase } from "./ai.js";

const SUB = "edition.pushSub", KEY = "edition.pushKey";
const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } };

export function supported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** On iPhone, notifications need the Home Screen app. */
export function needsHomeScreen() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios && !(window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone);
}

export function subscription() {
  try { return JSON.parse(get(SUB) || "null"); } catch { return null; }
}

/** On: a subscription is kept, permission still stands, and there's a relay to send through. */
export function enabled() {
  return Boolean(subscription() && relayBase() && supported() && Notification.permission === "granted");
}

/** Fetch the relay's public key ahead of the tap, so the tap can subscribe straight away. */
export async function prefetchKey() {
  const base = relayBase();
  if (!base) return null;
  const res = await fetch(`${base}/push/key`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.key) throw new Error(data?.error?.message || `The relay couldn't give a notification key (${res.status}).`);
  set(KEY, data.key);
  return data.key;
}

function keyBytes(str) {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** Call straight from a tap: the phone asks for permission, then subscribes. */
export async function turnOn() {
  if (!supported()) throw new Error("This browser can't receive notifications.");
  if (needsHomeScreen()) throw new Error("On iPhone, open Shoebox from your Home Screen to turn on notifications.");
  const key = get(KEY) || await prefetchKey();
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && get(KEY) && sub.options?.applicationServerKey) {
    const have = new Uint8Array(sub.options.applicationServerKey);
    const want = keyBytes(key);
    if (have.length !== want.length || have.some((b, i) => b !== want[i])) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  if (Notification.permission !== "granted") throw new Error("Notifications weren't allowed. Turn them on for Shoebox in the phone's Settings.");
  set(SUB, JSON.stringify(sub.toJSON()));
  return true;
}

export async function turnOff() {
  set(SUB, null);
  try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) await sub.unsubscribe(); } catch { /* already gone */ }
}

async function post(path, body) {
  const res = await fetch(`${relayBase()}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `The relay said ${res.status}.`);
  return data;
}

export function sendTest() {
  return post("/push/test", { sub: subscription() });
}

/** Ask the relay to notify at `at`. Returns { id, token } to cancel it later. */
export async function remind({ id, at, title, body, url }) {
  const token = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^\w-]/g, "");
  await post("/remind", { id, token, at, title, body, url, sub: subscription() });
  return { id, token };
}

export async function cancel(r) {
  if (!r || !r.id || !relayBase()) return;
  await fetch(`${relayBase()}/remind/${encodeURIComponent(r.id)}?token=${encodeURIComponent(r.token)}`, { method: "DELETE" }).catch(() => {});
}
