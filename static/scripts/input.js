// Keyboard, mouse (pointer lock) and touch input. Keys are matched by
// KeyboardEvent.code, so layouts, Shift and Caps Lock don't matter.

const BIND = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA'],
  right: ['KeyD'],
  turnLeft: ['ArrowLeft'],
  turnRight: ['ArrowRight'],
  run: ['ShiftLeft', 'ShiftRight'],
  interact: ['KeyE', 'Enter'],
  throw: ['Space'],
  drink: ['KeyC'],
  map: ['KeyM', 'Tab'],
  pause: ['Escape', 'KeyP'],
  name: ['KeyN'],
  answer1: ['Digit1', 'Numpad1'],
  answer2: ['Digit2', 'Numpad2'],
  answer3: ['Digit3', 'Numpad3'],
};
const ACTION_OF = Object.fromEntries(Object.entries(BIND).flatMap(([a, codes]) => codes.map((c) => [c, a])));
const ONE_SHOT = ['interact', 'throw', 'drink'];
const clamp1 = (v) => Math.max(-1, Math.min(1, v));

export class Input {
  constructor(canvas, touchRoot) {
    this.canvas = canvas;
    this.down = new Set();
    this.pressed = new Set();
    this.mouseDX = 0;
    this.sensitivity = 1;
    this.classicTurn = false; // A/D turn instead of strafe
    this.enabled = false; // true while a round is being played
    this.locked = false;
    this.onLockChange = null;
    this.touch = { moveX: 0, moveY: 0, lookDX: 0 };

    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.down.clear());
    document.addEventListener('mousemove', (e) => { if (this.locked) this.mouseDX += e.movementX || 0; });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (this.locked) { if (e.button === 0) this.pressed.add('throw'); } else this.requestLock();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    if (touchRoot) this.setupTouch(touchRoot);
  }

  requestLock() {
    if (!this.canvas.requestPointerLock) return;
    try {
      // Newer browsers return a promise that rejects (e.g. when re-locking
      // too soon after Esc); keyboard turning still works without the lock.
      const r = this.canvas.requestPointerLock();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* not available (iframe without permission, etc.) */ }
  }

  releaseLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  onKey(e, isDown) {
    const action = ACTION_OF[e.code];
    if (!action) return;
    if (this.enabled && !e.metaKey && !e.ctrlKey) e.preventDefault(); // no page scroll, no Tab focus jumps
    if (isDown) {
      if (!this.down.has(e.code)) this.pressed.add(action);
      this.down.add(e.code);
    } else {
      this.down.delete(e.code);
    }
  }

  held(action) {
    return BIND[action].some((c) => this.down.has(c));
  }

  // One-shot actions handled outside the simulation (map, pause).
  consume(action) {
    const had = this.pressed.has(action);
    this.pressed.delete(action);
    return had;
  }

  clear() {
    this.pressed.clear();
    this.mouseDX = 0;
    this.touch.lookDX = 0;
  }

  // Input for this frame; clears one-shot presses and accumulated mouse look.
  read() {
    const lr = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    let turn = (this.held('turnRight') ? 1 : 0) - (this.held('turnLeft') ? 1 : 0);
    let strafe = this.touch.moveX;
    if (this.classicTurn) turn += lr; else strafe += lr;
    const stick = Math.hypot(this.touch.moveX, this.touch.moveY);
    const out = {
      forward: clamp1((this.held('forward') ? 1 : 0) - (this.held('back') ? 1 : 0) - this.touch.moveY),
      strafe: clamp1(strafe),
      turn: clamp1(turn),
      look: (this.mouseDX * 0.0025 + this.touch.lookDX * 0.006) * this.sensitivity,
      run: this.held('run') || stick > 0.92,
    };
    for (const a of ONE_SHOT) { out[a] = this.pressed.has(a); this.pressed.delete(a); }
    out.answer = 0; // Jeopardy response 1-3
    for (const k of [1, 2, 3]) if (this.pressed.delete(`answer${k}`) && !out.answer) out.answer = k;
    this.mouseDX = 0;
    this.touch.lookDX = 0;
    return out;
  }

  setupTouch(root) {
    const zone = root.querySelector('.stick-zone');
    const base = root.querySelector('.stick-base');
    const knob = root.querySelector('.stick-knob');
    const look = root.querySelector('.look-zone');
    let stickId = null, ox = 0, oy = 0, lookId = null, lx = 0;
    const R = 56;
    const resetStick = () => {
      stickId = null;
      this.touch.moveX = this.touch.moveY = 0;
      base.style.opacity = '0.35';
      knob.style.transform = 'translate(-50%, -50%)';
    };
    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      stickId = e.pointerId; ox = e.clientX; oy = e.clientY;
      zone.setPointerCapture(e.pointerId);
      const r = zone.getBoundingClientRect();
      base.style.left = `${ox - r.left}px`;
      base.style.top = `${oy - r.top}px`;
      base.style.opacity = '1';
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== stickId) return;
      const dx = e.clientX - ox, dy = e.clientY - oy, len = Math.hypot(dx, dy), k = len > R ? R / len : 1;
      this.touch.moveX = (dx * k) / R;
      this.touch.moveY = (dy * k) / R;
      knob.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
    });
    for (const ev of ['pointerup', 'pointercancel']) zone.addEventListener(ev, (e) => { if (e.pointerId === stickId) resetStick(); });

    look.addEventListener('pointerdown', (e) => { e.preventDefault(); lookId = e.pointerId; lx = e.clientX; look.setPointerCapture(e.pointerId); });
    look.addEventListener('pointermove', (e) => { if (e.pointerId !== lookId) return; this.touch.lookDX += e.clientX - lx; lx = e.clientX; });
    for (const ev of ['pointerup', 'pointercancel']) look.addEventListener(ev, (e) => { if (e.pointerId === lookId) lookId = null; });

    root.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.pressed.add(btn.dataset.action); });
    });
    resetStick();
  }
}
