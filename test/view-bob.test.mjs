import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { ViewBob } from '../export/web/view-bob.js';

function settle(bob, state, seconds = 2) {
  for (let t = 0; t < seconds; t += 1 / 60) bob.update(1 / 60, state);
}

test('standing still leaves the camera untouched', () => {
  const bob = new ViewBob();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(10, 60, -5);
  camera.quaternion.setFromEuler(new THREE.Euler(0.2, 1.1, 0, 'YXZ'));
  settle(bob, { speed: 0, moving: false, grounded: true });
  const position = camera.position.clone();
  const quaternion = camera.quaternion.clone();
  bob.apply(camera);
  assert.ok(camera.position.distanceTo(position) < 1e-6);
  assert.ok(Math.abs(camera.quaternion.angleTo(quaternion)) < 1e-6);
  bob.restore(camera);
});

test('walking bobs the camera and restore puts it back exactly', () => {
  const bob = new ViewBob();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 60, 0);
  camera.quaternion.setFromEuler(new THREE.Euler(0, 0.7, 0, 'YXZ'));
  const position = camera.position.clone();
  const quaternion = camera.quaternion.clone();
  let moved = false;
  for (let i = 0; i < 60; i += 1) {
    bob.update(1 / 60, { speed: 300, moving: true, grounded: true });
    bob.apply(camera);
    if (camera.position.distanceTo(position) > 0.05) moved = true;
    bob.restore(camera);
    assert.deepEqual(camera.position.toArray(), position.toArray());
    assert.deepEqual(camera.quaternion.toArray(), quaternion.toArray());
  }
  assert.ok(moved, 'walk stride should displace the rendered eye');
});

test('sprinting swings harder and leans in, and airborne stride fades', () => {
  const walk = new ViewBob();
  settle(walk, { speed: 300, moving: true, grounded: true });
  const sprint = new ViewBob();
  settle(sprint, { speed: 450, moving: true, sprinting: true, grounded: true });
  assert.ok(sprint.sprintBlend > 0.99);
  assert.ok(sprint.tilt.x < 0, 'sprint should pitch the eye down slightly');
  let walkPeak = 0;
  let sprintPeak = 0;
  for (let i = 0; i < 120; i += 1) {
    walk.update(1 / 60, { speed: 300, moving: true, grounded: true });
    sprint.update(1 / 60, { speed: 450, moving: true, sprinting: true, grounded: true });
    walkPeak = Math.max(walkPeak, Math.abs(walk.offset.x));
    sprintPeak = Math.max(sprintPeak, Math.abs(sprint.offset.x));
  }
  assert.ok(sprintPeak > walkPeak * 1.5);

  settle(sprint, { speed: 450, moving: true, sprinting: true, grounded: false });
  assert.ok(sprint.bobAmp < 0.01, 'airborne stride should fade out');
});

test('apply is idempotent until restored', () => {
  const bob = new ViewBob();
  const camera = new THREE.PerspectiveCamera();
  settle(bob, { speed: 300, moving: true, grounded: true }, 0.5);
  bob.apply(camera);
  const once = camera.position.clone();
  bob.apply(camera);
  assert.deepEqual(camera.position.toArray(), once.toArray());
  bob.restore(camera);
  assert.deepEqual(camera.position.toArray(), [0, 0, 0]);
});

test('a brief loss of ground contact, as on a stair riser, does not stop the stride', () => {
  const bob = new ViewBob();
  settle(bob, { speed: 300, moving: true, grounded: true });
  const before = bob.bobAmp;
  for (let i = 0; i < 6; i += 1) bob.update(1 / 60, { speed: 300, moving: true, grounded: false });
  assert.ok(Math.abs(bob.bobAmp - before) < 1e-6, 'six airborne frames should not touch the stride');
  settle(bob, { speed: 300, moving: true, grounded: false }, 1);
  assert.ok(bob.bobAmp < 0.01, 'a real jump still fades the stride');
});
