#!/usr/bin/env node
// Copies just the files the website needs into dist/game/, so the game is
// served at <domain>/game/, plus a dist/index.html that sends the bare domain
// to the game. Run by `npm run build` (and by Cloudflare's build before each
// deploy).

import { cpSync, rmSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT = join(DIST, 'game');
const PUBLIC = ['index.html', 'static', 'audio'];

rmSync(DIST, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const p of PUBLIC) {
  cpSync(join(ROOT, p), join(OUT, p), { recursive: true, filter: (src) => basename(src) !== '.DS_Store' });
}
writeFileSync(join(DIST, 'index.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cosmic Cubicle Combatants</title>
  <meta http-equiv="refresh" content="0; url=game/">
</head>
<body style="background:#070b16;color:#e8eef7;font-family:system-ui,sans-serif">
  <p><a href="game/" style="color:#f2d22e">Cosmic Cubicle Combatants</a></p>
</body>
</html>
`);

let files = 0, bytes = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else { files++; bytes += s.size; }
  }
};
walk(OUT);
console.log(`Built dist/game/: ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
