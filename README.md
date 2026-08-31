# Claude of Duty: Vibe Slops II

A browser-based Three.js first-person shooter played on the Black Ops II
Hijacked map export, with capsule collision and a baked Recast navigation mesh.

## Run it

Install the JavaScript dependencies once, then serve the web export from the
repository root:

```powershell
npm install
python -m http.server 8000 --directory export/web
```

Open <http://localhost:8000>. The viewer must be served over HTTP; opening
`index.html` directly will not load its modules and binary assets.

Controls:

- `WASD`: move; mouse: look
- `Shift`: sprint; `Space`: jump
- `C` or `Ctrl`: crouch; `B`: respawn
- `Left mouse`: fire; `R`: reload
- `Right mouse`: aim down sights
- `Tab`: hold the free-for-all scoreboard
- `N`: navmesh overlay; `V`: collision overlay
- `P`: find and draw a navmesh path to the point under the crosshair
- `Esc`: pause and release the mouse

## Frontend

The viewer opens on a menu shell rather than a bare loading message. It has a
loading screen, a title screen, and an `Esc` pause menu, all sharing one set of
layers built from the game's own frontend art in `zone/all/ui_mp.ff`: the
`menu_mp_background_main2` backdrop, a scrolling `bg_fogscrollthin` strip, the
`menu_mp_background_glow` plate, and the `menu_mp_map_select_hijacked_final`
map card. The pause buttons and panel use `menu_button_backing` and
`menu_mp_lobby_frame_outer`.

Those plates ship white-on-alpha because the game tints them at runtime, so the
browser does the same through `mask-image`. The single `--fe-accent` custom
property in `index.html` recolours every panel, button, and glow at once; it is
set to the HUD's mint rather than the game's blue. The layout is not the
original: T6 menudefs do not dump (the Unlinker lists all 133 in `ui_mp.ff` and
writes none of them), so only the art is reused.

The load bar measures stages declared up front with fixed weights. The visible
map ships as one Meshopt-compressed GLB containing GPU-compressed KTX2 textures,
so its progress callback covers the dominant transfer. A stage is held below
its full weight until its promise settles, preventing the bar from reaching
100% before the game is playable.

Re-export the menu art with:

```powershell
python .tools/export_ui.py
```

It dumps `ui_mp.ff` and converts the dozen images the menu uses into
`export/web/ui/` (~1.4 MB), leaving the other 513 in the zone.

The original in-game HUD art is exported the same way into
`export/web/ui/hud/`:

```powershell
python .tools/export_hud.py
```

It dumps `common_mp.ff` and `mp_hijacked.ff` and converts everything matching
the HUD filters — compass ring, pings, and the `compass_map_mp_hijacked` radar
map, waypoints, killstreak and killfeed icons, fire-mode selectors, grenade
icons, damage feedback, and the low-health overlays (~2 MB). The HUD's layout
menudefs do not dump for T6, so the browser would rebuild placement itself and
draw with this art.

## Play counter

The title screen shows how many people have played, under the prompt:

```
3 PLAYERS · 8 PLAYS
```

`players` counts browsers that have started a match, `plays` counts sessions
that have. The split is deliberate: `players` is the honest answer to "how many
people have played", and `plays` is the one that moves.

`export/web/play-counter.js` holds the client half and, like `frontend.js`,
touches no DOM so it tests in node. A play is recorded when pointer lock is
granted, not when the page loads, so social-card scrapers and bounced tabs
never reach it; the automation harness enters through `setAutomationActive`
without taking a lock, so the smoke tests stay out of the totals too. The first
record per page session latches, so resuming from the pause menu does not count
again. New-versus-returning is a `vibeslops:player` key in `localStorage` —
clearing site data counts you again, which is unavoidable without asking
anonymous players to sign in.

