import assert from 'node:assert/strict';
import test from 'node:test';

import {
  shBasis,
  sphereDirections,
  probeAt,
  BVH,
  rayTri,
} from '../.tools/bake_probes.mjs';
import * as THREE from 'three';
import { ProbeVolume, attachObjectProbe } from '../export/web/light-probes.js';

// A single triangle spanning the xz plane at y = 10, big enough to cover any
// upward ray from the origin.
const CEILING = [
  -100, 10, -100,
  100, 10, -100,
  0, 10, 100,
];

test('sphere directions are unit length and evenly balanced', () => {
  const dirs = sphereDirections(256);
  assert.equal(dirs.length, 256);
  let sx = 0, sy = 0, sz = 0;
  for (const d of dirs) {
    assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-9, 'direction must be normalised');
    sx += d[0]; sy += d[1]; sz += d[2];
  }
  // An even sphere distribution sums to roughly zero in every axis.
  for (const [axis, sum] of [['x', sx], ['y', sy], ['z', sz]]) {
    assert.ok(Math.abs(sum) < 1.5, `${axis} sum ${sum} should be near zero`);
  }
});

test('SH basis matches the THREE.SphericalHarmonics3 constants', () => {
  const b = shBasis([1, 0, 0]);
  assert.ok(Math.abs(b[0] - 0.282095) < 1e-6);
  assert.ok(Math.abs(b[3] - 0.488603) < 1e-6, 'x drives the fourth coefficient');
  const up = shBasis([0, 1, 0]);
  assert.ok(Math.abs(up[1] - 0.488603) < 1e-6, 'y drives the second coefficient');
});

test('a uniform sky integrates to the analytic L0 with no directional term', () => {
  const dirs = sphereDirections(2048);
  const emptyBvh = new BVH([0, -1000, 0, 1, -1000, 0, 0, -1000, 1]); // far below, never hit
  const sh = probeAt([0, 0, 0], dirs, emptyBvh, () => [1, 1, 1]);
  // Uniform radiance L over the sphere projects to L * Y00 * 4pi on the first
  // coefficient, and cancels to zero on the linear ones.
  const expected = 0.282095 * 4 * Math.PI;
  assert.ok(Math.abs(sh[0] - expected) < 1e-3, `L0 ${sh[0]} != ${expected}`);
  for (let b = 1; b < 4; b++) {
    assert.ok(Math.abs(sh[b * 3]) < 0.05, `L1 band ${b} should cancel, got ${sh[b * 3]}`);
  }
});

test('a brighter upper hemisphere produces a positive vertical L1 lobe', () => {
  const dirs = sphereDirections(2048);
  const emptyBvh = new BVH([0, -1000, 0, 1, -1000, 0, 0, -1000, 1]);
  const sky = (d) => (d[1] > 0 ? [1, 1, 1] : [0, 0, 0]);
  const sh = probeAt([0, 0, 0], dirs, emptyBvh, sky);
  // coefficient index 1 is the y lobe; light from above must make it positive.
  assert.ok(sh[3] > 0.5, `expected a positive y lobe, got ${sh[3]}`);
  assert.ok(Math.abs(sh[6]) < 0.1, 'z lobe should stay neutral');
  assert.ok(Math.abs(sh[9]) < 0.1, 'x lobe should stay neutral');
});

test('occluding geometry darkens the probe', () => {
  const dirs = sphereDirections(512);
  const open = new BVH([0, -1000, 0, 1, -1000, 0, 0, -1000, 1]);
  const roofed = new BVH(CEILING);
  const sky = () => [1, 1, 1];
  const openSh = probeAt([0, 0, 0], dirs, open, sky);
  const roofedSh = probeAt([0, 0, 0], dirs, roofed, sky);
  assert.ok(roofedSh[0] < openSh[0], 'a ceiling must reduce incoming light');
  // The bounce floor keeps interiors from going fully black.
  assert.ok(roofedSh[0] > 0, 'occluded probes keep a bounce floor');
});

test('ray/triangle respects distance bounds', () => {
  const tris = Float32Array.from(CEILING);
  assert.ok(rayTri(0, 0, 0, 0, 1, 0, tris, 0, 100), 'upward ray hits the ceiling');
  assert.ok(!rayTri(0, 0, 0, 0, -1, 0, tris, 0, 100), 'downward ray misses');
  assert.ok(!rayTri(0, 0, 0, 0, 1, 0, tris, 0, 5), 'hit beyond maxDist is ignored');
});

// --- runtime sampling -------------------------------------------------------

function volumeOf(dims, fill) {
  const [dx, dy, dz] = dims;
  const data = new Float32Array(dx * dy * dz * 12);
  for (let x = 0; x < dx; x++) {
    for (let y = 0; y < dy; y++) {
      for (let z = 0; z < dz; z++) {
        const cell = (x * dy + y) * dz + z;
        for (let i = 0; i < 12; i++) data[cell * 12 + i] = fill(x, y, z, i);
      }
    }
  }
  return new ProbeVolume({ origin: [0, 0, 0], spacing: 10, dims }, data);
}

