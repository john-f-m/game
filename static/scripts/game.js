// Game rules and state. Pure logic: no DOM, no canvas, no audio. Everything
// the outside world needs to react to (sounds, screen shake) is pushed onto
// game.events and drained by the caller each frame.

import { World, T } from './world.js';

export const DIFFICULTY = {
  intern: {
    label: 'Intern', blurb: 'Generous deadline, slower bosses.',
    time: 540, patrolSpeed: 1.1, chaseSpeed: 2.4, viewRange: 6, fov: 1.5, detect: 1.0, doseMult: 0.8, catchMult: 0.6,
    reviews: 1, multiStamp: 0.3,
  },
  analyst: {
    label: 'Analyst', blurb: 'The intended experience.',
    time: 450, patrolSpeed: 1.35, chaseSpeed: 3.0, viewRange: 7.5, fov: 1.8, detect: 0.5, doseMult: 1, catchMult: 0.9,
    reviews: 2, multiStamp: 0.5,
  },
  director: {
    label: 'Director', blurb: 'Tight deadline. Sharper eyes. Faster bosses.',
    time: 330, patrolSpeed: 1.6, chaseSpeed: 3.4, viewRange: 9, fov: 2.0, detect: 0.35, doseMult: 1.25, catchMult: 1.25,
    reviews: 3, multiStamp: 0.7,
  },
};

export const PLAYER = {
  radius: 0.22, walk: 2.6, run: 4.2, turnRate: 2.6,
  sanity: 100, stamina: 100, staminaDrain: 30, staminaRegen: 22, startMemos: 2, maxMemos: 10, maxCoffee: 3, memoPack: 3, stun: 3.5,
};

// The astronauts' dose climbs until you deliver the assessment (faster as the
// solar particle event builds, and during flares). It is your score, not a
// fail state: the deadline is.
export const CREW = { start: 1.5, base: 0.02, ramp: 0.08, flare: 4, limit: 50 };

export const ITEMS = {
  coffee: { name: 'coffee', pickup: 'Picked up a coffee. Press C to drink it (+35 sanity).' },
  memos: { name: 'memos', pickup: '+3 memos. Throw them with Space or a click.' },
  timesheet: { name: "Katie's timesheet", pickup: "Found Katie's timesheet, jammed in the printer. PC LOAD LETTER indeed." },
  r13: { name: 'a blank Form R-13', pickup: "Swiped a blank Form R-13 from Eddie's cabinet." },
  dosimetry: { name: "the crew's dosimetry readings", pickup: "Got the crew's dosimetry readings." },
};

// What helpful coworkers (encounters.json "perk") do for you.
export const PERKS = {
  freeze_managers: { label: 'Management laptops rebooting' },
  flare_watch: { label: 'Flare watch' },
  fast_reviews: { label: 'Pivot-tabled reports: fast reviews' },
  jeopardy: { label: 'Jeopardy' },
  people_person: { label: 'People person on call' },
  remote_access: { label: 'Remote access to the vehicle run' },
  sim_priority: { label: 'Priority queue: vehicle run 2x faster' },
  gcr_model: { label: 'GCR model results' },
};

// Work that reports need besides sign-offs and stamps (encounters.json
// report "task"), and the stations in office.json where it happens.
export const TASKS = {
  detector: { label: 'Calibrate the prototype radiation detector', short: 'calibrate the detector (Detector Lab)', station: 'detector_bench' },
  vehicle: { label: 'Assess radiation dose inside the vehicle', short: 'run the vehicle dose model (console room)', station: 'vehicle_sim' },
  medical: { label: "Calculate the astronauts' medical doses", short: 'medical dose calculations', station: 'dose_calc', needs: 'dosimetry' },
  astronaut: { label: 'Debrief the visiting astronaut', short: 'debrief the astronaut' },
};

export const STATIONS = {
  detector_bench: { label: 'detector test bench', radius: 0.36 },
  vehicle_sim: { label: 'vehicle dose console', radius: 0.36 },
  dose_calc: { label: 'medical dose workstation', radius: 0.32 },
  srag_console: { label: 'SRAG console', radius: 0.36 },
};

const QUIZ_TIME = 12;
const QUIZ_COOLDOWN = 35;
const FREEZE_TIME = 15;
const CAL_TIME = 20;
const SIM_TIME = 16;
const BOTHER_LIMIT = 3; // talks to Ryan within 40 s before the physics lesson

// What getting caught costs, per boss.
const CATCH_RULES = {
  eddie: { sanity: 25, time: 0, lock: 2.2, lockText: 'Filling out another Weekly Report, in triplicate...' },
  clifton: { sanity: 15, time: 20, lock: 1.6, lockText: 'Explaining what it is you do here...' },
  default: { sanity: 25, time: 0, lock: 1.8, lockText: 'Stuck in a meeting...' },
};

const DEFAULT_BOSS_LINES = {
  spot: ['Hey! You there!'], hear: ['Hm? Who is that?'], lost: ['Never mind.'],
  catch: ['Got a minute?'], stunned: ['Oh, a memo.'],
  review: ['Let me take a look...'], approve: ['Fine. Approved.'],
};

const DEFAULT_AMBIENT = {
  titles: ['Dose analyst', 'Health physicist', 'Space weather forecaster', 'Software engineer', 'Data analyst'],
  lines: ['Busy. Dose numbers are due today.', 'Have you seen the stapler?', 'Is it Friday yet?'],
};

const DECOR_RADIUS = { plant: 0.28, cooler: 0.25, printer: 0.34, trash: 0.2, console: 0.36 };
const FACING = { east: 0, south: Math.PI / 2, west: Math.PI, north: -Math.PI / 2 };

