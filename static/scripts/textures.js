// Procedural pixel art: wall/floor/ceiling textures, the space panorama seen
// through windows, and the small sprites (coworkers, items, props, icons).
// Pixels are packed little-endian RGBA in a Uint32Array, the same layout as
// canvas ImageData, so they can be copied straight into the frame buffer.
//
// Alpha is used as a flag in wall/ceiling textures:
//   0   = window glass (the renderer shows space instead)
//   254 = emissive (lights, LEDs: not darkened by distance)

import { mulberry32 } from './game.js';

export const TEX = 64;
export const GLASS = 0;
export const EMISSIVE = 254;

export const rgba = (r, g, b, a = 255) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
export const hex = (h, a = 255) => {
  const n = parseInt(String(h).replace('#', ''), 16);
  return Number.isFinite(n) ? rgba((n >> 16) & 255, (n >> 8) & 255, n & 255, a) : rgba(255, 0, 255, a);
};
const cr = (c) => c & 255;
const cg = (c) => (c >>> 8) & 255;
const cb = (c) => (c >>> 16) & 255;
const ca = (c) => c >>> 24;
const sat = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
export const shade = (c, f) => rgba(sat(cr(c) * f), sat(cg(c) * f), sat(cb(c) * f), ca(c));
export const mix = (c1, c2, t) => rgba(
  sat(cr(c1) + (cr(c2) - cr(c1)) * t), sat(cg(c1) + (cg(c2) - cg(c1)) * t), sat(cb(c1) + (cb(c2) - cb(c1)) * t), ca(c1),
);

// 3x5 pixel font for labels painted onto textures.
const FONT = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'], B: ['##.', '#.#', '##.', '#.#', '##.'], C: ['###', '#..', '#..', '#..', '###'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'], E: ['###', '#..', '##.', '#..', '###'], F: ['###', '#..', '##.', '#..', '#..'],
  G: ['###', '#..', '#.#', '#.#', '###'], H: ['#.#', '#.#', '###', '#.#', '#.#'], I: ['###', '.#.', '.#.', '.#.', '###'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'], L: ['#..', '#..', '#..', '#..', '###'], M: ['#.#', '###', '###', '#.#', '#.#'],
  N: ['##.', '#.#', '#.#', '#.#', '#.#'], O: ['###', '#.#', '#.#', '#.#', '###'], P: ['##.', '#.#', '##.', '#..', '#..'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'], S: ['###', '#..', '###', '..#', '###'], T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'], V: ['#.#', '#.#', '#.#', '#.#', '.#.'], W: ['#.#', '#.#', '###', '###', '#.#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'], Y: ['#.#', '#.#', '.#.', '.#.', '.#.'], 0: ['###', '#.#', '#.#', '#.#', '###'],
  1: ['.#.', '##.', '.#.', '.#.', '###'], 2: ['###', '..#', '###', '#..', '###'], 3: ['###', '..#', '.##', '..#', '###'],
  4: ['#.#', '#.#', '###', '..#', '..#'], 5: ['###', '#..', '###', '..#', '###'], 7: ['###', '..#', '..#', '.#.', '.#.'],
  '-': ['...', '...', '###', '...', '...'], '!': ['.#.', '.#.', '.#.', '...', '.#.'], '?': ['###', '..#', '.##', '...', '.#.'],
  ' ': ['...', '...', '...', '...', '...'],
};

export class Tex {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint32Array(w * h);
  }

  px(x, y, c) {
    x |= 0; y |= 0;
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.data[y * this.w + x] = c;
    return this;
  }

  get(x, y) {
    x |= 0; y |= 0;
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.data[y * this.w + x] : 0;
  }

  rect(x, y, w, h, c) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.px(i, j, c);
    return this;
  }

  fill(c) {
    this.data.fill(c);
    return this;
  }

  // Multiplies every opaque pixel in the region by a random factor.
  noise(rng, amount, x0 = 0, y0 = 0, w = this.w, h = this.h) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const c = this.get(x, y);
        if (ca(c) === 255) this.px(x, y, shade(c, 1 + (rng() - 0.5) * amount));
      }
    }
    return this;
  }

  circle(cx, cy, r, c) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) this.px(x, y, c);
      }
    }
    return this;
  }

  tri(x0, y0, x1, y1, x2, y2, c) {
    const minX = Math.floor(Math.min(x0, x1, x2)), maxX = Math.ceil(Math.max(x0, x1, x2));
    const minY = Math.floor(Math.min(y0, y1, y2)), maxY = Math.ceil(Math.max(y0, y1, y2));
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area === 0) return this;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
        const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) this.px(x, y, c);
      }
    }
    return this;
  }

  text(str, x, y, c) {
    for (const ch of String(str).toUpperCase()) {
      const g = FONT[ch] || FONT['?'];
      g.forEach((row, j) => [...row].forEach((on, i) => { if (on === '#') this.px(x + i, y + j, c); }));
      x += 4;
    }
    return this;
  }

  // Draws a 1px outline in colour c around every opaque pixel.
  outline(c) {
    const src = this.data.slice();
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (ca(src[y * this.w + x]) !== 0) continue;
        const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
          const nx = x + dx, ny = y + dy;
          return nx >= 0 && ny >= 0 && nx < this.w && ny < this.h && ca(src[ny * this.w + nx]) !== 0;
        });
        if (near) this.data[y * this.w + x] = c;
      }
    }
    return this;
  }
}

// --------------------------------------------------------------- walls --

function bulkhead(rng, variant) {
  const t = new Tex(TEX, TEX).fill(hex('#3d4859'));
  t.noise(rng, 0.1);
  t.rect(0, 0, 64, 6, hex('#2c3543')).rect(0, 56, 64, 8, hex('#262e3a'));
  t.rect(0, 6, 64, 1, hex('#56647a')).rect(0, 55, 64, 1, hex('#1d242e'));
  for (const x of [0, 31, 32, 63]) t.rect(x, 0, 1, 64, hex('#232a35'));
  for (const [x, y] of [[4, 10], [27, 10], [36, 10], [59, 10], [4, 50], [27, 50], [36, 50], [59, 50]]) {
    t.px(x, y, hex('#7d8aa0')).px(x + 1, y + 1, hex('#1d242e'));
  }
  for (let x = 0; x < 64; x++) t.rect(x, 59, 1, 3, ((x >> 2) & 1) ? hex('#d9b21c') : hex('#1b1b1b'));
  if (variant === 1) t.text('BLDG 45', 4, 24, hex('#c9b56a'));
  if (variant === 2) for (let y = 18; y < 40; y += 4) t.rect(38, y, 20, 2, hex('#1a2029')).rect(38, y + 2, 20, 1, hex('#56647a'));
  return t.noise(rng, 0.05);
}

