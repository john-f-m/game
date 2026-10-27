// The office map: tiles, floor zones, collision, line of sight and
// pathfinding. No DOM access, so the test harness in tools/ can run it under
// Node.

export const T = {
  FLOOR: 0,
  BULKHEAD: 1,
  WINDOW: 2,
  CUBICLE: 3,
  FILING: 4,
  WHITEBOARD: 5,
  SERVER: 6,
  VENDING: 7,
  SHELTER: 8,
  OFFICE: 9,
  ELEVATOR: 10,
};

export const LEGEND = {
  '.': T.FLOOR,
  '#': T.BULKHEAD,
  W: T.WINDOW,
  C: T.CUBICLE,
  F: T.FILING,
  B: T.WHITEBOARD,
  R: T.SERVER,
  V: T.VENDING,
  S: T.SHELTER, // the stairwell door in the core
  O: T.OFFICE,
  E: T.ELEVATOR,
};

// Floor zones (office.json "zones"): decide the floor texture and make
// doorways and rooms easy to read.
export const ZONES = { c: 0, o: 1, d: 2, k: 3, i: 4, l: 5, p: 6 };

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class World {
  constructor(rows, warn = () => {}) {
    if (!Array.isArray(rows) || rows.length < 3 || rows.some((r) => typeof r !== 'string')) {
      throw new Error('office.json: "map" must be an array of at least 3 strings');
    }
    this.h = rows.length;
    this.w = Math.max(...rows.map((r) => r.length));
    this.tiles = new Uint8Array(this.w * this.h);
    // Tiles that are floor but occupied by something solid (people, plants).
    // Bosses path around them; the player collides with the object itself.
    this.occupied = new Uint8Array(this.w * this.h);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const ch = rows[y][x] ?? '#';
        let t = LEGEND[ch];
        if (t === undefined) {
          warn(`office.json: unknown map character "${ch}" at ${x},${y}; using a wall`);
          t = T.BULKHEAD;
        }
        const edge = x === 0 || y === 0 || x === this.w - 1 || y === this.h - 1;
        if (edge && t === T.FLOOR) {
          warn(`office.json: open floor on the map edge at ${x},${y}; sealing it`);
          t = T.BULKHEAD;
        }
        this.tiles[y * this.w + x] = t;
      }
    }
    this.zones = new Uint8Array(this.w * this.h);
    this.doorAdj = new Uint8Array(this.w * this.h);
    this.posters = new Uint8Array(this.w * this.h);
  }

  // Wall tiles that carry the "for the children" poster (office.json "posters").
  setPosters(list, warn = () => {}) {
    for (const at of Array.isArray(list) ? list : []) {
      const [x, y] = Array.isArray(at) ? at : [];
      if (Number.isInteger(x) && Number.isInteger(y) && this.isWall(x, y) && x >= 0 && y >= 0 && x < this.w && y < this.h) this.posters[y * this.w + x] = 1;
      else warn(`office.json posters: ${JSON.stringify(at)} is not a wall tile`);
    }
  }

  // rows: strings like the map, one zone letter per floor tile (see ZONES).
  // Wall tiles next to a doorway get flagged so they can show a door frame.
  setZones(rows, warn = () => {}) {
    if (!Array.isArray(rows)) return;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const ch = (rows[y] || '')[x];
        const z = ZONES[ch];
        if (z === undefined && ch !== '#' && ch !== undefined) warn(`office.json zones: unknown zone "${ch}" at ${x},${y}`);
        this.zones[y * this.w + x] = z ?? 0;
      }
    }
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (!this.isWall(x, y)) continue;
        const nextToDoor = DIRS4.some(([dx, dy]) => {
          const nx = x + dx, ny = y + dy;
          return !this.isWall(nx, ny) && this.zones[ny * this.w + nx] === ZONES.d;
        });
        if (nextToDoor) this.doorAdj[y * this.w + x] = 1;
      }
    }
  }

  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return T.BULKHEAD;
    return this.tiles[y * this.w + x];
  }

  isWall(x, y) {
    return this.get(x, y) !== T.FLOOR;
  }

  isWallAt(px, py) {
    return this.isWall(Math.floor(px), Math.floor(py));
  }

  walkable(x, y) {
    return !this.isWall(x, y) && !this.occupied[y * this.w + x];
  }

  // Moves a circle of radius r by (dx, dy), sliding along walls. Each axis is
  // resolved separately; r must be < 0.5 and the step < 1 - 2r.
  moveCircle(x, y, dx, dy, r) {
    let nx = x + dx;
    if (dx > 0) {
      const cx = Math.floor(nx + r);
      if (this.isWall(cx, Math.floor(y - r)) || this.isWall(cx, Math.floor(y + r))) nx = cx - r - 1e-4;
    } else if (dx < 0) {
      const cx = Math.floor(nx - r);
      if (this.isWall(cx, Math.floor(y - r)) || this.isWall(cx, Math.floor(y + r))) nx = cx + 1 + r + 1e-4;
    }
    let ny = y + dy;
    if (dy > 0) {
      const cy = Math.floor(ny + r);
      if (this.isWall(Math.floor(nx - r), cy) || this.isWall(Math.floor(nx + r), cy)) ny = cy - r - 1e-4;
    } else if (dy < 0) {
      const cy = Math.floor(ny - r);
      if (this.isWall(Math.floor(nx - r), cy) || this.isWall(Math.floor(nx + r), cy)) ny = cy + 1 + r + 1e-4;
    }
    return { x: nx, y: ny };
  }

  // True when the segment crosses no wall. If the segment ends inside a wall
  // tile (a window, say), reaching that tile counts as clear.
  clearLine(x0, y0, x1, y1) {
    let mx = Math.floor(x0), my = Math.floor(y0);
    const ex = Math.floor(x1), ey = Math.floor(y1);
    const dx = x1 - x0, dy = y1 - y0;
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tmx = dx > 0 ? (mx + 1 - x0) / dx : dx < 0 ? (x0 - mx) / -dx : Infinity;
    let tmy = dy > 0 ? (my + 1 - y0) / dy : dy < 0 ? (y0 - my) / -dy : Infinity;
    for (let guard = 0; guard < 256 && (mx !== ex || my !== ey); guard++) {
      if (tmx < tmy) { mx += sx; tmx += tdx; } else { my += sy; tmy += tdy; }
      if (mx === ex && my === ey) return true;
      if (this.isWall(mx, my)) return false;
    }
    return true;
  }

  // First wall tile hit walking from (x, y) along angle a, within maxDist.
  wallAhead(x, y, a, maxDist) {
    const dx = Math.cos(a), dy = Math.sin(a);
    for (let d = 0.05; d <= maxDist; d += 0.05) {
      const tx = Math.floor(x + dx * d), ty = Math.floor(y + dy * d);
      if (this.isWall(tx, ty)) return { x: tx, y: ty, tile: this.get(tx, ty), dist: d };
    }
    return null;
  }

  // Breadth-first search over walkable tiles (4-neighbour). Returns the list
  // of tiles to step through, excluding the start, or null if unreachable.
  findPath(sx, sy, tx, ty) {
    const { w, h } = this;
    if (sx === tx && sy === ty) return [];
    if (!this.walkable(tx, ty)) {
      const near = this.nearestWalkable(tx, ty);
      if (!near) return null;
      [tx, ty] = near;
      if (sx === tx && sy === ty) return [];
    }
    const prev = new Int32Array(w * h).fill(-1);
    const start = sy * w + sx, goal = ty * w + tx;
    prev[start] = start;
    const queue = new Int32Array(w * h);
    let head = 0, tail = 0;
    queue[tail++] = start;
    while (head < tail) {
      const cur = queue[head++];
      if (cur === goal) break;
      const cx = cur % w, cy = (cur / w) | 0;
      for (const [ox, oy] of DIRS4) {
        const nx = cx + ox, ny = cy + oy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (prev[n] !== -1) continue;
        // The start tile may be "occupied" (a boss brushing a plant); any
        // other occupied tile is avoided.
        if (this.isWall(nx, ny) || (this.occupied[n] && n !== goal)) continue;
        prev[n] = cur;
        queue[tail++] = n;
      }
    }
    if (prev[goal] === -1) return null;
    const path = [];
    for (let cur = goal; cur !== start; cur = prev[cur]) path.push([cur % w, (cur / w) | 0]);
    return path.reverse();
  }

  nearestWalkable(tx, ty) {
    const { w, h } = this;
    const seen = new Uint8Array(w * h);
    const queue = [[Math.max(0, Math.min(w - 1, tx)), Math.max(0, Math.min(h - 1, ty))]];
    seen[queue[0][1] * w + queue[0][0]] = 1;
    for (let i = 0; i < queue.length; i++) {
      const [x, y] = queue[i];
      if (this.walkable(x, y)) return [x, y];
      for (const [ox, oy] of DIRS4) {
        const nx = x + ox, ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[ny * w + nx]) continue;
        seen[ny * w + nx] = 1;
        queue.push([nx, ny]);
      }
    }
    return null;
  }

  // Set of floor tiles reachable from (sx, sy), as a Uint8Array mask.
  reachable(sx, sy, ignoreOccupied = false) {
    const { w, h } = this;
    const seen = new Uint8Array(w * h);
    if (this.isWall(sx, sy)) return seen;
    const queue = [[sx, sy]];
    seen[sy * w + sx] = 1;
    for (let i = 0; i < queue.length; i++) {
      const [x, y] = queue[i];
      for (const [ox, oy] of DIRS4) {
        const nx = x + ox, ny = y + oy, n = ny * w + nx;
        if (this.isWall(nx, ny) || seen[n]) continue;
        if (!ignoreOccupied && this.occupied[n]) continue;
        seen[n] = 1;
        queue.push([nx, ny]);
      }
    }
    return seen;
  }
}