The server half is `netlify/functions/plays.mjs`, on Netlify Blobs. Both counts
live under one key so a reader cannot catch the pair mid-update, and the
increment is a compare-and-swap against the entry's ETag with a short retry
ladder: Blobs has no atomic add, and a plain read-modify-write would silently
drop a count whenever two players started at the same moment.

The counter is decoration and fails silently — offline, blocked, or served by
the static dev server above, which has no function and simply 404s, the line
stays blank rather than breaking the frontend. There is no "am I in production"
check, so `netlify dev` exercises the real thing against its own local blob
store:

```powershell
npx netlify dev
```

`netlify.toml` exists only to name the publish and functions directories; it
restates the `export/web` the site already served, since a `netlify.toml`
overrides the Netlify UI's settings.

## First-person viewmodel

The viewer renders a weapon viewmodel (FBI shortsleeve viewhands holding the
M27/HK416) in a dedicated depth-cleared pass so it never clips into walls. The
rigs come from the game export (`export_chars/model_export/`,
`export_common/model_export/`, see `EXPORTING_ASSETS.md`); the copies served to
the browser live in `export/web/viewmodel/`. The weapon is mounted by aligning
its `j_gun` joint to the hands' `tag_weapon` joint, and the whole rig is
anchored at `tag_view` with the engine view axes (X forward, Z up) mapped to
the camera. It includes look sway, walk bob, a sprint pose, and hold-right-
mouse ADS, which rotates the gun square to the view axis and seats the eye
7 units behind `tag_sights` for a proper iron-sight picture.

The M27 fires automatic camera-centered hitscan rounds against the collision
scene. Shots use the authored hip/ADS fire animations and include view recoil,
a `tag_flash` muzzle flash, the extracted M27 player-shot/decay/LFE audio layers,
tracers, persistent
impact marks, a 30-round magazine, and eight reserve magazines. Every respawn
restores the full `30/240` life loadout.

Rounds that connect raise a hitmarker on the crosshair: white for a body hit,
gold for a head hit, and a longer-lived red marker for a kill. Each is paired
with a short synthesized tick — the extracted banks carry no UI alias — routed
around the gunfire compressor so the confirmation is not ducked by the shot
that earned it.

## Free for all

The browser runs a seven-combatant free-for-all: the player and six named PLA
bots, first to 30 kills or the leader after five minutes. The match HUD shows
score, time, placement, and a kill feed; holding `Tab` opens the full standings.
Death keeps the fight visible behind a killer/respawn card, then selects a safe
authored `mp_dm_spawn`, restores the loadout, and grants brief spawn protection.

Six PLA assault enemies spawn across the map's authored FFA markers and
move with the baked Detour crowd. They patrol, acquire the player through
field-of-view and collision-based line-of-sight checks, pursue, fire, remember
the last seen position, search nearby navigation points after losing contact,
die, and respawn. Bots use the same perception and damage paths against every
other living combatant, so bot-versus-bot kills count in the standings. Every
enemy with visibility and a clear firing line can shoot; individual reaction
delays, bursts, reloads, movement-sensitive
accuracy, suppression, and tactical repositioning keep the fight readable
without an artificial attacker cap. The browser uses the exported PLA
body, M27 world model, and converted `pb_*` body animations, with separate
head, torso, and leg damage zones.

The HUD is drawn with the game's own art (`export/web/ui/hud/`, dumped by
`.tools/export_hud.py`; layout rebuilt in `export/web/hud.js` since T6 HUD
menudefs do not dump): a rotating radar minimap built on the
`compass_map_mp_hijacked` radar texture with firing-enemy pings, the compass
tape, and the digit-based ammo counter. Health reads through the low-health
vignette and damage flash rather than a bar, as in the game.

