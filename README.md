# Cosmic Cubicle Combatants

An intergalactic office RPG: survive bureaucracy in space. A first-person
stealth game set on the 5th floor of Building 45, which (thanks to a clerical
error on Form R-13) is now in orbit with a solar storm on the way.

Before the CME arrives you need five reports ready: the Weekly Report, TPS
Report, Mission Dose Report, Astronaut Dose Report and Astronaut Risk Report.
Nic, Katie W., Kevin and John FM sign off on them (some want a favor first).
Management wants approval stamps too, and every now and then a management
review adds more, sometimes from both managers at once. Then reach the Storm
Shelter in the stairwell.

Eddie and Clifton patrol the floor. If they catch you, you lose sanity (and,
with Clifton, time). To get a stamp you have to walk up to them on purpose
and press E: they stop, review the paperwork while you wait, and stamp it
APPROVED. Solar flares make the windowed offices dangerous.

Six more coworkers are optional helpers (blue "?" bubble): Ryan R (IT)
freezes management with a forced update if you file a ticket (a memo),
Janet (Mission Control Console) gives early flare warnings, Steve J
(Spreadsheets) halves review time, Ramona (dosimeters) recalibrates your
badge, Amir B quizzes you Jeopardy-style for sanity (keys 1-3), and Mark S
(People Person) talks a manager down the next time you're caught.

It is a static web page with no build step and no dependencies.

## Play it locally

Browsers won't run the game from a `file://` page, so serve it:

```sh
npm start            # http://localhost:8080   (PORT=9000 npm start to change)
```

Any other static server works too (`python3 -m http.server`, VS Code Live Server, ...).

## Put it on the web

### homebodi.ai/game (Cloudflare, deploys from GitHub)

`wrangler.jsonc` describes a Cloudflare Worker that serves the game at
`homebodi.ai/game/` and nothing else, so whatever else runs on homebodi.ai is
untouched. `npm run build` copies the files the site needs into `dist/game/`.

1. Push this folder to a GitHub repo (it can be private).
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a
   repository** → pick the repo. Name the Worker
   `cosmic-cubicle-combatants` (it has to match `name` in `wrangler.jsonc`).
   Build command: `npm run build`. Deploy command: `npx wrangler deploy`.
3. homebodi.ai must be proxied by Cloudflare (orange cloud in **DNS**).
   If nothing is hosted at homebodi.ai yet, add a DNS record: type `AAAA`,
   name `@`, address `100::`, proxied. A Worker route only runs for
   hostnames Cloudflare proxies.
4. Open <https://homebodi.ai/game/>. Every push to `main` redeploys.

To deploy from your own machine instead: `npx wrangler login`, then
`npm run deploy`. For `www.homebodi.ai/game` too, add matching routes to
`wrangler.jsonc` (or redirect www to the bare domain in Cloudflare).

### Anywhere else

Upload `index.html`, `static/` and `audio/` (or run `npm run build` and
upload `dist/game/`). Everything else (`sprites/` originals, `tools/`, the old
zip) is only needed for development. All paths are relative, so it works from
any sub-folder.

- **GitHub Pages:** push the repo, then Settings → Pages → deploy from the
  main branch, root folder. The game appears at `https://<you>.github.io/<repo>/`.
- **Netlify / Cloudflare Pages:** drag the folder onto the dashboard (no build
  command, publish directory = the project root).
- **itch.io:** zip `index.html`, `static/` and `audio/`, upload the zip as an
  HTML game, set the viewport to 1280×720 and turn on the fullscreen button.

## Controls

| | Keyboard / mouse | Touch |
|---|---|---|
| Move | W A S D | left thumb stick |
| Turn | mouse (click the game to capture it) or ← → | drag on the right half |
| Sprint | Shift (noisy, uses stamina) | push the stick all the way |
| Talk / ask a manager for a stamp | E or Enter | Use |
| Throw a memo (stuns, or lures a boss to where it lands) | Space or click | Memo |
| Drink coffee (+35 sanity) | C | Coffee |
| Map | M or Tab | Map |
| Pause | Esc or P | II |

The settings (in the title screen and the pause menu) cover sound, mouse
sensitivity, A/D turning instead of strafing, and pixel size.

## Changing the content

Everything is plain JSON in `static/data/`; reload the page after editing.

- **`encounters.json`**: the reports (who signs off on each, and which
  managers must stamp it from the start), coworkers (name, map position,
  lines, what they want before signing off, sprite colours), the overheard
  puns, and Eddie's and Clifton's lines (including what they say while
  reviewing and approving).
- **`office.json`**: the floor plan (one character per tile; the legend is
  in the file), where everyone starts, the bosses' patrol routes, items, props,
  the briefing text, and `"window_view"`: `"orbit"` (Earth and the sun) or
  `"houston"` (daytime campus view).

Coordinates are `[column, row]`, counting from 0 at the top-left of the map.
If something lands inside a wall, the game moves it to the nearest open tile
and logs a warning in the browser console. `npm test` reports it as well.

Tuning numbers (storm timer, boss speed and vision, radiation, how many
management reviews per round and how often they demand two stamps) are at
the top of `static/scripts/game.js`.

### Sprites

`sprites/` holds the original art. `npm run sprites` (needs `ffmpeg`)
removes the solid backgrounds, aligns the frames and writes the game-ready
copies to `static/sprites/`. Which frame is shown from which viewing angle is
set in `static/scripts/sprite-config.js`.

### Audio

Sound effects and music are synthesized in the browser. The files in
`audio/` are currently silent placeholders: replace `eddie_line.wav` /
`clifton_line.wav` with real recordings and they play when that boss catches
you. `ambient.wav` loops in the background.

## Tests

```sh
npm test
```

This runs the real game code headlessly. It checks that everything in the
data files is reachable, lets bots play full rounds on every difficulty,
fuzzes random input (looking for crashes, NaN, or walking through walls), and
times the renderer. Add `--frames <dir>` to save screenshots (needs ffmpeg).

Add `?debug` to the URL to get `window.ccc.game` in the browser console, and
`?fps` for a frame counter.

## Layout

```
index.html                 page + menus
static/css/style.css
static/data/               office.json, encounters.json
static/sprites/            processed Eddie / Clifton frames
static/scripts/
  game-engine.js           entry: loading, menus, main loop
  game.js                  rules: player, bosses, items, storm, scoring
  world.js                 map, collision, line of sight, pathfinding
  raycaster.js             first-person renderer (pixel buffer)
  textures.js              procedural textures and small sprites
  hud.js                   heads-up display and map
  input.js, audio.js, sprite-config.js
tools/                     serve.mjs, simulate.mjs (tests), build.mjs, process-sprites.mjs
wrangler.jsonc             Cloudflare Worker config (homebodi.ai/game routes)
```