function windowTex(rng) {
  const t = new Tex(TEX, TEX).fill(rgba(0, 0, 0, GLASS));
  const frame = hex('#2b3241'), light = hex('#4b5568');
  t.rect(0, 0, 64, 7, hex('#363e4e')).rect(0, 57, 64, 7, hex('#363e4e'));
  t.rect(0, 0, 4, 64, frame).rect(60, 0, 4, 64, frame).rect(30, 0, 4, 64, frame);
  t.rect(0, 7, 64, 1, light).rect(0, 56, 64, 1, hex('#1c222c'));
  t.rect(4, 7, 1, 49, light).rect(34, 7, 1, 49, light);
  t.noise(rng, 0.08);
  return t;
}

function cubicle(rng, variant) {
  const t = new Tex(TEX, TEX).fill(hex('#7f8aa0'));
  t.noise(rng, 0.16);
  t.rect(0, 0, 64, 4, hex('#c7ccd5')).rect(0, 4, 64, 1, hex('#9aa1ad'));
  t.rect(0, 58, 64, 6, hex('#555c6b')).rect(0, 57, 64, 1, hex('#3e4450'));
  t.rect(0, 0, 2, 64, hex('#b3b9c4')).rect(62, 0, 2, 64, hex('#b3b9c4'));
  if (variant === 1) {
    t.rect(20, 16, 14, 17, hex('#f3f1ea'));
    for (let y = 20; y < 31; y += 3) t.rect(22, y, 10, 1, hex('#9b9a95'));
    t.rect(26, 15, 2, 2, hex('#d23c3c'));
  } else if (variant === 2) {
    t.rect(12, 18, 9, 9, hex('#f4d84a')).rect(24, 22, 9, 9, hex('#9be27c')).rect(38, 17, 9, 9, hex('#f49ac1'));
    t.text('TPS', 39, 19, hex('#5b3a5b'));
    t.rect(14, 21, 5, 1, hex('#7d6a20')).rect(14, 23, 4, 1, hex('#7d6a20'));
  } else if (variant === 3) {
    t.rect(36, 12, 18, 20, hex('#f6f6f6')).rect(36, 12, 18, 5, hex('#c94a3d'));
    for (let y = 19; y < 31; y += 3) for (let x = 38; x < 53; x += 3) t.px(x, y, hex('#777'));
    t.text('MON', 6, 40, hex('#4a5162'));
  }
  return t;
}

function filing(rng) {
  const t = new Tex(TEX, TEX).fill(hex('#b5ad9c'));
  t.noise(rng, 0.08);
  for (const x0 of [0, 32]) {
    t.rect(x0, 0, 1, 64, hex('#6f695e')).rect(x0 + 31, 0, 1, 64, hex('#6f695e'));
    for (let i = 0; i < 4; i++) {
      const y0 = 2 + i * 15;
      t.rect(x0 + 3, y0, 26, 13, hex('#c7bfad')).rect(x0 + 3, y0 + 12, 26, 1, hex('#7f786b')).rect(x0 + 3, y0, 26, 1, hex('#dcd5c4'));
      t.rect(x0 + 11, y0 + 8, 10, 2, hex('#5c574d'));
      t.rect(x0 + 8, y0 + 2, 16, 5, hex('#f2efe6'));
    }
    t.text(x0 ? 'TPS' : 'R-13', x0 + (x0 ? 11 : 9), 3, hex('#b02a2a'));
  }
  ['WKLY', 'DOSE', 'RISK'].forEach((label, i) => {
    t.text(label, 9, 19 + i * 15, hex('#4a4a4a'));
    t.text(['MSN', 'ASTR', 'MGMT'][i], 41, 19 + i * 15, hex('#4a4a4a'));
  });
  return t;
}

function whiteboard(rng) {
  const t = new Tex(TEX, TEX).fill(hex('#3d4859'));
  t.noise(rng, 0.08);
  t.rect(3, 6, 58, 44, hex('#aeb4bd')).rect(5, 8, 54, 40, hex('#eef1f3'));
  t.noise(rng, 0.03, 5, 8, 54, 40);
  t.text('SYNERGY', 8, 11, hex('#2c5ec9'));
  t.text('GO', 44, 11, hex('#2f9a4a')).text('NO', 44, 17, hex('#c93a3a'));
  t.text('TPS?', 38, 30, hex('#2f9a4a'));
  let y = 40;
  for (let x = 8; x < 32; x++) { y += rng() < 0.5 ? -1 : 1; y = Math.max(22, Math.min(44, y - (x % 5 === 0 ? 1 : 0))); t.px(x, y, hex('#c93a3a')); }
  t.rect(8, 22, 1, 23, hex('#555')).rect(8, 44, 24, 1, hex('#555'));
  t.circle(50, 14, 1.6, hex('#d23c3c')).circle(55, 14, 1.6, hex('#2c5ec9'));
  t.rect(10, 50, 44, 3, hex('#9aa1ad')).rect(16, 49, 6, 1, hex('#2c5ec9')).rect(26, 49, 6, 1, hex('#c93a3a'));
  return t;
}

function server(rng, frame) {
  const t = new Tex(TEX, TEX).fill(hex('#14171c'));
  const lr = mulberry32(99 + frame);
  for (const x0 of [2, 33]) {
    t.rect(x0, 2, 29, 60, hex('#1d2128'));
    for (let y = 4; y < 60; y += 6) {
      t.rect(x0 + 1, y, 27, 5, hex('#262b33')).rect(x0 + 1, y + 4, 27, 1, hex('#101317'));
      for (let x = x0 + 12; x < x0 + 26; x += 2) t.px(x, y + 2, hex('#0b0d10'));
      const leds = [hex('#3cff6e', EMISSIVE), hex('#45a6ff', EMISSIVE), hex('#ffb13b', EMISSIVE)];
      for (let k = 0; k < 3; k++) if (lr() < 0.7) t.px(x0 + 3 + k * 2, y + 2, leds[(lr() * 3) | 0]);
    }
  }
  return t.noise(rng, 0.06);
}

function vending(rng, variant) {
  const body = variant ? hex('#2f5d9e') : hex('#a8322d');
  const t = new Tex(TEX, TEX).fill(body);
  t.noise(rng, 0.08);
  t.rect(0, 0, 64, 2, hex('#1a1a1a')).rect(0, 62, 64, 2, hex('#1a1a1a'));
  t.rect(5, 12, 36, 44, hex('#151c26'));
  const colors = ['#e84a4a', '#f2c94c', '#6fcf97', '#56ccf2', '#bb6bd9', '#f2994a'].map((c) => hex(c));
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) t.rect(8 + col * 7, 15 + row * 8, 5, 6, colors[(row + col * 2 + variant) % colors.length]);
    t.rect(6, 21 + row * 8, 34, 1, hex('#3a4352'));
  }
  t.rect(5, 12, 1, 44, hex('#d7e3f0', EMISSIVE));
  t.rect(45, 14, 14, 20, hex('#2b2b2b'));
  for (let i = 0; i < 4; i++) t.rect(47, 16 + i * 4, 4, 2, hex('#ffe08a', EMISSIVE)).rect(53, 16 + i * 4, 4, 2, hex('#cccccc'));
  t.rect(48, 38, 8, 3, hex('#111')).rect(46, 46, 12, 6, hex('#111'));
  t.text(variant ? 'COFFEE' : 'SNACK', 6, 4, hex('#ffffff', EMISSIVE));
  return t;
}

