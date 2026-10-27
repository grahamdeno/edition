import { test } from "node:test";
import assert from "node:assert/strict";
import { focusFromPixels } from "../src/visuals.js";
import { cleanFocus } from "../src/ai.js";

function canvas(w, h, paint) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = paint(x, y); const i = (y * w + x) * 4;
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
  }
  return d;
}

test("a flat picture keeps the middle", () => {
  assert.deepEqual(focusFromPixels(canvas(40, 30, () => [120, 120, 120]), 40, 30), { x: 50, y: 50 });
});

test("a detailed, colourful subject in the top left pulls the focus there", () => {
  const d = canvas(64, 48, (x, y) => (x < 20 && y < 16 ? ((x + y) % 2 ? [230, 40, 40] : [30, 30, 200]) : [128, 128, 128]));
  const f = focusFromPixels(d, 64, 48);
  assert.ok(f.x < 40 && f.y < 40, JSON.stringify(f));
});

test("skin tones on the right pull the focus right", () => {
  const d = canvas(64, 40, (x) => (x > 44 ? [224, 170, 140] : [40, 60, 70]));
  const f = focusFromPixels(d, 64, 40);
  assert.ok(f.x > 60, JSON.stringify(f));
});

test("cleanFocus accepts 0-100 points only", () => {
  assert.deepEqual(cleanFocus({ x: 12.4, y: "80" }), { x: 12, y: 80 });
  assert.equal(cleanFocus({ x: 140, y: 2 }), null);
  assert.equal(cleanFocus(null), null);
});
