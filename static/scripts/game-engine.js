// Entry point: loads data and sprites, runs the menus and the game loop.
// Game rules live in game.js, drawing in raycaster.js / hud.js.

import { createGame, updateGame, DIFFICULTY, formatClock, readyCount } from './game.js';
import { buildTextures } from './textures.js';
import { Raycaster } from './raycaster.js';
import { drawHud } from './hud.js';
import { Input } from './input.js';
import { Sound } from './audio.js';
import { BOSS_SPRITES, spritePath } from './sprite-config.js';

const STEP = 1 / 60;
const STATIC = new URL('../', import.meta.url); // the static/ folder, wherever the site is hosted
const $ = (id) => document.getElementById(id);

const ui = {
  canvas: $('screen'), loading: $('loading'), error: $('error'), title: $('title'),
  pause: $('pause'), end: $('end'), touch: $('touch-ui'), settings: $('settings'),
};
const ctx = ui.canvas.getContext('2d');
const low = document.createElement('canvas');
const lowCtx = low.getContext('2d');
let imageData = null;

const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const showFps = new URLSearchParams(location.search).has('fps');
const input = new Input(ui.canvas, ui.touch);
const sound = new Sound();

let data = null, raycaster = null, icons = {};
let game = null, demo = null;
let state = 'loading';
let showMap = false, shake = 0, lastFrame = performance.now(), acc = 0, fps = 60;

// ------------------------------------------------------------- storage --
// Browser storage can be unavailable (private mode, blocked cookies), so
// every access is guarded and the game works without it.

const DEFAULT_SETTINGS = { sound: true, sensitivity: 1, classicTurn: false, pixels: 300, difficulty: 'analyst' };

function readStore(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

const settings = readStore('ccc.settings', DEFAULT_SETTINGS);
const best = readStore('ccc.best', {});

// --------------------------------------------------------------- loading --

async function loadJSON(path) {
  let res;
  try {
    res = await fetch(new URL(path, STATIC), { cache: 'no-cache' });
  } catch (e) {
    throw new Error(`Couldn't load static/${path} (${e.message}).`);
  }
  if (!res.ok) throw new Error(`Couldn't load static/${path}: the server answered ${res.status}.`);
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`static/${path} is not valid JSON: ${e.message}`);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Couldn't load ${url}`));
    img.src = url;
  });
}

async function loadTex(url) {
  const img = await loadImage(url);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0);
  const px = cx.getImageData(0, 0, c.width, c.height);
  return { w: c.width, h: c.height, data: new Uint32Array(px.data.buffer) };
}

async function loadBossSprites() {
  const out = {};
  await Promise.all(Object.entries(BOSS_SPRITES).map(async ([id, cfg]) => {
    try {
      const frames = await Promise.all(Array.from({ length: cfg.frameCount }, (_, i) => loadTex(new URL(spritePath(id, i), STATIC).href)));
      out[id] = { ...cfg, frames };
    } catch (e) {
      console.warn(`Sprites for ${id} didn't load, using a stand-in figure.`, e);
    }
  }));
  return out;
}

function texToCanvas(t) {
  const c = document.createElement('canvas');
  c.width = t.w;
  c.height = t.h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(t.data.buffer.slice(0)), t.w, t.h), 0, 0);
  return c;
}

async function boot() {
  try {
    const [office, encounters] = await Promise.all([loadJSON('data/office.json'), loadJSON('data/encounters.json')]);
    data = { office, encounters };
    // The demo round behind the title screen also tells us everyone's look,
    // including the unnamed coworkers, so sprites can be built for all.
    demo = createGame({ office, encounters, seed: 7, warn: (m) => console.warn(m) });
    demo.player.x = 15.5;
    demo.player.y = 5.5;
    let poster = null;
    try {
      poster = await loadTex(new URL('sprites/posters/for-the-children.png', STATIC).href);
    } catch (e) {
      console.warn("Poster image didn't load; walls go without it.", e);
    }
    const textures = buildTextures(demo.npcs.map((n) => n.look), office.window_view, { poster });
    raycaster = new Raycaster(textures, await loadBossSprites());
    icons = Object.fromEntries(Object.entries(textures.items).map(([k, t]) => [k, texToCanvas(t)]));
    try {
      drawHazardPortraits(textures, demo);
    } catch (e) {
      console.warn("Couldn't draw the hazard portraits.", e); // decorative only; never block the game
    }
    applySettings();
    setupTitle();
    showScreen(ui.title);
    state = 'title';
  } catch (err) {
    showError(err);
  }
}

