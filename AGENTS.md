# Agent development guide

This project is a browser-based Three.js reconstruction of T6 Hijacked. Agents
must verify gameplay changes with both structured state and rendered evidence;
source inspection alone is not sufficient for changes that can affect runtime
behavior or visuals.

## Standard workflow

1. Run `npm run ai:state` before a gameplay or rendering change when a baseline
   is useful.
2. Make the smallest relevant code change.
3. Run the focused unit tests, then `npm run ai:test`.
4. Inspect `artifacts/ai-game/report.json`, `state.json`, `console.log`, and
   `screenshot.png`. Compare `before.png` when visual state changed.
5. For animation, timing, camera, or effects work, run
   `npm run ai:record -- 10` and inspect `recording.webm` or `trace.zip`.
6. For enemy perception, navigation, combat, or coordination work, run
   `npm run ai:enemy` to stage a reproducible six-enemy encounter.

The harness launches its own HTTP server and Chrome/Edge. Set
`AI_GAME_HEADED=1` only when a visible browser is useful. Generated artifacts
are local evidence and must not be committed.

## Runtime automation API

Wait until `globalThis.hijacked?.debug?.getState().ready` is true. Prefer the
stable methods on `globalThis.hijacked.debug` over reaching into Three.js or
gameplay implementation details:

- `getState()` returns serializable player, weapon, enemy, overlay, HUD, and
  renderer state.
- `setActive(boolean)`, `pause()`, and `resume()` control automated play.
- `teleportPlayer([x, y, z])` and `lookAt([x, y, z])` arrange reproducible
  scenes.
- `showNavigation(boolean)` and `showCollision(boolean)` control debug views.
- `damagePlayer(number)`, `respawnPlayer()`, and `respawnEnemies()` create test
  conditions.
- `teleportEnemy(index, [x, y, z])` and `alertEnemies(radius)` stage encounters.

When adding a gameplay system, expose only compact, serializable observations
or safe test controls through this API. Do not expose frame-sized geometry,
textures, audio buffers, or cyclic Three.js objects in `getState()`.

## Visual evidence rules

- Capture a new screenshot after every input or state change being evaluated;
  coordinates and visual assumptions become stale after the scene changes.
- Treat browser console errors, page errors, and failed asset requests as test
  failures.
- Prefer deterministic setup through the debug API, then use real keyboard and
  mouse events for the behavior under test.
- Use a fixed viewport unless the task specifically concerns responsive layout
  or rendering resolution.