// Stairwell door in the core (map tile S): steel fire door, exit sign.
function stairwell(rng) {
  const t = new Tex(TEX, TEX).fill(hex('#3d4859'));
  t.noise(rng, 0.08);
  t.rect(10, 8, 44, 50, hex('#5f6b7a')).rect(12, 10, 40, 48, hex('#7b8796'));
  t.noise(rng, 0.06, 12, 10, 40, 48);
  t.rect(12, 10, 40, 1, hex('#9aa6b5')).rect(31, 10, 2, 48, hex('#5f6b7a'));
  t.rect(36, 32, 10, 3, hex('#c9ced6')).rect(18, 32, 10, 3, hex('#c9ced6'));
  t.rect(20, 16, 24, 9, hex('#f4f1e8')).text('STAIRS', 21, 18, hex('#2d2a28'));
  t.rect(22, 1, 20, 6, hex('#0e3d1e')).text('EXIT', 24, 1, hex('#5dff8a', EMISSIVE));
  t.rect(0, 58, 64, 6, hex('#262e3a'));
  return t;
}

// Drywall next to a doorway: wooden jambs on both edges and a header, so
// office entrances stand out from the corridor.
function doorFrame(rng) {
  const t = officeWall(rng, 0);
  const wood = hex('#8b5a2b'), woodD = hex('#6b4423');
  t.rect(0, 0, 5, 57, wood).rect(59, 0, 5, 57, wood).rect(4, 0, 1, 57, woodD).rect(59, 0, 1, 57, woodD);
  t.rect(0, 0, 64, 4, wood).rect(0, 4, 64, 1, woodD);
  t.rect(22, 18, 20, 7, hex('#2d2a28')).rect(24, 20, 12, 1, hex('#e8e8e8')).rect(24, 22, 16, 1, hex('#bdbdbd'));
  return t;
}

// A wall texture with the "for the children" poster on it. poster is a
// 56x44 picture (static/sprites/posters/), framed with a caption below.
function posterWall(base, poster) {
  const t = new Tex(TEX, TEX);
  t.data.set(base.data);
  t.rect(2, 1, 60, 61, hex('#1f1b18')).rect(3, 2, 58, 59, hex('#f4f1e8'));
  for (let y = 0; y < 44; y++) for (let x = 0; x < 56; x++) {
    const c = poster.data[y * poster.w + x];
    if (ca(c) > 0) t.px(4 + x, 3 + y, c | 0xff000000);
  }
  t.text('FOR THE', 18, 49, hex('#1f1b18')).text('CHILDREN', 16, 55, hex('#1f1b18'));
  return t;
}

function officeWall(rng, variant) {
  const t = new Tex(TEX, TEX).fill(hex('#cdbfa3'));
  t.noise(rng, 0.06);
  t.rect(0, 0, 64, 2, hex('#e2d6bd')).rect(0, 57, 64, 7, hex('#5d5248')).rect(0, 56, 64, 1, hex('#8a7d6e'));
  const frame = hex('#2d2a28');
  if (variant === 1) {
    t.rect(22, 20, 20, 7, frame).rect(24, 22, 10, 1, hex('#e8e8e8')).rect(24, 24, 15, 1, hex('#bdbdbd'));
  } else if (variant === 2) {
    // Saturn V poster.
    t.rect(20, 6, 24, 44, frame).rect(22, 8, 20, 40, hex('#14213d'));
    for (let i = 0; i < 12; i++) t.px(23 + rng() * 18, 9 + rng() * 30, hex('#d9e2ff'));
    t.rect(30, 12, 4, 30, hex('#f2f2f2')).rect(31, 9, 2, 3, hex('#f2f2f2')).px(31, 8, hex('#f2f2f2'));
    for (const y of [17, 25, 33]) t.rect(30, y, 4, 2, hex('#1b1b1b'));
    t.rect(28, 38, 8, 4, hex('#f2f2f2')).rect(29, 42, 6, 3, hex('#ffb13b')).rect(30, 45, 4, 2, hex('#ff5a3c'));
  } else if (variant === 3) {
    // Framed mission patch.
    t.rect(19, 10, 26, 30, frame).rect(21, 12, 22, 26, hex('#f4f1e8'));
    t.circle(32, 23, 9, hex('#1d3f8f')).circle(32, 23, 6.5, hex('#2c5ec9'));
    for (let x = 25; x < 40; x++) t.px(x, 23 - (x - 25) * 0.5, hex('#f2f2f2')).px(x, 24 - (x - 25) * 0.5, hex('#d23c3c'));
    t.text('B45', 26, 33, hex('#2d2a28'));
  } else if (variant === 4) {
    // Corkboard.
    t.rect(14, 12, 36, 26, hex('#6b4a2b')).rect(16, 14, 32, 22, hex('#b9895a'));
    t.noise(rng, 0.15, 16, 14, 32, 22);
    t.rect(19, 17, 9, 11, hex('#f3f1ea')).rect(31, 16, 8, 8, hex('#f4d84a')).rect(40, 20, 7, 12, hex('#9fd3ff'));
    t.px(23, 17, hex('#d23c3c')).px(35, 16, hex('#2c5ec9')).px(43, 20, hex('#2f9a4a'));
  }
  return t;
}

function elevator(rng) {
  const t = new Tex(TEX, TEX).fill(hex('#4a4f57'));
  for (let x = 7; x < 57; x++) {
    const base = 150 + Math.round(Math.sin(x * 0.7) * 6 + (rng() - 0.5) * 10);
    t.rect(x, 12, 1, 46, rgba(base, base + 4, base + 10));
  }
  t.rect(31, 12, 2, 46, hex('#2a2d33')).rect(7, 12, 50, 1, hex('#d8dde4'));
  t.rect(4, 10, 56, 2, hex('#7d838c')).rect(4, 10, 3, 50, hex('#7d838c')).rect(57, 10, 3, 50, hex('#7d838c'));
  t.rect(24, 2, 16, 7, hex('#111')).text('5', 30, 3, hex('#ff4a3a', EMISSIVE));
  t.rect(60, 28, 3, 9, hex('#2a2d33')).px(61, 30, hex('#ffd27a', EMISSIVE)).px(61, 34, hex('#ffd27a', EMISSIVE));
  t.rect(0, 58, 64, 6, hex('#3a3e45'));
  return t;
}