// Quiz entries from encounters.json; "answer" there is 1-based.
function readQuiz(list, who, warn) {
  if (!Array.isArray(list)) return [];
  return list.filter((q, i) => {
    const ok = q && typeof q.clue === 'string' && Array.isArray(q.choices) && q.choices.length >= 2
      && Number.isInteger(q.answer) && q.answer >= 1 && q.answer <= q.choices.length;
    if (!ok) warn(`encounters.json ${who} quiz #${i + 1}: needs a clue, 2+ choices and an answer number`);
    return ok;
  }).map((q) => ({ clue: q.clue, choices: q.choices.map(String), answer: q.answer - 1 }));
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// "🗣️ Nic: Ugh..." -> "Ugh..." (the dialog box already shows the name).
export function stripSpeaker(line) {
  return String(line).replace(/^\s*🗣️?\s*[^:]{1,24}:\s*/u, '');
}

// Sprite colours for the unnamed coworkers. Depends only on the index, so
// every round (and the texture builder) agrees on how each one looks.
export function ambientLook(i) {
  const r = mulberry32(9000 + i * 7);
  const pick = (a) => a[Math.floor(r() * a.length)];
  return {
    hair: pick(['#1f1a17', '#3b2a1e', '#5a3a22', '#7a5230', '#a0522d', '#c9a36b', '#8a8a8a', '#d8d8d8']),
    skin: pick(['#f0c8a0', '#e8b48c', '#d9a37c', '#c98e62', '#b98560', '#8d5a3b']),
    shirt: pick(['#4f7fb5', '#6d8f4e', '#c0504d', '#8e5aa8', '#d9a441', '#3d5a80', '#eef0f2', '#7a8a99', '#2e8b8b']),
    pants: pick(['#2d2f3a', '#353b48', '#3b3b3b', '#4a3f35']),
    long_hair: r() < 0.4, glasses: r() < 0.35, beard: r() < 0.15,
  };
}

export function createGame({ office, encounters, difficulty = 'analyst', seed = Date.now(), warn = () => {} }) {
  const diff = DIFFICULTY[difficulty] || DIFFICULTY.analyst;
  const rng = mulberry32(seed);
  const world = new World(office.map, warn);
  world.setZones(office.zones, warn);
  world.setPosters(office.posters, warn);

  const place = (at, label) => {
    let x = Array.isArray(at) ? Math.floor(Number(at[0])) : NaN;
    let y = Array.isArray(at) ? Math.floor(Number(at[1])) : NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !world.walkable(x, y)) {
      const near = world.nearestWalkable(Number.isFinite(x) ? x : 1, Number.isFinite(y) ? y : 1);
      warn(`${label}: ${JSON.stringify(at)} is not open floor; moved to [${near}]`);
      [x, y] = near;
    }
    return [x, y];
  };
  const center = ([x, y]) => ({ x: x + 0.5, y: y + 0.5 });

  const decor = (office.decor || []).map((d, i) => {
    const [x, y] = place(d.at, `office.json decor #${i} (${d.type})`);
    world.occupied[y * world.w + x] = 1;
    return { type: d.type, x: x + 0.5, y: y + 0.5, radius: DECOR_RADIUS[d.type] ?? 0.25 };
  });

  const stations = (office.stations || []).filter((s, i) => {
    if (!STATIONS[s.type]) warn(`office.json station #${i}: unknown type "${s.type}"`);
    return STATIONS[s.type];
  }).map((s, i) => {
    const [x, y] = place(s.at, `office.json station #${i} (${s.type})`);
    world.occupied[y * world.w + x] = 1;
    return { type: s.type, x: x + 0.5, y: y + 0.5, radius: STATIONS[s.type].radius, cooldown: 0 };
  });

  const named = (encounters.npc_encounters || []).map((n, i) => {
    const name = n.npc || `Coworker ${i + 1}`;
    const roams = Array.isArray(n.patrol) && n.patrol.length > 0;
    const drops = !!n.drop_in;
    const [x, y] = place(roams ? n.patrol[0] : drops ? n.drop_in.from : n.location, `encounters.json ${name}`);
    if (!roams && !drops) world.occupied[y * world.w + x] = 1;
    if (n.perk && !PERKS[n.perk]) warn(`encounters.json ${name}: unknown perk "${n.perk}"`);
    if (n.gives && !ITEMS[n.gives]) warn(`encounters.json ${name}: unknown item "${n.gives}" to give`);
    const quiz = readQuiz(n.quiz, name, warn);
    const perk = PERKS[n.perk] && (n.perk !== 'jeopardy' || quiz.length) ? n.perk : null;
    const npc = baseNpc(i, name, x, y, n.look);
    Object.assign(npc, {
      title: n.title || '',
      lines: Array.isArray(n.lines) && n.lines.length ? n.lines : ['...'],
      wants: n.wants && ITEMS[n.wants.item] ? n.wants : null,
      signLine: n.sign || "Sure, I'll sign off.",
      perk, perkLine: n.perk_line || '', quiz, quizIdx: quiz.length ? Math.floor(rng() * quiz.length) : 0,
      gives: ITEMS[n.gives] ? n.gives : null, giveLine: n.give_line || '', gave: false,
      blackHole: n.black_hole ? { radius: Number(n.black_hole.radius) || 3.2, lines: n.black_hole.lines || n.lines } : null,
      physics: n.physics ? { home: center(place(n.physics.home || n.patrol?.[0] || [x, y], `encounters.json ${name} home`)), lines: n.physics.lines || n.lines } : null,
      debrief: Array.isArray(n.debrief) && n.debrief.length ? n.debrief : null,
      dropIn: drops ? {
        from: { x: x + 0.5, y: y + 0.5 }, lines: n.drop_in.lines || n.lines, exit: n.drop_in.exit || 'Anyway, I won\'t keep you.',
        every: Array.isArray(n.drop_in.every) ? n.drop_in.every : [70, 110], timer: Number(n.drop_in.first) || 45,
      } : null,
      present: !drops,
      patrol: roams ? n.patrol.map((wp, j) => center(place(wp, `encounters.json ${name} patrol ${j}`))) : null,
      speed: Number(n.speed) || 1.4,
    });
    return npc;
  });

  const amb = { ...DEFAULT_AMBIENT, ...(encounters.ambient || {}) };
  const ambient = (office.coworkers || []).map((c, j) => {
    const at = Array.isArray(c) ? c : c.at;
    const [x, y] = place(at, `office.json coworker #${j}`);
    world.occupied[y * world.w + x] = 1;
    const idx = named.length + j;
    const npc = baseNpc(idx, 'Coworker', x, y, ambientLook(j));
    const lr = mulberry32(500 + j * 13);
    npc.ambient = true;
    npc.title = (!Array.isArray(c) && c.title) || amb.titles[Math.floor(lr() * amb.titles.length)];
    npc.lines = [0, 1].map(() => amb.lines[Math.floor(lr() * amb.lines.length)]);
    return npc;
  });
  const npcs = [...named, ...ambient];

  const items = (office.items || []).filter((it) => ITEMS[it.type]).map((it, i) => {
    const [x, y] = place(it.at, `office.json item #${i} (${it.type})`);
    return { type: it.type, x: x + 0.5, y: y + 0.5, taken: false, respawn: it.type === 'memos' ? 25 : 0, timer: 0 };
  });

  const start = place(office.player?.start ?? [1, 1], 'office.json player start');
  const facing = office.player?.facing;
  const player = {
    x: start[0] + 0.5, y: start[1] + 0.5,
    a: typeof facing === 'number' ? (facing * Math.PI) / 180 : FACING[facing] ?? 0,
    sanity: PLAYER.sanity, memos: PLAYER.startMemos, coffee: 0,
    stamina: PLAYER.stamina, winded: false, restTimer: 0,
    items: new Set(),
    lock: 0, lockMax: 0, lockText: '', lockKind: '', hurt: 0, throwAnim: 0, drinkAnim: 0,
    moving: false, running: false, bob: 0, stepAcc: 0,
  };

  const bossLines = encounters.bosses || {};
  const bosses = (office.bosses || []).map((b, i) => {
    const id = String(b.id || `boss${i}`).toLowerCase();
    const [x, y] = place(b.start, `office.json boss ${id} start`);
    let patrol = (b.patrol || []).map((wp, j) => place(wp, `office.json boss ${id} waypoint ${j}`));
    if (!patrol.length) patrol = [[x, y]];
    return {
      id, name: b.name || id, x: x + 0.5, y: y + 0.5, a: 0, turnTo: 0,
      patrol: patrol.map(center), patrolIdx: 0,
      state: 'patrol', path: null, pathKey: '', repath: 0, pathFailed: false,
      alert: 0, sees: false, lost: 0, lastSeen: null, target: null, searchTime: 0,
      stun: 0, stunKind: '', satisfied: 0, pause: 0, barkCd: 0, flash: 0, moving: false, walkPhase: 0,
      reviewing: 0, reviewList: [],
      lines: { ...DEFAULT_BOSS_LINES, ...(bossLines[id] || {}) },
    };
  });

  const reports = buildReports(encounters.reports, npcs, bosses, warn);
  for (const r of reports) {
    if (r.task && TASKS[r.task.type].station && !stations.some((s) => s.type === TASKS[r.task.type].station)) {
      warn(`office.json: the ${r.name} needs a "${TASKS[r.task.type].station}" station, and there isn't one`);
    }
  }

  const g = {
    world, diff, difficulty: DIFFICULTY[difficulty] ? difficulty : 'analyst', rng,
    t: 0, timeLeft: diff.time, status: 'playing', result: null,
    player, npcs, bosses, items, decor, stations, projectiles: [],
    toasts: [], dialog: null, prompt: null, target: null, events: [],
    flare: { state: 'idle', timer: 40 + rng() * 15 },
    intensity: 0.3, chase: 0, gravity: 0, crewDose: CREW.start, crewRate: 0,
    puns: Array.isArray(encounters.puns) ? encounters.puns : [], punTimer: 15,
    explored: new Uint8Array(world.w * world.h),
    reports, allReady: false, stampFlash: null,
    review: { timer: 45 + rng() * 15, left: diff.reviews },
    perks: { flareWatch: false, fastReviews: false, shield: false, remote: false, priority: false },
    quiz: null, mini: null, chat: null,
    stats: {
      catches: 0, memosThrown: 0, memosHit: 0, coffees: 0, distance: 0,
      stamps: 0, reviews: 0, perks: 0, quizRight: 0, quizWrong: 0, tasks: 0, trapped: 0,
    },
    noMemoNagged: 0, mapName: office.name || '',
  };
  markExplored(g, 2.5);
  toast(g, `DEADLINE: the Flight Director needs your dose assessment in ${formatClock(g.timeLeft)}.`, 'warn', 7);
  toast(g, `Finish your ${reports.length} reports and submit them at the SRAG console (south side, console room) to protect the crew.`, 'info', 9);
  return g;
}

function baseNpc(index, name, x, y, look) {
  return {
    index, name, title: '', x: x + 0.5, y: y + 0.5, radius: 0.3, look: look || {},
    lines: ['...'], wants: null, signLine: '', signed: false, met: false, talkCount: 0, report: null,
    perk: null, perkLine: '', perkUsed: false, cooldown: 0, quiz: [], quizIdx: 0,
    gives: null, giveLine: '', gave: false, ambient: false,
    blackHole: null, physics: null, debrief: null, dropIn: null, present: true,
    patrol: null, patrolIdx: 0, speed: 1.4, path: null, pathKey: '', repath: 0, pathFailed: false,
    a: Math.PI / 2, turnTo: Math.PI / 2, moving: false, walkPhase: 0, pause: 0,
    chatCd: 0, bother: [], seeking: false, seekTime: 0, leaving: false,
  };
}

