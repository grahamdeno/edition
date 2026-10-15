/*
 * Scroll wheels and the corner dial. Both are drag-to-turn controls with
 * detents: every time the selection crosses an item there is a tick.
 * Tapping an item selects it directly, so a wheel is never slower than a
 * button for someone who just wants to tap. Arrow keys turn them too.
 */

import { tick } from "./feel.js";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * A wheel of items along one axis.
 *   axis     "x" (horizontal wheel) or "y" (vertical wheel)
 *   drum     curve the items like a drum picker
 *   spacing  pixels between item centres
 */
export function createWheel(root, { items, index = 0, axis = "x", drum = false, spacing = 88, label = "Wheel", onChange, onCommit }) {
  const n = items.length;
  let pos = clamp(index, 0, Math.max(0, n - 1));
  let current = Math.round(pos);
  let anim = 0;

  root.classList.add("wheel", axis === "x" ? "wheel-x" : "wheel-y");
  if (drum) root.classList.add("wheel-drum");
  root.setAttribute("role", "listbox");
  root.setAttribute("aria-label", label);
  root.setAttribute("aria-orientation", axis === "x" ? "horizontal" : "vertical");
  root.tabIndex = 0;

  const track = document.createElement("div");
  track.className = "wheel-items";
  const els = items.map((it, i) => {
    const b = document.createElement("span");
    b.className = "wheel-item" + (it.className ? " " + it.className : "");
    b.setAttribute("role", "option");
    b.id = `${root.id || "wheel"}-opt-${i}`;
    b.dataset.i = String(i);
    b.textContent = it.label;
    track.appendChild(b);
    return b;
  });
  root.appendChild(track);

  function paint() {
    for (let i = 0; i < n; i++) {
      const d = i - pos;
      const ad = Math.abs(d);
      const off = d * spacing;
      const scale = 1 - Math.min(ad, 2.5) * (drum ? 0.1 : 0.14);
      const move = axis === "x" ? `translateX(${off}px)` : `translateY(${off}px)`;
      const rot = drum ? ` rotateX(${clamp(-d * 26, -80, 80)}deg)` : "";
      const el = els[i];
      el.style.transform = `translate(-50%, -50%) ${move}${rot} scale(${scale})`;
      el.style.opacity = String(clamp(1 - ad * (drum ? 0.32 : 0.28), 0, 1));
      const on = i === Math.round(pos);
      el.classList.toggle("on", on);
      el.setAttribute("aria-selected", String(on));
    }
    if (n) root.setAttribute("aria-activedescendant", els[Math.round(pos)].id);
  }

  function settle(target, notify = true) {
    target = clamp(target, 0, n - 1);
    cancelAnimationFrame(anim);
    const from = pos;
    const t0 = performance.now();
    const dur = Math.min(220, 90 + Math.abs(target - from) * 60);
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      pos = from + (target - from) * (1 - Math.pow(1 - k, 3));
      paint();
      if (k < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
    if (target !== current) {
      current = target;
      tick();
      if (notify && onChange) onChange(current, items[current]);
    }
  }

  // Drag to turn
  let drag = null;
  root.addEventListener("pointerdown", (e) => {
    if (!n || e.button > 0) return;
    cancelAnimationFrame(anim);
    drag = { start: axis === "x" ? e.clientX : e.clientY, from: pos, moved: 0, x: e.clientX, y: e.clientY };
    root.setPointerCapture(e.pointerId);
    root.classList.add("turning");
  });
  root.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const delta = (axis === "x" ? e.clientX : e.clientY) - drag.start;
    drag.moved = Math.max(drag.moved, Math.abs(delta));
    pos = clamp(drag.from - delta / spacing, -0.45, n - 0.55);
    const r = clamp(Math.round(pos), 0, n - 1);
    if (r !== current) {
      current = r;
      tick();
      if (onChange) onChange(current, items[current]);
    }
    paint();
  });
  const end = (e) => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    root.classList.remove("turning");
    if (moved < 6 && e && e.type === "pointerup") {
      // A tap: select the item under the finger, or commit if it's already selected.
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const item = hit && hit.closest && hit.closest(".wheel-item");
      if (item && root.contains(item)) {
        const i = Number(item.dataset.i);
        if (i === current && onCommit) { settle(i, false); tick(true); onCommit(i, items[i]); return; }
        settle(i);
        return;
      }
    }
    settle(Math.round(pos), true);
  };
  root.addEventListener("pointerup", end);
  root.addEventListener("pointercancel", end);

  // Mouse wheel and trackpad, one detent per gesture step
  let wheelAcc = 0;
  root.addEventListener("wheel", (e) => {
    e.preventDefault();
    wheelAcc += axis === "x" ? (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) : e.deltaY;
    if (Math.abs(wheelAcc) > 40) {
      settle(current + Math.sign(wheelAcc));
      wheelAcc = 0;
    }
  }, { passive: false });

  root.addEventListener("keydown", (e) => {
    const back = axis === "x" ? "ArrowLeft" : "ArrowUp";
    const fwd = axis === "x" ? "ArrowRight" : "ArrowDown";
    if (e.key === back) { e.preventDefault(); settle(current - 1); }
    else if (e.key === fwd) { e.preventDefault(); settle(current + 1); }
    else if ((e.key === "Enter" || e.key === " ") && onCommit) { e.preventDefault(); tick(true); onCommit(current, items[current]); }
  });

  paint();
  return {
    get index() { return current; },
    set(i, notify = false) { settle(i, notify); },
  };
}