// ------------------------------------------------------- floor / ceiling --

function carpet(rng, variant) {
  const t = new Tex(TEX, TEX).fill(variant ? hex('#3e4c5e') : hex('#394657'));
  t.noise(rng, 0.22);
  for (let i = 0; i < 90; i++) t.px(rng() * 64, rng() * 64, hex('#55657a'));
  t.rect(0, 0, 64, 1, hex('#2f3a48')).rect(0, 0, 1, 64, hex('#2f3a48'));
  return t;
}

// Floors per zone (world.js ZONES): c corridor, o office, d doorway,
// k break room, i console IT room, l lab, p copy room.
function zoneFloor(rng, zone, variant) {
  if (zone === 'c') return carpet(rng, variant);
  if (zone === 'o') {
    const t = new Tex(TEX, TEX).fill(variant ? hex('#7a6a58') : hex('#74654f'));
    t.noise(rng, 0.18);
    for (let i = 0; i < 70; i++) t.px(rng() * 64, rng() * 64, hex('#8e7d68'));
    return t.rect(0, 0, 64, 1, hex('#5f5243')).rect(0, 0, 1, 64, hex('#5f5243'));
  }
  if (zone === 'd') {
    const t = carpet(rng, 0);
    return t.rect(0, 26, 64, 12, hex('#9aa1ad')).rect(0, 26, 64, 1, hex('#c9ced6')).rect(0, 37, 64, 1, hex('#6b717c'));
  }
  if (zone === 'k') {
    const t = new Tex(TEX, TEX);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) t.px(x, y, ((x >> 4) + (y >> 4)) & 1 ? hex('#d9d2c0') : hex('#b9b09a'));
    return t.noise(rng, 0.06);
  }
  if (zone === 'i') {
    const t = new Tex(TEX, TEX).fill(hex('#9aa1ad'));
    t.noise(rng, 0.05);
    for (const v of [0, 32]) t.rect(v, 0, 1, 64, hex('#6b717c')).rect(0, v, 64, 1, hex('#6b717c'));
    for (let y = 6; y < 64; y += 8) for (let x = 6; x < 64; x += 8) t.px(x, y, hex('#7d838c'));
    return t;
  }
  if (zone === 'l') {
    const t = new Tex(TEX, TEX).fill(hex('#e3e6ea'));
    t.noise(rng, 0.04);
    for (const v of [0, 21, 42]) t.rect(v, 0, 1, 64, hex('#b9bec6')).rect(0, v, 64, 1, hex('#b9bec6'));
    return t;
  }
  const t = new Tex(TEX, TEX).fill(hex('#5c6470'));
  return t.noise(rng, 0.15);
}

function ceiling(rng, light) {
  const t = new Tex(TEX, TEX).fill(hex('#c4c8cf'));
  t.noise(rng, 0.05);
  for (let i = 0; i < 120; i++) t.px(rng() * 64, rng() * 64, hex('#a9aeb6'));
  t.rect(0, 0, 64, 1, hex('#8c929b')).rect(0, 0, 1, 64, hex('#8c929b')).rect(0, 32, 64, 1, hex('#a0a5ad')).rect(32, 0, 1, 64, hex('#a0a5ad'));
  if (light) {
    t.rect(10, 18, 44, 28, hex('#8c929b'));
    t.rect(12, 20, 40, 24, hex('#fffbe6', EMISSIVE));
    for (let x = 12; x < 52; x += 4) t.rect(x, 20, 1, 24, hex('#e9e4cc', EMISSIVE));
  }
  return t;
}

// ------------------------------------------------------------- panorama --

export const PANO_W = 1024;
export const PANO_H = 256;
export const SUN_AZ = -0.45;
const SUN_EL = 0.16;
const EARTH_AZ = -Math.PI / 2 - 0.25;
const EARTH_EL = -0.66;
const EARTH_R = 0.56;

// v index for an elevation angle (radians) and back.
export const panoV = (el) => Math.round(PANO_H / 2 - el * 190);
const panoEl = (v) => (PANO_H / 2 - v) / 190;
const panoAz = (u) => (u / PANO_W) * Math.PI * 2 - Math.PI;
const TAU = Math.PI * 2;
const wrapAngle = (a) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

function panorama(rng) {
  const t = new Tex(PANO_W, PANO_H);
  const glow = new Uint8Array(PANO_W * PANO_H);
  const blobs = Array.from({ length: 26 }, () => ({
    az: rng() * Math.PI * 2 - Math.PI, el: (rng() - 0.5) * 1.2, r: 0.15 + rng() * 0.35,
    c: [[60, 30, 90], [20, 50, 90], [80, 30, 60], [20, 70, 80]][(rng() * 4) | 0],
  }));
  const earthSpots = Array.from({ length: 40 }, () => ({
    az: EARTH_AZ + (rng() - 0.5) * EARTH_R * 2, el: EARTH_EL + (rng() - 0.3) * EARTH_R * 1.6, r: 0.03 + rng() * 0.09, land: rng() < 0.55,
  }));
  const sunX = Math.cos(SUN_EL) * Math.cos(SUN_AZ), sunY = Math.cos(SUN_EL) * Math.sin(SUN_AZ), sunZ = Math.sin(SUN_EL);

  for (let v = 0; v < PANO_H; v++) {
    const el = panoEl(v);
    for (let u = 0; u < PANO_W; u++) {
      const az = panoAz(u);
      let r = 3, g = 4, b = 12 + Math.max(0, -el) * 10;
      for (const bl of blobs) {
        if (Math.abs(el - bl.el) > bl.r) continue;
        const d = Math.hypot(wrapAngle(az - bl.az) * Math.cos(el), el - bl.el);
        if (d < bl.r) { const k = (1 - d / bl.r) ** 2 * 0.35; r += bl.c[0] * k; g += bl.c[1] * k; b += bl.c[2] * k; }
      }
      const ds = Math.hypot(wrapAngle(az - SUN_AZ) * Math.cos(el), el - SUN_EL);
      glow[v * PANO_W + u] = sat(255 * Math.exp(-((ds / 0.3) ** 2)));
      if (ds < 0.05) { r = 255; g = 250; b = 225; } else if (ds < 0.14) {
        const k = (1 - (ds - 0.05) / 0.09) ** 2;
        r += 255 * k; g += 190 * k; b += 90 * k;
      }
      // Earth, lit from the sun's direction.
      const de = Math.hypot(wrapAngle(az - EARTH_AZ) * Math.cos(el), el - EARTH_EL);
      if (de < EARTH_R) {
        const nx = wrapAngle(az - EARTH_AZ) / EARTH_R, ny = (el - EARTH_EL) / EARTH_R;
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        const px = Math.cos(EARTH_AZ) * nz - Math.sin(EARTH_AZ) * nx, py = Math.sin(EARTH_AZ) * nz + Math.cos(EARTH_AZ) * nx;
        const lit = Math.max(0.06, Math.min(1, (px * sunX + py * sunY + ny * sunZ) * 1.3 + 0.25));
        let er = 30, eg = 80, ebl = 170;
        for (const s of earthSpots) {
          if (Math.hypot(wrapAngle(az - s.az), el - s.el) < s.r) { if (s.land) { er = 70; eg = 120; ebl = 60; } else { er = 235; eg = 240; ebl = 245; } }
        }
        r = er * lit; g = eg * lit; b = ebl * lit;
      } else if (de < EARTH_R + 0.035) {
        const k = 1 - (de - EARTH_R) / 0.035;
        r += 60 * k; g += 140 * k; b += 255 * k;
      }
      t.data[v * PANO_W + u] = rgba(sat(r), sat(g), sat(b));
    }
  }
  for (let i = 0; i < 2200; i++) {
    const u = (rng() * PANO_W) | 0, v = (rng() * PANO_H) | 0;
    const el = panoEl(v), az = panoAz(u);
    if (Math.hypot(wrapAngle(az - EARTH_AZ) * Math.cos(el), el - EARTH_EL) < EARTH_R + 0.04) continue;
    const k = 120 + rng() * 135, tint = rng();
    t.data[v * PANO_W + u] = rgba(sat(k * (tint < 0.2 ? 1 : 0.85)), sat(k * 0.9), sat(k * (tint > 0.8 ? 1 : 0.9)));
    if (rng() < 0.06) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) t.px(u + dx, v + dy, rgba(sat(k * 0.5), sat(k * 0.5), sat(k * 0.55)));
  }
  return { tex: t, glow };
}