// --------------------------------------------------------------- screens --

function showScreen(el) {
  for (const s of [ui.loading, ui.error, ui.title, ui.pause, ui.end]) s.hidden = s !== el;
  if (el === ui.title) $('title-settings-slot').append(ui.settings);
  if (el === ui.pause) $('pause-settings-slot').append(ui.settings);
}

function showError(err, crashed = false) {
  console.error(err);
  state = 'error';
  input.enabled = false;
  input.releaseLock();
  ui.touch.hidden = true;
  $('error-heading').textContent = crashed ? 'The game hit a bug' : "The game couldn't start";
  $('error-message').textContent = err && err.message ? err.message : String(err);
  $('error-details').textContent = err && err.stack ? err.stack : '';
  showScreen(ui.error);
}

const listNames = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

function setupTitle() {
  const { office, encounters } = data;
  $('floor-name').textContent = office.name || '';
  $('briefing').textContent = office.briefing || '';
  const signers = new Set((encounters.reports || []).map((r) => r.signoff).filter(Boolean));
  const people = encounters.npc_encounters || [];
  $('coworkers').textContent = listNames(people.filter((n) => signers.has(n.npc)).map((n) => n.npc));
  $('helpers').textContent = listNames(people.filter((n) => n.perk && !signers.has(n.npc)).map((n) => (n.title ? `${n.npc} (${n.title})` : n.npc)));
  $('report-list').textContent = listNames((encounters.reports || []).map((r) => r.name));
  const box = $('difficulty');
  box.textContent = '';
  for (const [key, d] of Object.entries(DIFFICULTY)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'diff';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(settings.difficulty === key));
    const score = best[key];
    b.innerHTML = `<span class="diff-name"></span><span class="diff-blurb"></span><span class="diff-best"></span>`;
    b.querySelector('.diff-name').textContent = `${d.label} · ${formatClock(d.time)}`;
    b.querySelector('.diff-blurb').textContent = d.blurb;
    b.querySelector('.diff-best').textContent = score ? `Best score ${score.toLocaleString()}` : 'Not cleared yet';
    b.addEventListener('click', () => {
      settings.difficulty = key;
      writeStore('ccc.settings', settings);
      box.querySelectorAll('.diff').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    });
    box.append(b);
  }
}

// Title-screen portraits for the coworker hazards (Kevin, Ryan), drawn from
// their in-game sprites into <canvas data-hazard="Name"> elements.
function drawHazardPortraits(textures, game) {
  document.querySelectorAll('canvas[data-hazard]').forEach((c) => {
    const n = game.npcs.find((x) => x.name === c.dataset.hazard);
    const t = n && textures.people[n.index];
    if (!t) return;
    const s = Math.floor(Math.min(c.width / t.w, c.height / t.h));
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = false;
    cx.clearRect(0, 0, c.width, c.height);
    cx.drawImage(texToCanvas(t), (c.width - t.w * s) / 2, c.height - t.h * s, t.w * s, t.h * s);
  });
}

// Hazard portraits on the title screen turn slowly through every angle.
let portraitTick = 0;
setInterval(() => {
  if (state !== 'title') return;
  portraitTick++;
  for (const [id, cfg] of Object.entries(BOSS_SPRITES)) {
    const img = $(`portrait-${id}`);
    if (!img) continue;
    const order = cfg.views.map((v) => v[1]);
    img.src = new URL(spritePath(id, order[portraitTick % order.length]), STATIC).href;
  }
}, 420);

