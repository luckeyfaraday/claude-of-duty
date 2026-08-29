import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { PlayerController } from '../export/web/player-controller.js';

test('capsule stops at a wall without gaining launch velocity', () => {
  const world = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.BoxGeometry(2000, 1, 2000));
  floor.position.y = -0.5;
  const wall = new THREE.Mesh(new THREE.BoxGeometry(2000, 120, 1));
  wall.position.set(0, 60, -50);
  world.add(floor, wall);
  world.updateWorldMatrix(true, true);

  const camera = new THREE.PerspectiveCamera();
  const player = new PlayerController(camera, world, {
    spawn: new THREE.Vector3(0, 0.2, 0),
    moveSpeed: 300,
    sprintSpeed: 450,
    gravity: 980,
  });

  let groundedFrames = 0;
  for (let i = 0; i < 360; i += 1) {
    player.update(1 / 120, { forward: true, strafe: 0.35 });
    if (i >= 240 && player.isGrounded) groundedFrames += 1;
    assert.ok(Number.isFinite(player.velocity.length()));
    assert.ok(
      player.velocity.length() < 500,
      `unexpected launch speed ${player.velocity.length()} at frame ${i}; ` +
        `velocity=${player.velocity.toArray()} feet=${player.feetPosition.toArray()}`,
    );
  }

  assert.ok(
    groundedFrames >= 100,
    `grounding was unstable: ${groundedFrames}/120 frames; ` +
      `feet=${player.feetPosition.toArray()} velocity=${player.velocity.toArray()}`,
  );
  assert.ok(Math.abs(player.feetPosition.y) < 1, `capsule left floor: y=${player.feetPosition.y}`);
  assert.ok(player.feetPosition.z > -35, `capsule crossed wall: z=${player.feetPosition.z}`);
  assert.ok(Math.abs(player.feetPosition.x) < 1000, `wall slide diverged: x=${player.feetPosition.x}`);
});
