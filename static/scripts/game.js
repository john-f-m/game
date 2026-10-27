// Game rules and state. Pure logic: no DOM, no canvas, no audio. Everything
// the outside world needs to react to (sounds, screen shake) is pushed onto
// game.events and drained by the caller each frame.

import { World, T } from './world.js';

export const DIFFICULTY = {
  intern: {
    label: 'Intern', blurb: 'More time, slower bosses, less radiation.',
    time: 360, patrolSpeed: 1.1, chaseSpeed: 2.4, viewRange: 6, fov: 1.5, detect: 1.0, doseMult: 0.7, catchMult: 0.6,
    reviews: 1, multiStamp: 0.3,
  },
  analyst: {
    label: 'Analyst', blurb: 'The intended experience.',
    time: 280, patrolSpeed: 1.35, chaseSpeed: 3.0, viewRange: 7.5, fov: 1.8, detect: 0.5, doseMult: 1, catchMult: 0.9,
    reviews: 2, multiStamp: 0.5,
  },
  director: {
    label: 'Director', blurb: 'Less time. Sharper eyes. Faster bosses.',
    time: 210, patrolSpeed: 1.6, chaseSpeed: 3.4, viewRange: 9, fov: 2.0, detect: 0.35, doseMult: 1.3, catchMult: 1.25,
    reviews: 3, multiStamp: 0.7,
  },
};

export const PLAYER = {
  radius: 0.22, walk: 2.6, run: 4.2, turnRate: 2.6,
  sanity: 100, doseLimit: 100, stamina: 100, staminaDrain: 30, staminaRegen: 22, startMemos: 2, maxMemos: 10, maxCoffee: 3, memoPack: 3, stun: 3.5,
};

export const ITEMS = {
  coffee: { name: 'coffee', pickup: 'Picked up a coffee. Press C to drink it (+35 sanity).' },
  memos: { name: 'memos', pickup: '+3 memos. Throw them with Space or a click.' },
  timesheet: { name: "Katie's timesheet", pickup: "Found Katie's timesheet, jammed in the printer. PC LOAD LETTER indeed." },
  r13: { name: 'a blank Form R-13', pickup: "Swiped a blank Form R-13 from Eddie's cabinet." },
  vest: { name: 'the lead apron', pickup: 'Put on a lead apron. Radiation dose cut by 60%.' },
};

// What helpful coworkers (encounters.json "perk") do for you.
export const PERKS = {
  freeze_managers: { label: 'Management laptops rebooting' },
  flare_watch: { label: 'Flare watch' },
  fast_reviews: { label: 'Pivot-tabled reports: fast reviews' },
  recalibrate: { label: 'Recalibrated badge' },
  jeopardy: { label: 'Jeopardy' },
  people_person: { label: 'People person on call' },
};
const QUIZ_TIME = 12;
const QUIZ_COOLDOWN = 35;
const FREEZE_TIME = 15;

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

const DECOR_RADIUS = { plant: 0.28, cooler: 0.25, printer: 0.34, trash: 0.2, console: 0.36 };

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
const FACING = { east: 0, south: Math.PI / 2, west: Math.PI, north: -Math.PI / 2 };

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