// Daytime view over a low-rise campus, for window_view: "houston".
function houstonPanorama(rng) {
  const t = new Tex(PANO_W, PANO_H);
  const glow = new Uint8Array(PANO_W * PANO_H);
  const clouds = Array.from({ length: 34 }, () => ({ az: rng() * TAU - Math.PI, el: 0.08 + rng() * 0.5, r: 0.05 + rng() * 0.12 }));
  const skyline = new Float32Array(PANO_W);
  const roof = new Uint32Array(PANO_W);
  for (let u = 0; u < PANO_W;) {
    const w = 10 + ((rng() * 50) | 0), h = rng() < 0.12 ? 0.06 + rng() * 0.05 : 0.015 + rng() * 0.03;
    const c = [hex('#d8d2c4'), hex('#c9c1b0'), hex('#e7e3da'), hex('#b8b2a6')][(rng() * 4) | 0];
    for (let i = 0; i < w && u < PANO_W; i++, u++) { skyline[u] = h; roof[u] = c; }
    const gap = (rng() * 30) | 0;
    for (let i = 0; i < gap && u < PANO_W; i++, u++) skyline[u] = 0;
  }
  for (let v = 0; v < PANO_H; v++) {
    const el = panoEl(v);
    for (let u = 0; u < PANO_W; u++) {
      const az = panoAz(u);
      let r, g, b;
      if (el > -0.03) {
        const k = Math.min(1, Math.max(0, el / 0.6));
        r = 200 - 140 * k; g = 222 - 110 * k; b = 240 - 60 * k;
        for (const c of clouds) {
          if (Math.abs(el - c.el) > c.r) continue;
          const d = Math.hypot(wrapAngle(az - c.az) * 0.5, el - c.el);
          if (d < c.r) { const m = (1 - d / c.r) * 0.8; r += (250 - r) * m; g += (250 - g) * m; b += (252 - b) * m; }
        }
        const top = -0.03 + skyline[u];
        if (el < top) {
          const c = roof[u];
          r = cr(c); g = cg(c); b = cb(c);
          if (((v >> 1) & 1) && (u & 3)) { r *= 0.55; g *= 0.6; b *= 0.7; }
        }
      } else if (el > -0.07) {
        const k = rng() * 0.2;
        r = 50 + 30 * k; g = 85 + 40 * k; b = 45;
      } else {
        const lot = Math.sin(az * 9) > 0.55 && el > -0.35;
        r = lot ? 120 : 92; g = lot ? 122 : 128; b = lot ? 118 : 70;
        if (lot && (u % 9 === 0)) { r = 230; g = 230; b = 225; }
      }
      const ds = Math.hypot(wrapAngle(az - SUN_AZ) * Math.cos(el), el - SUN_EL);
      glow[v * PANO_W + u] = sat(255 * Math.exp(-((ds / 0.3) ** 2)));
      if (ds < 0.045) { r = 255; g = 252; b = 235; }
      t.data[v * PANO_W + u] = rgba(sat(r), sat(g), sat(b));
    }
  }
  return { tex: t, glow };
}

// --------------------------------------------------------------- sprites --