// Reports come from encounters.json: each can need a task, a coworker's
// sign-off and approval stamps from management (boss ids).
function buildReports(list, npcs, bosses, warn) {
  const bossIds = new Set(bosses.map((b) => b.id));
  const src = Array.isArray(list) && list.length ? list : npcs.filter((n) => !n.ambient).map((n) => ({ name: `${n.name}'s report`, signoff: n.name }));
  return src.map((r, i) => {
    const name = r.name || `Report ${i + 1}`;
    let signoff = null;
    if (r.signoff) {
      signoff = npcs.find((n) => n.name === r.signoff) || null;
      if (!signoff) warn(`encounters.json report "${name}": no coworker named "${r.signoff}"; dropping that sign-off`);
      else if (signoff.report) { warn(`encounters.json report "${name}": ${signoff.name} already signs "${signoff.report.name}"`); signoff = null; }
    }
    const stamps = new Set();
    for (const id of r.stamps || []) {
      const key = String(id).toLowerCase();
      if (bossIds.has(key)) stamps.add(key);
      else warn(`encounters.json report "${name}": no manager with id "${id}"`);
    }
    if (r.task && !TASKS[r.task]) warn(`encounters.json report "${name}": unknown task "${r.task}"`);
    const task = TASKS[r.task] ? { type: r.task, done: false, progress: 0, running: false } : null;
    const report = { id: r.id || `report${i}`, name, signoff, stamps, stamped: new Set(), task, done: false };
    if (signoff) signoff.report = report;
    return report;
  });
}

export const reportReady = (r) => (!r.task || r.task.done) && (!r.signoff || r.signoff.signed) && [...r.stamps].every((id) => r.stamped.has(id));
export const readyCount = (g) => g.reports.filter(reportReady).length;
export const pendingStamps = (g, bossId) => g.reports.filter((r) => r.stamps.has(bossId) && !r.stamped.has(bossId));
export const taskReport = (g, type) => g.reports.find((r) => r.task && r.task.type === type);

