// Heads-up display, drawn at full screen resolution on top of the scaled-up
// 3D view: clock, checklist, meters, inventory, minimap, dialog, toasts.

import { T } from './world.js';
import { formatClock, readyCount, reportReady, pendingStamps, hasItem, ITEMS, PLAYER } from './game.js';

const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export const BOSS_COLORS = { eddie: '#7fd6ff', clifton: '#ffb85c' };
const TOAST_COLORS = {
  info: '#e8eef7', warn: '#ffd166', alarm: '#ff6b6b', good: '#7dffa0', item: '#bfe3ff', overheard: '#cdb8ff',
};
const TILE_COLORS = {
  [T.FLOOR]: '#1d2736', [T.BULKHEAD]: '#56637a', [T.WINDOW]: '#6fb7ff', [T.CUBICLE]: '#8a93a6', [T.FILING]: '#b5ad9c',
  [T.WHITEBOARD]: '#e8ecef', [T.SERVER]: '#2f3846', [T.VENDING]: '#c0504d', [T.SHELTER]: '#f2d22e', [T.OFFICE]: '#cdbfa3', [T.ELEVATOR]: '#a6aeb8',
};

const font = (px, weight = 600, family = SANS) => `${weight} ${Math.round(px)}px ${family}`;

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

  // --- full-screen effects
  if (g.flare.state === 'active') {
    const k = Math.min(1, g.flare.timer / 7);
    ctx.fillStyle = `rgba(255, 244, 214, ${0.08 + 0.3 * k * k})`;
    ctx.fillRect(0, 0, w, h);
  } else if (g.flare.state === 'warning') {
    vignette(ctx, w, h, 'rgba(255, 40, 40, 0.9)', 0.25 + 0.25 * Math.sin(time * 10));
  }
  vignette(ctx, w, h, 'rgba(190, 255, 60, 0.9)', Math.min(0.45, (p.doseRate - 0.6) * 0.08));
  vignette(ctx, w, h, 'rgba(255, 0, 0, 1)', p.hurt * 1.2);

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

  if (g.prompt && g.status === 'playing') {
    ctx.font = font(17 * u, 700);
    const tw = ctx.measureText(g.prompt).width;
    panel(ctx, cx - tw / 2 - 14 * u, cy + 38 * u, tw + 28 * u, 32 * u, u, 0.75);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(g.prompt, cx, cy + 60 * u);
  }

  drawClockAndChecklist(ctx, g, o, m);
  drawMeters(ctx, g, o, m);
  drawInventory(ctx, g, o, m);
  drawMinimap(ctx, g, w - m - 190 * u, m, 190 * u, 150 * u, u, time, false);
  drawToasts(ctx, g, o);
  drawDialog(ctx, g, o, m);

  drawPerks(ctx, g, o, m);
  if (g.quiz) drawQuiz(ctx, g, o);
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

