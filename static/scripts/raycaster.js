// First-person renderer. Draws the world into a Uint32Array frame buffer
// (same byte layout as canvas ImageData): textured floor and ceiling, walls
// via DDA ray casting, windows showing space, then depth-sorted billboard
// sprites and the player's hand. No DOM access, so it also runs under Node.

import { T } from './world.js';
import { pendingStamps, TASKS } from './game.js';
import { TEX, GLASS, EMISSIVE, PANO_W, PANO_H } from './textures.js';

const FOG_R = 12, FOG_G = 14, FOG_B = 26;
const FOG = (0xff000000 | (FOG_B << 16) | (FOG_G << 8) | FOG_R) >>> 0;

const light = (d) => (d < 1.2 ? 1 : Math.max(0.16, 1.12 - d * 0.08));

function lit(c, L) {
  const inv = 1 - L;
  const r = (c & 255) * L + FOG_R * inv;
  const g = ((c >>> 8) & 255) * L + FOG_G * inv;
  const b = ((c >>> 16) & 255) * L + FOG_B * inv;
  return 0xff000000 | (b << 16) | (g << 8) | r;
}

function tint(c, t, k) {
  const r = (c & 255) + ((t & 255) - (c & 255)) * k;
  const g = ((c >>> 8) & 255) + (((t >>> 8) & 255) - ((c >>> 8) & 255)) * k;
  const b = ((c >>> 16) & 255) + (((t >>> 16) & 255) - ((c >>> 16) & 255)) * k;
  return ((c >>> 24) << 24) | (b << 16) | (g << 8) | r;
}

const STUN_TINT = 0xffffd08a; // pale blue (ABGR)
const tileHash = (x, y) => ((x * 73856093) ^ (y * 19349663)) >>> 0;

const DECOR_HEIGHT = { plant: 0.62, cooler: 0.64, printer: 0.42, trash: 0.3, console: 0.5, bench: 0.48, desk: 0.5 };
const STATION_SPRITE = { detector_bench: 'bench', vehicle_sim: 'console', dose_calc: 'desk', srag_console: 'console' };
const TASK_STATION = Object.fromEntries(Object.entries(TASKS).map(([k, t]) => [k, t.station]));

export class Raycaster {
  // bossSprites: { [id]: { frames: Tex[], views: [[degrees, frameIndex, flip?]], height } }
  constructor(textures, bossSprites = {}) {
    this.tx = textures;
    this.bossSprites = bossSprites;
    this.sprites = [];
  }

  resize(W, H, fb) {
    this.W = W;
    this.H = H;
    this.fb = fb || new Uint32Array(W * H);
    this.zbuf = new Float32Array(W);
    this.focal = H; // pixels per world unit at distance 1
    this.plane = W / (2 * this.focal);
    this.colAz = new Float32Array(W);
    for (let x = 0; x < W; x++) this.colAz[x] = Math.atan(((2 * (x + 0.5)) / W - 1) * this.plane);
    this.rowV = new Int32Array(H);
  }

  render(g, time) {
    const { W, H, fb, focal } = this;
    const p = g.player, world = g.world;
    const dirX = Math.cos(p.a), dirY = Math.sin(p.a);
    const planeX = -dirY * this.plane, planeY = dirX * this.plane;
    let horizon = H / 2 + Math.sin(p.bob) * H * 0.006;
    if (p.lock > 0) horizon -= H * 0.08 * Math.min(1, p.lock / 0.4);

    for (let y = 0; y < H; y++) {
      const el = Math.atan((horizon - y - 0.5) / focal);
      this.rowV[y] = Math.max(0, Math.min(PANO_H - 1, Math.round(PANO_H / 2 - el * 190)));
    }

    this.cam = { px: p.x, py: p.y, dirX, dirY, planeX, planeY, horizon, invDet: 1 / (planeX * dirY - dirX * planeY) };
    this.drawFloorCeiling(g, dirX, dirY, planeX, planeY, horizon);
    this.drawWalls(g, dirX, dirY, planeX, planeY, horizon, time);
    this.drawSprites(g, dirX, dirY, planeX, planeY, horizon, time);
    this.drawHand(p);
    return fb;
  }

