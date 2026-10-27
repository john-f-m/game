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
    this.touch = { moveX: 0, moveY: 0, lookDX: 0, run: false };

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

  // Also lets go of the touch stick, so a thumb resting on it through a
  // pause or a dialog doesn't keep you walking afterwards.
  clear() {
    this.pressed.clear();
    this.mouseDX = 0;
    this.touch.lookDX = 0;
    if (this.touchReset) this.touchReset();
  }

  // Input for this frame; clears one-shot presses and accumulated mouse look.
  read() {
    const lr = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    let turn = (this.held('turnRight') ? 1 : 0) - (this.held('turnLeft') ? 1 : 0);
    let strafe = this.touch.moveX;
    if (this.classicTurn) turn += lr; else strafe += lr;
    const out = {
      forward: clamp1((this.held('forward') ? 1 : 0) - (this.held('back') ? 1 : 0) - this.touch.moveY),
      strafe: clamp1(strafe),
      turn: clamp1(turn),
      look: (this.mouseDX * 0.0025 + this.touch.lookDX * 0.006) * this.sensitivity,
      run: this.held('run') || this.touch.run,
    };
    for (const a of ONE_SHOT) { out[a] = this.pressed.has(a); this.pressed.delete(a); }
    out.answer = 0; // Jeopardy response 1-3
    for (const k of [1, 2, 3]) if (this.pressed.delete(`answer${k}`) && !out.answer) out.answer = k;
    this.mouseDX = 0;
    this.touch.lookDX = 0;
    return out;
  }

  // Left thumb: a joystick that rests in the corner and jumps to wherever you
  // put your thumb. Right side: swipe to look. On touch screens this uses
  // touch events with preventDefault: with pointer events, iOS Safari takes
  // an upward swipe (walking forward) for its own scroll/toolbar gesture and
  // cancels it.
  setupTouch(root) {
    const zone = root.querySelector('.stick-zone');
    const base = root.querySelector('.stick-base');
    const knob = root.querySelector('.stick-knob');
    const look = root.querySelector('.look-zone');
    const R = 56, DEAD = 6, RUN = R * 1.4; // stick travel, dead zone, run past the ring (CSS px)
    let stick = null, lookAt = null; // { id, x, y } of the finger on each
    const resetStick = () => {
      stick = null;
      this.touch.moveX = this.touch.moveY = 0;
      this.touch.run = false;
      base.classList.remove('active', 'running');
      base.style.left = base.style.top = ''; // back to its resting spot
      knob.style.transform = 'translate(-50%, -50%)';
    };
    const startStick = (id, x, y) => {
      stick = { id, x, y };
      const r = zone.getBoundingClientRect();
      base.style.left = `${x - r.left}px`;
      base.style.top = `${y - r.top}px`;
      base.classList.add('active');
      zone.classList.add('used');
    };
    const moveStick = (x, y) => {
      const dx = x - stick.x, dy = y - stick.y, len = Math.hypot(dx, dy), k = len > R ? R / len : 1;
      this.touch.moveX = len > DEAD ? (dx * k) / R : 0;
      this.touch.moveY = len > DEAD ? (dy * k) / R : 0;
      this.touch.run = len > RUN;
      base.classList.toggle('running', this.touch.run);
      knob.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
    };
    const press = (btn) => this.pressed.add(btn.dataset.action);
    const buttons = root.querySelectorAll('[data-action]');

    if ('ontouchstart' in window) {
      const opts = { passive: false };
      const find = (e, f) => f && Array.from(e.changedTouches).find((t) => t.identifier === f.id);
      zone.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const t = e.changedTouches[0];
        if (!stick && t) startStick(t.identifier, t.clientX, t.clientY);
      }, opts);
      zone.addEventListener('touchmove', (e) => {
        e.preventDefault();
        const t = find(e, stick);
        if (t) moveStick(t.clientX, t.clientY);
      }, opts);
      look.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const t = e.changedTouches[0];
        if (!lookAt && t) lookAt = { id: t.identifier, x: t.clientX };
      }, opts);
      look.addEventListener('touchmove', (e) => {
        e.preventDefault();
        const t = find(e, lookAt);
        if (t) { this.touch.lookDX += t.clientX - lookAt.x; lookAt.x = t.clientX; }
      }, opts);
      for (const ev of ['touchend', 'touchcancel']) {
        zone.addEventListener(ev, (e) => { if (find(e, stick)) resetStick(); });
        look.addEventListener(ev, (e) => { if (find(e, lookAt)) lookAt = null; });
      }
      buttons.forEach((btn) => btn.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); press(btn); }, opts));
      // No page scrolling, bouncing or pinch-zooming while a round is on
      // (menus still scroll).
      document.addEventListener('touchmove', (e) => { if (this.enabled) e.preventDefault(); }, opts);
      document.addEventListener('gesturestart', (e) => { if (this.enabled) e.preventDefault(); });
    } else {
      // Pens and touch screens that only send pointer events.
      zone.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        zone.setPointerCapture(e.pointerId);
        startStick(e.pointerId, e.clientX, e.clientY);
      });
      zone.addEventListener('pointermove', (e) => { if (stick && e.pointerId === stick.id) moveStick(e.clientX, e.clientY); });
      look.addEventListener('pointerdown', (e) => { e.preventDefault(); look.setPointerCapture(e.pointerId); lookAt = { id: e.pointerId, x: e.clientX }; });
      look.addEventListener('pointermove', (e) => {
        if (!lookAt || e.pointerId !== lookAt.id) return;
        this.touch.lookDX += e.clientX - lookAt.x;
        lookAt.x = e.clientX;
      });
      for (const ev of ['pointerup', 'pointercancel']) {
        zone.addEventListener(ev, (e) => { if (stick && e.pointerId === stick.id) resetStick(); });
        look.addEventListener(ev, (e) => { if (lookAt && e.pointerId === lookAt.id) lookAt = null; });
      }
      buttons.forEach((btn) => btn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); press(btn); }));
    }
    this.touchReset = () => { resetStick(); lookAt = null; };
    resetStick();
  }
}