test('probe volume reproduces cell values exactly at lattice points', () => {
  const volume = volumeOf([3, 3, 3], (x, y, z, i) => x * 100 + y * 10 + z + i * 0.5);
  const out = volume.sample(20, 10, 0);
  assert.ok(Math.abs(out[0] - 210) < 1e-4, `expected 210, got ${out[0]}`);
  assert.ok(Math.abs(out[5] - (210 + 2.5)) < 1e-4);
});

test('probe volume interpolates between cells', () => {
  // value varies only along x, so the midpoint must be the average
  const volume = volumeOf([2, 1, 1], (x) => (x === 0 ? 0 : 10));
  assert.equal(volume.sample(0, 0, 0)[0], 0);
  assert.equal(volume.sample(10, 0, 0)[0], 10);
  assert.ok(Math.abs(volume.sample(5, 0, 0)[0] - 5) < 1e-5, 'midpoint averages');
});

test('probe volume clamps outside its bounds instead of wrapping', () => {
  const volume = volumeOf([2, 1, 1], (x) => (x === 0 ? 1 : 9));
  assert.equal(volume.sample(-9999, 0, 0)[0], 1, 'below origin clamps to the first cell');
  assert.equal(volume.sample(9999, 0, 0)[0], 9, 'past the end clamps to the last cell');
});

// --- per-object probes ------------------------------------------------------

function enemyLike() {
  const root = new THREE.Group();
  const shared = new THREE.MeshLambertMaterial({ color: 0x808080 });
  const body = new THREE.Mesh(new THREE.BufferGeometry(), shared);
  const head = new THREE.Mesh(new THREE.BufferGeometry(), shared);
  // hitbox proxies are unlit and must be left alone
  const hitbox = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  root.add(body, head, hitbox);
  return { root, shared, body, head, hitbox };
}

test('attaching a probe clones lit materials but leaves unlit ones shared', () => {
  const { root, shared, body, head, hitbox } = enemyLike();
  const probe = attachObjectProbe(root);
  assert.equal(probe.materialCount, 2, 'only the two lit meshes are patched');
  assert.notEqual(body.material, shared, 'lit material is cloned off the shared one');
  assert.notEqual(body.material, head.material, 'each mesh gets its own clone');
  assert.ok(hitbox.material.isMeshBasicMaterial, 'unlit hitbox material is untouched');
  assert.equal(hitbox.material.userData.probeDeltaSH, undefined);
  assert.equal(body.material.userData.probeDeltaSH, probe.uniform);
});

test('two objects patched separately do not share a uniform', () => {
  const a = attachObjectProbe(enemyLike().root);
  const b = attachObjectProbe(enemyLike().root);
  assert.notEqual(a.uniform, b.uniform);
});

test('patched materials share one shader program cache key', () => {
  // The injection is defined once at module scope precisely so THREE does not
  // compile a separate program per enemy.
  const a = enemyLike();
  const b = enemyLike();
  attachObjectProbe(a.root);
  attachObjectProbe(b.root);
  assert.equal(
    a.body.material.onBeforeCompile.toString(),
    b.body.material.onBeforeCompile.toString(),
  );
});

test('object probe stores the difference against the scene probe', () => {
  const { root, body } = enemyLike();
  const probe = attachObjectProbe(root);
  // uniform ambient of 2 everywhere
  const volume = volumeOf([2, 2, 2], () => 2);
  const sceneSH = new Float32Array(12).fill(0.5);
  probe.update(volume, new THREE.Vector3(5, 5, 5), sceneSH, 1);
  // local (2) - scene (0.5) = 1.5, so scene + delta lands back on local
  for (let b = 0; b < 4; b++) {
    assert.ok(Math.abs(probe.uniform.value[b].x - 1.5) < 1e-5,
      `coefficient ${b} should be 1.5, got ${probe.uniform.value[b].x}`);
  }
  assert.equal(body.material.userData.probeDeltaSH.value[0].x, probe.uniform.value[0].x);
});

test('object probe intensity scales the local term only', () => {
  const probe = attachObjectProbe(enemyLike().root);
  const volume = volumeOf([2, 2, 2], () => 2);
  const sceneSH = new Float32Array(12).fill(1);
  probe.update(volume, new THREE.Vector3(5, 5, 5), sceneSH, 0.5);
  // local 2 * 0.5 = 1, minus scene 1 => 0: an object matching the scene probe
  // contributes nothing extra.
  assert.ok(Math.abs(probe.uniform.value[0].x) < 1e-5,
    `expected no delta, got ${probe.uniform.value[0].x}`);
});

test('object probe update is inert without a volume', () => {
  const probe = attachObjectProbe(enemyLike().root);
  probe.uniform.value[0].set(7, 7, 7);
  probe.update(null, new THREE.Vector3(), new Float32Array(12), 1);
  assert.equal(probe.uniform.value[0].x, 7, 'no volume must not clobber the uniform');
});

test('probe volume rejects data that does not match its dims', () => {
  assert.throws(() => new ProbeVolume({ origin: [0, 0, 0], spacing: 1, dims: [4, 4, 4] },
    new Float32Array(10)), /too small/);
  assert.throws(() => new ProbeVolume({ origin: [0, 0, 0], spacing: 1 }, new Float32Array(10)),
    /dims/);
});