// -------------------------------------------------------------- settings --

function applySettings() {
  sound.setMuted(!settings.sound);
  input.sensitivity = settings.sensitivity;
  input.classicTurn = settings.classicTurn;
  imageData = null; // rebuild the frame buffer at the new pixel size
  $('opt-sound').checked = settings.sound;
  $('opt-sens').value = settings.sensitivity;
  $('opt-classic').checked = settings.classicTurn;
  $('opt-pixels').value = String(settings.pixels);
}

$('opt-sound').addEventListener('change', (e) => { settings.sound = e.target.checked; applySettings(); writeStore('ccc.settings', settings); });
$('opt-sens').addEventListener('input', (e) => { settings.sensitivity = Number(e.target.value) || 1; applySettings(); writeStore('ccc.settings', settings); });
$('opt-classic').addEventListener('change', (e) => { settings.classicTurn = e.target.checked; applySettings(); writeStore('ccc.settings', settings); });
$('opt-pixels').addEventListener('change', (e) => { settings.pixels = Number(e.target.value) || 300; applySettings(); writeStore('ccc.settings', settings); });

// ----------------------------------------------------------------- flow --

function startGame(difficulty) {
  sound.unlock();
  game = createGame({
    office: data.office, encounters: data.encounters, difficulty,
    seed: (Math.random() * 2 ** 31) | 0, warn: (m) => console.warn(m),
  });
  game.mapName = data.office.name;
  showMap = false;
  shake = 0;
  acc = 0;
  input.clear();
  input.enabled = true;
  state = 'playing';
  showScreen(null);
  ui.touch.hidden = !isTouch;
  if (!isTouch) input.requestLock();
}

function pause() {
  if (state !== 'playing') return;
  state = 'paused';
  input.enabled = false;
  input.releaseLock();
  ui.touch.hidden = true;
  $('pause-status').textContent = `${formatClock(game.timeLeft)} until the CME · ${readyCount(game)}/${game.reports.length} reports ready`;
  showScreen(ui.pause);
}

function resume() {
  if (state !== 'paused') return;
  state = 'playing';
  showScreen(null);
  input.clear();
  input.enabled = true;
  ui.touch.hidden = !isTouch;
  acc = 0;
  if (!isTouch) input.requestLock();
}

function quitToTitle() {
  state = 'title';
  game = null;
  input.enabled = false;
  input.releaseLock();
  ui.touch.hidden = true;
  setupTitle();
  showScreen(ui.title);
}

function endRound() {
  state = 'ended';
  input.enabled = false;
  input.releaseLock();
  ui.touch.hidden = true;
  const r = game.result;
  const key = game.difficulty;
  const newBest = r.won && r.score > (best[key] || 0);
  if (newBest) { best[key] = r.score; writeStore('ccc.best', best); }
  $('end').classList.toggle('won', r.won);
  $('end-title').textContent = r.title;
  $('end-text').textContent = r.text;
  $('end-rating').textContent = r.won ? `${r.rating}${newBest ? ' · new best!' : ''}` : r.rating;
  $('end-score').textContent = r.won ? r.score.toLocaleString() : '-';
  const s = game.stats;
  const rows = [
    ['Difficulty', DIFFICULTY[key].label],
    ['Reports ready', `${r.reports}/${game.reports.length}`],
    ['Approval stamps', `${s.stamps}`],
    ['Time to spare', r.won ? formatClock(r.timeLeft) : '-'],
    ['Crew dose', `${r.crewDose.toFixed(1)} mSv`],
    ['Tasks done', `${s.tasks}`],
    ['Trapped in conversations', `${s.trapped}`],
    ['Sanity left', `${Math.round(r.sanity)}`],
    ['Times caught', `${s.catches}`],
    ['Memos thrown / hit', `${s.memosThrown} / ${s.memosHit}`],
  ];
  const tbody = $('end-stats');
  tbody.textContent = '';
  for (const [k, v] of rows) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    const td = document.createElement('td');
    th.textContent = k;
    td.textContent = v;
    tr.append(th, td);
    tbody.append(tr);
  }
  setTimeout(() => { if (state === 'ended') showScreen(ui.end); }, 900);
}