  // Where a world point (height z in wall units) lands on the frame buffer
  // in the last rendered frame, or null if off screen or behind a wall.
  // The HUD uses it to put name tags over people's heads.
  project(x, y, z) {
    const c = this.cam;
    if (!c) return null;
    const rx = x - c.px, ry = y - c.py;
    const tX = c.invDet * (c.dirY * rx - c.dirX * ry);
    const tY = c.invDet * (-c.planeY * rx + c.planeX * ry);
    if (tY < 0.2) return null;
    const sx = (this.W / 2) * (1 + tX / tY);
    if (sx < 0 || sx >= this.W || tY >= this.zbuf[Math.floor(sx)]) return null;
    const scale = this.focal / tY;
    return { x: sx, y: c.horizon + 0.5 * scale - z * scale, depth: tY };
  }

  drawFloorCeiling(g, dirX, dirY, planeX, planeY, horizon) {
    const { W, H, fb, focal } = this;
    const p = g.player, zones = g.world.zones, mapW = g.world.w, mapH = g.world.h;
    const rdx0 = dirX - planeX, rdy0 = dirY - planeY;
    const rdx1 = dirX + planeX, rdy1 = dirY + planeY;
    const posZ = 0.5 * focal;
    const floors = this.tx.floors, ceils = this.tx.ceiling;
    for (let y = 0; y < H; y++) {
      const below = y + 0.5 > horizon;
      const pd = below ? y + 0.5 - horizon : horizon - y - 0.5;
      const row = y * W;
      if (pd < 0.5) { fb.fill(FOG, row, row + W); continue; }
      const dist = posZ / pd;
      const L = light(dist) * (below ? 1 : 0.92);
      const sx = (dist * (rdx1 - rdx0)) / W, sy = (dist * (rdy1 - rdy0)) / W;
      let fx = p.x + dist * rdx0, fy = p.y + dist * rdy0;
      for (let x = 0; x < W; x++) {
        const cx = Math.floor(fx), cy = Math.floor(fy);
        const tx = ((fx - cx) * TEX) & 63, ty = ((fy - cy) * TEX) & 63;
        let tex;
        if (below) {
          const z = cx >= 0 && cy >= 0 && cx < mapW && cy < mapH ? zones[cy * mapW + cx] : 0;
          tex = floors[z][(cx + cy) & 1];
        } else {
          tex = ceils[cx % 3 === 1 && (cy & 1) === 0 ? 1 : 0];
        }
        const c = tex.data[(ty << 6) | tx];
        fb[row + x] = c >>> 24 === EMISSIVE ? c | 0xff000000 : lit(c, L);
        fx += sx;
        fy += sy;
      }
    }
  }

  wallTexture(tile, mx, my, time, world) {
    if (tile === T.SERVER && ((time * 2) | 0) & 1) return this.tx.serverAlt[0];
    if (world.posters[my * world.w + mx] && this.tx.posters[tile]) return this.tx.posters[tile];
    if (tile === T.OFFICE && world.doorAdj[my * world.w + mx]) return this.tx.doorFrame;
    const list = this.tx.walls[tile] || this.tx.walls[T.BULKHEAD];
    return list[tileHash(mx, my) % list.length];
  }

