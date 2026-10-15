/*
 * Detent feedback. iPhone web apps can't vibrate, so each wheel click is a
 * very short synthesized tick through Web Audio; devices that support the
 * Vibration API get a 4 ms pulse as well. Sound can be turned off in Settings.
 */

const KEY = "edition.sound";
let ctx = null;
let lastTick = 0;

export function soundOn() {
  try { return localStorage.getItem(KEY) !== "0"; } catch { return true; }
}

export function setSound(on) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* storage blocked */ }
}

/** Create the audio context inside a user gesture so iOS allows it. */
export function unlock() {
  if (ctx || !soundOn()) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    ctx = new AC();
    if (ctx.state === "suspended") ctx.resume();
  } catch { ctx = null; }
}

/** One detent click. `strong` is the heavier click used to confirm. */
export function tick(strong = false) {
  const now = performance.now();
  if (now - lastTick < 18) return; // a fast spin shouldn't buzz
  lastTick = now;
  if (navigator.vibrate) {
    try { navigator.vibrate(strong ? 12 : 4); } catch { /* not allowed */ }
  }
  if (!soundOn()) return;
  unlock();
  if (!ctx) return;
  const t = ctx.currentTime;
  const len = Math.floor(ctx.sampleRate * (strong ? 0.012 : 0.005));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = strong ? 1800 : 3200;
  const gain = ctx.createGain();
  gain.gain.value = strong ? 0.35 : 0.18;
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start(t);
}