// One or two lines per report: name, then what it is still waiting on.
function reportRows(g) {
  const p = g.player;
  const nameOf = (id) => g.bosses.find((b) => b.id === id)?.name || id;
  return g.reports.map((r) => {
    if (reportReady(r)) return { text: `✔ ${r.name}`, color: '#7dffa0' };
    const needs = [];
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

function drawClockAndChecklist(ctx, g, o, m) {
  const { u, time } = o;
  const pw = 340 * u;
  const rows = reportRows(g);
  const done = readyCount(g) === g.reports.length;
  const listH = rows.reduce((hh, r) => hh + (r.sub ? 38 : 22), 0);
  const ph = (124 + listH + (done ? 26 : 0)) * u;
  panel(ctx, m, m, pw, ph, u);
  let y = m + 22 * u;
  const x = m + 14 * u, tw = pw - 28 * u;
  ctx.textAlign = 'left';
  ctx.font = font(12 * u, 700);
  ctx.fillStyle = '#9fb0c8';
  ctx.fillText('CME ARRIVES IN', x, y);
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
    if (r.sub) {
      y += 16 * u;
      ctx.font = font(12 * u, 600);
      ctx.fillStyle = r.subColor;
      ctx.fillText(r.sub, x + 12 * u, y, tw - 12 * u);
    }
    y += 2 * u;
  }
  if (done) {
    y += 24 * u;
    ctx.font = font(14 * u, 800);
    ctx.fillStyle = '#7dffa0';
    ctx.fillText('→ Get to the Storm Shelter!', x, y);
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
  ctx.fillText(p.vest ? 'DOSE (LEAD APRON ON)' : 'DOSE', x, y);
  ctx.textAlign = 'right';
  ctx.font = font(13 * u, 700, MONO);
  const rate = p.doseRate;
  ctx.fillStyle = rate > 3 ? '#ff5a5a' : rate > 0.8 ? '#ffd166' : '#9fe8b0';
  ctx.fillText(`${p.dose.toFixed(1)} mSv  +${rate.toFixed(2)}/s`, x + bw, y);
  ctx.textAlign = 'left';
  y += 7 * u;
  const d = p.dose / PLAYER.doseLimit;
  bar(ctx, x, y, bw, 9 * u, d, d < 0.5 ? '#b6f35a' : d < 0.8 ? '#ffd166' : '#ff5a5a', u);
  ctx.font = font(10.5 * u, 600);
  ctx.fillStyle = '#7f8da3';
  ctx.fillText(`limit ${PLAYER.doseLimit} mSv · windows are dangerous during flares`, x, y + 24 * u, bw);
}

function drawInventory(ctx, g, o, m) {
  const { u, w, h, icons } = o;
  const p = g.player;
  const slots = [
    { icon: icons.memos, count: p.memos, key: 'Space', label: 'memos' },
    { icon: icons.coffee, count: p.coffee, key: 'C', label: 'coffee' },
  ];
  for (const k of ['timesheet', 'r13']) if (p.items.has(k)) slots.push({ icon: icons[k], label: k === 'r13' ? 'R-13' : 'timesheet' });
  if (p.vest) slots.push({ icon: icons.vest, label: 'apron' });
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
    const lines = wrap(ctx, t.text, maxW - 28 * u);
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
function drawQuiz(ctx, g, o) {
  const { u, w, h } = o;
  const q = g.quiz, p = g.player;
  const bw = Math.min(760 * u, w - 40 * u);
  ctx.font = font(26 * u, 800, 'Georgia, "Times New Roman", serif');
  const clue = wrap(ctx, q.clue.toUpperCase(), bw - 60 * u);
  const bh = (110 + clue.length * 34 + q.choices.length * 34) * u;
  const x = w / 2 - bw / 2, y = h / 2 - bh / 2;
  roundRect(ctx, x, y, bw, bh, 8 * u);
  ctx.fillStyle = '#060ce9';
  ctx.fill();
  ctx.strokeStyle = '#ffcc00';
  ctx.lineWidth = 4 * u;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffcc00';
  ctx.font = font(13 * u, 800, MONO);
  ctx.fillText(`${q.npc.name.toUpperCase()} PRESENTS: JEOPARDY!`, w / 2, y + 30 * u);
  ctx.fillStyle = '#ffffff';
  ctx.font = font(26 * u, 800, 'Georgia, "Times New Roman", serif');
  clue.forEach((l, i) => ctx.fillText(l, w / 2, y + (68 + i * 34) * u));
  ctx.textAlign = 'left';
  ctx.font = font(19 * u, 650);
  const cy = y + (78 + clue.length * 34) * u;
  q.choices.forEach((c, i) => {
    const ly = cy + i * 34 * u;
    roundRect(ctx, x + 40 * u, ly, 26 * u, 26 * u, 5 * u);
    ctx.fillStyle = '#ffcc00';
    ctx.fill();
    ctx.fillStyle = '#060ce9';
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), x + 53 * u, ly + 20 * u);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(c, x + 80 * u, ly + 20 * u, bw - 120 * u);
  });
  bar(ctx, x + 40 * u, y + bh - 22 * u, bw - 80 * u, 8 * u, p.lock / p.lockMax, '#ffcc00', u);
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
  const flare = g.flare.state === 'active';
  for (let y = 0; y < w.h; y++) {
    for (let x = 0; x < w.w; x++) {
      const t = w.get(x, y);
      if (!g.explored[y * w.w + x] && t !== T.SHELTER) continue;
      let c = TILE_COLORS[t] || '#556';
      if (t === T.WINDOW && flare) c = '#fff1b0';
      ctx.fillStyle = c;
      ctx.fillRect(ox + x * ts, oy + y * ts, Math.ceil(ts), Math.ceil(ts));
      if (t === T.FLOOR) {
        const e = w.exposure[y * w.w + x] * g.intensity;
        if (e > 0.08) {
          ctx.fillStyle = `rgba(255, 150, 40, ${Math.min(0.55, e * 0.6)})`;
          ctx.fillRect(ox + x * ts, oy + y * ts, Math.ceil(ts), Math.ceil(ts));
        }
      }
    }
  }
  const at = (px, py) => [ox + px * ts, oy + py * ts];
  const seen = (px, py) => g.explored[Math.floor(py) * w.w + Math.floor(px)];
  for (const it of g.items) {
    if (it.taken || !seen(it.x, it.y)) continue;
    const [sx, sy] = at(it.x, it.y);
    ctx.fillStyle = it.type === 'coffee' ? '#c58a5a' : it.type === 'memos' ? '#f2f2f2' : '#5ff0ff';
    ctx.fillRect(sx - ts * 0.2, sy - ts * 0.2, ts * 0.4, ts * 0.4);
  }
  for (const n of g.npcs) {
    if (!seen(n.x, n.y)) continue;
    const [sx, sy] = at(n.x, n.y);
    ctx.beginPath();
    ctx.arc(sx, sy, ts * 0.38, 0, Math.PI * 2);
    const helps = n.perk && (n.perk === 'jeopardy' ? n.cooldown <= 0 : !n.perkUsed);
    ctx.fillStyle = n.report ? (n.signed ? '#5fd38d' : '#ffd84a') : helps ? '#6fb7ff' : '#7f8da3';
    ctx.fill();
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
  if (readyCount(g) === g.reports.length) {
    for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) {
      if (w.get(x, y) !== T.SHELTER) continue;
      ctx.strokeStyle = `rgba(125, 255, 160, ${0.5 + 0.5 * Math.sin(time * 6)})`;
      ctx.lineWidth = 2 * u;
      ctx.strokeRect(ox + x * ts - 2 * u, oy + y * ts - 2 * u, ts + 4 * u, ts + 4 * u);
    }
  }
  const p = g.player;
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
  const legend = '■ yellow: sign-off needed   ■ green: signed off   ■ blue: coworker who can help   ■ cyan: key item   red ring: manager whose stamp you need   orange floor: radiation   cones: what bosses can see   (M to close)';
  wrap(ctx, legend, w - 60 * u).forEach((l, i) => ctx.fillText(l, w / 2, y0 + g.world.h * ts + (30 + i * 18) * u));
}
