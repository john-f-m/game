// Heads-up display, drawn at full screen resolution on top of the scaled-up
// 3D view: clock, checklist, meters, inventory, minimap, dialog, toasts.

import { T } from './world.js';
import { formatClock, readyCount, reportReady, pendingStamps, hasItem, ITEMS, PLAYER, CREW, TASKS, needlePos } from './game.js';

const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export const BOSS_COLORS = { eddie: '#7fd6ff', clifton: '#ffb85c' };
const TOAST_COLORS = {
  info: '#e8eef7', warn: '#ffd166', alarm: '#ff6b6b', good: '#7dffa0', item: '#bfe3ff', overheard: '#cdb8ff', npc: '#ffc68a',
};
const TILE_COLORS = {
  [T.FLOOR]: '#1d2736', [T.BULKHEAD]: '#56637a', [T.WINDOW]: '#6fb7ff', [T.CUBICLE]: '#8a93a6', [T.FILING]: '#b5ad9c',
  [T.WHITEBOARD]: '#e8ecef', [T.SERVER]: '#2f3846', [T.VENDING]: '#c0504d', [T.SHELTER]: '#7b8796', [T.OFFICE]: '#cdbfa3', [T.ELEVATOR]: '#a6aeb8',
};

const font = (px, weight = 600, family = SANS) => `${weight} ${Math.round(px)}px ${family}`;

// Keyboard hints, reworded for the on-screen buttons on touch screens.
const TOUCH_WORDS = [
  [/^E: /, 'Use: '], [/ · N: /, ' · Name: '], [/Press E/g, 'Tap Use'], [/Press C/g, 'Tap Coffee'],
  [/with Space or a click/g, 'with the Memo button'], [/\(M to close\)/, '(tap Map to close)'],
];
const say = (o, text) => (o.touch ? TOUCH_WORDS.reduce((t, [re, to]) => t.replace(re, to), text) : text);

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function panel(ctx, x, y, w, h, u, alpha = 0.66) {
  roundRect(ctx, x, y, w, h, 8 * u);
  ctx.fillStyle = `rgba(8, 12, 24, ${alpha})`;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)';
  ctx.lineWidth = Math.max(1, u);
  ctx.stroke();
}