$('start').addEventListener('click', () => startGame(settings.difficulty));
$('resume').addEventListener('click', resume);
$('restart').addEventListener('click', () => startGame(game ? game.difficulty : settings.difficulty));
$('quit').addEventListener('click', quitToTitle);
$('again').addEventListener('click', () => startGame(game ? game.difficulty : settings.difficulty));
$('menu').addEventListener('click', quitToTitle);
$('reload').addEventListener('click', () => location.reload());

input.onLockChange = (locked) => {
  if (!locked && state === 'playing' && !isTouch) pause();
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});

// ------------------------------------------------------------- rendering --

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const cw = Math.max(1, Math.round(window.innerWidth * dpr));
  const ch = Math.max(1, Math.round(window.innerHeight * dpr));
  if (ui.canvas.width !== cw || ui.canvas.height !== ch) {
    ui.canvas.width = cw;
    ui.canvas.height = ch;
  }
  const H = settings.pixels;
  const W = Math.round(Math.max(H * 0.5, Math.min(H * 2.6, (H * cw) / ch)));
  if (!imageData || low.width !== W || low.height !== H) {
    low.width = W;
    low.height = H;
    imageData = lowCtx.createImageData(W, H);
    raycaster.resize(W, H, new Uint32Array(imageData.data.buffer));
  }
  return { cw, ch, dpr };
}

function render(g, t, withHud) {
  const { cw, ch, dpr } = resize();
  raycaster.render(g, t);
  lowCtx.putImageData(imageData, 0, 0);
  ctx.imageSmoothingEnabled = false;
  const u = Math.max(Math.min(cw / 1280, ch / 760), dpr * 0.7);
  let sx = 0, sy = 0;
  if (shake > 0.2) {
    sx = (Math.random() - 0.5) * shake * u;
    sy = (Math.random() - 0.5) * shake * u;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
  }
  ctx.drawImage(low, sx, sy, cw, ch);
  if (withHud) drawHud(ctx, g, { w: cw, h: ch, u, time: t, showMap, icons, fps: showFps ? fps : 0 });
}

function drainEvents() {
  for (const e of game.events) {
    if (e.type === 'sfx') sound.play(e.name, e);
    else if (e.type === 'voice') sound.voice(e.boss);
    else if (e.type === 'shake') shake = Math.max(shake, e.amount);
  }
  game.events.length = 0;
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  try {
    if (state === 'playing') {
      if (input.consume('pause')) {
        pause();
      } else {
        if (input.consume('map')) showMap = !showMap;
        const step = input.read();
        acc += dt;
        let n = 0;
        while (acc >= STEP && n < 6) {
          updateGame(game, step, STEP);
          step.interact = step.throw = step.drink = false;
          step.answer = 0;
          step.look = 0;
          acc -= STEP;
          n++;
        }
        if (n >= 6) acc = 0;
        drainEvents();
        ui.touch.classList.toggle('quiz', !!game.quiz);
        if (game.status !== 'playing') endRound();
      }
    } else {
      input.consume('pause'); // Esc while a menu is open shouldn't queue up
      input.consume('map');
    }
    sound.update(dt, state === 'playing' ? game : null);
    shake = Math.max(0, shake - dt * 30);

    if (game && (state === 'playing' || state === 'paused' || state === 'ended')) {
      render(game, now / 1000, true);
    } else if (demo && state === 'title') {
      demo.player.a = ((now / 1000) * 0.12) % (Math.PI * 2);
      render(demo, now / 1000, false);
    }
  } catch (err) {
    showError(err, true);
  }
}

// ?debug exposes the live state in the console (window.ccc.game).
if (new URLSearchParams(location.search).has('debug')) {
  window.ccc = { get game() { return game; }, get state() { return state; }, settings };
}

boot();
requestAnimationFrame(frame);
