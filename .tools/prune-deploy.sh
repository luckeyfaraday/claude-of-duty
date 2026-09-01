#!/usr/bin/env bash
# Strips build inputs from the publish directory before Netlify uploads it.
#
# `export/web` doubles as the bake workspace: `compose_scene.py` writes
# hijacked.gltf/.bin there, `export_collision.py` writes the collision source
# beside it, and `textures/` holds the 359 source PNGs that `bake_map.mjs`
# encodes into hijacked_optimized.glb. None of that is fetched by the browser --
# the runtime reads the baked .glb, the baked BVH, and a handful of loose
# textures -- but all of it was being served, and crawlers were pulling it.
#
# Netlify builds in a throwaway container, so deleting here never touches git.
set -euo pipefail

WEB="export/web"
cd "$(dirname "$0")/.."

# Loose textures the runtime still fetches directly (lighting.js, index.html).
# Everything else under textures/ is a bake input.
KEEP_TEXTURES=(env probe mp_hijacked_lut.png)

require() {
  [ -e "$1" ] || { echo "prune-deploy: expected runtime asset missing: $1" >&2; exit 1; }
}

# Fail loudly rather than shipping a broken map if an asset was renamed.
require "$WEB/hijacked_optimized.glb"
require "$WEB/hijacked_collision_bvh.bin"
require "$WEB/hijacked_collision_bvh.json"
require "$WEB/hijacked.navmesh.bin"
for keep in "${KEEP_TEXTURES[@]}"; do require "$WEB/textures/$keep"; done

before=$(du -sm "$WEB" | cut -f1)

# Bake inputs and intermediates.
rm -f "$WEB"/hijacked.gltf \
      "$WEB"/hijacked.bin \
      "$WEB"/hijacked_geometry.glb \
      "$WEB"/hijacked_collision.gltf \
      "$WEB"/hijacked_collision.bin \
      "$WEB"/hijacked_collision_source.json

# Source PNGs, now embedded in the .glb as KTX2.
find "$WEB/textures" -maxdepth 1 -type f -name '*.png' \
  ! -name 'mp_hijacked_lut.png' -delete

after=$(du -sm "$WEB" | cut -f1)
echo "prune-deploy: publish dir ${before} MB -> ${after} MB"