function bar(ctx, x, y, w, h, frac, color, u) {
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.fill();
  const fw = Math.max(0, Math.min(1, frac)) * w;
  if (fw > 0.5) {
    roundRect(ctx, x, y, Math.max(fw, h), h, h / 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

export function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function vignette(ctx, w, h, color, alpha) {
  if (alpha <= 0.01) return;
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, color);
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;
}

// o: { w, h, u, time, showMap, icons: {coffee, memos, timesheet, r13, vest} (canvases), fps }
export function drawHud(ctx, g, o) {
  const { w, h, u, time } = o;
  const p = g.player;
  const m = 16 * u;
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.imageSmoothingEnabled = false;

  // --- full-screen effects: flare alarms from the console, getting caught,
  // and the pull of Kevin's gravity well.
  if (g.flare.state === 'warning') vignette(ctx, w, h, 'rgba(255, 40, 40, 0.9)', 0.25 + 0.25 * Math.sin(time * 10));
  else if (g.flare.state === 'active') vignette(ctx, w, h, 'rgba(255, 150, 40, 0.9)', 0.18 + 0.08 * Math.sin(time * 4));
  vignette(ctx, w, h, 'rgba(70, 20, 120, 1)', (g.gravity || 0) * 0.9);
  vignette(ctx, w, h, 'rgba(255, 0, 0, 1)', p.hurt * 1.2);

  if (o.project) drawNameTags(ctx, g, o);

  // --- crosshair, detection, prompt
  const cx = w / 2, cy = h / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = Math.max(1, 1.5 * u);
  ctx.beginPath();
  ctx.moveTo(cx - 7 * u, cy); ctx.lineTo(cx - 2 * u, cy);
  ctx.moveTo(cx + 2 * u, cy); ctx.lineTo(cx + 7 * u, cy);
  ctx.moveTo(cx, cy - 7 * u); ctx.lineTo(cx, cy - 2 * u);
  ctx.moveTo(cx, cy + 2 * u); ctx.lineTo(cx, cy + 7 * u);
  ctx.stroke();

  const chaser = g.bosses.find((b) => b.state === 'chase');
  const watcher = !chaser && g.bosses.filter((b) => b.alert > 0.15 && b.stun <= 0).sort((a, b) => b.alert - a.alert)[0];
  if (chaser || watcher) {
    const b = chaser || watcher;
    const label = chaser ? `! ${b.name.toUpperCase()} SPOTTED YOU` : `? ${b.name} is suspicious`;
    ctx.font = font(15 * u, 800);
    ctx.textAlign = 'center';
    ctx.fillStyle = chaser ? '#ff5a5a' : '#ffd166';
    ctx.globalAlpha = chaser ? 0.75 + 0.25 * Math.sin(time * 12) : 0.5 + b.alert * 0.5;
    ctx.fillText(label, cx, cy - 40 * u);
    ctx.globalAlpha = 1;
  }
  // Coworker hazards: Kevin's pull, Neil wandering about.
  if (p.lock <= 0) {
    const kevin = g.npcs.find((n) => n.blackHole && n.present && n.chatCd <= 0 && Math.hypot(n.x - p.x, n.y - p.y) < n.blackHole.radius);
    const neil = g.npcs.find((n) => n.dropIn && n.present && n.seeking);
    const warn = kevin ? [`${kevin.name} would love to tell you about ${kevin.blackHole.topic}. Keep walking!`, '#c9a6ff']
      : neil ? [`${neil.name} is on the floor, looking for someone to talk to`, '#ffc68a'] : null;
    if (warn) {
      ctx.font = font(14 * u, 800);
      ctx.textAlign = 'center';
      ctx.fillStyle = warn[1];
      ctx.globalAlpha = 0.7 + 0.3 * Math.sin(time * 8);
      ctx.fillText(warn[0], cx, cy - (chaser || watcher ? 62 : 40) * u);
      ctx.globalAlpha = 1;
    }
  }
  const run = g.reports.find((r) => r.task && r.task.type === 'vehicle' && r.task.running && !r.task.done);
  if (run) {
    const bw = 220 * u;
    panel(ctx, cx - bw / 2, h - m - 132 * u, bw, 30 * u, u, 0.7);
    ctx.font = font(12 * u, 700);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#bfe3ff';
    ctx.fillText(`Vehicle dose run ${Math.floor(run.task.progress * 100)}%`, cx - bw / 2 + 10 * u, h - m - 113 * u);
    bar(ctx, cx + 10 * u, h - m - 121 * u, bw / 2 - 20 * u, 8 * u, run.task.progress, '#56ccf2', u);
  }

  if (g.prompt && g.status === 'playing') {
    const prompt = say(o, g.prompt);
    ctx.font = font(17 * u, 700);
    const tw = Math.min(ctx.measureText(prompt).width, w - 60 * u);
    panel(ctx, cx - tw / 2 - 14 * u, cy + 38 * u, tw + 28 * u, 32 * u, u, 0.75);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(prompt, cx, cy + 60 * u, tw);
  }

  drawClockAndChecklist(ctx, g, o, m);
  drawMeters(ctx, g, o, m);
  drawInventory(ctx, g, o, m);
  drawMinimap(ctx, g, w - m - 190 * u, m, 190 * u, 150 * u, u, time, false);
  drawToasts(ctx, g, o);
  drawDialog(ctx, g, o, m);

  drawPerks(ctx, g, o, m);
  if (g.quiz) drawQuiz(ctx, g, o);
  else if (g.mini) drawCalibration(ctx, g, o);
  else if (g.chat) drawChat(ctx, g, o);
  else if (p.lock > 0) drawLock(ctx, p, o);
  if (g.stampFlash) drawStamp(ctx, g.stampFlash, o);
  if (o.showMap) drawBigMap(ctx, g, o);
  if (o.fps) {
    ctx.font = font(12 * u, 600, MONO);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#9fe89f';
    ctx.fillText(`${o.fps.toFixed(0)} fps`, w - m, h - m - 120 * u);
  }
  ctx.restore();
}

// Name tags over the heads of named people within a few steps (and in view).
function drawNameTags(ctx, g, o) {
  const { u } = o;
  const p = g.player;
  ctx.textAlign = 'center';
  for (const n of g.npcs) {
    if (!n.present || (n.ambient && !n.custom)) continue;
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d > 5) continue;
    const s = o.project(n.x, n.y, 0.95);
    if (!s) continue;
    const size = Math.max(10, Math.min(16, 26 / s.depth)) * u;
    ctx.font = font(size, 700);
    const tw = ctx.measureText(n.name).width;
    ctx.globalAlpha = Math.min(1, (5 - d) / 1.5);
    roundRect(ctx, s.x - tw / 2 - 6 * u, s.y - size - 4 * u, tw + 12 * u, size + 8 * u, 5 * u);
    ctx.fillStyle = 'rgba(8, 12, 24, 0.65)';
    ctx.fill();
    ctx.fillStyle = n.ambient ? '#e8eef7' : '#ffd166';
    ctx.fillText(n.name, s.x, s.y);
  }
  ctx.globalAlpha = 1;
}

// One or two lines per report: name, then what it is still waiting on.
function reportRows(g) {
  const p = g.player;
  const nameOf = (id) => g.bosses.find((b) => b.id === id)?.name || id;
  return g.reports.map((r) => {
    if (reportReady(r)) return { text: `✔ ${r.name}`, color: '#7dffa0' };
    const needs = [];
    const t = r.task;
    if (t && !t.done) {
      const info = TASKS[t.type];
      if (t.type === 'vehicle' && t.running) needs.push(`vehicle run ${Math.floor(t.progress * 100)}%`);
      else if (info.needs && !hasItem(p, info.needs)) {
        const giver = g.npcs.find((x) => x.gives === info.needs);
        needs.push(`${info.short} (get ${ITEMS[info.needs].name}${giver ? ` from ${giver.name}` : ''})`);
      } else needs.push(info.short);
    }
    const n = r.signoff;
    if (n && !n.signed) {
      if (!n.met) needs.push(`sign-off: ${n.name}`);
      else if (n.wants && !hasItem(p, n.wants.item)) needs.push(`${n.name} wants ${ITEMS[n.wants.item].name}`);
      else needs.push(`${n.name} can sign off`);
    }
    const missing = [...r.stamps].filter((id) => !r.stamped.has(id)).map(nameOf);
    if (missing.length) needs.push(`stamp${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
    return { text: `• ${r.name}`, color: '#e8eef7', sub: needs.join(' · '), subColor: missing.length ? '#ff9d6b' : '#ffd166' };
  });
}

// Sub-lines can be long (task + sign-off + stamps): wrap them.
function rowLines(ctx, rows, width, u) {
  ctx.font = font(12 * u, 600);
  return rows.map((r) => ({ ...r, subLines: r.sub ? wrap(ctx, r.sub, width) : [] }));
}

function drawClockAndChecklist(ctx, g, o, m) {
  const { u, time } = o;
  const pw = 340 * u;
  const x = m + 14 * u, tw = pw - 28 * u;
  const rows = rowLines(ctx, reportRows(g), tw - 12 * u, u);
  const done = readyCount(g) === g.reports.length;
  const listH = rows.reduce((hh, r) => hh + 22 + r.subLines.length * 16, 0);
  const ph = (124 + listH + (done ? 26 : 0)) * u;
  panel(ctx, m, m, pw, ph, u);
  let y = m + 22 * u;
  ctx.textAlign = 'left';
  ctx.font = font(12 * u, 700);
  ctx.fillStyle = '#9fb0c8';
  ctx.fillText('FLIGHT DIRECTOR DEADLINE', x, y);
  if (g.flare.state !== 'idle') {
    ctx.textAlign = 'right';
    ctx.fillStyle = g.flare.state === 'active' ? '#fff3c4' : '#ff6b6b';
    ctx.globalAlpha = 0.6 + 0.4 * Math.sin(time * 10);
    const inbound = g.perks.flareWatch ? `FLARE IN ${Math.ceil(g.flare.timer)}s` : 'FLARE INBOUND';
    ctx.fillText(g.flare.state === 'active' ? 'SOLAR FLARE' : inbound, m + pw - 14 * u, y);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  } else if (g.perks.flareWatch) {
    // Janet's console: countdown to the next flare (warning lasts 12 s).
    ctx.textAlign = 'right';
    ctx.fillStyle = '#9fd3ff';
    ctx.fillText(`NEXT FLARE ${formatClock(g.flare.timer + 12)}`, m + pw - 14 * u, y);
    ctx.textAlign = 'left';
  }
  y += 36 * u;
  const tl = g.timeLeft;
  ctx.font = font(38 * u, 800, MONO);
  ctx.fillStyle = tl < 30 ? (Math.sin(time * 8) > 0 ? '#ff5a5a' : '#ffffff') : tl < 60 ? '#ffd166' : '#ffffff';
  ctx.fillText(formatClock(tl), x, y);
  y += 14 * u;
  bar(ctx, x, y, tw, 5 * u, g.intensity, `hsl(${40 - g.intensity * 40}, 95%, 60%)`, u);
  y += 30 * u;
  ctx.font = font(12 * u, 700);
  ctx.fillStyle = '#9fb0c8';
  ctx.fillText(`REPORTS DUE  ${readyCount(g)}/${g.reports.length} READY`, x, y);
  y += 4 * u;
  for (const r of rows) {
    y += 20 * u;
    ctx.font = font(14 * u, 650);
    ctx.fillStyle = r.color;
    ctx.fillText(r.text, x, y, tw);
    ctx.font = font(12 * u, 600);
    ctx.fillStyle = r.subColor;
    for (const line of r.subLines) {
      y += 16 * u;
      ctx.fillText(line, x + 12 * u, y, tw - 12 * u);
    }
    y += 2 * u;
  }
  if (done) {
    y += 24 * u;
    ctx.font = font(14 * u, 800);
    ctx.fillStyle = '#7dffa0';
    ctx.fillText('→ Submit at the SRAG console (console room)', x, y, tw);
  }
}

function drawMeters(ctx, g, o, m) {
  const { u, h } = o;
  const p = g.player;
  const pw = 290 * u, ph = 118 * u;
  const x0 = m, y0 = h - m - ph;
  panel(ctx, x0, y0, pw, ph, u);
  const x = x0 + 14 * u, bw = pw - 28 * u;
  ctx.textAlign = 'left';
  let y = y0 + 22 * u;

  ctx.font = font(12 * u, 700);
  ctx.fillStyle = '#9fb0c8';
  ctx.fillText('SANITY', x, y);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#fff';
  ctx.font = font(13 * u, 700, MONO);
  ctx.fillText(`${Math.max(0, Math.round(p.sanity))}`, x + bw, y);
  ctx.textAlign = 'left';
  y += 7 * u;
  const s = p.sanity / PLAYER.sanity;
  bar(ctx, x, y, bw, 9 * u, s, s > 0.5 ? '#5fd38d' : s > 0.25 ? '#ffd166' : '#ff5a5a', u);
  y += 15 * u;
  bar(ctx, x, y, bw, 4 * u, p.stamina / PLAYER.stamina, p.winded ? '#ff8f5a' : '#7fb8ff', u);

  y += 26 * u;
  ctx.font = font(12 * u, 700);
  ctx.fillStyle = '#9fb0c8';
  ctx.fillText('CREW DOSE (IN ORBIT)', x, y);
  ctx.textAlign = 'right';
  ctx.font = font(13 * u, 700, MONO);
  const rate = g.crewRate;
  ctx.fillStyle = g.flare.state === 'active' ? '#ff5a5a' : rate > 0.07 ? '#ffd166' : '#9fe8b0';
  ctx.fillText(`${g.crewDose.toFixed(1)} mSv  +${rate.toFixed(2)}/s`, x + bw, y);
  ctx.textAlign = 'left';
  y += 7 * u;
  const d = g.crewDose / CREW.limit;
  bar(ctx, x, y, bw, 9 * u, d, d < 0.5 ? '#b6f35a' : d < 0.8 ? '#ffd166' : '#ff5a5a', u);
  ctx.font = font(10.5 * u, 600);
  ctx.fillStyle = '#7f8da3';
  ctx.fillText(`event limit ${CREW.limit} mSv · the sooner you submit, the sooner they shelter`, x, y + 24 * u, bw);
}

function drawInventory(ctx, g, o, m) {
  const { u, w, h, icons } = o;
  const p = g.player;
  const slots = [
    { icon: icons.memos, count: p.memos, key: o.touch ? '' : 'Space', label: 'memos' },
    { icon: icons.coffee, count: p.coffee, key: o.touch ? '' : 'C', label: 'coffee' },
  ];
  const LABELS = { timesheet: 'timesheet', r13: 'R-13', dosimetry: 'dosimetry' };
  for (const k of Object.keys(LABELS)) if (p.items.has(k)) slots.push({ icon: icons[k], label: LABELS[k] });
  const sw = 64 * u, gap = 8 * u;
  const pw = slots.length * sw + (slots.length - 1) * gap + 24 * u, ph = 86 * u;
  const x0 = w - m - pw, y0 = h - m - ph;
  panel(ctx, x0, y0, pw, ph, u);
  slots.forEach((s, i) => {
    const x = x0 + 12 * u + i * (sw + gap), y = y0 + 10 * u;
    roundRect(ctx, x, y, sw, sw, 6 * u);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fill();
    if (s.icon) {
      ctx.globalAlpha = s.count === 0 ? 0.35 : 1;
      const isz = 44 * u;
      ctx.drawImage(s.icon, x + (sw - isz) / 2, y + 4 * u, isz, isz);
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'right';
    ctx.font = font(15 * u, 800, MONO);
    ctx.fillStyle = '#fff';
    if (s.count !== undefined) ctx.fillText(`${s.count}`, x + sw - 4 * u, y + sw - 6 * u);
    ctx.textAlign = 'center';
    ctx.font = font(10.5 * u, 700);
    ctx.fillStyle = '#9fb0c8';
    ctx.fillText(s.key ? `${s.key}` : s.label, x + sw / 2, y + sw + 13 * u);
  });
}

function drawToasts(ctx, g, o) {
  const { u, w } = o;
  let y = 18 * u;
  const maxW = Math.min(640 * u, w - 2 * (330 * u) - 20 * u > 300 * u ? w - 2 * (330 * u) : w - 40 * u);
  ctx.textAlign = 'center';
  for (const t of g.toasts) {
    const italic = t.kind === 'overheard';
    ctx.font = `${italic ? 'italic ' : ''}${font(15 * u, 600)}`;
    const lines = wrap(ctx, say(o, t.text), maxW - 28 * u);
    const bw = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 28 * u);
    const bh = (lines.length * 20 + 14) * u;
    ctx.globalAlpha = Math.min(1, t.ttl / 0.4, (t.max - t.ttl + 0.15) / 0.15);
    panel(ctx, w / 2 - bw / 2, y, bw, bh, u, 0.72);
    ctx.fillStyle = t.kind.startsWith('boss-') ? BOSS_COLORS[t.kind.slice(5)] || '#ff9b9b' : TOAST_COLORS[t.kind] || '#fff';
    lines.forEach((l, i) => ctx.fillText(l, w / 2, y + (22 + i * 20) * u));
    ctx.globalAlpha = 1;
    y += bh + 6 * u;
  }
}

function drawDialog(ctx, g, o, m) {
  const d = g.dialog;
  if (!d) return;
  const { u, w, h } = o;
  const bw = Math.min(720 * u, w - 2 * m);
  ctx.font = font(17 * u, 500);
  const lines = d.lines.flatMap((l, i) => [...wrap(ctx, l, bw - 36 * u), ...(i < d.lines.length - 1 ? [''] : [])]);
  const bh = (48 + lines.length * 23) * u;
  const x = w / 2 - bw / 2, y = h - m - 140 * u - bh;
  ctx.globalAlpha = Math.min(1, d.ttl / 0.4);
  panel(ctx, x, y, bw, bh, u, 0.84);
  ctx.textAlign = 'left';
  ctx.font = font(14 * u, 800);
  ctx.fillStyle = '#ffd166';
  ctx.fillText((d.title ? `${d.name} · ${d.title}` : d.name).toUpperCase(), x + 18 * u, y + 26 * u, bw - 36 * u);
  ctx.font = font(17 * u, 500);
  ctx.fillStyle = '#f2f5fa';
  lines.forEach((l, i) => ctx.fillText(l, x + 18 * u, y + (52 + i * 23) * u));
  ctx.globalAlpha = 1;
}

function drawLock(ctx, p, o) {
  const { u, w, h } = o;
  const bw = Math.min(460 * u, w - 40 * u), bh = 110 * u;
  const x = w / 2 - bw / 2, y = h / 2 - bh / 2;
  const review = p.lockKind === 'review';
  const accent = review ? '#2c5ec9' : '#c94a3d';
  roundRect(ctx, x, y, bw, bh, 6 * u);
  ctx.fillStyle = '#f7f4ea';
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3 * u;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillStyle = accent;
  ctx.font = font(13 * u, 800, MONO);
  ctx.fillText(review ? 'MANAGEMENT REVIEW' : 'CAUGHT IN A CONVERSATION', w / 2, y + 28 * u);
  ctx.fillStyle = '#2b2b2b';
  ctx.font = font(16 * u, 600);
  ctx.fillText(p.lockText, w / 2, y + 58 * u, bw - 30 * u);
  bar(ctx, x + 30 * u, y + 76 * u, bw - 60 * u, 10 * u, 1 - p.lock / p.lockMax, accent, u);
}

// Help you've picked up from coworkers, stacked above the meters.
function drawPerks(ctx, g, o, m) {
  const { u, h } = o;
  const rows = [];
  const frozen = g.bosses.filter((b) => b.stun > 0 && b.stunKind === 'update');
  if (frozen.length) rows.push(`Managers rebooting: ${Math.ceil(Math.max(...frozen.map((b) => b.stun)))}s`);
  if (g.perks.shield) rows.push('People person on call (next catch is free)');
  if (g.perks.fastReviews) rows.push('Pivot-tabled reports: fast reviews');
  if (g.perks.flareWatch) rows.push('Flare watch: early warnings');
  if (g.perks.remote) rows.push('Remote access to the vehicle run');
  if (g.perks.priority) rows.push('Vehicle run: priority queue (2x)');
  if (!rows.length) return;
  ctx.font = font(12.5 * u, 650);
  const pw = 290 * u, ph = (12 + rows.length * 19) * u;
  const y0 = h - m - 118 * u - 8 * u - ph;
  panel(ctx, m, y0, pw, ph, u, 0.6);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#9fd3ff';
  rows.forEach((r, i) => ctx.fillText(`★ ${r}`, m + 12 * u, y0 + (21 + i * 19) * u, pw - 24 * u));
}

// Amir's clue board.
// Amir's clue board, or the medical dose calculator (same 1-2-3 answers).
function drawQuiz(ctx, g, o) {
  const { u, w, h } = o;
  const q = g.quiz, p = g.player;
  const calc = q.kind === 'dosecalc';
  const theme = calc
    ? { bg: '#0b1a12', border: '#3cff6e', accent: '#3cff6e', text: '#d8ffe4', clueFont: font(21 * u, 700, MONO), upper: false }
    : { bg: '#060ce9', border: '#ffcc00', accent: '#ffcc00', text: '#ffffff', clueFont: font(26 * u, 800, 'Georgia, "Times New Roman", serif'), upper: true };
  const bw = Math.min(760 * u, w - 40 * u);
  ctx.font = theme.clueFont;
  const clue = wrap(ctx, theme.upper ? q.clue.toUpperCase() : q.clue, bw - 60 * u);
  const bh = (110 + clue.length * 34 + q.choices.length * 34) * u;
  const x = w / 2 - bw / 2, y = h / 2 - bh / 2;
  roundRect(ctx, x, y, bw, bh, 8 * u);
  ctx.fillStyle = theme.bg;
  ctx.fill();
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 4 * u;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillStyle = theme.accent;
  ctx.font = font(13 * u, 800, MONO);
  const title = calc ? `MEDICAL DOSE CALCULATOR · ${q.step + 1}/${q.questions.length} · ${q.report.name.toUpperCase()}` : `${q.npc.name.toUpperCase()} PRESENTS: JEOPARDY!`;
  ctx.fillText(title, w / 2, y + 30 * u, bw - 30 * u);
  ctx.fillStyle = theme.text;
  ctx.font = theme.clueFont;
  clue.forEach((l, i) => ctx.fillText(l, w / 2, y + (68 + i * 34) * u));
  ctx.textAlign = 'left';
  ctx.font = font(19 * u, 650, calc ? MONO : SANS);
  const cy = y + (78 + clue.length * 34) * u;
  q.choices.forEach((c, i) => {
    const ly = cy + i * 34 * u;
    roundRect(ctx, x + 40 * u, ly, 26 * u, 26 * u, 5 * u);
    ctx.fillStyle = theme.accent;
    ctx.fill();
    ctx.fillStyle = theme.bg;
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), x + 53 * u, ly + 20 * u);
    ctx.textAlign = 'left';
    ctx.fillStyle = theme.text;
    ctx.fillText(c, x + 80 * u, ly + 20 * u, bw - 120 * u);
  });
  bar(ctx, x + 40 * u, y + bh - 22 * u, bw - 80 * u, 8 * u, p.lock / p.lockMax, theme.accent, u);
}

// Detector calibration: a needle sweeping a gauge, press E in the green band.
function drawCalibration(ctx, g, o) {
  const { u, w, h } = o;
  const m = g.mini, p = g.player;
  const bw = Math.min(560 * u, w - 40 * u), bh = 190 * u;
  const x = w / 2 - bw / 2, y = h / 2 - bh / 2;
  roundRect(ctx, x, y, bw, bh, 8 * u);
  ctx.fillStyle = '#1b1f27';
  ctx.fill();
  ctx.strokeStyle = m.flash > 0 ? (m.result === 'hit' ? '#3cff6e' : '#ff5a5a') : '#9aa1ad';
  ctx.lineWidth = 3 * u;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd166';
  ctx.font = font(13 * u, 800, MONO);
  ctx.fillText(`DETECTOR CALIBRATION · ${m.report.name.toUpperCase()}`, w / 2, y + 28 * u, bw - 30 * u);
  const gx = x + 30 * u, gw = bw - 60 * u, gy = y + 62 * u, gh = 30 * u;
  roundRect(ctx, gx, gy, gw, gh, 4 * u);
  ctx.fillStyle = '#0b0e13';
  ctx.fill();
  ctx.fillStyle = 'rgba(60, 255, 110, 0.55)';
  ctx.fillRect(gx + m.zone[0] * gw, gy, (m.zone[1] - m.zone[0]) * gw, gh);
  const nx = gx + needlePos(m) * gw;
  ctx.fillStyle = '#ff5a3c';
  ctx.fillRect(nx - 2 * u, gy - 8 * u, 4 * u, gh + 16 * u);
  ctx.fillStyle = '#e8eef7';
  ctx.font = font(15 * u, 700);
  ctx.fillText(`${say(o, 'Press E')} when the needle is in the green band   ${'●'.repeat(m.hits)}${'○'.repeat(m.need - m.hits)}`, w / 2, y + 128 * u, bw - 30 * u);
  ctx.font = font(12 * u, 600);
  ctx.fillStyle = '#9fb0c8';
  ctx.fillText(`misses ${m.misses}/3`, w / 2, y + 150 * u);
  bar(ctx, x + 30 * u, y + bh - 22 * u, bw - 60 * u, 8 * u, p.lock / p.lockMax, '#ffd166', u);
}

// Stuck in a conversation: who's talking, what they're saying, how to escape.
function drawChat(ctx, g, o) {
  const { u, w, h } = o;
  const c = g.chat, p = g.player, n = c.npc;
  const bw = Math.min(600 * u, w - 40 * u);
  // Only Kevin-style talkers have a topic; build each title only when needed.
  const titles = {
    blackhole: () => `${n.name.toUpperCase()} IS TALKING ${(n.blackHole?.topic || 'physics').toUpperCase()}`,
    physics: () => `${n.name.toUpperCase()} HAS A PHYSICS PROBLEM`,
    dropin: () => `${n.name.toUpperCase()} DROPPED IN`, debrief: () => 'ASTRONAUT DEBRIEF',
  };
  const accent = c.kind === 'blackhole' ? '#c9a6ff' : c.kind === 'debrief' ? '#7fd6ff' : '#ffc68a';
  ctx.font = font(18 * u, 600);
  const lines = wrap(ctx, `"${c.lines[c.lineIdx]}"`, bw - 40 * u);
  const bh = (96 + lines.length * 24) * u;
  const x = w / 2 - bw / 2, y = h / 2 - bh / 2;
  roundRect(ctx, x, y, bw, bh, 8 * u);
  ctx.fillStyle = 'rgba(14, 10, 24, 0.92)';
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3 * u;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillStyle = accent;
  ctx.font = font(13 * u, 800, MONO);
  ctx.fillText(titles[c.kind] ? titles[c.kind]() : n.name.toUpperCase(), w / 2, y + 28 * u, bw - 30 * u);
  ctx.fillStyle = '#f2f5fa';
  ctx.font = font(18 * u, 600);
  lines.forEach((l, i) => ctx.fillText(l, w / 2, y + (56 + i * 24) * u));
  ctx.font = font(12 * u, 700);
  ctx.fillStyle = '#9fb0c8';
  const hint = say(o, c.escape ? (c.escort ? 'He is walking you back to his desk. Press E (repeatedly) to excuse yourself.' : 'Press E (repeatedly) to excuse yourself.') : 'Just nod along.');
  ctx.fillText(hint, w / 2, y + bh - 30 * u, bw - 30 * u);
  bar(ctx, x + 30 * u, y + bh - 18 * u, bw - 60 * u, 6 * u, p.lock / p.lockMax, accent, u);
}

// The big red rubber stamp that slams down when a manager approves.
function drawStamp(ctx, f, o) {
  const { u, w, h } = o;
  const age = f.max - f.ttl;
  const scale = age < 0.12 ? 1.8 - (age / 0.12) * 0.8 : 1;
  ctx.save();
  ctx.translate(w / 2, h * 0.36);
  ctx.rotate(-0.2);
  ctx.scale(scale, scale);
  ctx.globalAlpha = Math.min(1, f.ttl / 0.35);
  const sw = 300 * u, sh = 84 * u;
  ctx.strokeStyle = '#d8342c';
  ctx.lineWidth = 7 * u;
  roundRect(ctx, -sw / 2, -sh / 2, sw, sh, 10 * u);
  ctx.stroke();
  ctx.lineWidth = 2.5 * u;
  roundRect(ctx, -sw / 2 + 9 * u, -sh / 2 + 9 * u, sw - 18 * u, sh - 18 * u, 6 * u);
  ctx.stroke();
  ctx.fillStyle = '#d8342c';
  ctx.textAlign = 'center';
  ctx.font = font(46 * u, 900, MONO);
  ctx.fillText('APPROVED', 0, 14 * u);
  ctx.font = font(12 * u, 800, MONO);
  ctx.fillText(f.by.toUpperCase(), 0, sh / 2 + 18 * u);
  ctx.restore();
}

function bossVisible(g, b) {
  const p = g.player;
  const d = Math.hypot(b.x - p.x, b.y - p.y);
  return d < 2.5 || (d < 12 && g.world.clearLine(p.x, p.y, b.x, b.y));
}

export function drawMinimap(ctx, g, x0, y0, maxW, maxH, u, time, full) {
  const w = g.world;
  const ts = Math.min(maxW / w.w, maxH / w.h);
  const mw = ts * w.w, mh = ts * w.h;
  const ox = x0 + (maxW - mw) / 2, oy = y0;
  if (!full) panel(ctx, x0 - 8 * u, y0 - 8 * u, maxW + 16 * u, mh + 16 * u, u);
  for (let y = 0; y < w.h; y++) {
    for (let x = 0; x < w.w; x++) {
      if (!g.explored[y * w.w + x]) continue;
      const t = w.get(x, y);
      ctx.fillStyle = TILE_COLORS[t] || '#556';
      ctx.fillRect(ox + x * ts, oy + y * ts, Math.ceil(ts), Math.ceil(ts));
    }
  }
  const at = (px, py) => [ox + px * ts, oy + py * ts];
  const seen = (px, py) => g.explored[Math.floor(py) * w.w + Math.floor(px)];
  const p = g.player;
  const inSight = (o) => Math.hypot(o.x - p.x, o.y - p.y) < 2.5 || (Math.hypot(o.x - p.x, o.y - p.y) < 12 && w.clearLine(p.x, p.y, o.x, o.y));
  for (const it of g.items) {
    if (it.taken || !seen(it.x, it.y)) continue;
    const [sx, sy] = at(it.x, it.y);
    ctx.fillStyle = it.type === 'coffee' ? '#c58a5a' : it.type === 'memos' ? '#f2f2f2' : '#5ff0ff';
    ctx.fillRect(sx - ts * 0.2, sy - ts * 0.2, ts * 0.4, ts * 0.4);
  }
  // Stations are on the floor plan from the start: you know where your
  // work is. Orange = work waiting, green = the console where you submit.
  for (const s of g.stations) {
    const [sx, sy] = at(s.x, s.y);
    const due = s.type === 'srag_console' ? true : g.reports.some((r) => r.task && !r.task.done && TASKS[r.task.type].station === s.type);
    ctx.fillStyle = s.type === 'srag_console' ? (g.allReady ? '#7dffa0' : '#3f8f5a') : due ? '#ff9d3b' : '#6b717c';
    ctx.fillRect(sx - ts * 0.4, sy - ts * 0.4, ts * 0.8, ts * 0.8);
    if (s.type === 'srag_console' && g.allReady) {
      ctx.strokeStyle = `rgba(125, 255, 160, ${0.5 + 0.5 * Math.sin(time * 6)})`;
      ctx.lineWidth = 2 * u;
      ctx.strokeRect(sx - ts * 0.7, sy - ts * 0.7, ts * 1.4, ts * 1.4);
    }
  }
  for (const n of g.npcs) {
    if (!n.present) continue;
    // Named people away from their desk: an empty ring where they sit.
    if (n.errand && !n.ambient && seen(n.home.x, n.home.y)) {
      const [hx, hy] = at(n.home.x, n.home.y);
      ctx.beginPath();
      ctx.arc(hx, hy, ts * 0.32, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(200, 210, 225, 0.5)';
      ctx.lineWidth = 1.5 * u;
      ctx.stroke();
      if (full && !inSight(n)) {
        ctx.font = font(10.5 * u, 600);
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(232, 238, 247, 0.6)';
        ctx.fillText(`${n.name} (away)`, hx, hy - ts * 0.6);
      }
    }
    const roams = n.patrol || n.dropIn || n.errand;
    if (roams ? !inSight(n) : !seen(n.x, n.y)) continue;
    const [sx, sy] = at(n.x, n.y);
    if (n.blackHole && n.chatCd <= 0) {
      ctx.beginPath();
      ctx.arc(sx, sy, ts * n.blackHole.radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(120, 60, 200, 0.18)';
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(sx, sy, ts * 0.38, 0, Math.PI * 2);
    const helps = (n.perk && (n.perk === 'jeopardy' ? n.cooldown <= 0 : !n.perkUsed)) || (n.gives && !n.gave);
    ctx.fillStyle = n.blackHole && !n.signed ? '#c9a6ff'
      : n.report ? (n.signed ? '#5fd38d' : '#ffd84a')
        : n.debrief ? '#7fd6ff'
          : n.dropIn ? '#ffc68a'
            : helps ? '#6fb7ff' : '#7f8da3';
    ctx.fill();
    if (full && (!n.ambient || n.custom)) {
      ctx.font = font(10.5 * u, 600);
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(232, 238, 247, 0.85)';
      ctx.fillText(n.name, sx, sy - ts * 0.6);
    }
  }
  for (const b of g.bosses) {
    if (!bossVisible(g, b)) continue;
    const [sx, sy] = at(b.x, b.y);
    const col = BOSS_COLORS[b.id] || '#ff7070';
    if (b.stun <= 0) {
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.arc(sx, sy, ts * g.diff.viewRange, b.a - g.diff.fov / 2, b.a + g.diff.fov / 2);
      ctx.closePath();
      ctx.fillStyle = b.state === 'chase' ? 'rgba(255, 80, 80, 0.22)' : 'rgba(255, 220, 120, 0.13)';
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(sx, sy, ts * 0.45, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
    if (pendingStamps(g, b.id).length) {
      ctx.beginPath();
      ctx.arc(sx, sy, ts * 0.8, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 120, 100, ${0.5 + 0.5 * Math.sin(time * 6)})`;
      ctx.lineWidth = 2 * u;
      ctx.stroke();
    }
    if (full) {
      ctx.font = font(12 * u, 800);
      ctx.textAlign = 'center';
      ctx.fillText(b.name, sx, sy - ts * 0.8);
    }
  }
  const [px, py] = at(p.x, p.y);
  const r = Math.max(ts * 0.7, 5 * u);
  ctx.beginPath();
  ctx.moveTo(px + Math.cos(p.a) * r, py + Math.sin(p.a) * r);
  ctx.lineTo(px + Math.cos(p.a + 2.5) * r * 0.7, py + Math.sin(p.a + 2.5) * r * 0.7);
  ctx.lineTo(px + Math.cos(p.a - 2.5) * r * 0.7, py + Math.sin(p.a - 2.5) * r * 0.7);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = Math.max(1, u);
  ctx.stroke();
}

function drawBigMap(ctx, g, o) {
  const { u, w, h, time } = o;
  ctx.fillStyle = 'rgba(4, 7, 15, 0.86)';
  ctx.fillRect(0, 0, w, h);
  const maxW = w * 0.86, maxH = h * 0.72;
  const ts = Math.min(maxW / g.world.w, maxH / g.world.h);
  const mw = ts * g.world.w;
  const x0 = (w - mw) / 2, y0 = h * 0.12;
  ctx.textAlign = 'center';
  ctx.font = font(20 * u, 800);
  ctx.fillStyle = '#fff';
  ctx.fillText(g.mapName || 'Floor plan', w / 2, y0 - 22 * u);
  drawMinimap(ctx, g, x0, y0, mw, maxH, u, time, true);
  ctx.font = font(13 * u, 600);
  ctx.fillStyle = '#9fb0c8';
  const legend = '● yellow: sign-off needed   ● green: signed off   ● blue: can help   ● purple: Kevin (inside the ring, he starts talking)   ○ empty ring: away from their desk   ■ orange: work station   ■ green: SRAG console   red ring: manager whose stamp you need   cones: what managers can see   (M to close)';
  wrap(ctx, say(o, legend), w - 60 * u).forEach((l, i) => ctx.fillText(l, w / 2, y0 + g.world.h * ts + (30 + i * 18) * u));
}