export function person(look = {}, seed = 1) {
  const rng = mulberry32(seed);
  const t = new Tex(28, 50);
  const hair = hex(look.hair || '#3b2a1e'), skin = hex(look.skin || '#e0b08a');
  const shirt = hex(look.shirt || '#7aa0c8'), pants = hex(look.pants || '#353b48');
  const dark = hex('#16161d');
  t.rect(7, 46, 6, 3, hex('#2a2220')).rect(15, 46, 6, 3, hex('#2a2220'));
  t.rect(8, 34, 5, 12, pants).rect(15, 34, 5, 12, pants).rect(13, 34, 2, 3, pants);
  t.rect(8, 33, 12, 1, hex('#2b2b2b'));
  t.rect(7, 17, 14, 16, shirt).rect(18, 17, 3, 16, shade(shirt, 0.8));
  t.rect(4, 18, 3, 14, shade(shirt, 0.9)).rect(21, 18, 3, 14, shade(shirt, 0.75));
  t.rect(4, 32, 3, 3, skin).rect(21, 32, 3, 3, shade(skin, 0.85));
  t.rect(12, 17, 4, 2, hex('#f2f2f2')).rect(13, 19, 2, 1, shade(shirt, 0.6));
  t.rect(12, 15, 4, 2, shade(skin, 0.85));
  if (look.flightsuit) {
    // Flight suit: zipper, mission patch, name tape.
    t.rect(13, 19, 2, 14, shade(shirt, 1.25)).circle(9.5, 22, 1.8, hex('#f2f2f2')).px(9, 22, hex('#d23c3c')).px(10, 21, hex('#2c5ec9'));
    t.rect(16, 21, 4, 2, hex('#f2f2f2'));
  }
  if (look.rainbow_jacket) {
    // Open pony-fan jacket over a white tee, rainbow stripe across the chest.
    t.rect(12, 17, 4, 16, hex('#f6f6f6'));
    ['#e84a4a', '#f2994a', '#f2c94c', '#6fcf97', '#56ccf2', '#bb6bd9'].forEach((c, i) => {
      t.rect(7, 22 + i, 5, 1, hex(c)).rect(16, 22 + i, 5, 1, hex(c));
    });
    t.px(19, 19, hex('#ff8ad8')).px(20, 19, hex('#ff8ad8')).px(19, 20, hex('#ffd1f0'));
  }
  if (look.dress_shirt) {
    t.rect(13, 19, 2, 13, shade(shirt, 0.82)).px(13, 22, hex('#f2f2f2')).px(13, 26, hex('#f2f2f2'));
    t.rect(4, 30, 3, 2, hex('#f6f8fb')).rect(21, 30, 3, 2, hex('#e3e8ef'));
  }
  if (look.bracelets) {
    ['#ff8ad8', '#56ccf2', '#f2c94c'].forEach((c, i) => { t.px(4 + i, 31, hex(c)); t.px(21 + i, 31, hex(c)); });
  }
  t.rect(9, 4, 10, 11, skin).rect(17, 4, 2, 11, shade(skin, 0.88));
  if (look.bald) {
    t.rect(9, 2, 10, 3, skin).rect(10, 1, 8, 1, skin).rect(17, 2, 2, 3, shade(skin, 0.88)).rect(11, 2, 3, 1, shade(skin, 1.15));
  } else {
    t.rect(8, 2, 12, 4, hair).rect(8, 6, 2, 4, hair).rect(18, 6, 2, 3, hair);
    if (look.long_hair) t.rect(7, 5, 3, 13, hair).rect(18, 5, 3, 13, hair);
  }
  t.px(11, 9, dark).px(16, 9, dark).rect(12, 12, 4, 1, hex('#8a4a3a'));
  if (look.glasses === 'thick') {
    t.rect(9, 7, 4, 4, dark).rect(15, 7, 4, 4, dark).rect(13, 8, 2, 1, dark).rect(10, 8, 2, 2, hex('#cfe9ff')).rect(16, 8, 2, 2, hex('#cfe9ff'));
    t.px(11, 9, dark).px(16, 9, dark);
  } else if (look.glasses) {
    t.rect(10, 8, 3, 3, dark).rect(15, 8, 3, 3, dark).rect(13, 9, 2, 1, dark).px(11, 9, hex('#9fd3ff')).px(16, 9, hex('#9fd3ff'));
  }
  if (look.beard) t.rect(9, 11, 10, 4, hair).rect(10, 15, 8, 1, hair).rect(12, 12, 4, 1, hex('#8a4a3a'));
  if (look.mustache) {
    // Big plumber-style mustache.
    const m = hex(look.mustache);
    t.rect(10, 11, 8, 2, m).rect(9, 12, 2, 2, m).rect(17, 12, 2, 2, m).rect(12, 10, 4, 1, m);
  }
  if (look.tie) t.rect(13, 19, 2, 11, hex(look.tie)).rect(12, 29, 4, 2, hex(look.tie));
  if (look.headset) {
    // Mission Control headset: band over the head, earpiece, boom mic.
    t.rect(8, 1, 12, 1, dark).rect(7, 2, 1, 7, dark).rect(6, 7, 3, 4, hex('#3a3a44'));
    t.rect(8, 11, 1, 2, dark).rect(9, 13, 3, 1, dark).px(12, 13, hex('#555'));
  }
  t.noise(rng, 0.06);
  return t.outline(hex('#121218'));
}

function item(type) {
  const t = new Tex(20, 20);
  const dark = hex('#15151b');
  if (type === 'coffee') {
    t.rect(5, 7, 9, 11, hex('#f4f4f4')).rect(12, 7, 2, 11, hex('#d2d2d2')).rect(5, 7, 9, 2, hex('#5a3a22'));
    t.rect(14, 9, 3, 1, hex('#e6e6e6')).rect(16, 9, 1, 5, hex('#e6e6e6')).rect(14, 13, 3, 1, hex('#e6e6e6'));
    t.rect(6, 11, 6, 3, hex('#c94a3d'));
    for (const [x, y] of [[7, 5], [8, 4], [7, 3], [10, 5], [11, 4], [10, 3]]) t.px(x, y, hex('#d8dde3', 200));
  } else if (type === 'memos') {
    t.rect(4, 11, 13, 8, hex('#d9d9d2')).rect(3, 9, 13, 8, hex('#ebebe4')).rect(2, 7, 13, 8, hex('#fbfbf6'));
    for (let y = 9; y < 14; y += 2) t.rect(4, y, 9, 1, hex('#9a9a94'));
    t.rect(11, 6, 2, 4, hex('#4a7bd0'));
  } else if (type === 'timesheet') {
    t.rect(4, 2, 12, 16, hex('#f3e7a6'));
    for (let y = 7; y < 17; y += 2) t.rect(5, y, 10, 1, hex('#b5a65c'));
    for (let x = 8; x < 16; x += 3) t.rect(x, 7, 1, 10, hex('#b5a65c'));
    t.text('TS', 5, 2, hex('#c0392b'));
  } else if (type === 'r13') {
    t.rect(2, 2, 16, 18, hex('#8b5a2b')).rect(4, 5, 12, 14, hex('#fbfbf6')).rect(7, 1, 6, 4, hex('#b9c0c8'));
    t.text('R13', 4, 7, hex('#c0392b'));
    for (let y = 14; y < 18; y += 2) t.rect(5, y, 10, 1, hex('#9a9a94'));
  } else if (type === 'dosimetry') {
    // Folder of dosimeter readouts with a badge clipped on.
    t.rect(2, 4, 16, 14, hex('#2c5ec9')).rect(4, 2, 12, 14, hex('#fbfbf6'));
    for (let y = 5; y < 14; y += 2) t.rect(6, y, 8, 1, hex('#9a9a94'));
    t.rect(11, 9, 6, 8, hex('#e8e8e8')).rect(12, 10, 4, 3, hex('#d8342c')).rect(13, 7, 2, 2, hex('#9aa1ad'));
  }
  return t.outline(dark);
}

