import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { Viewmodel } from '../export/web/viewmodel.js';

// Gun joint axes (X down the barrel, Y left, Z up) expressed in the camera's
// convention (X right, Y up, -Z forward), the same mapping tag_view carries.
const GUN_TO_CAMERA = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
);

// Stand-in for the exported HK416: tag_sights sits on the sight base and the
// front post's tritium insert spans 0.4 units above it, 0.84 further down the
// barrel, which is how the shipped rig is authored. The hip pose is off-square
// so the alignment has a real rotation to solve.
function buildRig({ insert = true, tilt = new THREE.Euler(0.09, -0.14, 0.06, 'YXZ') } = {}) {
  const viewmodel = new Viewmodel();
  const jGun = new THREE.Object3D();
  jGun.name = 'j_gun';
  jGun.quaternion
    .setFromRotationMatrix(GUN_TO_CAMERA)
    .premultiply(new THREE.Quaternion().setFromEuler(tilt));

  const tagSights = new THREE.Object3D();
  tagSights.name = 'tag_sights';
  tagSights.position.set(11.53, 0, 4.6);
  jGun.add(tagSights);

  if (insert) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      12.37, -0.026, 4.856,
      12.37, 0.026, 4.856,
      12.37, 0.026, 4.999,
      12.37, -0.026, 4.999,
    ], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const post = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      name: 'mc/mtl_t6_attach_tritium_red',
    }));
    jGun.add(post);
  }

  viewmodel.root.add(jGun);
  viewmodel.root.updateMatrixWorld(true);
  return { viewmodel, jGun, tagSights };
}

test('ADS centres the front post tip, not the tag on the sight base', () => {
  const { viewmodel, jGun, tagSights } = buildRig();
  viewmodel.computeAdsAlignment();

  const tip = viewmodel.findSightTip(jGun).applyMatrix4(viewmodel.adsMatrix);
  assert.ok(Math.hypot(tip.x, tip.y) < 1e-6, `post tip should land on the view axis, got ${tip.x}, ${tip.y}`);

  // The tag still sets the eye relief, so it keeps its distance and drops the
  // 0.4 units that used to float the whole sight picture above the shot ray.
  const sight = tagSights.getWorldPosition(new THREE.Vector3()).applyMatrix4(viewmodel.adsMatrix);
  assert.ok(Math.abs(sight.z + viewmodel.adsDistance) < 1e-6, `eye relief moved: ${sight.z}`);
  assert.ok(Math.abs(sight.y + 0.399) < 1e-3, `tag should hang below the axis, got ${sight.y}`);
  assert.ok(Math.abs(sight.x) < 1e-6);
  assert.ok(Math.abs(tip.z + viewmodel.adsDistance - -0.84) < 1e-2, `tip depth: ${tip.z}`);
});

test('ADS squares the gun up with the view axis', () => {
  const { viewmodel, jGun } = buildRig();
  viewmodel.computeAdsAlignment();

  const aimed = jGun.getWorldQuaternion(new THREE.Quaternion()).premultiply(viewmodel.adsQuat);
  const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(aimed);
  const up = new THREE.Vector3(0, 0, 1).applyQuaternion(aimed);
  assert.ok(forward.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-6, `barrel off axis: ${forward.toArray()}`);
  assert.ok(up.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-6, `gun rolled: ${up.toArray()}`);
});

test('rigs without a sight insert still align on tag_sights alone', () => {
  const { viewmodel, tagSights } = buildRig({ insert: false });
  viewmodel.computeAdsAlignment();

  const sight = tagSights.getWorldPosition(new THREE.Vector3()).applyMatrix4(viewmodel.adsMatrix);
  assert.ok(Math.hypot(sight.x, sight.y) < 1e-6, `fallback should centre the tag, got ${sight.x}, ${sight.y}`);
  assert.ok(Math.abs(sight.z + viewmodel.adsDistance) < 1e-6);
});