  drawWalls(g, dirX, dirY, planeX, planeY, horizon, time) {
    const { W, H, fb, focal } = this;
    const p = g.player, world = g.world, explored = g.explored;
    const mapW = world.w, mapH = world.h;
    const pano = this.tx.pano.data, glow = this.tx.glow;
    const flare = g.flare.state === 'active' ? 1.6 : g.flare.state === 'warning' ? 0.4 + 0.3 * Math.sin(time * 18) : 0;
    const sunBoost = 0.35 + g.intensity * 0.6 + flare;
    const heat = g.intensity * 14;

    for (let x = 0; x < W; x++) {
      const camX = (2 * (x + 0.5)) / W - 1;
      const rdx = dirX + planeX * camX, rdy = dirY + planeY * camX;
      let mx = Math.floor(p.x), my = Math.floor(p.y);
      const ddx = rdx === 0 ? 1e30 : Math.abs(1 / rdx);
      const ddy = rdy === 0 ? 1e30 : Math.abs(1 / rdy);
      let stepX, stepY, sdx, sdy;
      if (rdx < 0) { stepX = -1; sdx = (p.x - mx) * ddx; } else { stepX = 1; sdx = (mx + 1 - p.x) * ddx; }
      if (rdy < 0) { stepY = -1; sdy = (p.y - my) * ddy; } else { stepY = 1; sdy = (my + 1 - p.y) * ddy; }
      let side = 0, tile = T.BULKHEAD;
      for (let i = 0; i < 96; i++) {
        if (sdx < sdy) { sdx += ddx; mx += stepX; side = 0; } else { sdy += ddy; my += stepY; side = 1; }
        if (mx >= 0 && my >= 0 && mx < mapW && my < mapH) explored[my * mapW + mx] = 1;
        tile = world.get(mx, my);
        if (tile !== T.FLOOR) break;
      }
      const perp = Math.max(0.01, side === 0 ? sdx - ddx : sdy - ddy);
      this.zbuf[x] = perp;
      const lineH = focal / perp;
      const top = horizon - lineH / 2;
      let wallX = side === 0 ? p.y + perp * rdy : p.x + perp * rdx;
      wallX -= Math.floor(wallX);
      let texX = (wallX * TEX) | 0;
      // Mirror so textures (and the text painted on them) read left to right.
      if ((side === 0 && rdx < 0) || (side === 1 && rdy > 0)) texX = TEX - 1 - texX;
      const tex = (mx >= 0 && my >= 0 && mx < mapW && my < mapH ? this.wallTexture(tile, mx, my, time, world) : this.tx.walls[T.BULKHEAD][0]).data;
      const L = light(perp) * (side ? 0.8 : 1);
      const y0 = Math.max(0, Math.ceil(top)), y1 = Math.min(H - 1, Math.floor(top + lineH));
      const step = TEX / lineH;
      let tpos = (y0 - top) * step;
      let u = Math.floor(((p.a + this.colAz[x]) / (Math.PI * 2) + 0.5) * PANO_W) % PANO_W;
      if (u < 0) u += PANO_W;
      for (let y = y0; y <= y1; y++) {
        const ty = Math.min(TEX - 1, tpos | 0);
        tpos += step;
        const c = tex[(ty << 6) | texX];
        const a = c >>> 24;
        if (a === GLASS) {
          const i = this.rowV[y] * PANO_W + u;
          const s = pano[i], k = (glow[i] / 255) * sunBoost;
          const r = Math.min(255, (s & 255) + k * 255 + heat);
          const gg = Math.min(255, ((s >>> 8) & 255) + k * 200);
          const b = Math.min(255, ((s >>> 16) & 255) + k * 110);
          fb[y * W + x] = 0xff000000 | (b << 16) | (gg << 8) | r;
        } else if (a === EMISSIVE) {
          fb[y * W + x] = c | 0xff000000;
        } else {
          fb[y * W + x] = lit(c, L);
        }
      }
    }
  }

  bossFrame(b, p) {
    const set = this.bossSprites[b.id];
    if (!set || !set.frames.length) return { tex: this.tx.genericPerson, flip: false, h: 0.72 };
    // Angle from the boss's facing direction to the camera: 0 = we see their front.
    let rel = ((Math.atan2(p.y - b.y, p.x - b.x) - b.a) * 180) / Math.PI;
    rel = ((rel % 360) + 360) % 360;
    let best = set.views[0], bestD = 999;
    for (const v of set.views) {
      const d = Math.min(Math.abs(rel - v[0]), 360 - Math.abs(rel - v[0]));
      if (d < bestD) { bestD = d; best = v; }
    }
    return { tex: set.frames[best[1]] || set.frames[0], flip: !!best[2], h: set.height };
  }