The rifle rides `tag_weapon_right`, the body's own weapon socket, the same way
the viewmodel welds `j_gun` to the hands' `tag_weapon`. Two details do not come
free. The stance clips have to be the weapon set (`pb_stand_alert`,
`pb_combatrun_forward_loop`); the `pb_hold_*` set is T6's carry stance, which
poses the hands for an object and parks the socket somewhere unrelated. And the
clips and the PLA rig disagree about the socket offset — the clips put it about
14 inches from the wrist, the model's bind 11.4 — so the socket is calibrated
once per stance against the authored trigger hand, which lands the grip within
about a sixth of an inch of the wrist. `pb_death_faceplant` animates the
socket 30 inches clear of the body because T6 drops the weapon on death, so the
falling body instead keeps the rifle welded to its trigger hand.

Enemy fire is audible and locatable. Every shot lights a pooled additive sprite
at the shooter's `tag_flash` and plays a panned report through an HRTF
`PannerNode` whose distances are tuned to Radiant inches, with a distance-driven
lowpass standing in for air absorption. The export ships only the
player-perspective M27 alias, so that report is derived from it rather than
sampled from a true `_npc` variant; extracting those from `mpl_common` would
replace the filtering with the authored sound. The flashes are deliberately
unlit sprites — a `PointLight` per shot would recompile every material it
reached, undoing the load-time shader warm-up.

## Rebuild collision and navigation

Python 3 is required. The scene composer also runs the collision exporter:

```powershell
python .tools/compose_scene.py
npm run bake:map
npm run bake:collision
npm run bake:navmesh
```

The first command rebuilds the source render scene, collision-only glTF, and
spawn/pathnode navigation hints. The bake commands then create the optimized
render GLB, collision BVH, and serialized Recast navmesh loaded by the browser.
`bake:map` requires Khronos KTX-Software's `ktx` executable on `PATH`.

Generated runtime assets are in `export/web`:

- `hijacked.gltf` / `hijacked.bin`: visible map
- `hijacked_collision.gltf` / `.bin`: physics-only geometry
- `hijacked_optimized.glb`: Meshopt/KTX2 runtime render map
- `hijacked_collision_bvh.bin` / `.json`: runtime collision BVH
- `hijacked_nav_hints.json`: spawns, pathnodes, and traversal links
- `hijacked.navmesh.bin` / `.json`: baked Recast mesh and build metadata

The collision export combines filtered BSP render surfaces with each placed
xmodel's authored `collLod`. The extracted game files do not include usable T6
clipmap/physics brushes, so this is a close geometry-derived approximation
rather than the original engine collision.

## Tests

Run fast collision and navmesh tests with:

```powershell
npm run test:unit
```

With the localhost server running on port 8000, run the Chrome/Edge smoke test:

```powershell
npm run test:browser
```

`npm test` runs both sets.

## AI visual testing

The repository includes a Playwright harness that gives coding agents both a
rendered view of the game and a JSON snapshot of its internal state. It starts
its own local server and headless Chrome/Edge, so no manual setup is required:

```powershell
npm run ai:state
npm run ai:screenshot
npm run ai:test
npm run ai:enemy
npm run ai:life
npm run ai:record -- 10
```

Outputs are written to `artifacts/ai-game/`:

- `before.png` and `screenshot.png`: visual before/after evidence
- `before-state.json` and `state.json`: player, weapon, enemy, overlay, and
  renderer state
- `console.log`: browser console, page, and network failures
- `trace.zip`: a Playwright trace with screenshots and DOM snapshots
- `recording.webm`: video produced by `ai:record`
- `report.json`: machine-readable checks and pass/fail status

Set `AI_GAME_HEADED=1` to watch the controlled browser. `BROWSER_TEST_URL` can
point the harness at an existing server, and `BROWSER_PATH` can select a custom
Chrome/Edge executable.

At runtime, `globalThis.hijacked.debug` provides a stable automation surface:
`getState`, `setActive`, `pause`, `resume`, `teleportPlayer`, `lookAt`, overlay
toggles, damage/respawn controls, and enemy reset. Keep this surface stable when
changing runtime internals because tests and coding agents depend on it.