function decor(type, rng) {
  const dark = hex('#15151b');
  if (type === 'plant') {
    const t = new Tex(24, 40);
    t.rect(6, 29, 12, 10, hex('#b5653a')).rect(5, 28, 14, 2, hex('#c97a4c')).rect(14, 30, 4, 9, hex('#8f4c2a'));
    const greens = [hex('#3f8f3a'), hex('#2f6f2c'), hex('#5fae4a')];
    for (let i = 0; i < 70; i++) {
      const a = rng() * Math.PI - Math.PI, len = 4 + rng() * 14;
      const x = 12 + Math.cos(a) * len * 0.7, y = 27 + Math.sin(a) * len * 1.4;
      t.rect(x, y, 2, 2, greens[(rng() * 3) | 0]);
    }
    return t.outline(dark);
  }
  if (type === 'cooler') {
    const t = new Tex(20, 42);
    t.rect(3, 18, 14, 23, hex('#d8dde2')).rect(13, 18, 4, 23, hex('#b5bcc4'));
    t.rect(5, 2, 10, 15, hex('#6fa8dc')).rect(4, 5, 12, 10, hex('#6fa8dc')).rect(6, 3, 3, 10, hex('#a9d0f2')).rect(8, 16, 4, 3, hex('#4f86b8'));
    t.rect(6, 22, 2, 2, hex('#d23c3c')).rect(12, 22, 2, 2, hex('#2c6ed2'));
    t.rect(5, 30, 10, 1, hex('#9aa1ad'));
    return t.outline(dark);
  }
  if (type === 'printer') {
    const t = new Tex(32, 24);
    t.rect(1, 7, 30, 16, hex('#d3d3cf')).rect(1, 7, 30, 3, hex('#aaaaa6')).rect(25, 10, 6, 13, hex('#b9b9b5'));
    t.rect(8, 2, 16, 6, hex('#fbfbf6')).rect(9, 4, 12, 1, hex('#c4c4bf'));
    t.rect(4, 12, 10, 4, hex('#2a3a2a')).text('PC', 5, 12, hex('#9fe89f', EMISSIVE));
    t.rect(17, 13, 2, 2, hex('#ff5a3c', EMISSIVE));
    t.rect(5, 18, 20, 2, hex('#7b7b77'));
    return t.outline(dark);
  }
  if (type === 'console') {
    // Mission Control style console: three screens with plots, keyboard ledge.
    const c = new Tex(40, 28);
    c.rect(1, 12, 38, 15, hex('#5a6270')).rect(1, 12, 38, 2, hex('#7a8494')).rect(3, 16, 34, 3, hex('#3a404a'));
    for (let i = 0; i < 3; i++) {
      const x0 = 2 + i * 12;
      c.rect(x0, 1, 12, 11, hex('#22262e')).rect(x0 + 1, 2, 10, 8, hex('#0b1a12', EMISSIVE));
      for (let x = 0; x < 10; x++) c.px(x0 + 1 + x, 2 + Math.round(4 + Math.sin(x * 0.9 + i * 2) * 2.5), hex(['#3cff6e', '#ffb13b', '#45a6ff'][i], EMISSIVE));
    }
    c.rect(6, 21, 28, 2, hex('#2a2e36'));
    return c.outline(dark);
  }
  if (type === 'bench') {
    // Detector test bench: oscilloscope, a detector tube on a stand, cables.
    const b = new Tex(40, 26);
    b.rect(1, 12, 38, 4, hex('#c9ced6')).rect(1, 15, 38, 1, hex('#8a9099')).rect(3, 16, 3, 10, hex('#6b717c')).rect(34, 16, 3, 10, hex('#6b717c'));
    b.rect(3, 2, 14, 10, hex('#3a3f48')).rect(4, 3, 9, 7, hex('#0b1a12', EMISSIVE));
    for (let x = 0; x < 9; x++) b.px(4 + x, 6 + Math.round(Math.sin(x * 1.4) * 2), hex('#3cff6e', EMISSIVE));
    b.rect(14, 4, 2, 2, hex('#ffb13b', EMISSIVE)).rect(14, 7, 2, 2, hex('#9aa1ad'));
    b.rect(22, 3, 5, 9, hex('#d9a441')).rect(23, 1, 3, 2, hex('#9aa1ad')).rect(28, 9, 8, 3, hex('#5a6270'));
    b.rect(17, 8, 5, 1, hex('#e84a4a')).rect(27, 6, 1, 4, hex('#2c5ec9'));
    return b.outline(dark);
  }
  if (type === 'desk') {
    // Workstation: desk, monitor showing a dose table, keyboard.
    const d = new Tex(34, 26);
    d.rect(1, 14, 32, 3, hex('#8b5a2b')).rect(1, 16, 32, 1, hex('#6b4423')).rect(3, 17, 3, 9, hex('#6b4423')).rect(28, 17, 3, 9, hex('#6b4423'));
    d.rect(9, 1, 16, 11, hex('#22262e')).rect(10, 2, 14, 8, hex('#e8f2ff', EMISSIVE));
    for (let y = 3; y < 10; y += 2) d.rect(11, y, 12, 1, hex('#6fa8dc', EMISSIVE));
    d.rect(16, 11, 2, 3, hex('#3a3f48')).rect(10, 13, 14, 1, hex('#c9ced6'));
    return d.outline(dark);
  }
  const t = new Tex(16, 18);
  t.rect(3, 6, 10, 11, hex('#6b717c'));
  for (let x = 4; x < 13; x += 2) t.rect(x, 7, 1, 9, hex('#4f545d'));
  t.rect(2, 5, 12, 2, hex('#878d98')).circle(6, 4, 2.5, hex('#f2f2ee')).circle(10, 4, 2, hex('#e1e1da'));
  return t.outline(dark);
}