  collectSprites(g, time) {
    const list = this.sprites;
    list.length = 0;
    const tx = this.tx, p = g.player;
    for (const b of g.bosses) {
      const f = this.bossFrame(b, p);
      const z = b.moving ? Math.abs(Math.sin(b.walkPhase)) * 0.03 : 0;
      list.push({ x: b.x, y: b.y, z, h: f.h, tex: f.tex, flip: f.flip, tint: b.stun > 0 ? STUN_TINT : 0, flash: b.flash > 0 });
      // Rubber stamp over a manager whose approval you still need, unless
      // they're busy being alarmed.
      const ic = b.stun > 0 ? (b.stunKind === 'update' ? tx.icons.update : tx.icons.stun) : b.state === 'chase' ? tx.icons.alert : b.alert > 0.15 || b.state === 'search' ? tx.icons.question
        : pendingStamps(g, b.id).length ? tx.icons.stamp : null;
      if (ic) list.push({ x: b.x, y: b.y, z: f.h + z + 0.04 + Math.sin(time * 6) * 0.01, h: ic === tx.icons.stun ? 0.1 : 0.15, tex: ic, bright: true });
    }
    const astronautDue = g.reports.some((r) => r.task && r.task.type === 'astronaut' && !r.task.done);
    for (const n of g.npcs) {
      if (!n.present) continue;
      const z = n.moving ? Math.abs(Math.sin(n.walkPhase)) * 0.025 : 0;
      list.push({ x: n.x, y: n.y, z, h: 0.7, tex: tx.people[n.index] || tx.genericPerson });
      // Yellow "!" = report sign-off (or debrief) still needed, blue "?" =
      // optional help available, green check = done. Kevin's gravity well
      // gets a warning instead.
      const icon = n.blackHole && n.chatCd <= 0 ? tx.icons.swirl
        : n.report && !n.signed ? tx.icons.talk
          : n.debrief ? (astronautDue ? tx.icons.talk : null)
            : n.gives ? (n.gave ? tx.icons.check : tx.icons.talk)
              : n.perk === 'jeopardy' ? (n.cooldown <= 0 ? tx.icons.help : null)
                : n.perk && !n.perkUsed ? tx.icons.help
                  : n.report || n.perkUsed ? tx.icons.check : null;
      if (icon) list.push({ x: n.x, y: n.y, z: 0.76 + z + Math.sin(time * 3 + n.index) * 0.015, h: icon === tx.icons.swirl ? 0.16 : 0.12, tex: icon, bright: true });
    }
    for (const s of g.stations) {
      const kind = STATION_SPRITE[s.type] || 'console';
      list.push({ x: s.x, y: s.y, z: 0, h: DECOR_HEIGHT[kind] ?? 0.45, tex: tx.decor[kind] });
      const due = s.type === 'srag_console' ? g.allReady
        : g.reports.some((r) => r.task && !r.task.done && TASK_STATION[r.task.type] === s.type);
      if (due) list.push({ x: s.x, y: s.y, z: 0.62 + Math.sin(time * 3 + s.x) * 0.015, h: 0.12, tex: s.type === 'srag_console' ? tx.icons.check : tx.icons.task, bright: true });
    }
    for (const it of g.items) {
      if (it.taken) continue;
      list.push({ x: it.x, y: it.y, z: 0.08 + Math.sin(time * 3 + it.x * 2) * 0.03, h: 0.2, tex: tx.items[it.type], bright: true });
    }
    for (const d of g.decor) list.push({ x: d.x, y: d.y, z: 0, h: DECOR_HEIGHT[d.type] ?? 0.4, tex: tx.decor[d.type] || tx.decor.trash });
    for (const pr of g.projectiles) list.push({ x: pr.x, y: pr.y, z: pr.z, h: 0.07, tex: tx.icons.memo, bright: true });
    for (const s of list) s.d = (s.x - p.x) ** 2 + (s.y - p.y) ** 2;
    list.sort((a, b) => b.d - a.d);
    return list;
  }

