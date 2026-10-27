# Cosmic Cubicle Combatants

A first-person office stealth game set on deadline day on the 5th floor of
Building 45. A solar particle event is heading for the crew in orbit, and the
Flight Director needs the radiation team's dose assessment before it arrives.
The crew's dose keeps climbing (faster during solar flares) until you submit.

Five reports are due, each with real work behind it:

| Report | Work | Sign-off / approval |
|---|---|---|
| Weekly Report | calibrate the prototype detector (Detector Lab bench) | Nic |
| TPS Report | rescue Katie's timesheet from the copy room | Katie W. |
| Mission Dose Report | run the vehicle dose model (console room) | Kevin (wants coffee) |
| Astronaut Dose Report | medical dose calculations, with Ramona's dosimetry | John FM (wants a blank R-13) |
| Astronaut Risk Report | debrief the visiting astronaut | Eddie and Clifton's stamps |

Management reviews add more approval stamps during the round. Submit
everything at the SRAG console in the console room.

Hazards: Eddie and Clifton patrol (getting caught costs sanity, and time with
Clifton; to get a stamp, walk up and press E). Kevin is a conversational black
hole whose gravity well pulls you in. Neil Z, a former manager, drops in from
the elevator now and then with a pun and no point. Press E repeatedly to
excuse yourself from either of them.

Helpers (blue "?" bubble): Ryan R (IT, freezes management if you file a memo
as a ticket; bother him three times in a row and he walks you to his
whiteboard for a physics problem), Janet (flare warnings), Jennifer M and Mark L (console room:
faster vehicle run, remote access), Serkan G (hands over half the vehicle run
from his cosmic ray model), Steve J (faster approvals), Amir B (Jeopardy for
sanity) and Mark S (talks a manager down once). Pat O has a galactic cosmic
ray model and is no help at all, just nostalgic physics puns. Every office has
its three occupants, and two "For the children" posters are up on the floor
(their walls are listed under `posters` in `office.json`).

The background music is a medley of genre versions of the Nyan Cat theme
(`audio/nyancat-medley.m4a`, cut from `NyanCat.m4a` by
`node tools/process-music.mjs`). It jumps to a different version when a
manager starts chasing you or a solar flare hits, speeds up near the deadline,
and slows down inside Kevin's gravity well. Music has its own on/off setting.

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
`homebodi.ai/game/` and nothing else: it only answers the routes
`homebodi.ai/game` and `homebodi.ai/game/*`, so the rest of homebodi.ai is
untouched. `npm run build` copies the files the site needs into `dist/game/`.

1. Push this folder to a GitHub repo (it can be private).
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a
   repository** → pick the repo. Name the Worker
   `cosmic-cubicle-combatants` (it has to match `name` in `wrangler.jsonc`).
   Build command: `npm run build`. Deploy command: `npx wrangler deploy`.
3. homebodi.ai needs a proxied DNS record (orange cloud) for the routes to
   run. If nothing else is hosted there, add: type `AAAA`, name `@`,
   address `100::`, proxied.
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
| Talk / use a station / ask a manager for a stamp | E or Enter | Use |
| Excuse yourself from a conversation, tap the detector gauge | E (repeatedly) | Use |
| Answer the dose calculator or Jeopardy | 1, 2, 3 | 1 2 3 buttons |
| Throw a memo (stuns, or lures a boss to where it lands) | Space or click | Memo |
| Drink coffee (+35 sanity) | C | Coffee |
| Map | M or Tab | Map |
| Pause | Esc or P | II |

The settings (in the title screen and the pause menu) cover sound, mouse
sensitivity, A/D turning instead of strafing, and pixel size.

## Changing the content

Everything is plain JSON in `static/data/`; reload the page after editing.

- **`encounters.json`**: the reports (their task, who signs off, which
  managers stamp them), the named coworkers (position, lines, what they want,
  what they give, their perk, sprite looks, and who walks a patrol or traps
  you in conversation), the pool of lines for unnamed coworkers, the overheard
  puns, and Eddie's and Clifton's lines. The `_help` entry at the top lists
  every option.
- **`office.json`**: the floor plan (one character per tile; the legend is
  in the file), the floor zones (corridor, office, doorway, lab, console room,
  break room, copy room), work stations, seats for the unnamed coworkers,
  the managers' patrol routes, items, props, the briefing text, and
  `"window_view"` (`"houston"` campus view, or `"orbit"`).

Coordinates are `[column, row]`, counting from 0 at the top-left of the map.
If something lands inside a wall, the game moves it to the nearest open tile
and logs a warning in the browser console. `npm test` reports it as well.

Tuning numbers (deadline per difficulty, manager speed and vision, how fast
the crew's dose climbs, management reviews, minigame timings) are at the top
of `static/scripts/game.js`.

### Sprites and posters

`sprites/` holds the original art. `npm run sprites` (needs `ffmpeg`)
removes the solid backgrounds, aligns the frames, turns Clifton's hair grey,
and writes the game-ready copies to `static/sprites/`. It also crops
`IMG_0238.jpg` into the "For the children" poster
(`static/sprites/posters/for-the-children.png`). Which frame is shown from
which viewing angle is set in `static/scripts/sprite-config.js`.

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
fuzzes random input (looking for crashes, NaN, or walking through walls),
tests each activity and coworker mechanic, and times the renderer. Add
`--frames <dir>` to save screenshots (needs ffmpeg).

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
  game.js                  rules: reports, tasks, coworkers, managers, crew dose, scoring
  world.js                 map, collision, line of sight, pathfinding
  raycaster.js             first-person renderer (pixel buffer)
  textures.js              procedural textures and small sprites
  hud.js                   heads-up display and map
  input.js, audio.js, sprite-config.js
tools/                     serve.mjs, simulate.mjs (tests), build.mjs, process-sprites.mjs
wrangler.jsonc             Cloudflare Worker config (homebodi.ai/game routes)
```