function icon(kind) {
  const dark = hex('#15151b');
  if (kind === 'talk' || kind === 'check' || kind === 'help') {
    const t = new Tex(13, 14);
    const bg = kind === 'talk' ? hex('#ffd84a') : kind === 'help' ? hex('#6fb7ff') : hex('#4ccf6a');
    t.rect(1, 1, 11, 9, bg).rect(2, 0, 9, 11, bg).tri(3, 9, 7, 9, 3, 13, bg);
    if (kind === 'talk') t.rect(6, 2, 2, 5, dark).rect(6, 8, 2, 1, dark);
    else if (kind === 'help') t.rect(4, 2, 5, 1, dark).rect(8, 3, 1, 2, dark).rect(6, 5, 2, 1, dark).rect(6, 6, 1, 1, dark).rect(6, 8, 1, 1, dark);
    else t.px(3, 5, hex('#fff')).px(4, 6, hex('#fff')).px(5, 7, hex('#fff')).px(6, 6, hex('#fff')).px(7, 5, hex('#fff')).px(8, 4, hex('#fff')).px(9, 3, hex('#fff'));
    return t.outline(dark);
  }
  if (kind === 'alert') {
    const t = new Tex(7, 15);
    t.rect(2, 1, 3, 9, hex('#ff3b3b')).rect(2, 11, 3, 3, hex('#ff3b3b'));
    return t.outline(dark);
  }
  if (kind === 'question') {
    const t = new Tex(11, 15);
    const y = hex('#ffd84a');
    t.rect(2, 1, 7, 2, y).rect(7, 2, 2, 4, y).rect(4, 6, 4, 2, y).rect(4, 8, 2, 2, y).rect(4, 11, 2, 2, y);
    return t.outline(dark);
  }
  if (kind === 'task') {
    // Orange bubble with a checklist: work waiting at this station.
    const t = new Tex(13, 14);
    const bg = hex('#ff9d3b');
    t.rect(1, 1, 11, 9, bg).rect(2, 0, 9, 11, bg).tri(3, 9, 7, 9, 3, 13, bg);
    for (const y of [2, 5, 8]) t.rect(3, y, 2, 2, dark).rect(6, y, 4, 1, dark);
    return t.outline(dark);
  }
  if (kind === 'swirl') {
    // Kevin's gravity well.
    const t = new Tex(15, 15);
    t.circle(7.5, 7.5, 7, hex('#3b1f5a')).circle(7.5, 7.5, 5, hex('#5b2f8a')).circle(7.5, 7.5, 2.5, hex('#0b0612'));
    for (let a = 0; a < 6.28; a += 0.5) t.px(7.5 + Math.cos(a) * (3 + a * 0.6), 7.5 + Math.sin(a) * (3 + a * 0.6), hex('#c9a6ff'));
    return t.outline(dark);
  }
  if (kind === 'update') {
    // Laptop stuck on "installing updates".
    const t = new Tex(17, 13);
    t.rect(2, 0, 13, 9, hex('#2b2f3a')).rect(3, 1, 11, 7, hex('#1f6fd1'));
    t.rect(4, 5, 9, 2, hex('#0e3d7a')).rect(4, 5, 5, 2, hex('#e8f2ff'));
    t.rect(0, 9, 17, 2, hex('#9aa3ad'));
    return t.outline(hex('#15151b'));
  }
  if (kind === 'stamp') {
    // Rubber stamp: wooden knob and handle, red rubber base.
    const t = new Tex(13, 15);
    t.circle(6.5, 3, 2.6, hex('#a8743f')).rect(5, 4, 3, 5, hex('#8b5a2b'));
    t.rect(2, 9, 9, 2, hex('#6b4a2b')).rect(1, 11, 11, 3, hex('#d8342c'));
    return t.outline(hex('#15151b'));
  }
  if (kind === 'stun') {
    const t = new Tex(17, 11);
    t.rect(2, 4, 6, 6, hex('#fbfbf6')).rect(9, 2, 6, 6, hex('#ebebe4'));
    for (const [x, y] of [[1, 1], [8, 0], [15, 9]]) t.px(x, y, hex('#ffe14a')).px(x + 1, y, hex('#ffe14a'));
    return t.outline(dark);
  }
  // Paper plane memo in flight.
  const t = new Tex(14, 8);
  t.tri(0, 4, 13, 1, 6, 7, hex('#fbfbf6')).tri(0, 4, 13, 1, 5, 4, hex('#d6d6cf'));
  return t.outline(hex('#5a5a5a'));
}

// First-person hand. kind: 'memo' | 'coffee' | 'empty'.
function hand(kind) {
  const t = new Tex(64, 48);
  const skin = hex('#e2a988'), skinD = hex('#c58a6b'), sleeve = hex('#c9d6e3'), cuff = hex('#a7b6c6');
  t.rect(34, 28, 30, 20, sleeve).rect(32, 28, 4, 20, cuff).rect(56, 28, 8, 20, hex('#aebccb'));
  t.rect(18, 22, 18, 16, skin).rect(18, 34, 18, 4, skinD);
  for (let i = 0; i < 4; i++) t.rect(18 + i * 4, 18 + (i === 0 ? 2 : 0), 3, 6, i % 2 ? skin : skinD);
  t.rect(12, 26, 8, 5, skin).rect(12, 30, 8, 2, skinD);
  if (kind === 'memo') {
    t.tri(0, 14, 44, 6, 26, 20, hex('#fbfbf6')).tri(0, 14, 44, 6, 20, 15, hex('#dcdcd5'));
    t.rect(18, 18, 3, 6, skin).rect(22, 18, 3, 5, skinD);
  } else if (kind === 'coffee') {
    t.rect(16, 2, 16, 22, hex('#f4f4f4')).rect(28, 2, 4, 22, hex('#d2d2d2')).rect(16, 2, 16, 3, hex('#5a3a22')).rect(18, 10, 12, 6, hex('#c94a3d'));
    t.rect(18, 18, 3, 6, skin).rect(22, 18, 3, 5, skinD);
  }
  return t.outline(hex('#121218'));
}

// Builds every texture and procedural sprite the renderer needs.
// extras.poster: optional 56x44 picture for the "for the children" posters.
export function buildTextures(npcLooks = [], view = 'houston', extras = {}) {
  const rng = mulberry32(1337);
  const walls = {
    1: [bulkhead(rng, 0), bulkhead(rng, 0), bulkhead(rng, 1), bulkhead(rng, 2)],
    2: [windowTex(rng)],
    3: [cubicle(rng, 0), cubicle(rng, 1), cubicle(rng, 0), cubicle(rng, 2), cubicle(rng, 3)],
    4: [filing(rng)],
    5: [whiteboard(rng)],
    6: [server(rng, 0)],
    7: [vending(rng, 0), vending(rng, 1)],
    8: [stairwell(rng)],
    9: [officeWall(rng, 0), officeWall(rng, 1), officeWall(rng, 0), officeWall(rng, 2), officeWall(rng, 1), officeWall(rng, 3), officeWall(rng, 0), officeWall(rng, 4)],
    10: [elevator(rng)],
  };
  // The poster goes up on drywall, cubicles and the core walls.
  if (extras.poster) {
    walls[9].push(posterWall(walls[9][0], extras.poster), posterWall(walls[9][2], extras.poster));
    walls[3].push(posterWall(walls[3][0], extras.poster));
    walls[1].push(posterWall(walls[1][0], extras.poster));
  }
  const serverAlt = [server(rng, 1)];
  const pano = view === 'orbit' ? panorama(rng) : houstonPanorama(rng);
  const floors = ['c', 'o', 'd', 'k', 'i', 'l', 'p'].map((z) => [zoneFloor(rng, z, 0), zoneFloor(rng, z, 1)]);
  return {
    walls,
    doorFrame: doorFrame(rng),
    serverAlt,
    floors,
    ceiling: [ceiling(rng, false), ceiling(rng, true)],
    pano: pano.tex,
    glow: pano.glow,
    people: npcLooks.map((look, i) => person(look, 50 + i)),
    genericPerson: person({ hair: '#555', shirt: '#888', pants: '#333' }, 7),
    items: Object.fromEntries(['coffee', 'memos', 'timesheet', 'r13', 'dosimetry'].map((k) => [k, item(k)])),
    decor: Object.fromEntries(['plant', 'cooler', 'printer', 'trash', 'console', 'bench', 'desk'].map((k) => [k, decor(k, rng)])),
    icons: Object.fromEntries(['talk', 'check', 'help', 'task', 'swirl', 'alert', 'question', 'stun', 'update', 'stamp', 'memo'].map((k) => [k, icon(k)])),
    hands: { memo: hand('memo'), coffee: hand('coffee'), empty: hand('empty') },
  };
}