  drawSprites(g, dirX, dirY, planeX, planeY, horizon, time) {
    const { W, H, fb, focal, zbuf } = this;
    const p = g.player;
    const invDet = 1 / (planeX * dirY - dirX * planeY);
    for (const s of this.collectSprites(g, time)) {
      const rx = s.x - p.x, ry = s.y - p.y;
      const tX = invDet * (dirY * rx - dirX * ry);
      const tY = invDet * (-planeY * rx + planeX * ry);
      if (tY < 0.12) continue;
      const scale = focal / tY;
      const tex = s.tex, tw = tex.w, th = tex.h, td = tex.data;
      const sh = s.h * scale, sw = (sh * tw) / th;
      const sx = (W / 2) * (1 + tX / tY);
      const bottom = horizon + 0.5 * scale - s.z * scale;
      const top = bottom - sh, left = sx - sw / 2;
      const x0 = Math.max(0, Math.ceil(left)), x1 = Math.min(W - 1, Math.floor(left + sw));
      const y0 = Math.max(0, Math.ceil(top)), y1 = Math.min(H - 1, Math.floor(bottom));
      if (x0 > x1 || y0 > y1) continue;
      const L = s.bright ? Math.max(0.85, light(tY)) : light(tY);
      const ustep = tw / sw, vstep = th / sh;
      for (let x = x0; x <= x1; x++) {
        if (tY >= zbuf[x]) continue;
        let u = ((x - left) * ustep) | 0;
        if (u >= tw) u = tw - 1;
        if (s.flip) u = tw - 1 - u;
        let vpos = (y0 - top) * vstep;
        for (let y = y0; y <= y1; y++) {
          const v = Math.min(th - 1, vpos | 0);
          vpos += vstep;
          let c = td[v * tw + u];
          const a = c >>> 24;
          if (a < 128) continue;
          if (s.flash) c = 0xffffffff;
          else {
            if (s.tint) c = tint(c, s.tint, 0.45);
            c = a === EMISSIVE ? c | 0xff000000 : lit(c, L);
          }
          fb[y * W + x] = c;
        }
      }
    }
  }

  drawHand(p) {
    if (p.lock > 0) return;
    const { W, H, fb } = this;
    const hands = this.tx.hands;
    const throwing = p.throwAnim > 0;
    const tex = p.drinkAnim > 0 ? hands.coffee : !throwing && p.memos > 0 ? hands.memo : hands.empty;
    const s = Math.max(1, Math.round(H / 170));
    const sway = p.moving ? 1 : 0.25;
    let dx = Math.cos(p.bob * 0.5) * 4 * s * sway, dy = Math.abs(Math.sin(p.bob * 0.5)) * 4 * s * sway;
    if (throwing) { const k = Math.sin((1 - p.throwAnim / 0.3) * Math.PI); dx -= k * 14 * s; dy -= k * 10 * s; }
    if (p.drinkAnim > 0) dy -= Math.sin((1 - p.drinkAnim / 0.8) * Math.PI) * 16 * s;
    const x0 = Math.round(W - tex.w * s - W * 0.06 + dx), y0 = Math.round(H - tex.h * s + 8 * s + dy);
    for (let ty = 0; ty < tex.h; ty++) {
      for (let tx = 0; tx < tex.w; tx++) {
        const c = tex.data[ty * tex.w + tx];
        if (c >>> 24 < 128) continue;
        const out = lit(c, 0.95);
        for (let j = 0; j < s; j++) {
          const y = y0 + ty * s + j;
          if (y < 0 || y >= H) continue;
          for (let i = 0; i < s; i++) {
            const x = x0 + tx * s + i;
            if (x >= 0 && x < W) fb[y * W + x] = out;
          }
        }
      }
    }
  }
}
