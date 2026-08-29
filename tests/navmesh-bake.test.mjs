import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { importNavMesh, init, NavMeshQuery } from '@recast-navigation/core';
import { asVector3 } from '../export/web/navigation.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const BAKER = path.join(ROOT, '.tools', 'bake_navmesh.mjs');

test('bakes JSON collision input and imports the serialized mesh', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hijacked-nav-'));
  const input = path.join(temp, 'collision.json');
  const output = path.join(temp, 'hijacked.navmesh.bin');
  const meta = path.join(temp, 'hijacked.navmesh.json');
  fs.writeFileSync(input, JSON.stringify({
    coordinateSystem: 'three-y-up',
    // 200 x 200 Three.js-unit floor, split into two walkable triangles.
    positions: [0, 0, 0, 200, 0, 0, 200, 0, 200, 0, 0, 200],
    // Counter-clockwise when viewed from above (+Y), so Recast marks it walkable.
    indices: [0, 2, 1, 0, 3, 2],
    pathnodes: [[80, 0, 80]],
  }));
  const result = spawnSync(process.execPath, [BAKER, '--input', input, '--output', output, '--meta', meta], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(fs.statSync(output).size > 0);
  const metadata = JSON.parse(fs.readFileSync(meta, 'utf8'));
  assert.equal(metadata.config.cs, 4);
  assert.equal(metadata.config.ch, 2);
  assert.equal(metadata.pathnodes.projected, 1);

  await init();
  const { navMesh } = importNavMesh(new Uint8Array(fs.readFileSync(output)));
  const query = new NavMeshQuery(navMesh);
  const point = query.findClosestPoint({ x: 80, y: 10, z: 80 }, { halfExtents: { x: 48, y: 128, z: 48 } });
  assert.equal(point.success, true);
  // The voxelized detail surface is one cell (2 units) above the input
  // origin for this deliberately minimal fixture.
  assert.equal(Math.round(point.point.y), 2);
  query.destroy();
  navMesh.destroy();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('accepts common navigation vector inputs', () => {
  assert.deepEqual(asVector3([1, 2, 3]).toArray(), [1, 2, 3]);
  assert.deepEqual(asVector3({ x: 4, y: 5, z: 6 }).toArray(), [4, 5, 6]);
});
