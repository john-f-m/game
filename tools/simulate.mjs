#!/usr/bin/env node
// Headless test run of the real game code (no browser needed):
//   1. validates the data files (everything on open, reachable floor)
//   2. lets a bot play full rounds on every difficulty
//   3. fuzzes random input to catch crashes / NaN / wall clipping
//   4. renders a few frames to PNG (needs ffmpeg; skipped otherwise)
//
// Usage: npm test            (or: node tools/simulate.mjs --frames <dir>)

import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, updateGame, DIFFICULTY, readyCount, pendingStamps, hasItem, angleDiff } from '../static/scripts/game.js';
import { buildTextures, Tex } from '../static/scripts/textures.js';
import { Raycaster } from '../static/scripts/raycaster.js';
import { T } from '../static/scripts/world.js';
import { BOSS_SPRITES, spritePath } from '../static/scripts/sprite-config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const office = JSON.parse(readFileSync(join(ROOT, 'static/data/office.json'), 'utf8'));
const encounters = JSON.parse(readFileSync(join(ROOT, 'static/data/encounters.json'), 'utf8'));
const DT = 1 / 60;
let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL ${msg}`); };

// ------------------------------------------------------------ 1. data --
console.log('1. Data files');
{
  const warnings = [];
  const g = createGame({ office, encounters, seed: 1, warn: (m) => warnings.push(m) });
  warnings.forEach((w) => fail(`load warning: ${w}`));
  const w = g.world, p = g.player;
  const reach = w.reachable(Math.floor(p.x), Math.floor(p.y));
  const ok = (x, y) => reach[Math.floor(y) * w.w + Math.floor(x)];
  const nextTo = (x, y) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => ok(x + dx, y + dy));
  g.items.forEach((it) => ok(it.x, it.y) || fail(`item ${it.type} unreachable`));
  g.npcs.forEach((n) => nextTo(n.x, n.y) || fail(`${n.name} cannot be reached`));
  g.bosses.forEach((b) => b.patrol.forEach((wp, i) => ok(wp.x, wp.y) || fail(`${b.id} waypoint ${i} unreachable`)));
  let shelter = false;
  for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) if (w.get(x, y) === T.SHELTER && nextTo(x + 0.5, y + 0.5)) shelter = true;
  if (!shelter) fail('no reachable shelter door');
  for (const n of g.npcs) if (n.wants && !g.items.some((it) => it.type === n.wants.item)) fail(`${n.name} wants ${n.wants.item}, which is not on the map`);
  console.log(`  ${g.npcs.length} coworkers, ${g.bosses.length} bosses, ${g.items.length} items, ${failures ? 'problems above' : 'all placed on reachable floor'}`);
}

// ------------------------------------------------------------- 2. bot --
// A bot that knows where everything is and walks the shortest paths. It
// ignores stealth entirely (worst case) but throws memos at bosses that
// are chasing it, and drinks coffee when its sanity runs low.
function botInput(g, bot) {
  const p = g.player, w = g.world;
  const input = { forward: 0, strafe: 0, turn: 0, look: 0, run: false, interact: false, throw: false, drink: false };
  if (p.lock > 0) return input;

  const keepCoffee = g.npcs.some((n) => n.report && !n.signed && n.wants?.item === 'coffee') ? 1 : 0;
  if (p.sanity < 50 && p.coffee > keepCoffee) input.drink = true;

  const chaser = g.bosses.find((b) => b.state === 'chase' && b.stun <= 0 && Math.hypot(b.x - p.x, b.y - p.y) < 4 && w.clearLine(p.x, p.y, b.x, b.y));
  // A chasing manager whose stamp we need: turn around and ask for it.
  if (chaser && pendingStamps(g, chaser.id).length) {
    input.look = angleDiff(Math.atan2(chaser.y - p.y, chaser.x - p.x), p.a);
    if (Math.abs(input.look) < 0.1 && Math.hypot(chaser.x - p.x, chaser.y - p.y) < 1.5 && g.t - bot.lastInteract > 0.5) { input.interact = true; bot.lastInteract = g.t; }
    return input;
  }
  if (chaser && p.memos > 0) {
    const want = Math.atan2(chaser.y - p.y, chaser.x - p.x);
    input.look = angleDiff(want, p.a);
    if (Math.abs(input.look) < 0.05 && g.t - bot.lastThrow > 0.6) { input.throw = true; bot.lastThrow = g.t; }
    return input;
  }

  // Pick the current goal.
  let goal = null, face = null, act = false;
  // Only coworkers who sign off on a report; the helpers are optional.
  const signers = g.npcs.filter((n) => n.report && !n.signed);
  const todo = signers.find((n) => !n.wants || hasItem(p, n.wants.item)) || signers[0];
  if (todo && todo.wants && !hasItem(p, todo.wants.item)) {
    // Commit to one item until it's gone, so the target doesn't flip-flop.
    if (!bot.item || bot.item.taken || bot.item.type !== todo.wants.item) {
      bot.item = g.items.filter((i) => i.type === todo.wants.item && !i.taken)
        .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
    }
    if (bot.item) goal = { x: bot.item.x, y: bot.item.y };
  } else if (todo) {
    goal = { x: todo.x, y: todo.y }; face = goal; act = Math.hypot(todo.x - p.x, todo.y - p.y) < 1.4;
  }
  // Managers: go to the nearest one whose stamp is still needed (first,
  // if they're close by).
  const boss = g.bosses.filter((b) => pendingStamps(g, b.id).length && b.reviewing <= 0)
    .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
  if (boss && (!goal || Math.hypot(boss.x - p.x, boss.y - p.y) < 5)) {
    goal = { x: boss.x, y: boss.y, key: `boss:${boss.id}` }; face = goal; act = Math.hypot(boss.x - p.x, boss.y - p.y) < 1.4 && boss.stun <= 0;
  }
  if (!goal && readyCount(g) === g.reports.length) {
    for (let y = 0; y < w.h && !goal; y++) for (let x = 0; x < w.w; x++) {
      if (w.get(x, y) !== T.SHELTER) continue;
      const n = [[0, 1], [0, -1], [1, 0], [-1, 0]].find(([dx, dy]) => !w.isWall(x + dx, y + dy));
      if (!n) continue;
      goal = { x: x + n[0] + 0.5, y: y + n[1] + 0.5 }; face = { x: x + 0.5, y: y + 0.5 };
      act = Math.hypot(goal.x - p.x, goal.y - p.y) < 0.4;
      break;
    }
  }
  if (!goal) return input;
  // Explorer mode: before each new objective, wander to a couple of random
  // spots first, like a player who doesn't know the map yet.
  const key = goal.key || `${Math.floor(goal.x)},${Math.floor(goal.y)}`;
  if (bot.explore && key !== bot.goalKey) {
    bot.goalKey = key;
    bot.detours = Array.from({ length: 2 }, () => bot.floor[Math.floor(bot.rand() * bot.floor.length)]);
  }
  if (bot.detours?.length) {
    const d = bot.detours[0];
    if (Math.hypot(d.x - p.x, d.y - p.y) < 0.7) bot.detours.shift();
    else { goal = d; act = false; }
  }
  if (act) {
    input.look = angleDiff(Math.atan2(face.y - p.y, face.x - p.x), p.a);
    if (Math.abs(input.look) < 0.1 && g.t - bot.lastInteract > 0.5) { input.interact = true; bot.lastInteract = g.t; }
    return input;
  }
  const path = w.findPath(Math.floor(p.x), Math.floor(p.y), Math.floor(goal.x), Math.floor(goal.y));
  const next = path && path.length ? { x: path[0][0] + 0.5, y: path[0][1] + 0.5 } : goal;
  const want = Math.atan2(next.y - p.y, next.x - p.x);
  input.look = Math.max(-0.25, Math.min(0.25, angleDiff(want, p.a)));
  input.forward = Math.abs(angleDiff(want, p.a)) < 0.6 ? 1 : 0.2;
  input.run = g.bosses.some((b) => b.state === 'chase');
  return input;
}

console.log('2. Bot playthroughs (bots ignore stealth; "explorer" wanders like a first-time player)');
for (const [mode, diff] of [['expert', 'intern'], ['expert', 'analyst'], ['expert', 'director'], ['explorer', 'intern'], ['explorer', 'analyst'], ['explorer', 'director']]) {
  const runs = [];
  for (let seed = 1; seed <= 24; seed++) {
    const g = createGame({ office, encounters, difficulty: diff, seed });
    const reach = g.world.reachable(Math.floor(g.player.x), Math.floor(g.player.y));
    const floor = [];
    reach.forEach((v, i) => v && floor.push({ x: (i % g.world.w) + 0.5, y: Math.floor(i / g.world.w) + 0.5 }));
    let r = seed * 48271;
    const bot = { lastThrow: -9, lastInteract: -9, explore: mode === 'explorer', floor, rand: () => ((r = (r * 16807) % 2147483647) / 2147483647) };
    while (g.status === 'playing' && g.t < DIFFICULTY[diff].time + 30) updateGame(g, botInput(g, bot), DT);
    if (g.status === 'playing') fail(`${diff} seed ${seed}: bot stuck (${readyCount(g)} reports ready, at ${g.player.x.toFixed(1)},${g.player.y.toFixed(1)})`);
    runs.push(g);
  }
  const won = runs.filter((g) => g.status === 'won');
  const avg = (arr, f) => (arr.length ? arr.reduce((s, g) => s + f(g), 0) / arr.length : 0);
  const reasons = {};
  runs.filter((g) => g.result && !g.result.won).forEach((g) => { reasons[g.result.reason] = (reasons[g.result.reason] || 0) + 1; });
  console.log(`  ${mode.padEnd(8)} ${DIFFICULTY[diff].label.padEnd(8)} won ${won.length}/${runs.length}` +
    ` | time left ${avg(won, (g) => g.timeLeft).toFixed(0)}s | dose ${avg(runs, (g) => g.player.dose).toFixed(1)}` +
    ` | catches ${avg(runs, (g) => g.stats.catches).toFixed(1)} | stamps ${avg(runs, (g) => g.stats.stamps).toFixed(1)}` +
    ` | score ${avg(won, (g) => g.result.score).toFixed(0)} | losses ${JSON.stringify(reasons)}`);
}

// ------------------------------------------------------------ 3. fuzz --
console.log('3. Random-input fuzzing');
{
  let frames = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const g = createGame({ office, encounters, difficulty: ['intern', 'analyst', 'director'][seed % 3], seed });
    let input = {};
    let r = seed * 7919;
    const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 60 * 90 && g.status === 'playing'; i++) {
      if (i % 15 === 0) {
        input = { forward: rand() * 2 - 1, strafe: rand() * 2 - 1, turn: rand() * 2 - 1, look: (rand() - 0.5) * 0.2, run: rand() < 0.3 };
      }
      input.interact = rand() < 0.05; input.throw = rand() < 0.03; input.drink = rand() < 0.01;
      input.answer = rand() < 0.03 ? 1 + Math.floor(rand() * 3) : 0;
      try { updateGame(g, input, DT); } catch (e) { fail(`seed ${seed} frame ${i}: ${e.stack}`); break; }
      frames++;
      const p = g.player;
      const bad = [p.x, p.y, p.a, p.dose, p.sanity, g.timeLeft].some((v) => !Number.isFinite(v));
      if (bad) { fail(`seed ${seed} frame ${i}: non-finite player state`); break; }
      for (const [ox, oy] of [[0, 0], [0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]]) {
        if (g.world.isWallAt(p.x + ox, p.y + oy)) { fail(`seed ${seed} frame ${i}: player inside wall at ${p.x.toFixed(2)},${p.y.toFixed(2)}`); i = 1e9; break; }
      }
      for (const b of g.bosses) if (g.world.isWallAt(b.x, b.y) || !Number.isFinite(b.x)) { fail(`seed ${seed}: ${b.id} inside wall`); i = 1e9; break; }
    }
  }
  console.log(`  ${frames} frames simulated`);
}

// ----------------------------------------------------------- 4. perks --
console.log('4. Coworker perks');
{
  const fresh = () => {
    const g = createGame({ office, encounters, seed: 11 });
    // Park both managers in a far office so they don't interfere.
    g.bosses.forEach((b) => Object.assign(b, { x: 25.5, y: 21.5, satisfied: 999 }));
    return g;
  };
  // Stand next to a coworker, face them, press E.
  const visit = (g, name) => {
    const n = g.npcs.find((x) => x.name === name);
    if (!n) { fail(`no coworker named ${name}`); return null; }
    const spot = [[0, 1], [0, -1], [1, 0], [-1, 0]].map(([dx, dy]) => [n.x + dx, n.y + dy])
      .find(([x, y]) => g.world.walkable(Math.floor(x), Math.floor(y)));
    Object.assign(g.player, { x: spot[0], y: spot[1], a: Math.atan2(n.y - spot[1], n.x - spot[0]), lock: 0 });
    updateGame(g, { interact: true }, DT);
    return n;
  };
  const expect = (cond, msg) => (cond ? console.log(`  ok: ${msg}`) : fail(msg));
  let g = fresh();

  g.player.memos = 0;
  const ryan = visit(g, 'Ryan R');
  expect(ryan && !ryan.perkUsed && /ticket/i.test(g.dialog?.lines.join(' ')), 'Ryan R asks for a ticket first');
  g.player.memos = 2;
  visit(g, 'Ryan R');
  expect(g.bosses.every((b) => b.stun > 10 && b.stunKind === 'update') && g.player.memos === 1, 'Ryan R: memo as ticket, managers frozen');

  g = fresh();
  visit(g, 'Janet');
  g.flare.state = 'idle'; g.flare.timer = 0.001;
  updateGame(g, {}, DT);
  expect(g.perks.flareWatch && g.flare.state === 'warning' && g.flare.timer > 11, 'Janet: 12 s flare warnings');

  g = fresh();
  visit(g, 'Steve J');
  const eddie = g.bosses.find((b) => b.id === 'eddie');
  Object.assign(g.player, { x: 15.5, y: 6.5, a: -Math.PI / 2, lock: 0 });
  Object.assign(eddie, { x: 15.5, y: 5.5, satisfied: 0, state: 'patrol' });
  updateGame(g, { interact: true }, DT);
  expect(g.perks.fastReviews && eddie.reviewing > 0 && Math.abs(g.player.lockMax - (1.5 + 1) * 0.5) < 1e-6, 'Steve J: reviews take half as long');

  g = fresh();
  g.player.dose = 30;
  visit(g, 'Ramona');
  expect(Math.abs(g.player.dose - 10) < 0.1, `Ramona: dose recalibrated 30 -> ${g.player.dose.toFixed(1)}`);

  g = fresh();
  g.player.sanity = 50;
  const amir = visit(g, 'Amir B');
  expect(!!g.quiz && g.quiz.choices.length === 3, 'Amir B: Jeopardy clue shown');
  updateGame(g, { answer: g.quiz.answer + 1 }, DT);
  expect(!g.quiz && g.stats.quizRight === 1 && g.player.sanity > 65 && amir.cooldown > 0, 'Amir B: right answer, +20 sanity, cooldown');
  visit(g, 'Amir B');
  expect(!g.quiz, 'Amir B: no new clue during cooldown');
  amir.cooldown = 0;
  visit(g, 'Amir B');
  for (let i = 0; i < 60 * 13 && g.quiz; i++) updateGame(g, {}, DT);
  expect(!g.quiz && g.stats.quizWrong === 1, "Amir B: time's up counts as wrong");

  g = fresh();
  visit(g, 'Mark S');
  const before = g.player.sanity;
  Object.assign(eddie && g.bosses.find((b) => b.id === 'eddie'), { x: g.player.x + 0.3, y: g.player.y, state: 'chase', satisfied: 0, stun: 0 });
  updateGame(g, {}, DT);
  expect(!g.perks.shield && g.stats.catches === 0 && g.player.sanity >= before - 0.01, 'Mark S: next catch is talked down');
}

// ---------------------------------------------------------- 5. render --
console.log('5. Rendering');
function loadSprite(file) {
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  const t = new Tex(w, h);
  t.data.set(new Uint32Array(raw.buffer, raw.byteOffset, w * h));
  return t;
}
let haveFfmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { haveFfmpeg = false; }
{
  const view = process.argv.includes('--houston') ? 'houston' : office.window_view;
  const textures = buildTextures(encounters.npc_encounters.map((n) => n.look || {}), view);
  const bossSprites = {};
  if (haveFfmpeg) {
    for (const [id, cfg] of Object.entries(BOSS_SPRITES)) {
      bossSprites[id] = { ...cfg, frames: Array.from({ length: cfg.frameCount }, (_, i) => loadSprite(join(ROOT, 'static', spritePath(id, i)))) };
    }
  }
  const W = 480, H = 270;
  const rc = new Raycaster(textures, bossSprites);
  rc.resize(W, H);
  const g = createGame({ office, encounters, seed: 3 });
  const views = [
    { name: 'start', x: 19.5, y: 10.5, a: 0 },
    { name: 'corridor', x: 10.5, y: 19.5, a: Math.PI },
    { name: 'john-fm-office', x: 26.5, y: 13.5, a: 0 },
    { name: 'shelter', x: 15.5, y: 5.5, a: Math.PI / 2 },
    { name: 'eddie-office', x: 21.5, y: 4.5, a: -Math.PI / 2 },
    { name: 'elevators', x: 9.5, y: 9.5, a: 0 },
    { name: 'cabinets', x: 21.3, y: 1.9, a: 0 },
    { name: 'janet', x: 27.5, y: 9.5, a: 0.15 },
    { name: 'break-room', x: 15.5, y: 15.6, a: -Math.PI / 2 - 0.3 },
    { name: 'amir-steve', x: 23.5, y: 8.6, a: -0.6 },
  ];
  const outDir = process.argv.includes('--frames') ? process.argv[process.argv.indexOf('--frames') + 1] : null;
  if (outDir) mkdirSync(outDir, { recursive: true });
  let ms = 0, n = 0;
  for (const v of views) {
    Object.assign(g.player, { x: v.x, y: v.y, a: v.a });
    if (v.name === 'corridor') Object.assign(g.bosses[1], { x: 6.5, y: 19.5, a: 0.3, state: 'search' });
    if (v.name === 'shelter') { Object.assign(g.bosses[0], { x: 17.5, y: 7.2, a: Math.PI, state: 'chase' }); }
    if (v.name === 'elevators') Object.assign(g.bosses[1], { x: 11.3, y: 10.5, a: Math.PI * 0.75, state: 'patrol' });
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) rc.render(g, i / 60);
    ms += performance.now() - t0; n += 20;
    if (outDir && haveFfmpeg) {
      const fb = rc.render(g, 0.5);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-i', '-',
        '-vf', 'scale=960:540:flags=neighbor', '-frames:v', '1', join(outDir, `${v.name}.png`)], { input: Buffer.from(fb.buffer) });
    }
  }
  console.log(`  ${(ms / n).toFixed(2)} ms per ${W}x${H} frame${outDir ? `; PNGs in ${outDir}` : ''}${haveFfmpeg ? '' : ' (no ffmpeg: boss sprites skipped)'}`);
}

console.log(failures ? `\n${failures} problem(s) found` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
