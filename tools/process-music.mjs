#!/usr/bin/env node
// Cuts the background music out of a long file that repeats a medley with a
// silence between repeats (the provided NyanCat.m4a is a 3:22 medley of
// genre versions of the Nyan Cat theme, repeated for an hour). Keeps one
// medley without the silence, so the game ships ~2 MB instead of 22 MB, and
// finds where each genre section starts so the game can jump between them.
// The medley opens with a cat snoring; that quiet lead-in is left out.
//
// Usage: node tools/process-music.mjs [source] [output]
//   default: NyanCat.m4a -> audio/nyancat-medley.m4a
// Prints the "music" entry for office.json. Needs ffmpeg.

import { execFileSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || join(ROOT, 'NyanCat.m4a');
const OUT = process.argv[3] || join(ROOT, 'audio', 'nyancat-medley.m4a');
const PAD = 0.5; // seconds kept around the music, so AAC padding never lands on a loop point
const TAIL = 0.3; // short breath of silence between the end and the restart

const SR = 8000;
const raw = execFileSync('ffmpeg', ['-v', 'error', '-t', '900', '-i', SRC, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 29 });
const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);

// 1. Silences of 3 s or more (50 ms frames) mark the medley repeats.
const hop = SR / 20, rms = [];
for (let i = 0; i + hop <= x.length; i += hop) {
  let s = 0;
  for (let j = 0; j < hop; j++) s += x[i + j] * x[i + j];
  rms.push(Math.sqrt(s / hop));
}
const runs = [];
let st = -1;
for (let i = 0; i < rms.length; i++) {
  const quiet = rms[i] < 0.03;
  if (quiet && st < 0) st = i;
  if (!quiet && st >= 0) { if (i - st >= 60) runs.push([st / 20, i / 20]); st = -1; }
}
if (runs.length < 2) {
  console.error('Could not find two silences marking a repeat; is this a looping medley?');
  process.exit(1);
}
let A = runs[0][1];
const B = runs[1][0]; // music between the first two silences

// 2. Skip a soft lead-in (the snoring cat): if the music only gets going
// after more than 2 s of quiet sound, start 50 ms before it does. The
// padding before the loop point is muted, so none of it ships.
const f0 = Math.round(A * 20);
const onset = rms.slice(f0, f0 + 300).findIndex((v, i, a) => v > 0.1 && a[i + 1] > 0.1 && a[i + 2] > 0.1);
let skipped = 0;
if (onset > 40) {
  skipped = (onset - 1) / 20;
  A += skipped;
}

// 3. Genre sections: changes in loudness and brightness over 3 s windows.
const frame = SR / 4, feats = [];
for (let t = A; t + 0.25 < B; t += 0.25) {
  const i0 = Math.round(t * SR);
  let s = 0, z = 0;
  for (let j = 0; j < frame; j++) {
    const v = x[i0 + j];
    s += v * v;
    if (j && (v >= 0) !== (x[i0 + j - 1] >= 0)) z++;
  }
  feats.push([Math.sqrt(s / frame), z / frame]);
}
const W = 12;
const avg = (a, b, k) => { let s = 0; for (let i = a; i < b; i++) s += feats[i][k]; return s / (b - a); };
const nov = [];
for (let i = W; i < feats.length - W; i++) {
  nov.push([i, Math.abs(avg(i - W, i, 0) - avg(i, i + W, 0)) / 0.15 + Math.abs(avg(i - W, i, 1) - avg(i, i + W, 1)) / 0.05]);
}
const sections = [0, ...nov.filter(([, v], k) => v > 1.0 && nov.slice(Math.max(0, k - 16), k + 17).every(([, w]) => w <= v))
  .map(([i]) => i * 0.25).filter((t) => t < B - A - 8)];

// 4. Export [A - PAD, B + TAIL + PAD]; the game loops PAD .. PAD + (B - A) + TAIL.
execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(A - PAD), '-t', String(B - A + TAIL + 2 * PAD), '-i', SRC,
  ...(skipped ? ['-af', `volume=0:enable='lt(t,${PAD - 0.02})'`] : []),
  '-ac', '2', '-c:a', 'aac', '-b:a', '80k', '-movflags', '+faststart', OUT]);
const r2 = (v) => Math.round(v * 100) / 100;
console.log(`${basename(SRC)}: medley ${r2(A)}-${r2(B)} s (${r2(B - A)} s), ${sections.length} sections${skipped ? `, skipped a ${r2(skipped)} s quiet intro` : ''}`);
console.log(`wrote ${OUT.slice(ROOT.length + 1)}`);
console.log(`office.json: "music": ${JSON.stringify({ file: basename(OUT), loop: [PAD, r2(PAD + B - A + TAIL)], sections: sections.map((t) => r2(PAD + t)) })}`);