export function createGame({ office, encounters, difficulty = 'analyst', seed = Date.now(), warn = () => {} }) {
  const diff = DIFFICULTY[difficulty] || DIFFICULTY.analyst;
  const rng = mulberry32(seed);
  const world = new World(office.map, warn);

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

  const decor = (office.decor || []).map((d, i) => {
    const [x, y] = place(d.at, `office.json decor #${i} (${d.type})`);
    world.occupied[y * world.w + x] = 1;
    return { type: d.type, x: x + 0.5, y: y + 0.5, radius: DECOR_RADIUS[d.type] ?? 0.25 };
  });

  const npcs = (encounters.npc_encounters || []).map((n, i) => {
    const name = n.npc || `Coworker ${i + 1}`;
    const [x, y] = place(n.location, `encounters.json ${name}`);
    world.occupied[y * world.w + x] = 1;
    if (n.perk && !PERKS[n.perk]) warn(`encounters.json ${name}: unknown perk "${n.perk}"`);
    const quiz = readQuiz(n.quiz, name, warn);
    const perk = PERKS[n.perk] && (n.perk !== 'jeopardy' || quiz.length) ? n.perk : null;
    return {
      index: i, name, title: n.title || '', x: x + 0.5, y: y + 0.5, radius: 0.3,
      lines: Array.isArray(n.lines) && n.lines.length ? n.lines : ['...'],
      wants: n.wants && ITEMS[n.wants.item] ? n.wants : null,
      signLine: n.sign || "Sure, I'll sign.",
      look: n.look || {}, signed: false, met: false, talkCount: 0, report: null,
      perk, perkLine: n.perk_line || '', perkUsed: false, cooldown: 0,
      quiz, quizIdx: quiz.length ? Math.floor(rng() * quiz.length) : 0,
    };
  });

  const items = (office.items || []).filter((it) => ITEMS[it.type]).map((it, i) => {
    const [x, y] = place(it.at, `office.json item #${i} (${it.type})`);
    return { type: it.type, x: x + 0.5, y: y + 0.5, taken: false, respawn: it.type === 'memos' ? 25 : 0, timer: 0 };
  });

  const start = place(office.player?.start ?? [1, 1], 'office.json player start');
  const facing = office.player?.facing;
  const player = {
    x: start[0] + 0.5, y: start[1] + 0.5,
    a: typeof facing === 'number' ? (facing * Math.PI) / 180 : FACING[facing] ?? 0,
    sanity: PLAYER.sanity, dose: 0, doseRate: 0, memos: PLAYER.startMemos, coffee: 0,
    stamina: PLAYER.stamina, winded: false, restTimer: 0,
    items: new Set(), vest: false,
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
      patrol: patrol.map(([px, py]) => ({ x: px + 0.5, y: py + 0.5 })), patrolIdx: 0,
      state: 'patrol', path: null, pathKey: '', repath: 0, pathFailed: false,
      alert: 0, sees: false, lost: 0, lastSeen: null, target: null, searchTime: 0,
      stun: 0, satisfied: 0, pause: 0, barkCd: 0, flash: 0, moving: false, walkPhase: 0,
      reviewing: 0, reviewList: [],
      lines: { ...DEFAULT_BOSS_LINES, ...(bossLines[id] || {}) },
    };
  });

  const reports = buildReports(encounters.reports, npcs, bosses, warn);

  const g = {
    world, diff, difficulty: DIFFICULTY[difficulty] ? difficulty : 'analyst', rng,
    t: 0, timeLeft: diff.time, status: 'playing', result: null,
    player, npcs, bosses, items, decor, projectiles: [],
    toasts: [], dialog: null, prompt: null, target: null, events: [],
    flare: { state: 'idle', timer: 40 + rng() * 15 },
    intensity: 0.3, chase: 0,
    puns: Array.isArray(encounters.puns) ? encounters.puns : [], punTimer: 15,
    explored: new Uint8Array(world.w * world.h),
    reports, allReady: false, stampFlash: null,
    review: { timer: 45 + rng() * 15, left: diff.reviews },
    perks: { flareWatch: false, fastReviews: false, shield: false }, quiz: null,
    stats: {
      catches: 0, memosThrown: 0, memosHit: 0, coffees: 0, distance: 0, peakDoseRate: 0,
      stamps: 0, reviews: 0, perks: 0, quizRight: 0, quizWrong: 0,
    },
    noMemoNagged: 0,
  };
  markExplored(g, 2.5);
  toast(g, `SOLAR STORM WARNING: CME arrives in ${formatClock(g.timeLeft)}.`, 'warn', 7);
  toast(g, `Get your ${reports.length} reports signed off and approved, then reach the Storm Shelter (the stairwell in the central core).`, 'info', 9);
  return g;
}

// Reports come from encounters.json: each needs a coworker's sign-off
// and/or approval stamps from management (boss ids).
function buildReports(list, npcs, bosses, warn) {
  const bossIds = new Set(bosses.map((b) => b.id));
  const src = Array.isArray(list) && list.length ? list : npcs.map((n) => ({ name: `${n.name}'s report`, signoff: n.name }));
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
    const report = { id: r.id || `report${i}`, name, signoff, stamps, stamped: new Set(), done: false };
    if (signoff) signoff.report = report;
    return report;
  });
}