export function joinNames(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// Announces reports that just became ready, and the moment all of them are.
function checkReports(g) {
  for (const r of g.reports) {
    if (r.done || !reportReady(r)) continue;
    r.done = true;
    toast(g, `${r.name} is ready (${readyCount(g)}/${g.reports.length})`, 'good', 5);
  }
  const all = readyCount(g) === g.reports.length;
  if (all && !g.allReady) toast(g, 'Every report is ready! Submit them at the SRAG console in the console room (south side).', 'good', 8);
  g.allReady = all;
}

export function formatClock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function toast(g, text, kind = 'info', ttl = 5) {
  const existing = g.toasts.find((t) => t.text === text);
  if (existing) { existing.ttl = ttl; return; }
  g.toasts.push({ text, kind, ttl, max: ttl });
  while (g.toasts.length > 4) g.toasts.shift();
}

function sfx(g, name, extra) {
  g.events.push({ type: 'sfx', name, ...extra });
}

export function hasItem(p, item) {
  if (item === 'coffee') return p.coffee > 0;
  if (item === 'memos') return p.memos > 0;
  return p.items.has(item);
}

function takeItem(p, item) {
  if (item === 'coffee') p.coffee--;
  else if (item === 'memos') p.memos--;
  else p.items.delete(item);
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------------------------------------------------------- update --

export function updateGame(g, input, dt) {
  if (g.status !== 'playing') return;
  const p = g.player;
  g.t += dt;
  g.timeLeft -= dt;

  for (const t of g.toasts) t.ttl -= dt;
  g.toasts = g.toasts.filter((t) => t.ttl > 0);
  if (g.stampFlash && (g.stampFlash.ttl -= dt) <= 0) g.stampFlash = null;
  if (g.dialog) {
    g.dialog.ttl -= dt;
    const n = g.dialog.npc;
    if (g.dialog.ttl <= 0 || (n && (!n.present || dist(n, p) > 2.6))) g.dialog = null;
  }

  p.a += (input.turn || 0) * PLAYER.turnRate * dt + (input.look || 0);
  p.a = ((p.a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  p.hurt = Math.max(0, p.hurt - dt);
  p.throwAnim = Math.max(0, p.throwAnim - dt);
  p.drinkAnim = Math.max(0, p.drinkAnim - dt);
  for (const n of g.npcs) {
    if (n.cooldown > 0) n.cooldown -= dt;
    if (n.chatCd > 0) n.chatCd -= dt;
  }
  for (const s of g.stations) if (s.cooldown > 0) s.cooldown -= dt;

  if (p.lock > 0) {
    p.lock -= dt;
    p.moving = p.running = false;
    g.target = null;
    if (g.quiz) {
      if (input.answer) answerQuiz(g, input.answer - 1);
      else if (p.lock <= 0) answerQuiz(g, -1); // time's up
    } else if (g.mini) {
      updateMini(g, input, dt);
    } else if (g.chat) {
      updateChat(g, input, dt);
    }
  } else {
    movePlayer(g, input, dt);
    g.target = findTarget(g);
    if (input.interact) interact(g);
    if (input.throw) throwMemo(g);
    if (input.drink) drink(g);
    if (p.lock <= 0) checkTraps(g);
  }
  g.prompt = p.lock > 0 ? null : promptFor(g, g.target);

  updateItems(g, dt);
  updateProjectiles(g, dt);
  updateCoworkers(g, dt);
  updateStations(g, dt);
  g.chase = 0;
  for (const b of g.bosses) {
    updateBoss(g, b, dt);
    g.chase = Math.max(g.chase, b.state === 'chase' ? 1 : b.alert * 0.6);
  }
  // Sanity slowly recovers while nobody is after you.
  if (g.chase < 0.5 && p.lock <= 0) p.sanity = Math.min(PLAYER.sanity, p.sanity + 0.4 * dt);
  updateCrew(g, dt);
  updateReviews(g, dt);
  updateAmbient(g, dt);
  markExplored(g, 1.6);

  if (g.status === 'playing') {
    if (p.sanity <= 0) endGame(g, false, 'sanity');
    else if (g.timeLeft <= 0) endGame(g, false, 'time');
  }
}

// People who walk around (the astronaut, Ryan, Neil) don't block you:
// otherwise you and they can deadlock in a doorway, each waiting politely.
function solids(g) {
  return [...g.npcs.filter((n) => n.present && !n.patrol && !n.dropIn), ...g.decor, ...g.stations];
}

function movePlayer(g, input, dt) {
  const p = g.player, w = g.world;
  const fwd = clamp(input.forward || 0, -1, 1), str = clamp(input.strafe || 0, -1, 1);
  let mx = Math.cos(p.a) * fwd - Math.sin(p.a) * str;
  let my = Math.sin(p.a) * fwd + Math.cos(p.a) * str;
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; }
  // Sprinting burns stamina; once it hits zero you're winded until it
  // recovers to 35%, so you can't simply outrun a chase forever.
  const wantsRun = !!input.run && (fwd !== 0 || str !== 0) && !p.winded && p.stamina > 0;
  const speed = wantsRun ? PLAYER.run : PLAYER.walk;
  if (wantsRun) {
    p.stamina = Math.max(0, p.stamina - PLAYER.staminaDrain * dt);
    p.restTimer = 0.6;
    if (p.stamina <= 0) p.winded = true;
  } else {
    p.restTimer -= dt;
    if (p.restTimer <= 0) p.stamina = Math.min(PLAYER.stamina, p.stamina + PLAYER.staminaRegen * dt);
    if (p.winded && p.stamina >= PLAYER.stamina * 0.35) p.winded = false;
  }
  // Kevin's gravity well drags you toward him.
  let px = 0, py = 0;
  g.gravity = 0;
  for (const n of g.npcs) {
    if (!n.blackHole || !n.present || n.chatCd > 0) continue;
    const dx = n.x - p.x, dy = n.y - p.y, d = Math.hypot(dx, dy);
    if (d >= n.blackHole.radius || d < 0.3) continue;
    const pull = 1.4 * (1 - d / n.blackHole.radius);
    g.gravity = Math.max(g.gravity, pull / 1.4);
    px += (dx / d) * pull * dt;
    py += (dy / d) * pull * dt;
  }
  const ox = p.x, oy = p.y;
  let pos = w.moveCircle(p.x, p.y, mx * speed * dt + px, my * speed * dt + py, PLAYER.radius);
  for (const s of solids(g)) {
    const dx = pos.x - s.x, dy = pos.y - s.y, d = Math.hypot(dx, dy), min = s.radius + PLAYER.radius;
    if (d < min && d > 1e-6) pos = w.moveCircle(pos.x, pos.y, (dx / d) * (min - d), (dy / d) * (min - d), PLAYER.radius);
  }
  p.x = pos.x; p.y = pos.y;
  const moved = Math.hypot(p.x - ox, p.y - oy);
  p.moving = moved > speed * dt * 0.2;
  p.running = p.moving && wantsRun;
  p.bob += moved * 7;
  g.stats.distance += moved;
  p.stepAcc += moved;
  const stride = p.running ? 0.85 : 0.65;
  if (p.stepAcc >= stride) {
    p.stepAcc -= stride;
    sfx(g, 'step', { run: p.running });
    if (p.running) makeNoise(g, p.x, p.y, 3.5);
  }
}

function facing(p, o, maxD) {
  const dx = o.x - p.x, dy = o.y - p.y, d = Math.hypot(dx, dy);
  return d < maxD && Math.abs(angleDiff(Math.atan2(dy, dx), p.a)) < 0.8 ? d : Infinity;
}

function findTarget(g) {
  const p = g.player, w = g.world;
  let best = null, bestD = 1.7;
  for (const n of g.npcs) {
    if (!n.present) continue;
    const d = facing(p, n, bestD);
    if (d < bestD && canReach(w, p, n)) { best = { kind: 'npc', npc: n }; bestD = d; }
  }
  for (const s of g.stations) {
    const d = facing(p, s, Math.min(bestD, 1.6));
    if (d < bestD && canReach(w, p, s)) { best = { kind: 'station', station: s }; bestD = d; }
  }
  for (const b of g.bosses) {
    if (b.stun > 0 || b.reviewing > 0 || !pendingStamps(g, b.id).length) continue;
    const d = facing(p, b, bestD);
    if (d < bestD && canReach(w, p, b)) { best = { kind: 'boss', boss: b }; bestD = d; }
  }
  return best;
}

// Straight line, or around one corner, so you can talk to someone in a
// cubicle while standing diagonally at its opening.
function canReach(w, p, n) {
  return w.clearLine(p.x, p.y, n.x, n.y)
    || (w.clearLine(p.x, p.y, n.x, p.y) && w.clearLine(n.x, p.y, n.x, n.y))
    || (w.clearLine(p.x, p.y, p.x, n.y) && w.clearLine(p.x, n.y, n.x, n.y));
}

function stationPrompt(g, s) {
  const p = g.player;
  if (s.type === 'srag_console') {
    const n = readyCount(g);
    return n >= g.reports.length ? 'E: Submit the reports to the Flight Director' : `E: SRAG console (${n}/${g.reports.length} reports ready)`;
  }
  const r = g.reports.find((rep) => rep.task && TASKS[rep.task.type].station === s.type);
  if (!r) return `E: Use the ${STATIONS[s.type].label}`;
  const t = r.task;
  if (t.done) return `${STATIONS[s.type].label}: done for the ${r.name}`;
  if (s.type === 'detector_bench') return `E: Calibrate the detector (${r.name})`;
  if (s.type === 'vehicle_sim') return t.running ? `Vehicle dose run: ${Math.floor(t.progress * 100)}%` : `E: Start the vehicle dose run (${r.name})`;
  if (s.type === 'dose_calc') {
    return hasItem(p, 'dosimetry') ? `E: Calculate medical doses (${r.name})` : "Medical dose workstation: needs the crew's dosimetry readings";
  }
  return `E: Use the ${STATIONS[s.type].label}`;
}

function promptFor(g, target) {
  if (!target) return null;
  if (target.kind === 'station') return stationPrompt(g, target.station);
  if (target.kind === 'boss') {
    const list = pendingStamps(g, target.boss.id);
    if (!list.length) return null;
    return `E: Ask ${target.boss.name} to approve the ${list[0].name}${list.length > 1 ? ` (+${list.length - 1} more)` : ''}`;
  }
  const n = target.npc;
  const label = n.title ? `${n.name} (${n.title})` : n.name;
  const signing = n.report && !n.signed;
  if (!signing && n.perk === 'jeopardy' && n.cooldown <= 0) return `E: Play Jeopardy with ${n.name}`;
  if (n.debrief && taskPending(g, 'astronaut')) return `E: Debrief the ${n.name.toLowerCase()}`;
  const wantsSomething = signing || (n.perk && !n.perkUsed && n.perk !== 'jeopardy') || (n.gives && !n.gave);
  if (wantsSomething && n.wants && hasItem(g.player, n.wants.item)) return `E: Give ${ITEMS[n.wants.item].name} to ${n.name}`;
  return `E: Talk to ${label}`;
}

const taskPending = (g, type) => { const r = taskReport(g, type); return !!(r && !r.task.done); };

function interact(g) {
  const target = g.target;
  if (!target) return;
  if (target.kind === 'station') useStation(g, target.station);
  else if (target.kind === 'boss') requestApproval(g, target.boss);
  else talk(g, target.npc);
}

function talk(g, n) {
  const p = g.player;
  // Kevin always has a story first.
  if (n.blackHole && n.chatCd <= 0) {
    trapInChat(g, n, 'blackhole', () => talk(g, n));
    return;
  }
  // Ryan helps, but bother him too often and it turns into a physics lesson.
  if (n.physics) {
    n.bother = n.bother.filter((t) => g.t - t < 40);
    n.bother.push(g.t);
    if (n.bother.length >= BOTHER_LIMIT && n.chatCd <= 0) {
      toast(g, `You've bothered ${n.name} once too often. Now he has a physics problem for you.`, 'npc', 4);
      trapInChat(g, n, 'physics');
      return;
    }
  }
  const out = [stripSpeaker(n.lines[n.talkCount % n.lines.length])];
  n.talkCount++;
  n.met = true;
  if (n.dropIn) {
    trapInChat(g, n, 'dropin');
    return;
  }
  if (n.debrief) {
    const r = taskReport(g, 'astronaut');
    if (r && !r.task.done) {
      startChat(g, n, {
        kind: 'debrief', lines: n.debrief, duration: 4.5, escape: false,
        onDone: () => {
          completeTask(g, r, 'Astronaut debriefed. You have everything you need for the risk assessment.');
          g.dialog = { name: n.name, title: n.title, lines: ['Great talk. I mean, I did most of the talking. As usual.'], ttl: 6, npc: n };
        },
      });
      return;
    }
  }
  if (!n.signed && n.report) {
    const want = n.wants;
    if (want && !hasItem(p, want.item)) {
      out.push(want.ask || `Bring me ${ITEMS[want.item].name} and I'll sign off.`);
      sfx(g, 'talk');
    } else {
      if (want) takeItem(p, want.item);
      n.signed = true;
      out.push(want ? want.thanks || 'Thanks! Signed.' : n.signLine);
      sfx(g, 'sign');
      toast(g, `${n.name} signed off on the ${n.report.name}`, 'good', 4);
      checkReports(g);
    }
  } else if (n.gives && !n.gave) {
    const want = n.wants;
    if (want && !hasItem(p, want.item)) {
      out.push(want.ask || `Bring me ${ITEMS[want.item].name} first.`);
      sfx(g, 'talk');
    } else {
      if (want) takeItem(p, want.item);
      n.gave = true;
      p.items.add(n.gives);
      out.push(n.giveLine || `Here: ${ITEMS[n.gives].name}.`);
      toast(g, `${n.name} gave you ${ITEMS[n.gives].name}.`, 'item', 4);
      sfx(g, 'pickup');
    }
  } else if (n.perk === 'jeopardy') {
    if (n.cooldown <= 0) { startQuiz(g, n); return; }
    out.push("Give me a minute, I'm writing new clues.");
    sfx(g, 'talk');
  } else if (n.perk && !n.perkUsed) {
    const want = n.wants;
    if (want && !hasItem(p, want.item)) {
      out.push(want.ask || `Bring me ${ITEMS[want.item].name} and I'll help you out.`);
      sfx(g, 'talk');
    } else {
      if (want) takeItem(p, want.item);
      n.perkUsed = true;
      out.push((want && want.thanks) || n.perkLine || 'Happy to help.');
      grantPerk(g, n);
    }
  } else {
    sfx(g, 'talk');
  }
  if (n.physics && n.bother.length === BOTHER_LIMIT - 1) out.push("Anything else? Because I've got this physics problem...");
  g.dialog = { name: n.name, title: n.title, lines: out, ttl: 9, npc: n };
}

function grantPerk(g, n) {
  const p = g.player;
  g.stats.perks++;
  sfx(g, 'pickup');
  if (n.perk === 'freeze_managers') {
    for (const b of g.bosses) {
      if (b.reviewing > 0) continue;
      b.stun = FREEZE_TIME;
      b.stunKind = 'update';
      b.alert = 0;
    }
    toast(g, `Management laptops are installing updates: ${joinNames(g.bosses.map((b) => b.name))} are frozen for ${FREEZE_TIME} seconds.`, 'good', 6);
  } else if (n.perk === 'flare_watch') {
    g.perks.flareWatch = true;
    toast(g, 'Flare watch on: early warnings, and the crew shelters sooner during flares.', 'good', 5);
  } else if (n.perk === 'fast_reviews') {
    g.perks.fastReviews = true;
    toast(g, 'Your reports are pivot-tabled: management reviews now take half as long.', 'good', 5);
  } else if (n.perk === 'people_person') {
    g.perks.shield = true;
    toast(g, `${n.name} has your back: the next time you get caught, he'll talk them down.`, 'good', 5);
  } else if (n.perk === 'remote_access') {
    g.perks.remote = true;
    toast(g, 'Remote access: the vehicle dose run keeps going while you walk around.', 'good', 5);
  } else if (n.perk === 'sim_priority') {
    g.perks.priority = true;
    toast(g, 'Priority queue: the vehicle dose run goes twice as fast.', 'good', 5);
  } else if (n.perk === 'gcr_model') {
    const r = taskReport(g, 'vehicle');
    if (r && !r.task.done) {
      r.task.progress = Math.min(1, r.task.progress + 0.5);
      toast(g, `${n.name} handed over his cosmic ray transport run: vehicle dose assessment +50%.`, 'good', 5);
      if (r.task.progress >= 1) completeTask(g, r, 'Vehicle dose assessment complete.');
    } else {
      toast(g, `${n.name} shows you his transport plots anyway. All of them.`, 'info', 4);
    }
  }
  p.drinkAnim = 0;
}

// ------------------------------------------------------------- stations --

function useStation(g, s) {
  const p = g.player;
  if (s.type === 'srag_console') {
    const missing = g.reports.length - readyCount(g);
    if (missing <= 0) endGame(g, true, 'submitted');
    else {
      toast(g, `SRAG console: ${missing} report${missing === 1 ? '' : 's'} still need${missing === 1 ? 's' : ''} work. The Flight Director is waiting.`, 'warn', 5);
      sfx(g, 'deny');
    }
    return;
  }
  const r = g.reports.find((rep) => rep.task && !rep.task.done && TASKS[rep.task.type].station === s.type);
  if (!r) { toast(g, `Nothing left to do at the ${STATIONS[s.type].label}.`, 'info', 3); return; }
  if (s.type === 'detector_bench') {
    startCalibration(g, r);
  } else if (s.type === 'vehicle_sim') {
    if (!r.task.running) {
      r.task.running = true;
      toast(g, g.perks.remote
        ? 'Vehicle dose run started. Remote access is on, so it keeps going wherever you are.'
        : 'Vehicle dose run started. Stay near the console until it finishes.', 'info', 5);
      sfx(g, 'review');
    } else {
      toast(g, `Vehicle dose run: ${Math.floor(r.task.progress * 100)}% done.`, 'info', 3);
    }
  } else if (s.type === 'dose_calc') {
    if (!hasItem(p, 'dosimetry')) {
      const giver = g.npcs.find((n) => n.gives === 'dosimetry');
      toast(g, `You need the crew's dosimetry readings first.${giver ? ` ${giver.name} has them.` : ''}`, 'warn', 4);
      sfx(g, 'deny');
    } else if (s.cooldown > 0) {
      toast(g, 'The workstation is still recalculating. Give it a moment.', 'info', 2);
    } else {
      startDoseCalc(g, r, s);
    }
  }
}

function completeTask(g, r, text) {
  if (r.task.done) return;
  r.task.done = true;
  r.task.running = false;
  r.task.progress = 1;
  g.stats.tasks++;
  toast(g, text || `${TASKS[r.task.type].label}: done.`, 'good', 5);
  sfx(g, 'sign');
  checkReports(g);
}

function updateStations(g, dt) {
  const p = g.player;
  for (const r of g.reports) {
    const t = r.task;
    if (!t || t.done || !t.running || t.type !== 'vehicle') continue;
    const near = g.perks.remote || g.stations.some((s) => s.type === 'vehicle_sim' && dist(s, p) < 1.8);
    if (!near) continue;
    t.progress += (dt / SIM_TIME) * (g.perks.priority ? 2 : 1);
    if (t.progress >= 1) completeTask(g, r, 'Vehicle dose assessment complete: dose maps for every crew location.');
  }
}

// Detector calibration: a needle sweeps the gauge; press E while it's in the
// green band. Three hits calibrates it; three misses (or the timer) fails.
function newZone(g, w) {
  const a = 0.08 + g.rng() * (0.84 - w);
  return [a, a + w];
}

export const needlePos = (m) => 0.5 + 0.5 * Math.sin(m.phase);

function startCalibration(g, r) {
  const p = g.player;
  g.mini = { kind: 'calibrate', report: r, hits: 0, need: 3, misses: 0, phase: g.rng() * 6, speed: 2.4, zone: newZone(g, 0.22), flash: 0, result: '' };
  p.lock = p.lockMax = CAL_TIME;
  p.lockKind = 'mini';
  g.dialog = null;
  sfx(g, 'review');
}

function updateMini(g, input, dt) {
  const m = g.mini, p = g.player;
  m.phase += m.speed * dt;
  m.flash = Math.max(0, m.flash - dt);
  if (input.interact) {
    const v = needlePos(m);
    if (v >= m.zone[0] && v <= m.zone[1]) {
      m.hits++;
      m.speed += 0.6;
      m.flash = 0.3;
      m.result = 'hit';
      sfx(g, 'pickup');
      if (m.hits >= m.need) { endMini(g, true); return; }
      m.zone = newZone(g, Math.max(0.12, 0.22 - m.hits * 0.04));
    } else {
      m.misses++;
      m.flash = 0.3;
      m.result = 'miss';
      sfx(g, 'deny');
      if (m.misses >= 3) { endMini(g, false); return; }
    }
  }
  if (p.lock <= 0) endMini(g, false);
}

function endMini(g, ok) {
  const m = g.mini, p = g.player;
  g.mini = null;
  p.lock = 0;
  p.lockKind = '';
  if (ok) completeTask(g, m.report, 'Detector calibrated: its counts match the reference source.');
  else { toast(g, 'The detector drifted out of calibration. Try again.', 'warn', 4); sfx(g, 'deny'); }
}

// Medical dose arithmetic with fresh numbers every time, so the answers are
// always right by construction.
function doseQuestion(g) {
  const pick = (a) => a[Math.floor(g.rng() * a.length)];
  const kind = Math.floor(g.rng() * 4);
  let clue, ans;
  if (kind === 0) {
    const r = pick([0.3, 0.4, 0.5, 0.6]), d = pick([10, 20, 30, 60]);
    clue = `On the ISS the crew gets ${r} mSv per day. Total dose for a ${d}-day stay?`;
    ans = r * d;
  } else if (kind === 1) {
    const a = pick([6, 7, 8, 10]), n = pick([2, 3]);
    clue = `Medical imaging: ${n} CT scans at ${a} mSv each, plus a 0.1 mSv chest X-ray. Total?`;
    ans = n * a + 0.1;
  } else if (kind === 2) {
    const f = pick([2, 3, 4, 5]), h = pick([2, 4, 6]);
    clue = `During the solar particle event an unsheltered crew member gets ${f} mSv per hour. Total for ${h} hours?`;
    ans = f * h;
  } else {
    const d = pick([20, 30, 40, 60]), pc = pick([50, 75]);
    clue = `Sheltering cuts a ${d} mSv dose by ${pc}%. Dose with the shelter?`;
    ans = d * (1 - pc / 100);
  }
  const fmt = (v) => `${Math.round(v * 10) / 10} mSv`;
  const wrong = [...new Set([ans * 2, ans / 2, ans * 1.5, ans + 10].map(fmt))].filter((s) => s !== fmt(ans));
  const choices = [fmt(ans), wrong[0], wrong[1]];
  for (let i = choices.length - 1; i > 0; i--) {
    const j = Math.floor(g.rng() * (i + 1));
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  return { clue, choices, answer: choices.indexOf(fmt(ans)) };
}

function startDoseCalc(g, r, s) {
  const p = g.player;
  const questions = [doseQuestion(g), doseQuestion(g)];
  g.quiz = { kind: 'dosecalc', report: r, station: s, questions, step: 0, ...questions[0] };
  p.lock = p.lockMax = QUIZ_TIME + 6;
  p.lockKind = 'quiz';
  g.dialog = null;
  sfx(g, 'review');
}

// Amir's Jeopardy: one clue, three responses, keys 1-3, against the clock.
function startQuiz(g, n) {
  const q = n.quiz[n.quizIdx % n.quiz.length];
  n.quizIdx++;
  const p = g.player;
  g.quiz = { kind: 'jeopardy', npc: n, clue: q.clue, choices: q.choices, answer: q.answer };
  p.lock = p.lockMax = QUIZ_TIME;
  p.lockKind = 'quiz';
  p.lockText = '';
  g.dialog = null;
  sfx(g, 'review');
}

function answerQuiz(g, idx) {
  const q = g.quiz, p = g.player;
  if (q.kind === 'dosecalc') {
    if (idx === q.answer) {
      q.step++;
      if (q.step < q.questions.length) {
        Object.assign(q, q.questions[q.step]);
        p.lock = p.lockMax = QUIZ_TIME + 6;
        sfx(g, 'pickup');
        return;
      }
      g.quiz = null;
      p.lock = 0;
      p.lockKind = '';
      completeTask(g, q.report, 'Medical doses calculated and double-checked.');
      return;
    }
    g.quiz = null;
    p.lock = 0;
    p.lockKind = '';
    q.station.cooldown = 4;
    g.stats.quizWrong++;
    toast(g, idx < 0 ? 'Out of time. The numbers will still be there in a moment.' : `Recheck that one: the answer was ${q.choices[q.answer]}. Try again.`, 'warn', 5);
    sfx(g, 'deny');
    return;
  }
  const n = q.npc;
  g.quiz = null;
  p.lock = 0;
  p.lockKind = '';
  n.cooldown = QUIZ_COOLDOWN;
  let lines;
  if (idx === q.answer) {
    p.sanity = Math.min(PLAYER.sanity, p.sanity + 20);
    g.stats.quizRight++;
    lines = [`"${q.choices[q.answer]}" Correct! You're on fire.`];
    toast(g, `${n.name}: Correct! +20 sanity`, 'good', 4);
    sfx(g, 'sign');
  } else {
    p.sanity -= 5;
    g.stats.quizWrong++;
    lines = [idx < 0 ? "Time's up!" : 'Ooh, sorry.', `The correct response was "${q.choices[q.answer]}"`];
    toast(g, `${n.name}: ${idx < 0 ? "Time's up" : 'Ooh, sorry'}. -5 sanity`, 'warn', 4);
    sfx(g, 'deny');
  }
  g.dialog = { name: n.name, title: n.title, lines, ttl: 6, npc: n };
}

// ----------------------------------------------------------- chat traps --
// Some coworkers hold you in a conversation. While one is talking you can't
// move; press E to try to excuse yourself (each press shortens it). Managers
// can still catch you while you're stuck.

function startChat(g, n, { kind, lines, duration, escape = true, escort = null, onDone = null }) {
  const p = g.player;
  g.chat = { npc: n, kind, lines: lines.map(stripSpeaker), lineIdx: 0, lineTimer: 2.2, escape, escort, onDone, excuses: 0 };
  p.lock = p.lockMax = duration;
  p.lockKind = 'chat';
  g.dialog = null;
  n.met = true;
  sfx(g, 'talk');
}

function trapInChat(g, n, kind, after) {
  g.stats.trapped++;
  if (kind === 'blackhole') {
    n.chatCd = 30;
    startChat(g, n, {
      kind, lines: shuffled(g, n.blackHole.lines), duration: 5.5,
      onDone: () => {
        toast(g, `You escaped ${n.name}'s gravity well.`, 'info', 3);
        if (after) after();
      },
    });
  } else if (kind === 'physics') {
    n.chatCd = 40;
    n.bother = [];
    startChat(g, n, {
      kind, lines: shuffled(g, n.physics.lines), duration: 7, escort: n.physics.home,
      onDone: () => toast(g, `You finally got away from ${n.name}'s whiteboard.`, 'info', 3),
    });
  } else if (kind === 'dropin') {
    const di = n.dropIn;
    n.seeking = false;
    startChat(g, n, {
      kind, lines: shuffled(g, di.lines), duration: 4.5,
      onDone: () => {
        n.leaving = true;
        toast(g, `${n.name}: ${di.exit}`, 'info', 4);
      },
    });
  }
}

function shuffled(g, list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(g.rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function updateChat(g, input, dt) {
  const c = g.chat, p = g.player;
  c.lineTimer -= dt;
  if (c.lineTimer <= 0 && c.lines.length > 1) {
    c.lineIdx = (c.lineIdx + 1) % c.lines.length;
    c.lineTimer = 2.2;
  }
  if (c.escape && input.interact) {
    p.lock -= 0.8;
    c.excuses++;
    sfx(g, 'talk');
  }
  if (c.escort) escortStep(g, c, dt);
  else c.npc.turnTo = Math.atan2(p.y - c.npc.y, p.x - c.npc.x);
  if (p.lock <= 0) finishChat(g);
}

// Ryan walks you back to his whiteboard while he talks.
function escortStep(g, c, dt) {
  const n = c.npc, p = g.player;
  if (dist(n, c.escort) > 0.25) followPath(g, n, c.escort, 2.2, dt);
  const dx = n.x - p.x, dy = n.y - p.y, d = Math.hypot(dx, dy);
  if (d > 0.9) {
    const step = Math.min(d - 0.9, 2.6 * dt);
    const pos = g.world.moveCircle(p.x, p.y, (dx / d) * step, (dy / d) * step, PLAYER.radius);
    p.x = pos.x;
    p.y = pos.y;
    p.bob += step * 7;
  }
  p.a = Math.atan2(dy, dx);
}

function finishChat(g) {
  const c = g.chat, p = g.player;
  g.chat = null;
  p.lock = 0;
  p.lockKind = '';
  if (c && c.onDone) c.onDone();
}

// Walking too close to Kevin, or letting Neil catch up with you.
function checkTraps(g) {
  const p = g.player;
  for (const n of g.npcs) {
    if (!n.present || n.chatCd > 0) continue;
    const d = dist(n, p);
    if (n.blackHole && d < 1.25 && canReach(g.world, p, n)) { trapInChat(g, n, 'blackhole'); return; }
    if (n.dropIn && n.seeking && d < 1.2) { trapInChat(g, n, 'dropin'); return; }
  }
}

// ------------------------------------------------- moving coworkers --
// The visiting astronaut and Ryan walk patrol loops; Neil drops in from the
// elevator.

function updateCoworkers(g, dt) {
  const p = g.player;
  for (const n of g.npcs) {
    if (!n.patrol && !n.dropIn) continue;
    n.moving = false;
    if (g.chat && g.chat.npc === n) { turnNpc(n, dt); continue; }
    if (n.dropIn) { updateDropIn(g, n, dt); turnNpc(n, dt); continue; }
    const d = dist(n, p);
    if (d < 1.4) {
      n.turnTo = Math.atan2(p.y - n.y, p.x - n.x); // politely stops to chat
    } else if (n.pause > 0) {
      n.pause -= dt;
    } else {
      const wp = n.patrol[n.patrolIdx];
      if (dist(n, wp) < 0.2) {
        n.patrolIdx = (n.patrolIdx + 1) % n.patrol.length;
        n.path = null;
        n.pause = 1 + g.rng() * 1.5;
      } else {
        followPath(g, n, wp, n.speed, dt);
      }
    }
    turnNpc(n, dt);
  }
}

function updateDropIn(g, n, dt) {
  const di = n.dropIn, p = g.player;
  if (!n.present) {
    di.timer -= dt;
    if (di.timer <= 0 && p.lock <= 0) {
      Object.assign(n, { present: true, x: di.from.x, y: di.from.y, seeking: true, seekTime: 30, leaving: false, path: null });
      toast(g, `${n.name} steps off the elevator, looking for someone to talk to.`, 'npc', 4);
      sfx(g, 'review');
    }
    return;
  }
  if (n.leaving) {
    if (dist(n, di.from) < 0.3) {
      n.present = false;
      n.leaving = false;
      di.timer = di.every[0] + g.rng() * (di.every[1] - di.every[0]);
      if (g.dialog && g.dialog.npc === n) g.dialog = null;
    } else {
      followPath(g, n, di.from, 1.8, dt);
    }
    return;
  }
  if (n.seeking) {
    n.seekTime -= dt;
    if (n.seekTime <= 0) {
      n.seeking = false;
      n.leaving = true;
      toast(g, `${n.name} wanders back to the elevator. Nobody ever finds out why he came.`, 'npc', 4);
    } else if (p.lock <= 0) {
      followPath(g, n, { x: p.x, y: p.y }, 2.1, dt);
    }
  }
}

function turnNpc(n, dt) {
  n.a += clamp(angleDiff(n.turnTo, n.a), -6 * dt, 6 * dt);
  n.a = ((n.a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
}

// ------------------------------------------------------------- items etc --

function throwMemo(g) {
  const p = g.player;
  if (p.memos <= 0) {
    if (g.t - g.noMemoNagged > 3) { toast(g, 'Out of memos. The printers have more.', 'info', 3); g.noMemoNagged = g.t; }
    sfx(g, 'deny');
    return;
  }
  p.memos--;
  p.throwAnim = 0.3;
  g.stats.memosThrown++;
  const cx = Math.cos(p.a), cy = Math.sin(p.a);
  g.projectiles.push({ x: p.x + cx * 0.15, y: p.y + cy * 0.15, vx: cx * 9, vy: cy * 9, life: 1.2, z: 0.42, dead: false });
  sfx(g, 'throw');
}

function drink(g) {
  const p = g.player;
  if (p.coffee <= 0) { toast(g, 'No coffee. The break room is in the central core, south side.', 'info', 3); sfx(g, 'deny'); return; }
  if (p.sanity >= PLAYER.sanity) { toast(g, "You're as sane as you're going to get. Save it.", 'info', 3); return; }
  p.coffee--;
  p.sanity = Math.min(PLAYER.sanity, p.sanity + 35);
  p.drinkAnim = 0.8;
  g.stats.coffees++;
  sfx(g, 'drink');
}

function updateItems(g, dt) {
  const p = g.player;
  for (const it of g.items) {
    if (it.taken) {
      if (it.respawn > 0) {
        it.timer -= dt;
        if (it.timer <= 0) it.taken = false;
      }
      continue;
    }
    if (Math.hypot(it.x - p.x, it.y - p.y) > 0.5 || p.lock > 0) continue;
    if (it.type === 'coffee') {
      if (p.coffee >= PLAYER.maxCoffee) continue;
      p.coffee++;
    } else if (it.type === 'memos') {
      if (p.memos >= PLAYER.maxMemos) continue;
      p.memos = Math.min(PLAYER.maxMemos, p.memos + PLAYER.memoPack);
    } else {
      p.items.add(it.type);
    }
    it.taken = true;
    it.timer = it.respawn;
    toast(g, ITEMS[it.type].pickup, 'item', 4);
    sfx(g, 'pickup');
  }
}

function updateProjectiles(g, dt) {
  const w = g.world;
  for (const pr of g.projectiles) {
    const steps = 4;
    for (let s = 0; s < steps && !pr.dead; s++) {
      pr.x += (pr.vx * dt) / steps;
      pr.y += (pr.vy * dt) / steps;
      if (w.isWallAt(pr.x, pr.y)) { landMemo(g, pr, pr.x - (pr.vx * dt) / steps, pr.y - (pr.vy * dt) / steps); break; }
      for (const b of g.bosses) {
        if (b.stun <= 0 && Math.hypot(b.x - pr.x, b.y - pr.y) < 0.42) { stunBoss(g, b); pr.dead = true; break; }
      }
      if (pr.dead) break;
      for (const n of g.npcs) {
        if (n.present && Math.hypot(n.x - pr.x, n.y - pr.y) < 0.33) {
          toast(g, `${n.ambient ? 'A coworker' : n.name}: Hey! I'm working here.`, 'info', 3);
          sfx(g, 'land');
          pr.dead = true;
          break;
        }
      }
    }
    pr.life -= dt;
    pr.z = Math.max(0.05, 0.42 - (1.2 - pr.life) * 0.3);
    if (!pr.dead && pr.life <= 0) landMemo(g, pr, pr.x, pr.y);
  }
  g.projectiles = g.projectiles.filter((pr) => !pr.dead);
}

function landMemo(g, pr, x, y) {
  pr.dead = true;
  makeNoise(g, x, y, 4.5);
  sfx(g, 'land', { x, y });
}

function stunBoss(g, b) {
  b.stun = PLAYER.stun;
  b.stunKind = 'memo';
  b.alert = 0;
  b.flash = 0.25;
  b.moving = false;
  g.stats.memosHit++;
  bark(g, b, 'stunned', true);
  sfx(g, 'hit');
}

export function makeNoise(g, x, y, radius) {
  for (const b of g.bosses) {
    if (b.stun > 0 || b.satisfied > 0 || b.reviewing > 0 || b.state === 'chase') continue;
    if (Math.hypot(b.x - x, b.y - y) > radius) continue;
    b.state = 'search';
    b.target = { x, y };
    b.searchTime = 3;
    b.path = null;
    bark(g, b, 'hear');
  }
}

function bark(g, b, kind, force = false) {
  if (!force && b.barkCd > 0) return;
  const list = b.lines[kind];
  if (!Array.isArray(list) || !list.length) return;
  const text = list[Math.floor(g.rng() * list.length)];
  b.barkCd = 6;
  b.speech = { text, ttl: 3.5 };
  const p = g.player;
  if (Math.hypot(b.x - p.x, b.y - p.y) < 10) toast(g, `${b.name}: ${text}`, `boss-${b.id}`, 4);
}

// ----------------------------------------------------------------- bosses --

function updateBoss(g, b, dt) {
  const d = g.diff, p = g.player, w = g.world;
  b.flash = Math.max(0, b.flash - dt);
  b.barkCd = Math.max(0, b.barkCd - dt);
  if (b.speech) { b.speech.ttl -= dt; if (b.speech.ttl <= 0) b.speech = null; }
  b.moving = false;

  if (b.reviewing > 0) {
    // Standing still, reading your report, until the stamp comes down.
    b.reviewing -= dt;
    b.sees = false;
    b.turnTo = Math.atan2(p.y - b.y, p.x - b.x);
    b.a += clamp(angleDiff(b.turnTo, b.a), -7 * dt, 7 * dt);
    if (b.reviewing <= 0) finishReview(g, b);
    return;
  }

  if (b.stun > 0) {
    b.stun -= dt;
    b.sees = false;
    if (b.stun <= 0) {
      // Shakes it off and looks around where they were, or where they last
      // saw you if they had been chasing.
      b.state = 'search';
      b.target = b.lastSeen && b.lost < 2.5 ? b.lastSeen : { x: b.x, y: b.y };
      b.searchTime = 2.5;
      b.path = null;
    }
    return;
  }
  if (b.satisfied > 0) b.satisfied -= dt;

  // Stuck in one of Kevin's (or Ryan's, or Neil's) conversations? Managers
  // can still walk up and grab you.
  const exposed = p.lock <= 0 || p.lockKind === 'chat';
  const dx = p.x - b.x, dy = p.y - b.y, dist2 = Math.hypot(dx, dy);
  let sees = false;
  if (b.satisfied <= 0 && exposed && dist2 < d.viewRange) {
    const off = Math.abs(angleDiff(Math.atan2(dy, dx), b.a));
    if ((off < d.fov / 2 || dist2 < 1.3) && w.clearLine(b.x, b.y, p.x, p.y)) sees = true;
  }
  b.sees = sees;

  if (b.state === 'chase') {
    if (sees) { b.lastSeen = { x: p.x, y: p.y }; b.lost = 0; } else b.lost += dt;
    if (b.lost > 2.5) {
      b.state = 'search';
      b.target = b.lastSeen;
      b.searchTime = 3.5;
      b.path = null;
      bark(g, b, 'lost');
    }
  } else if (sees) {
    const closeness = 1 + ((d.viewRange - dist2) / d.viewRange) * 1.5;
    const searching = b.state === 'search' ? 1.6 : 1;
    b.alert = Math.min(1, b.alert + (dt / d.detect) * closeness * searching * (p.running ? 1.5 : 1));
    if (b.alert >= 1) {
      b.state = 'chase';
      b.lastSeen = { x: p.x, y: p.y };
      b.lost = 0;
      b.path = null;
      bark(g, b, 'spot', true);
      sfx(g, 'spotted', { boss: b.id });
    }
  } else {
    b.alert = Math.max(0, b.alert - dt * 0.35);
  }

  let goal = null, speed = 0;
  if (b.state === 'chase') {
    goal = sees ? { x: p.x, y: p.y } : b.lastSeen;
    speed = d.chaseSpeed;
  } else if (b.state === 'search') {
    if (b.alert > 0.25 && sees) {
      b.turnTo = Math.atan2(dy, dx);
    } else if (!b.pathFailed && Math.hypot(b.target.x - b.x, b.target.y - b.y) > 0.4) {
      goal = b.target;
      speed = d.patrolSpeed * 1.5;
    } else {
      b.searchTime -= dt;
      b.turnTo = b.a + (Math.sin(g.t * 1.7 + b.x) > 0 ? 1.2 : -1.2);
      if (b.searchTime <= 0) resumePatrol(b);
    }
  } else if (b.alert > 0.25 && sees) {
    b.turnTo = Math.atan2(dy, dx); // stops and stares
  } else if (b.pause > 0) {
    b.pause -= dt;
  } else {
    const wp = b.patrol[b.patrolIdx];
    if (Math.hypot(wp.x - b.x, wp.y - b.y) < 0.2) {
      b.patrolIdx = (b.patrolIdx + 1) % b.patrol.length;
      b.path = null;
      b.pause = 0.8 + g.rng() * 0.8;
    } else {
      goal = wp;
      speed = d.patrolSpeed;
    }
  }

  if (goal && speed > 0) followPath(g, b, goal, speed, dt);

  const turn = angleDiff(b.turnTo, b.a);
  const maxTurn = 7 * dt;
  b.a += clamp(turn, -maxTurn, maxTurn);
  b.a = ((b.a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

  if (b.state === 'chase' && dist2 < 0.6 && exposed) catchPlayer(g, b);
}

function resumePatrol(b) {
  let best = 0, bestD = Infinity;
  b.patrol.forEach((wp, i) => {
    const dd = Math.hypot(wp.x - b.x, wp.y - b.y);
    if (dd < bestD) { bestD = dd; best = i; }
  });
  b.patrolIdx = best;
  b.state = 'patrol';
  b.path = null;
  b.pathFailed = false;
}

// Moves a boss or a walking coworker one step along a grid path to goal.
function followPath(g, b, goal, speed, dt) {
  const w = g.world;
  const bx = Math.floor(b.x), by = Math.floor(b.y);
  const gx = Math.floor(goal.x), gy = Math.floor(goal.y);
  const key = `${gx},${gy}`;
  b.repath -= dt;
  if (!b.path || b.repath <= 0 || b.pathKey !== key) {
    b.path = w.findPath(bx, by, gx, gy);
    b.pathKey = key;
    b.repath = 0.4;
    b.pathFailed = !b.path;
    if (!b.path) return;
  }
  let tx, ty;
  if (b.path.length) {
    tx = b.path[0][0] + 0.5;
    ty = b.path[0][1] + 0.5;
    if (b.path.length === 1 && b.path[0][0] === gx && b.path[0][1] === gy) { tx = goal.x; ty = goal.y; }
  } else {
    tx = goal.x;
    ty = goal.y;
  }
  const dx = tx - b.x, dy = ty - b.y, dd = Math.hypot(dx, dy);
  if (dd < 0.06) {
    if (b.path.length) b.path.shift();
    return;
  }
  const step = Math.min(dd, speed * dt);
  const pos = w.moveCircle(b.x, b.y, (dx / dd) * step, (dy / dd) * step, 0.22);
  const moved = Math.hypot(pos.x - b.x, pos.y - b.y);
  b.x = pos.x;
  b.y = pos.y;
  b.turnTo = Math.atan2(dy, dx);
  b.moving = moved > 1e-4;
  b.walkPhase += moved * 6;
  if (dd - step < 0.06 && b.path.length) b.path.shift();
}

// Walking up to a manager on purpose: they stop whatever they were doing
// (even chasing you), review every report that needs their stamp, and
// approve it. Costs time and a little sanity; meetings are draining.
function requestApproval(g, b) {
  const p = g.player;
  const list = pendingStamps(g, b.id);
  if (!list.length) return;
  const dur = (1.5 + list.length) * (g.perks.fastReviews ? 0.5 : 1);
  p.lock = p.lockMax = dur;
  p.lockKind = 'review';
  p.lockText = `${b.name} is reviewing your ${joinNames(list.map((r) => r.name))}...`;
  p.sanity -= 4;
  b.reviewing = dur;
  b.reviewList = list;
  b.state = 'patrol';
  b.alert = 0;
  b.path = null;
  g.stats.reviews++;
  bark(g, b, 'review', true);
  sfx(g, 'talk');
}

function finishReview(g, b) {
  for (const r of b.reviewList) {
    r.stamped.add(b.id);
    g.stats.stamps++;
  }
  const names = b.reviewList.map((r) => r.name);
  b.reviewList = [];
  b.satisfied = 10;
  resumePatrol(b);
  g.stampFlash = { by: b.name, ttl: 1.4, max: 1.4 };
  toast(g, `${b.name} stamped the ${joinNames(names)}: APPROVED`, 'good', 4);
  bark(g, b, 'approve', true);
  sfx(g, 'stamp');
  g.events.push({ type: 'shake', amount: 4 });
  checkReports(g);
}

// Every now and then management decides a report needs (more) approval
// stamps, sometimes from several managers at once.
function updateReviews(g, dt) {
  const rv = g.review;
  if (rv.left <= 0 || !g.bosses.length) return;
  rv.timer -= dt;
  if (rv.timer > 0) return;
  rv.timer = 50 + g.rng() * 30;
  if (g.timeLeft < 45) return; // not in the last stretch: that would just be mean
  const ids = g.bosses.map((b) => b.id);
  const candidates = g.reports.filter((r) => ids.some((id) => !r.stamps.has(id)));
  if (!candidates.length) return;
  const r = candidates[Math.floor(g.rng() * candidates.length)];
  const free = ids.filter((id) => !r.stamps.has(id));
  const count = free.length > 1 && g.rng() < g.diff.multiStamp ? 2 : 1;
  const added = [];
  while (added.length < count) added.push(free.splice(Math.floor(g.rng() * free.length), 1)[0]);
  added.forEach((id) => r.stamps.add(id));
  r.done = false;
  g.allReady = readyCount(g) === g.reports.length;
  rv.left--;
  const names = added.map((id) => g.bosses.find((b) => b.id === id).name);
  toast(g, `MANAGEMENT REVIEW: the ${r.name} now needs ${added.length > 1 ? 'approval stamps' : 'an approval stamp'} from ${joinNames(names)}.`, 'warn', 8);
  sfx(g, 'review');
}

function catchPlayer(g, b) {
  if (g.chat) { g.chat = null; g.player.lock = 0; }
  if (g.perks.shield) {
    // Mark S steps in and talks them down; costs you nothing.
    g.perks.shield = false;
    b.satisfied = 12;
    b.alert = 0;
    resumePatrol(b);
    const mark = g.npcs.find((n) => n.perk === 'people_person');
    toast(g, `${mark ? mark.name : 'A coworker'} steps in: "I'm a people person!" ${b.name} wanders off, satisfied.`, 'good', 5);
    sfx(g, 'sign');
    return;
  }
  const rules = CATCH_RULES[b.id] || CATCH_RULES.default;
  const p = g.player;
  p.sanity -= rules.sanity * g.diff.catchMult;
  if (rules.time) g.timeLeft -= rules.time;
  p.lock = p.lockMax = rules.lock;
  p.lockKind = 'caught';
  p.lockText = rules.lockText;
  p.hurt = 0.6;
  g.stats.catches++;
  b.satisfied = 12;
  b.alert = 0;
  resumePatrol(b);
  bark(g, b, 'catch', true);
  if (rules.time) toast(g, `-${rules.time}s: the deadline won't wait for your timesheet.`, 'warn', 4);
  sfx(g, 'caught', { boss: b.id });
  g.events.push({ type: 'voice', boss: b.id });
  g.events.push({ type: 'shake', amount: 10 });
}

// ------------------------------------------------------------ the crew --

function updateCrew(g, dt) {
  const f = g.flare;
  const progress = clamp(1 - g.timeLeft / g.diff.time, 0, 1);
  g.intensity = 0.3 + 0.7 * Math.pow(progress, 1.4);

  f.timer -= dt;
  if (f.state === 'idle' && f.timer <= 0) {
    f.state = 'warning';
    f.timer = g.perks.flareWatch ? 12 : 4; // Janet's console gives you a head start
    toast(g, 'SOLAR FLARE INBOUND! The crew is about to take a burst of protons.', 'alarm', 4);
    sfx(g, 'alarm');
  } else if (f.state === 'warning' && f.timer <= 0) {
    f.state = 'active';
    f.timer = 7;
    g.events.push({ type: 'shake', amount: 3 });
    sfx(g, 'flare');
  } else if (f.state === 'active' && f.timer <= 0) {
    f.state = 'idle';
    f.timer = 30 + g.rng() * 25;
  }

  const flare = f.state === 'active' ? (g.perks.flareWatch ? CREW.flare / 2 : CREW.flare) : 1;
  g.crewRate = (CREW.base + CREW.ramp * g.intensity) * flare * g.diff.doseMult;
  g.crewDose += g.crewRate * dt;
}

function updateAmbient(g, dt) {
  g.punTimer -= dt;
  if (g.punTimer <= 0 && g.puns.length) {
    if (!g.dialog && !g.chat) toast(g, g.puns[Math.floor(g.rng() * g.puns.length)], 'overheard', 6);
    g.punTimer = 22 + g.rng() * 20;
  }
}

export function markExplored(g, radius) {
  const p = g.player, w = g.world, r = Math.ceil(radius);
  for (let y = Math.floor(p.y) - r; y <= Math.floor(p.y) + r; y++) {
    for (let x = Math.floor(p.x) - r; x <= Math.floor(p.x) + r; x++) {
      if (x < 0 || y < 0 || x >= w.w || y >= w.h) continue;
      if (Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y) <= radius + 0.5) g.explored[y * w.w + x] = 1;
    }
  }
}

const ENDINGS = {
  submitted: { title: 'Assessment Delivered', text: 'The Flight Director has your numbers, and the crew moves to the shielded quarters in time.' },
  sanity: { title: 'Buried in Paperwork', text: 'Your sanity hit zero somewhere between the third Weekly Report and a timesheet audit.' },
  time: { title: 'Deadline Missed', text: 'The Flight Director had to call it without your assessment. The crew sheltered on generic guidance, and your reports are now officially late.' },
};

function endGame(g, won, reason) {
  const p = g.player;
  g.status = won ? 'won' : 'lost';
  const s = g.stats;
  const score = won
    ? Math.max(0, Math.round(g.timeLeft * 10 + Math.max(0, CREW.limit - g.crewDose) * 20 + p.sanity * 3 + s.memosHit * 25 + s.stamps * 30 - s.catches * 50))
    : 0;
  const rating = !won ? 'Incident report filed'
    : score >= 4200 ? 'Employee of the Solar Cycle'
      : score >= 3400 ? 'Exceeds Expectations'
        : score >= 2400 ? 'Meets Expectations'
          : 'Needs Improvement (but on time)';
  g.result = {
    won, reason, ...ENDINGS[reason], score, rating, timeLeft: Math.max(0, g.timeLeft),
    crewDose: g.crewDose, sanity: Math.max(0, p.sanity), reports: readyCount(g),
  };
  g.dialog = null;
  g.prompt = null;
  g.quiz = null;
  g.mini = null;
  g.chat = null;
  sfx(g, won ? 'win' : 'lose');
}
