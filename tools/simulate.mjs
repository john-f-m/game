#!/usr/bin/env node
// Headless test run of the real game code (no browser needed):
//   1. validates the data files (everything on open, reachable floor)
//   2. lets bots play full rounds on every difficulty
//   3. fuzzes random input to catch crashes / NaN / wall clipping
//   4. checks every activity and coworker mechanic on its own
//   5. renders a few frames to PNG (needs ffmpeg; skipped otherwise)
//
// Usage: npm test            (or: node tools/simulate.mjs --frames <dir>)

import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createGame, updateGame, DIFFICULTY, TASKS, readyCount, reportReady, pendingStamps, hasItem, angleDiff, needlePos, taskReport,
} from '../static/scripts/game.js';
import { buildTextures, Tex } from '../static/scripts/textures.js';
import { Raycaster } from '../static/scripts/raycaster.js';
import { BOSS_SPRITES, spritePath } from '../static/scripts/sprite-config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const office = JSON.parse(readFileSync(join(ROOT, 'static/data/office.json'), 'utf8'));
const encounters = JSON.parse(readFileSync(join(ROOT, 'static/data/encounters.json'), 'utf8'));
const DT = 1 / 60;
let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL ${msg}`); };
const expect = (cond, msg) => (cond ? console.log(`  ok: ${msg}`) : fail(msg));
const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

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
  g.npcs.forEach((n) => (n.patrol ? n.patrol.every((wp) => ok(wp.x, wp.y)) : nextTo(n.x, n.y)) || fail(`${n.name} cannot be reached`));
  g.stations.forEach((s) => nextTo(s.x, s.y) || fail(`station ${s.type} cannot be reached`));
  g.bosses.forEach((b) => b.patrol.forEach((wp, i) => ok(wp.x, wp.y) || fail(`${b.id} waypoint ${i} unreachable`)));
  if (!g.stations.some((s) => s.type === 'srag_console')) fail('no SRAG console to submit at');
  for (const n of g.npcs) if (n.wants && !g.items.some((it) => it.type === n.wants.item) && !g.npcs.some((m) => m.gives === n.wants.item) && n.wants.item !== 'memos') fail(`${n.name} wants ${n.wants.item}, which nobody can get`);
  console.log(`  ${g.npcs.length} people (${g.npcs.filter((n) => !n.ambient).length} named), ${g.bosses.length} managers, ${g.stations.length} stations, ${g.items.length} items${failures ? '' : ', all reachable'}`);
}

// ------------------------------------------------------------- 2. bot --
// A bot that knows where everything is and walks the shortest paths. It
// ignores stealth (worst case) but throws memos at chasing managers, asks
// them for stamps when needed, plays the minigames correctly and mashes E
// to escape conversations.
function stepsFor(g, bot) {
  const p = g.player, steps = [];
  const station = (type) => g.stations.find((s) => s.type === type);
  for (const r of g.reports) {
    if (reportReady(r)) continue;
    const t = r.task;
    if (t && !t.done) {
      if (t.type === 'astronaut') {
        const a = g.npcs.find((n) => n.debrief);
        steps.push({ key: `${r.id}:astro`, target: a, act: 'talk', moving: true });
      } else if (t.type === 'medical' && !hasItem(p, 'dosimetry')) {
        steps.push({ key: `${r.id}:dosimetry`, target: g.npcs.find((n) => n.gives === 'dosimetry'), act: 'talk' });
      } else if (t.type === 'vehicle' && t.running) {
        steps.push({ key: `${r.id}:wait`, target: station('vehicle_sim'), act: 'wait', wait: true });
      } else {
        steps.push({ key: `${r.id}:task`, target: station(TASKS[t.type].station), act: 'use' });
      }
      continue;
    }
    const n = r.signoff;
    if (n && !n.signed) {
      if (n.wants && !hasItem(p, n.wants.item)) {
        if (!bot.item || bot.item.taken || bot.item.type !== n.wants.item) {
          bot.item = g.items.filter((i) => i.type === n.wants.item && !i.taken).sort((a, b) => near(a, p) - near(b, p))[0];
        }
        if (bot.item) steps.push({ key: `${r.id}:item`, target: bot.item, act: 'walk' });
      } else steps.push({ key: `${r.id}:sign`, target: n, act: 'talk' });
      continue;
    }
    for (const id of r.stamps) {
      if (r.stamped.has(id)) continue;
      const b = g.bosses.find((x) => x.id === id);
      if (b.reviewing <= 0) steps.push({ key: `stamp:${id}`, target: b, act: 'boss', moving: true });
    }
  }
  if (!steps.length && readyCount(g) === g.reports.length) steps.push({ key: 'submit', target: station('srag_console'), act: 'use' });
  return steps;
}

function botInput(g, bot) {
  const p = g.player, w = g.world;
  const input = { forward: 0, strafe: 0, turn: 0, look: 0, run: false, interact: false, throw: false, drink: false, answer: 0 };
  if (p.lock > 0) {
    if (g.quiz) input.answer = g.quiz.answer + 1;
    else if (g.mini) {
      const v = needlePos(g.mini);
      if (v > g.mini.zone[0] + 0.02 && v < g.mini.zone[1] - 0.02 && g.t - bot.lastTap > 0.3) { input.interact = true; bot.lastTap = g.t; }
    } else if (g.chat && g.chat.escape && g.t - bot.lastTap > 0.25) { input.interact = true; bot.lastTap = g.t; }
    return input;
  }
  const keepCoffee = g.npcs.some((n) => n.report && !n.signed && n.wants?.item === 'coffee') ? 1 : 0;
  if (p.sanity < 50 && p.coffee > keepCoffee) input.drink = true;

  const chaser = g.bosses.find((b) => b.state === 'chase' && b.stun <= 0 && near(b, p) < 4 && w.clearLine(p.x, p.y, b.x, b.y));
  if (chaser && pendingStamps(g, chaser.id).length) {
    input.look = angleDiff(Math.atan2(chaser.y - p.y, chaser.x - p.x), p.a);
    if (Math.abs(input.look) < 0.1 && near(chaser, p) < 1.5 && g.t - bot.lastInteract > 0.5) { input.interact = true; bot.lastInteract = g.t; }
    return input;
  }
  if (chaser && p.memos > 0) {
    input.look = angleDiff(Math.atan2(chaser.y - p.y, chaser.x - p.x), p.a);
    if (Math.abs(input.look) < 0.05 && g.t - bot.lastThrow > 0.6) { input.throw = true; bot.lastThrow = g.t; }
    return input;
  }

  // Commit to one step at a time (nearest first; waiting on the vehicle
  // run only when nothing else is left). A "guided" bot plays like a new
  // player: it only ever does what the in-game arrow says.
  const steps = bot.guided ? (g.guide ? [{ key: g.guide.key, target: g.guide, act: g.guide.act, wait: g.guide.act === 'wait' }] : []) : stepsFor(g, bot);
  let step = steps.find((s) => s.key === bot.stepKey);
  if (!step) {
    const work = steps.filter((s) => !s.wait);
    step = (work.length ? work : steps).sort((a, b) => near(a.target, p) - near(b.target, p))[0];
    bot.stepKey = step?.key;
  }
  if (!step || !step.target) return input;
  let goal = { x: step.target.x, y: step.target.y }, act = false;
  const d = near(step.target, p);
  if (step.act === 'walk') act = false;
  else if (step.act === 'wait') { if (d < 1.4) return input; }
  else act = d < (step.act === 'boss' ? 1.4 : 1.3);

  // Explorer mode: before each new step, wander to a couple of random spots.
  if (bot.explore && step.key !== bot.goalKey) {
    bot.goalKey = step.key;
    bot.detours = [bot.floor[Math.floor(bot.rand() * bot.floor.length)]];
  }
  if (bot.detours?.length) {
    const dt = bot.detours[0];
    if (near(dt, p) < 0.7) bot.detours.shift();
    else { goal = dt; act = false; }
  }
  if (act) {
    input.look = angleDiff(Math.atan2(step.target.y - p.y, step.target.x - p.x), p.a);
    if (Math.abs(input.look) < 0.1 && g.t - bot.lastInteract > 0.5) { input.interact = true; bot.lastInteract = g.t; }
    if (d > 1.0) input.forward = 0.3;
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

function newBot(g, mode, seed) {
  const reach = g.world.reachable(Math.floor(g.player.x), Math.floor(g.player.y));
  const floor = [];
  reach.forEach((v, i) => v && floor.push({ x: (i % g.world.w) + 0.5, y: Math.floor(i / g.world.w) + 0.5 }));
  let r = seed * 48271;
  return { lastThrow: -9, lastInteract: -9, lastTap: -9, explore: mode === 'explorer', guided: mode === 'guided', floor, rand: () => ((r = (r * 16807) % 2147483647) / 2147483647) };
}

console.log('2. Bot playthroughs (bots ignore stealth; "explorer" wanders like a first-time player; "guided" only follows the arrow)');
for (const [mode, diff] of [['expert', 'intern'], ['expert', 'analyst'], ['expert', 'director'], ['explorer', 'intern'], ['explorer', 'analyst'], ['explorer', 'director'], ['guided', 'intern'], ['guided', 'analyst']]) {
  const runs = [];
  for (let seed = 1; seed <= 24; seed++) {
    const g = createGame({ office, encounters, difficulty: diff, seed });
    const bot = newBot(g, mode, seed);
    while (g.status === 'playing' && g.t < DIFFICULTY[diff].time + 30) updateGame(g, botInput(g, bot), DT);
    if (g.status === 'playing') fail(`${diff} seed ${seed}: bot stuck (${readyCount(g)} reports ready, at ${g.player.x.toFixed(1)},${g.player.y.toFixed(1)}, step ${bot.stepKey})`);
    runs.push(g);
  }
  const won = runs.filter((g) => g.status === 'won');
  const avg = (arr, f) => (arr.length ? arr.reduce((s, g) => s + f(g), 0) / arr.length : 0);
  const reasons = {};
  runs.filter((g) => g.result && !g.result.won).forEach((g) => { reasons[g.result.reason] = (reasons[g.result.reason] || 0) + 1; });
  console.log(`  ${mode.padEnd(8)} ${DIFFICULTY[diff].label.padEnd(8)} won ${won.length}/${runs.length}` +
    ` | time left ${avg(won, (g) => g.timeLeft).toFixed(0)}s | crew dose ${avg(runs, (g) => g.crewDose).toFixed(1)}` +
    ` | catches ${avg(runs, (g) => g.stats.catches).toFixed(1)} | trapped ${avg(runs, (g) => g.stats.trapped).toFixed(1)}` +
    ` | stamps ${avg(runs, (g) => g.stats.stamps).toFixed(1)} | score ${avg(won, (g) => g.result.score).toFixed(0)} | losses ${JSON.stringify(reasons)}`);
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
      const bad = [p.x, p.y, p.a, g.crewDose, p.sanity, g.timeLeft].some((v) => !Number.isFinite(v));
      if (bad) { fail(`seed ${seed} frame ${i}: non-finite state`); break; }
      for (const [ox, oy] of [[0, 0], [0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]]) {
        if (g.world.isWallAt(p.x + ox, p.y + oy)) { fail(`seed ${seed} frame ${i}: player inside wall at ${p.x.toFixed(2)},${p.y.toFixed(2)}`); i = 1e9; break; }
      }
      for (const b of [...g.bosses, ...g.npcs.filter((n) => n.present)]) {
        if (g.world.isWallAt(b.x, b.y) || !Number.isFinite(b.x)) { fail(`seed ${seed}: ${b.id || b.name} inside wall`); i = 1e9; break; }
      }
    }
  }
  console.log(`  ${frames} frames simulated`);
}

// --------------------------------------------- 4. activities and people --
console.log('4. Activities and coworkers');
{
  const fresh = ({ errands = false } = {}) => {
    const g = createGame({ office, encounters, seed: 11 });
    // Park both managers in a far office so they don't interfere, and keep
    // everyone at their desk unless the test is about errands.
    g.bosses.forEach((b) => Object.assign(b, { x: 25.5, y: 21.5, satisfied: 999 }));
    if (!errands) g.npcs.forEach((n) => { if (n.home) n.errandTimer = Infinity; });
    return g;
  };
  const standAt = (g, o) => {
    const spot = [[0, 1], [0, -1], [1, 0], [-1, 0]].map(([dx, dy]) => [o.x + dx, o.y + dy])
      .find(([x, y]) => g.world.walkable(Math.floor(x), Math.floor(y)));
    Object.assign(g.player, { x: spot[0], y: spot[1], a: Math.atan2(o.y - spot[1], o.x - spot[0]), lock: 0 });
  };
  const press = (g, input = { interact: true }) => updateGame(g, input, DT);
  const run = (g, seconds, input = {}) => { for (let i = 0; i < seconds * 60; i++) updateGame(g, typeof input === 'function' ? input() : input, DT); };
  const npc = (g, name) => g.npcs.find((n) => n.name === name);
  const byPerk = (g, perk) => g.npcs.find((n) => n.perk === perk);
  const station = (g, type) => g.stations.find((s) => s.type === type);

  // Detector calibration.
  let g = fresh();
  standAt(g, station(g, 'detector_bench'));
  press(g);
  expect(g.mini && g.mini.kind === 'calibrate', 'detector bench opens the calibration gauge');
  run(g, 15, () => {
    const m = g.mini;
    return { interact: !!m && needlePos(m) > m.zone[0] + 0.02 && needlePos(m) < m.zone[1] - 0.02 && (g.t * 60 | 0) % 12 === 0 };
  });
  expect(taskReport(g, 'detector').task.done, 'three hits in the green band calibrate the detector');

  // Vehicle dose run: Serkan's model, Jennifer's priority queue, Mark's remote access.
  g = fresh();
  standAt(g, station(g, 'vehicle_sim'));
  press(g);
  const vt = taskReport(g, 'vehicle').task;
  expect(vt.running, 'vehicle dose run starts at the console');
  run(g, 4);
  expect(vt.progress > 0.2 && vt.progress < 0.3, `run progresses while you stay nearby (${(vt.progress * 100).toFixed(0)}%)`);
  g.player.x = 9.5; g.player.y = 16.5;
  const before = vt.progress;
  run(g, 3);
  expect(vt.progress === before, 'run pauses when you walk away');
  standAt(g, npc(g, 'Serkan'));
  press(g);
  expect(vt.progress >= before + 0.5 - 1e-9, `Serkan hands over half the run (${(vt.progress * 100).toFixed(0)}%)`);
  standAt(g, byPerk(g, 'remote_access'));
  press(g);
  standAt(g, npc(g, 'Jennifer'));
  press(g);
  g.player.x = 9.5; g.player.y = 16.5;
  run(g, 4);
  expect(vt.done, 'remote access + priority queue finish the run from across the floor');

  // Medical dose calculations need Ramona's dosimetry. (The workstation is
  // inside Kevin's gravity well, so keep him busy for this one.)
  g = fresh();
  npc(g, 'Kevin').chatCd = 999;
  standAt(g, station(g, 'dose_calc'));
  press(g);
  expect(!g.quiz, 'dose workstation refuses without dosimetry readings');
  standAt(g, npc(g, 'Ramona'));
  press(g);
  expect(hasItem(g.player, 'dosimetry'), 'Ramona hands over the crew dosimetry');
  standAt(g, station(g, 'dose_calc'));
  press(g);
  expect(g.quiz && g.quiz.kind === 'dosecalc', 'dose calculator opens');
  press(g, { answer: ((g.quiz.answer + 1) % 3) + 1 });
  expect(!g.quiz && !taskReport(g, 'medical').task.done, 'a wrong answer sends you back to recheck');
  run(g, 5);
  press(g);
  for (let i = 0; i < 2 && g.quiz; i++) press(g, { answer: g.quiz.answer + 1 });
  expect(taskReport(g, 'medical').task.done, 'two right answers finish the medical dose task');

  // The astronaut debrief, while the astronaut walks around.
  g = fresh();
  const astro = g.npcs.find((n) => n.debrief);
  run(g, 3);
  expect(astro.moving || astro.pause > 0 || near(astro, astro.patrol[0]) > 0.5, 'the astronaut walks the floor');
  standAt(g, astro);
  press(g);
  expect(g.chat && g.chat.kind === 'debrief', 'talking to the astronaut starts the debrief');
  run(g, 5);
  expect(taskReport(g, 'astronaut').task.done, 'debrief completes the astronaut task');

  // Kevin's gravity well.
  g = fresh();
  const kevin = npc(g, 'Kevin');
  Object.assign(g.player, { x: kevin.x - 0.2, y: kevin.y + 2.4, a: Math.PI / 2 });
  run(g, 1.5);
  expect(near(g.player, kevin) < 2.4 || g.chat, 'Kevin pulls you in when you stand still nearby');
  run(g, 3);
  expect(g.chat?.kind === 'blackhole' || g.stats.trapped > 0, 'getting close traps you in a Kevin conversation');
  let presses = 0;
  run(g, 4, () => ({ interact: g.chat && (presses++ % 6 === 0) }));
  expect(!g.chat && kevin.chatCd > 0, 'mashing E gets you out, and his pull switches off for a while');

  // Ryan helps, but bother him three times in a row and he walks you to his
  // whiteboard for a physics problem.
  g = fresh();
  const ryan = npc(g, 'Ryan');
  Object.assign(ryan, { x: 10.5, y: 12.5 });
  Object.assign(g.player, { x: 10.5, y: 15.5, a: -Math.PI / 2 });
  run(g, 4);
  expect(!g.chat, 'Ryan does not come after you');
  for (let i = 0; i < 3 && !g.chat; i++) { standAt(g, ryan); press(g); run(g, 0.3); g.dialog = null; }
  expect(g.chat?.kind === 'physics', 'the third quick conversation with Ryan turns into a physics problem');
  run(g, 9);
  expect(near(g.player, ryan.physics.home) < 2.5, `you end up at his whiteboard (${near(g.player, ryan.physics.home).toFixed(1)} tiles away)`);

  // Neil drops in, delivers a pun, and leaves.
  g = fresh();
  const neil = npc(g, 'Neil');
  neil.dropIn.timer = 0.01;
  run(g, 0.1);
  expect(neil.present && neil.seeking, 'Neil steps off the elevator');
  Object.assign(g.player, { x: neil.x + 1.0, y: neil.y, a: Math.PI });
  run(g, 0.5);
  expect(g.chat?.kind === 'dropin', 'Neil finds you and starts talking');
  run(g, 15);
  expect(!neil.present, 'then he heads back to the elevator');

  // Submitting at the SRAG console.
  g = fresh();
  standAt(g, station(g, 'srag_console'));
  press(g);
  expect(g.status === 'playing', 'the console refuses unfinished reports');
  for (const r of g.reports) { if (r.task) r.task.done = true; if (r.signoff) r.signoff.signed = true; r.stamps.forEach((id) => r.stamped.add(id)); }
  press(g);
  expect(g.status === 'won' && g.result.reason === 'submitted', 'submitting everything wins');

  // Earlier helpers still work.
  g = fresh();
  g.player.memos = 2;
  standAt(g, npc(g, 'Ryan'));
  Object.assign(npc(g, 'Ryan'), { chatCd: 99 });
  press(g);
  expect(g.bosses.every((b) => b.stun > 10 && b.stunKind === 'update'), 'Ryan: a memo ticket freezes management');
  g = fresh();
  standAt(g, byPerk(g, 'people_person'));
  press(g);
  Object.assign(g.bosses[0], { x: g.player.x + 0.3, y: g.player.y, state: 'chase', satisfied: 0, stun: 0 });
  run(g, 0.1);
  expect(g.stats.catches === 0 && !g.perks.shield, 'Mark (people person) talks a manager down');
  const marks = g.npcs.filter((n) => n.name === 'Mark');
  expect(marks.length === 2 && marks[0].title !== marks[1].title, `the two Marks are told apart by title (${marks.map((n) => n.title).join(' / ')})`);

  // Amir hosts with his own (Kansas) reactions.
  g = fresh();
  const amir = npc(g, 'Amir');
  standAt(g, amir);
  press(g);
  press(g, { answer: g.quiz.answer + 1 });
  expect(amir.quizLines.right.some((l) => g.dialog?.lines[0].endsWith(l)), `Amir reacts in his own words ("${g.dialog?.lines[0]}")`);
  expect(!amir.look.beard, 'Amir is clean-shaven');

  // The guide: always something to do, pointing at a real place.
  g = fresh();
  expect(g.guide && Number.isFinite(g.guide.dist) && /hallway|office|room|lab|move/i.test(g.guide.where), `the arrow has a target from the start ("${g.guide?.text}" · ${g.guide?.where})`);
  const firstKey = g.guide.key;
  run(g, 3, () => ({ forward: 1 }));
  expect(g.guide.key === firstKey, 'the pick sticks while you walk');
  for (const r of g.reports) { if (r.task) r.task.done = true; if (r.signoff) r.signoff.signed = true; r.stamps.forEach((id) => r.stamped.add(id)); }
  run(g, 0.1);
  expect(g.guide?.key === 'submit', 'with everything ready it points at the SRAG console');
  g = fresh();
  const katie = npc(g, 'Katie');
  Object.assign(g.player, { x: katie.x, y: katie.y - 1 });
  run(g, 0.1);
  expect(/timesheet/i.test(g.guide.text) && g.items.some((it) => it.type === 'timesheet' && near(it, g.guide) < 0.01), `near Katie it sends you for her timesheet first ("${g.guide.text}" · ${g.guide.where})`);
  g.player.items.add('timesheet');
  run(g, 0.1);
  expect(/Katie/.test(g.guide.text) && near(katie, g.guide) < 0.01, `with the timesheet in hand it points at Katie ("${g.guide.text}")`);
  g = fresh();
  const tipsSeen = [];
  run(g, 14, () => { for (const t of g.toasts) if (t.kind === 'tip' && !tipsSeen.includes(t.text)) tipsSeen.push(t.text); return {}; });
  expect(tipsSeen.length >= 2 && tipsSeen[0].startsWith('Welcome') && g.toasts.filter((t) => t.kind === 'tip').length <= 1, `hints arrive one at a time (${tipsSeen.length} in 14 s)`);
  g = createGame({ office, encounters, seed: 11, tips: false });
  run(g, 14);
  expect(!g.tips.on && g.toasts.every((t) => t.kind !== 'tip'), 'hints can be turned off');

  // Everyone with a desk gets up now and then, and comes back.
  g = fresh({ errands: true });
  Object.assign(g.player, { x: 19.5, y: 10.5 });
  npc(g, 'Kevin').chatCd = Infinity;
  const homes = g.npcs.filter((n) => n.home && n.present);
  const left = new Set(), since = new Map();
  let maxAway = 0, longest = 0;
  const idx = (o) => Math.floor(o.y) * g.world.w + Math.floor(o.x);
  for (let i = 0; i < 60 * 420; i++) {
    updateGame(g, {}, DT);
    if (i % 60 === 0) Object.assign(g, { crewDose: 0, timeLeft: 999 }) && (g.player.sanity = 100);
    let away = 0;
    for (const n of homes) {
      if (near(n, n.home) > 1) left.add(n);
      if (n.errand) {
        away++;
        if (!since.has(n)) since.set(n, g.t);
        longest = Math.max(longest, g.t - since.get(n));
      } else since.delete(n);
    }
    maxAway = Math.max(maxAway, away);
  }
  expect(g.status === 'playing', 'the errand run stays in play');
  expect(left.size >= homes.length * 0.9, `people get up from their desks (${left.size} of ${homes.length} within 7 minutes)`);
  const stayed = homes.filter((n) => !n.ambient && !left.has(n)).map((n) => n.name);
  expect(!stayed.length, `the named cast take errands too${stayed.length ? ` (not: ${stayed.join(', ')})` : ''}`);
  expect(maxAway <= g.errandCap, `only a few are up at once (at most ${maxAway}, cap ${g.errandCap})`);
  expect(longest < 120, `errands are short (longest ${longest.toFixed(0)} s)`);
  expect(homes.every((n) => (n.errand ? g.world.occupied[idx(n.home)] === 0 : near(n, n.home) < 1e-9 && g.world.occupied[idx(n.home)] === 1)),
    "people back from an errand sit in their own seat, and an empty desk doesn't block anyone");

  // Nobody walks off mid-conversation, and you can catch people on the way.
  g = fresh({ errands: true });
  const nic = npc(g, 'Nic');
  g.npcs.forEach((n) => { if (n.home && n !== nic) n.errandTimer = Infinity; });
  standAt(g, nic);
  press(g);
  nic.errandTimer = 0.01;
  run(g, 2);
  expect(g.dialog && !nic.errand, 'nobody leaves while you are talking to them');
  g.dialog = null;
  Object.assign(g.player, { x: 19.5, y: 10.5 });
  run(g, 20);
  expect(nic.errand && near(nic, nic.home) > 1, `Nic heads off on an errand (${nic.errand?.kind})`);
  standAt(g, nic);
  press(g);
  const spot = { x: nic.x, y: nic.y };
  run(g, 3);
  expect(g.dialog?.npc === nic && near(nic, spot) < 0.05, 'catch someone on the way and they stop to talk');
  g.dialog = null;
  Object.assign(g.player, { x: 19.5, y: 10.5 });
  run(g, 90);
  expect(!nic.errand && near(nic, nic.home) < 1e-9, 'then they go back to their desk');
  g = fresh({ errands: true });
  const amb = g.npcs.find((n) => n.ambient && n.present);
  Object.assign(amb, { errand: { kind: 'coffee', phase: 'there', stay: 30, x: amb.x, y: amb.y } });
  standAt(g, amb);
  press(g);
  expect(g.errandLines.coffee.includes(g.dialog?.lines[0]), `coworkers mention their errand ("${g.dialog?.lines[0]}")`);
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
  const g = createGame({ office, encounters, seed: 3 });
  const view = process.argv.includes('--orbit') ? 'orbit' : office.window_view;
  const poster = haveFfmpeg ? loadSprite(join(ROOT, 'static/sprites/posters/for-the-children.png')) : null;
  const textures = buildTextures(g.npcs.map((n) => n.look), view, { poster });
  const bossSprites = {};
  if (haveFfmpeg) {
    for (const [id, cfg] of Object.entries(BOSS_SPRITES)) {
      bossSprites[id] = { ...cfg, frames: Array.from({ length: cfg.frameCount }, (_, i) => loadSprite(join(ROOT, 'static', spritePath(id, i)))) };
    }
  }
  const W = 480, H = 270;
  const rc = new Raycaster(textures, bossSprites);
  rc.resize(W, H);
  const views = [
    { name: 'start', x: 19.5, y: 10.5, a: 0 },
    { name: 'console-room', x: 18.5, y: 21.5, a: Math.PI / 2 - 0.2 },
    { name: 'detector-lab', x: 9.5, y: 3.6, a: -Math.PI / 2 },
    { name: 'kevin', x: 22.5, y: 16.6, a: -Math.PI / 2 },
    { name: 'office-row', x: 13.5, y: 4.5, a: -Math.PI / 2 },
    { name: 'clifton', x: 9.5, y: 9.5, a: 0 },
    { name: 'corridor-doors', x: 5.5, y: 19.5, a: 0 },
    { name: 'serkan', x: 13.5, y: 2.5, a: -Math.PI / 2 },
    { name: 'posters-core', x: 15.5, y: 5.5, a: Math.PI / 2 }, // the Sun and a photo on the core's north wall
    { name: 'posters-east', x: 21.5, y: 12.5, a: Math.PI }, // Earth on the core's east wall
    { name: 'posters-south', x: 15.5, y: 18.5, a: -Math.PI / 2 }, // rocket and Moon
  ];
  const outDir = process.argv.includes('--frames') ? process.argv[process.argv.indexOf('--frames') + 1] : null;
  if (outDir) mkdirSync(outDir, { recursive: true });
  let ms = 0, n = 0;
  for (const v of views) {
    Object.assign(g.player, { x: v.x, y: v.y, a: v.a });
    if (v.name === 'clifton') Object.assign(g.bosses[1], { x: 11.3, y: 10.5, a: Math.PI * 0.75, state: 'patrol' });
    if (v.name === 'start') { const a = g.npcs.find((x) => x.debrief); Object.assign(a, { x: 22.5, y: 9.5 }); }
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