export const reportReady = (r) => (!r.signoff || r.signoff.signed) && [...r.stamps].every((id) => r.stamped.has(id));
export const readyCount = (g) => g.reports.filter(reportReady).length;
export const pendingStamps = (g, bossId) => g.reports.filter((r) => r.stamps.has(bossId) && !r.stamped.has(bossId));

export function joinNames(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// Announces reports that just became ready, and the moment all of them are.
function checkReports(g) {
  for (const r of g.reports) {
    if (r.done || !reportReady(r)) continue;
    r.done = true;
    toast(g, `${r.name} is ready to file (${readyCount(g)}/${g.reports.length})`, 'good', 5);
  }
  const all = readyCount(g) === g.reports.length;
  if (all && !g.allReady) toast(g, 'Every report is ready! Get to the Storm Shelter: the stairwell door on the north side of the core.', 'good', 8);
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
  if (item === 'vest') return p.vest;
  return p.items.has(item);
}

function takeItem(p, item) {
  if (item === 'coffee') p.coffee--;
  else if (item === 'memos') p.memos--;
  else if (item !== 'vest') p.items.delete(item);
}

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
    if (g.dialog.ttl <= 0 || (n && Math.hypot(n.x - p.x, n.y - p.y) > 2.6)) g.dialog = null;
  }

  p.a += (input.turn || 0) * PLAYER.turnRate * dt + (input.look || 0);
  p.a = ((p.a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  p.hurt = Math.max(0, p.hurt - dt);
  p.throwAnim = Math.max(0, p.throwAnim - dt);
  p.drinkAnim = Math.max(0, p.drinkAnim - dt);

  for (const n of g.npcs) if (n.cooldown > 0) n.cooldown -= dt;

  if (p.lock > 0) {
    p.lock -= dt;
    p.moving = p.running = false;
    g.target = null;
    if (g.quiz) {
      if (input.answer) answerQuiz(g, input.answer - 1);
      else if (p.lock <= 0) answerQuiz(g, -1); // time's up
    }
  } else {
    movePlayer(g, input, dt);
    g.target = findTarget(g);
    if (input.interact) interact(g);
    if (input.throw) throwMemo(g);
    if (input.drink) drink(g);
  }
  g.prompt = p.lock > 0 ? null : promptFor(g, g.target);

  updateItems(g, dt);
  updateProjectiles(g, dt);
  g.chase = 0;
  for (const b of g.bosses) {
    updateBoss(g, b, dt);
    g.chase = Math.max(g.chase, b.state === 'chase' ? 1 : b.alert * 0.6);
  }
  // Sanity slowly recovers while nobody is after you.
  if (g.chase < 0.5 && p.lock <= 0) p.sanity = Math.min(PLAYER.sanity, p.sanity + 0.4 * dt);
  updateStorm(g, dt);
  updateReviews(g, dt);
  updateAmbient(g, dt);
  markExplored(g, 1.6);

  if (g.status === 'playing') {
    if (p.sanity <= 0) endGame(g, false, 'sanity');
    else if (p.dose >= PLAYER.doseLimit) endGame(g, false, 'dose');
    else if (g.timeLeft <= 0) endGame(g, false, 'time');
  }
}

function solids(g) {
  return [...g.npcs, ...g.decor];
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
  const ox = p.x, oy = p.y;
  let pos = w.moveCircle(p.x, p.y, mx * speed * dt, my * speed * dt, PLAYER.radius);
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

function findTarget(g) {
  const p = g.player;
  let best = null, bestD = 1.7;
  for (const n of g.npcs) {
    const dx = n.x - p.x, dy = n.y - p.y, d = Math.hypot(dx, dy);
    if (d < bestD && Math.abs(angleDiff(Math.atan2(dy, dx), p.a)) < 0.8 && canReach(g.world, p, n)) {
      best = { kind: 'npc', npc: n };
      bestD = d;
    }
  }
  for (const b of g.bosses) {
    if (b.stun > 0 || b.reviewing > 0 || !pendingStamps(g, b.id).length) continue;
    const dx = b.x - p.x, dy = b.y - p.y, d = Math.hypot(dx, dy);
    if (d < bestD && Math.abs(angleDiff(Math.atan2(dy, dx), p.a)) < 0.8 && canReach(g.world, p, b)) {
      best = { kind: 'boss', boss: b };
      bestD = d;
    }
  }
  if (!best) {
    const hit = g.world.wallAhead(p.x, p.y, p.a, 1.4);
    if (hit && hit.tile === T.SHELTER) best = { kind: 'shelter' };
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

function promptFor(g, target) {
  if (!target) return null;
  if (target.kind === 'shelter') {
    const n = readyCount(g);
    return n >= g.reports.length ? 'E: Enter the Storm Shelter' : `E: Storm Shelter (${n}/${g.reports.length} reports ready)`;
  }
  if (target.kind === 'boss') {
    const list = pendingStamps(g, target.boss.id);
    if (!list.length) return null;
    return `E: Ask ${target.boss.name} to approve the ${list[0].name}${list.length > 1 ? ` (+${list.length - 1} more)` : ''}`;
  }
  const n = target.npc;
  const label = n.title ? `${n.name} (${n.title})` : n.name;
  const signing = n.report && !n.signed;
  if (!signing && n.perk === 'jeopardy' && n.cooldown <= 0) return `E: Play Jeopardy with ${n.name}`;
  const wantsSomething = signing || (n.perk && !n.perkUsed && n.perk !== 'jeopardy');
  if (wantsSomething && n.wants && hasItem(g.player, n.wants.item)) return `E: Give ${ITEMS[n.wants.item].name} to ${n.name}`;
  return `E: Talk to ${label}`;
}

function interact(g) {
  const target = g.target;
  if (!target) return;
  if (target.kind === 'shelter') {
    const missing = g.reports.length - readyCount(g);
    if (missing <= 0) endGame(g, true, 'shelter');
    else {
      toast(g, `Shelter Warden: "Not without your reports. ${missing} still need${missing === 1 ? 's' : ''} sign-offs or stamps."`, 'warn', 5);
      sfx(g, 'deny');
    }
    return;
  }
  if (target.kind === 'boss') { requestApproval(g, target.boss); return; }
  talk(g, target.npc);
}

function talk(g, n) {
  const p = g.player;
  const out = [stripSpeaker(n.lines[n.talkCount % n.lines.length])];
  n.talkCount++;
  n.met = true;
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
    toast(g, 'Flare watch on: early warnings and a countdown to the next flare.', 'good', 5);
  } else if (n.perk === 'fast_reviews') {
    g.perks.fastReviews = true;
    toast(g, 'Your reports are pivot-tabled: management reviews now take half as long.', 'good', 5);
  } else if (n.perk === 'recalibrate') {
    const before = p.dose;
    p.dose = Math.max(0, p.dose - 20);
    toast(g, `Dosimeter recalibrated: ${before.toFixed(1)} → ${p.dose.toFixed(1)} mSv.`, 'good', 5);
  } else if (n.perk === 'people_person') {
    g.perks.shield = true;
    toast(g, `${n.name} has your back: the next time you get caught, he'll talk them down.`, 'good', 5);
  }
}

// Amir's Jeopardy: one clue, three responses, keys 1-3, against the clock.
function startQuiz(g, n) {
  const q = n.quiz[n.quizIdx % n.quiz.length];
  n.quizIdx++;
  const p = g.player;
  g.quiz = { npc: n, clue: q.clue, choices: q.choices, answer: q.answer };
  p.lock = p.lockMax = QUIZ_TIME;
  p.lockKind = 'quiz';
  p.lockText = '';
  g.dialog = null;
  sfx(g, 'review');
}

function answerQuiz(g, idx) {
  const q = g.quiz, n = q.npc, p = g.player;
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
  const pr = { x: p.x + cx * 0.15, y: p.y + cy * 0.15, vx: cx * 9, vy: cy * 9, life: 1.2, z: 0.42, dead: false };
  g.projectiles.push(pr);
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
    } else if (it.type === 'vest') {
      p.vest = true;
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
        if (Math.hypot(n.x - pr.x, n.y - pr.y) < 0.33) {
          toast(g, `${n.name}: Hey! I'm working here.`, 'info', 3);
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

  const dx = p.x - b.x, dy = p.y - b.y, dist = Math.hypot(dx, dy);
  let sees = false;
  if (b.satisfied <= 0 && p.lock <= 0 && dist < d.viewRange) {
    const off = Math.abs(angleDiff(Math.atan2(dy, dx), b.a));
    if ((off < d.fov / 2 || dist < 1.3) && w.clearLine(b.x, b.y, p.x, p.y)) sees = true;
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
    const closeness = 1 + ((d.viewRange - dist) / d.viewRange) * 1.5;
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
  } else {
    // patrol
    if (b.alert > 0.25 && sees) {
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
  }

  if (goal && speed > 0) followPath(g, b, goal, speed, dt);

  const turn = angleDiff(b.turnTo, b.a);
  const maxTurn = 7 * dt;
  b.a += clamp(turn, -maxTurn, maxTurn);
  b.a = ((b.a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

  if (b.state === 'chase' && dist < 0.6 && p.lock <= 0) catchPlayer(g, b);
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
  if (rules.time) toast(g, `-${rules.time}s: the storm won't wait for your timesheet.`, 'warn', 4);
  sfx(g, 'caught', { boss: b.id });
  g.events.push({ type: 'voice', boss: b.id });
  g.events.push({ type: 'shake', amount: 10 });
}

// ------------------------------------------------------------ environment --

function updateStorm(g, dt) {
  const p = g.player, f = g.flare;
  const progress = clamp(1 - g.timeLeft / g.diff.time, 0, 1);
  g.intensity = 0.3 + 0.7 * Math.pow(progress, 1.4);

  f.timer -= dt;
  if (f.state === 'idle' && f.timer <= 0) {
    f.state = 'warning';
    f.timer = g.perks.flareWatch ? 12 : 4; // Janet's console gives you a head start
    toast(g, 'SOLAR FLARE INBOUND! Get away from the windows!', 'alarm', 4);
    sfx(g, 'alarm');
  } else if (f.state === 'warning' && f.timer <= 0) {
    f.state = 'active';
    f.timer = 7;
    g.events.push({ type: 'shake', amount: 5 });
    sfx(g, 'flare');
  } else if (f.state === 'active' && f.timer <= 0) {
    f.state = 'idle';
    f.timer = 30 + g.rng() * 25;
  }

  const exposure = g.world.exposureAt(p.x, p.y);
  const flare = f.state === 'active' ? 3 : 1;
  let rate = (0.03 + 8 * Math.pow(exposure, 1.3) * g.intensity * flare) * g.diff.doseMult;
  if (p.vest) rate *= 0.4;
  p.doseRate = rate;
  p.dose += rate * dt;
  g.stats.peakDoseRate = Math.max(g.stats.peakDoseRate, rate);
}

function updateAmbient(g, dt) {
  g.punTimer -= dt;
  if (g.punTimer <= 0 && g.puns.length) {
    if (!g.dialog) toast(g, g.puns[Math.floor(g.rng() * g.puns.length)], 'overheard', 6);
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
  shelter: { title: 'Safe in the Shelter', text: 'Every report filed, signed and stamped. The door seals behind you with a fully-approved clunk, and the CME rolls past Building 45.' },
  sanity: { title: 'Buried in Paperwork', text: 'Your sanity hit zero somewhere between the third Weekly Report and a timesheet audit.' },
  dose: { title: 'Dose Limit Exceeded', text: 'You absorbed a solar storm... physically. Medical sent you home under a lead blanket.' },
  time: { title: 'The CME Arrived', text: 'The storm hit before you made it to the shelter. HR will be in touch.' },
};

function endGame(g, won, reason) {
  const p = g.player;
  g.status = won ? 'won' : 'lost';
  const s = g.stats;
  const score = won
    ? Math.max(0, Math.round(g.timeLeft * 10 + (PLAYER.doseLimit - p.dose) * 5 + p.sanity * 3 + s.memosHit * 25 + s.stamps * 30 - s.catches * 50))
    : 0;
  const rating = !won ? 'Incident report filed'
    : score >= 2600 ? 'Employee of the Solar Cycle'
      : score >= 2000 ? 'Exceeds Expectations'
        : score >= 1400 ? 'Meets Expectations'
          : 'Needs Improvement (but alive)';
  g.result = { won, reason, ...ENDINGS[reason], score, rating, timeLeft: Math.max(0, g.timeLeft), dose: p.dose, sanity: Math.max(0, p.sanity), reports: readyCount(g) };
  g.dialog = null;
  g.prompt = null;
  g.quiz = null;
  sfx(g, won ? 'win' : 'lose');
}
