import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAP_CAL, MINIMAP_PING_SIZE, worldToMinimapUv } from '../export/web/hud.js';

test('minimap uses the authored minimap_corner world bounds', () => {
  assert.deepEqual(MAP_CAL, {
    centerX: -316,
    centerZ: 12,
    size: 7176,
    flipU: 1,
    flipV: -1,
    minimapSpan: 1250,
  });

  // Entity-space corners (3272, 3576) and (-3904, -3600) become
  // Three.js XZ corners (3272, -3576) and (-3904, 3600).
  assert.deepEqual(worldToMinimapUv(3272, -3576), { u: 0, v: 0 });
  assert.deepEqual(worldToMinimapUv(-3904, 3600), { u: 1, v: 1 });
});

test('player spawn projects to its actual location near the bow', () => {
  const uv = worldToMinimapUv(2102, 133);
  assert.ok(Math.abs(uv.u - 0.5168617614269788) < 1e-12);
  assert.ok(Math.abs(uv.v - 0.16304347826086957) < 1e-12);
});

test('enemy firing pings are five times the original size', () => {
  assert.equal(MINIMAP_PING_SIZE, 80);
});