/**
 * The corner dial: a quarter circle anchored at the bottom-right corner of
 * its box, with one detent per item. Sweep a thumb across it to choose; press
 * the hub to commit. Items run from the left edge (first) up to the top (last).
 */
export function createDial(root, { items, index = 0, size = 250, onChange, onCommit, setLabel = "Set" }) {
  const n = items.length;
  const cx = size - 8, cy = size - 8;
  // 176° (left edge) to 98° (top): about 26° apart, so labels on a 158 px arc never touch.
  const angles = items.map((_, i) => 176 - (i * 78) / Math.max(1, n - 1));
  let current = clamp(index, 0, n - 1);

  root.classList.add("dial");
  root.style.width = size + "px";
  root.style.height = size + "px";
  root.setAttribute("role", "listbox");
  root.setAttribute("aria-label", "Verdict dial");
  root.tabIndex = 0;

  const pt = (deg, r) => [cx + r * Math.cos((deg * Math.PI) / 180), cy - r * Math.sin((deg * Math.PI) / 180)];
  const [ox, oy] = [cx - 200, cy - 200];
  root.innerHTML = `
    <svg class="dial-face" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <path class="dial-ring" d="M${ox} ${cy} A200 200 0 0 1 ${cx} ${oy} L${cx} ${cy - 100} A100 100 0 0 0 ${cx - 100} ${cy} Z"></path>
      <path class="dial-knurl" d="M${cx - 192} ${cy} A192 192 0 0 1 ${cx} ${cy - 192}"></path>
      <line class="dial-needle" x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy}"></line>
      <circle class="dial-hub" cx="${cx}" cy="${cy}" r="64"></circle>
    </svg>
    ${items.map((it, i) => {
      let [x, y] = pt(angles[i], 158);
      x = clamp(x, 34, size - 34);
      y = clamp(y, 22, size - 22);
      return `<span class="dial-item" role="option" id="dial-opt-${i}" data-i="${i}" style="left:${x}px;top:${y}px">${it.label}</span>`;
    }).join("")}
    <button type="button" class="dial-set">${setLabel}</button>`;

  const needle = root.querySelector(".dial-needle");
  const els = Array.from(root.querySelectorAll(".dial-item"));
  const setBtn = root.querySelector(".dial-set");

  function paint() {
    const [x2, y2] = pt(angles[current], 104);
    needle.setAttribute("x2", x2.toFixed(1));
    needle.setAttribute("y2", y2.toFixed(1));
    els.forEach((el, i) => {
      el.classList.toggle("on", i === current);
      el.setAttribute("aria-selected", String(i === current));
    });
    root.setAttribute("aria-activedescendant", `dial-opt-${current}`);
    setBtn.setAttribute("aria-label", `${setLabel}: ${items[current].label}`);
  }

  function select(i) {
    i = clamp(i, 0, n - 1);
    if (i === current) return;
    current = i;
    tick();
    paint();
    if (onChange) onChange(current, items[current]);
  }

  function nearest(clientX, clientY) {
    const r = root.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    const deg = (Math.atan2(cy - y, x - cx) * 180) / Math.PI;
    let best = 0;
    angles.forEach((a, i) => { if (Math.abs(a - deg) < Math.abs(angles[best] - deg)) best = i; });
    return best;
  }

  let drag = null;
  root.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".dial-set")) return;
    drag = { moved: 0, x: e.clientX, y: e.clientY };
    root.setPointerCapture(e.pointerId);
    select(nearest(e.clientX, e.clientY));
  });
  root.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.x, e.clientY - drag.y));
    select(nearest(e.clientX, e.clientY));
  });
  const end = () => { drag = null; };
  root.addEventListener("pointerup", end);
  root.addEventListener("pointercancel", end);
  setBtn.addEventListener("click", () => { tick(true); if (onCommit) onCommit(current, items[current]); });
  root.addEventListener("keydown", (e) => {
    if (e.target === setBtn) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); select(current - 1); }
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); select(current + 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tick(true); if (onCommit) onCommit(current, items[current]); }
  });

  paint();
  return { get index() { return current; }, set: select };
}
