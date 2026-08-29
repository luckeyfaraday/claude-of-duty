import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';
import { optimizeStaticScene } from '../export/web/scene-optimizer.js';

test('spatially instances repeated opaque static meshes', () => {
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial();
  for (const x of [0, 10, 20, 900]) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.x = x;
    root.add(mesh);
  }
  const transparent = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ transparent: true }));
  root.add(transparent);

  const stats = optimizeStaticScene(root, { cellSize: 640 });
  assert.equal(stats.inputMeshes, 4);
  assert.equal(stats.batches, 1);
  assert.equal(stats.instances, 3);
  assert.equal(stats.retainedMeshes, 1);
  const batch = root.children.find((child) => child.isInstancedMesh);
  assert.ok(batch);
  assert.equal(batch.count, 3);
  assert.ok(root.children.includes(transparent));
});
