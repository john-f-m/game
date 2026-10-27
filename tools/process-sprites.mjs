#!/usr/bin/env node
// Turns the original sprite PNGs (solid backdrop, 341-384 x 512) into
// game-ready sprites: backdrop removed, all frames of a character cropped to
// one shared box (so feet line up between frames), and downscaled 2x.
//
// Usage: node tools/process-sprites.mjs
// Needs ffmpeg/ffprobe on PATH (only to decode/encode PNG). The outputs are
// committed, so the game itself never needs this script.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'sprites');
const OUT = join(ROOT, 'static', 'sprites');
const CHARACTERS = ['eddie', 'clifton'];
const SCALE = 2; // integer downscale factor
const PAD = 4; // source pixels of padding around the shared crop box

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString();
  const [w, h] = out.trim().split(',').map(Number);
  return { w, h };
}

function decode(file) {
  const { w, h } = probe(file);
  const rgb = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 64 << 20 });
  return { w, h, rgb };
}

function encode(file, w, h, rgba) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`,
    '-i', '-', '-frames:v', '1', file], { input: rgba });
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// Box blur of radius r on an RGB buffer -> Float32Array RGB.
function blur(img, r) {
  const { w, h, rgb } = img;
  const tmp = new Float32Array(w * h * 3);
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s0 = 0, s1 = 0, s2 = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k; if (xx < 0 || xx >= w) continue;
        const i = (y * w + xx) * 3; s0 += rgb[i]; s1 += rgb[i + 1]; s2 += rgb[i + 2]; n++;
      }
      const o = (y * w + x) * 3; tmp[o] = s0 / n; tmp[o + 1] = s1 / n; tmp[o + 2] = s2 / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s0 = 0, s1 = 0, s2 = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k; if (yy < 0 || yy >= h) continue;
        const i = (yy * w + x) * 3; s0 += tmp[i]; s1 += tmp[i + 1]; s2 += tmp[i + 2]; n++;
      }
      const o = (y * w + x) * 3; out[o] = s0 / n; out[o + 1] = s1 / n; out[o + 2] = s2 / n;
    }
  }
  return out;
}

// Returns a Uint8Array mask: 1 = backdrop, 0 = character.
function backdropMask(img) {
  const { w, h, rgb } = img;
  // Backdrop colour = median of the top row and side columns (the feet can
  // touch the bottom edge, so it is left out).
  const edge = [];
  for (let x = 0; x < w; x++) edge.push(x);
  for (let y = 0; y < h; y++) edge.push(y * w, y * w + w - 1);
  const bg = [0, 1, 2].map((c) => median(edge.map((p) => rgb[p * 3 + c])));

  const soft = blur(img, 2);
  const dist = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    dist[p] = Math.hypot(soft[p * 3] - bg[0], soft[p * 3 + 1] - bg[1], soft[p * 3 + 2] - bg[2]);
  }
  // Median, not a high percentile: some frames have a dark bar along the top
  // edge that would otherwise inflate the noise estimate.
  const noise = median(edge.map((p) => dist[p]));
  const threshold = Math.min(24, Math.max(8, noise * 3 + 4));

  // Flood fill from every border pixel that looks like backdrop.
  const mask = new Uint8Array(w * h);
  const stack = [];
  const seed = (p) => { if (!mask[p] && dist[p] < threshold) { mask[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop();
    const x = p % w, y = (p / w) | 0;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (y > 0) seed(p - w);
    if (y < h - 1) seed(p + w);
  }

  // The blur leaves a thin halo of backdrop colour around the outline; peel
  // off character pixels that touch the backdrop and are still close to it.
  for (let pass = 0; pass < 3; pass++) {
    const peel = [];
    for (let p = 0; p < w * h; p++) {
      if (mask[p]) continue;
      const x = p % w, y = (p / w) | 0;
      const touches = (x > 0 && mask[p - 1]) || (x < w - 1 && mask[p + 1]) || (y > 0 && mask[p - w]) || (y < h - 1 && mask[p + w]);
      if (!touches) continue;
      const raw = Math.hypot(rgb[p * 3] - bg[0], rgb[p * 3 + 1] - bg[1], rgb[p * 3 + 2] - bg[2]);
      if (raw < threshold * 1.6) peel.push(p);
    }
    for (const p of peel) mask[p] = 1;
  }

  // Keep only the character: drop opaque pieces much smaller than the largest
  // one (noise specks, the dark bar some frames have along the top edge).
  const seen = new Uint8Array(w * h);
  const comps = [];
  for (let p = 0; p < w * h; p++) {
    if (mask[p] || seen[p]) continue;
    const comp = [p]; seen[p] = 1;
    for (let i = 0; i < comp.length; i++) {
      const q = comp[i]; const x = q % w, y = (q / w) | 0;
      for (const n of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, y > 0 ? q - w : -1, y < h - 1 ? q + w : -1]) {
        if (n >= 0 && !mask[n] && !seen[n]) { seen[n] = 1; comp.push(n); }
      }
    }
    comps.push(comp);
  }
  const largest = Math.max(...comps.map((c) => c.length));
  for (const comp of comps) {
    let y0 = h, y1 = 0, x0 = w, x1 = 0;
    for (const q of comp) { const x = q % w, y = (q / w) | 0; y0 = Math.min(y0, y); y1 = Math.max(y1, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    const strip = (y1 - y0 + 1) <= 16 && (x1 - x0 + 1) >= 4 * (y1 - y0 + 1);
    if (strip || comp.length < largest * 0.02) for (const q of comp) mask[q] = 1;
  }
  return { mask, bg, threshold };
}

function bbox(mask, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { x0, y0, x1, y1 };
}

// Crop + SCALE x SCALE box downscale. Colour is averaged over opaque pixels
// only (so no backdrop bleeds in), and alpha is kept binary for crisp edges.
function cropAndShrink(img, mask, box) {
  const cw = box.x1 - box.x0 + 1, ch = box.y1 - box.y0 + 1;
  const ow = Math.ceil(cw / SCALE), oh = Math.ceil(ch / SCALE);
  const out = Buffer.alloc(ow * oh * 4);
  for (let oy = 0; oy < oh; oy++) {
    for (let ox = 0; ox < ow; ox++) {
      let r = 0, g = 0, b = 0, n = 0, total = 0;
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) {
          const sx = box.x0 + ox * SCALE + dx, sy = box.y0 + oy * SCALE + dy;
          if (sx < 0 || sy < 0 || sx >= img.w || sy >= img.h) { total++; continue; }
          total++;
          const p = sy * img.w + sx;
          if (mask[p]) continue;
          r += img.rgb[p * 3]; g += img.rgb[p * 3 + 1]; b += img.rgb[p * 3 + 2]; n++;
        }
      }
      const o = (oy * ow + ox) * 4;
      if (n * 2 >= total) {
        out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = 255;
      }
    }
  }
  return { w: ow, h: oh, rgba: out };
}

for (const name of CHARACTERS) {
  const dir = join(SRC, name);
  const files = readdirSync(dir).filter((f) => /^.+_\d+\.png$/.test(f))
    .sort((a, b) => Number(a.match(/(\d+)\.png$/)[1]) - Number(b.match(/(\d+)\.png$/)[1]));
  const frames = files.map((f) => {
    const img = decode(join(dir, f));
    const { mask, bg, threshold } = backdropMask(img);
    return { f, img, mask, bg, threshold };
  });

  // One crop box for all frames of a character keeps the feet on one baseline.
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const fr of frames) {
    const b = bbox(fr.mask, fr.img.w, fr.img.h);
    box.x0 = Math.min(box.x0, b.x0); box.y0 = Math.min(box.y0, b.y0);
    box.x1 = Math.max(box.x1, b.x1); box.y1 = Math.max(box.y1, b.y1);
  }
  box.x0 -= PAD; box.y0 -= PAD; box.x1 += PAD; box.y1 += PAD;

  const outDir = join(OUT, name);
  mkdirSync(outDir, { recursive: true });
  for (const fr of frames) {
    const small = cropAndShrink(fr.img, fr.mask, box);
    encode(join(outDir, fr.f), small.w, small.h, small.rgba);
    console.log(`${name}/${fr.f}: backdrop rgb(${fr.bg.join(',')}) threshold ${fr.threshold.toFixed(1)} -> ${small.w}x${small.h}`);
  }
}
