import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import { CollisionWorld } from '../export/web/collision-world.js';

function floorWorld() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -100, 0, -100, 100, 0, 100, 100, 0, -100,
    -100, 0, -100, -100, 0, 100, 100, 0, 100,
  ], 3));
  return new CollisionWorld(geometry);
}

test('CollisionWorld resolves a capsule out of static triangles', () => {
  const world = floorWorld();
  const capsule = new Capsule(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 5, 0), 2);
  const hit = world.capsuleIntersect(capsule);
  assert.ok(hit);
  assert.ok(hit.normal.y > 0.99);
  assert.ok(Math.abs(hit.depth - 1) < 1e-5);
});

test('CollisionWorld returns the nearest double-sided ray hit', () => {
  const world = floorWorld();
  const hit = world.rayIntersect(new THREE.Ray(
    new THREE.Vector3(0, 10, 0),
    new THREE.Vector3(0, -1, 0),
  ));
  assert.ok(hit);
  assert.ok(Math.abs(hit.distance - 10) < 1e-5);
  assert.deepEqual(hit.position.toArray().map(Math.round), [0, 0, 0]);
  const normal = hit.triangle.getNormal(new THREE.Vector3());
  assert.ok(Math.abs(normal.y) > 0.99);
});
