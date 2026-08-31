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

// Measured off the shipped HK416 (t6_wpn_ar_hk416_view_lod0.glb), in j_gun's
// local frame: tag_sights on the front sight base, the front post's tritium
// insert 0.4 above it and 0.84 further down the barrel, and the rear notch
// 12 units back the other way — the sight radius the old alignment ignored.
const TAG_SIGHTS = [11.53, 0, 4.6];
const FRONT_TIP = [12.37, 0, 4.999];
// The point the front post is levelled against: the top of the rear sight,
// laterally centred. The shoulders themselves stand 0.198 either side.
const REAR_TOP = [0.447, 0, 5.168];
// The floor of the notch, level with the post tip and therefore useless to aim
// with — the post grazes it and stays hidden behind the sight body.
const NOTCH_FLOOR = [0.319, 0, 5.002];

const RIFLE_SIGHT_CONFIGS = [
  { id: 'an94', sightTag: 'tag_sights', insert: true },
  { id: 'hk416', sightTag: 'tag_sights', insert: true },
  { id: 'sa58', sightTag: 'tag_sights', insert: true },
  {
    id: 'saritch',
    sightTag: 'tag_sights_on',
    insert: false,
    adsSightAnchors: { front: FRONT_TIP, rear: REAR_TOP },
  },
  {
    id: 'scar',
    sightTag: 'tag_sights_on',
    insert: false,
    adsSightAnchors: { front: FRONT_TIP, rear: REAR_TOP },
  },
  {
    id: 'sig556',
    sightTag: 'tag_sights_on',
    insert: false,
    adsSightAnchors: { front: FRONT_TIP, rear: REAR_TOP },
  },
  { id: 'tar21', sightTag: 'tag_sights_on', insert: true },
  { id: 'type95', sightTag: 'tag_sights_on', insert: true },
  { id: 'xm8', sightTag: 'tag_sights_on', insert: true },
];

function quad(vertices) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

// The hip pose is off-square so the alignment has a real rotation to solve.
function buildRig({
  insert = true,
  rear = true,
  sightTag = 'tag_sights',
  adsSightAnchors = null,
  tilt = new THREE.Euler(0.09, -0.14, 0.06, 'YXZ'),
} = {}) {
  const viewmodel = new Viewmodel({ adsSightAnchors });
  const jGun = new THREE.Object3D();
  jGun.name = 'j_gun';
  jGun.quaternion
    .setFromRotationMatrix(GUN_TO_CAMERA)
    .premultiply(new THREE.Quaternion().setFromEuler(tilt));

  const tagSights = new THREE.Object3D();
  tagSights.name = sightTag;
  tagSights.position.set(...TAG_SIGHTS);
  jGun.add(tagSights);

  if (insert) {
    const post = new THREE.Mesh(quad([
      12.37, -0.026, 4.856,
      12.37, 0.026, 4.856,
      12.37, 0.026, 4.999,
      12.37, -0.026, 4.999,
    ]), new THREE.MeshBasicMaterial({ name: 'mc/mtl_t6_attach_tritium_red' }));
    jGun.add(post);
  }

  // The front sight hood stands higher than the rear sight and sits in the same
  // plane and centreline, so only its distance from the post tells the two
  // apart. It must never be mistaken for the rear sight.
  const hood = new THREE.Mesh(quad([
    11.9, -0.05, 5.3,
    11.9, 0.05, 5.3,
    12.2, 0.05, 5.3,
    12.2, -0.05, 5.3,
  ]), new THREE.MeshBasicMaterial({ name: 'mc/mtl_t6_wpn_ar_hk416' }));
  jGun.add(hood);

  if (rear) {
    // A V-notch, vertex for vertex as the rig authors it: a floor on the
    // centreline, inner corners rising away from it, then the shoulders.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      ...NOTCH_FLOOR,
      0.342, -0.048, 5.039,
      0.342, 0.048, 5.039,
      0.447, -0.198, 5.168,
      0.447, 0.198, 5.168,
    ], 3));
    geometry.setIndex([0, 1, 3, 0, 2, 4]);
    jGun.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      name: 'mc/mtl_t6_wpn_ar_hk416',
    })));
  }

  viewmodel.root.add(jGun);
  viewmodel.root.updateMatrixWorld(true);
  return { viewmodel, jGun, tagSights };
}

// Points in gun-local coordinates, mapped through the ADS transform into the
// camera's frame, which is where the player reads the sight picture.
function aimedSights(viewmodel, jGun) {
  const toCamera = (local) => jGun
    .localToWorld(new THREE.Vector3(...local))
    .applyMatrix4(viewmodel.adsMatrix);
  return {
    front: toCamera(FRONT_TIP),
    rear: toCamera(REAR_TOP),
    notchFloor: toCamera(NOTCH_FLOOR),
  };
}

test('ADS puts both sights on the view axis, not just the front post', () => {
  const { viewmodel, jGun } = buildRig();
  viewmodel.computeAdsAlignment();
  const { front, rear } = aimedSights(viewmodel, jGun);

  assert.ok(Math.hypot(front.x, front.y) < 1e-6, `front post off axis: ${front.x}, ${front.y}`);
  assert.ok(Math.hypot(rear.x, rear.y) < 1e-6, `rear sight off axis: ${rear.x}, ${rear.y}`);
});

test('the front post stands clear of the rear sight instead of grazing it', () => {
  const { viewmodel, jGun } = buildRig();
  viewmodel.computeAdsAlignment();
  const { front, rear, notchFloor } = aimedSights(viewmodel, jGun);

  // The post tip is authored level with the notch floor, so aiming on the floor
  // hides the post behind the sight body — the bug this guards. Levelling on the
  // shoulders instead drops the floor below the axis, opening the sight picture.
  const drop = -notchFloor.y / -notchFloor.z; // tangent of the angle below centre
  assert.ok(drop > 0.03, `notch floor should sit below the axis, got ${notchFloor.y} at ${notchFloor.z}`);
  // ...and it has to clear the post by more than the post's own height, or there
  // is still nothing to see standing up in the opening.
  assert.ok(-notchFloor.y > 0.143, `too little clearance over the post: ${-notchFloor.y}`);
  assert.ok(Math.abs(front.y) < 1e-6, 'the post itself stays on the axis');
  assert.ok(Math.abs(rear.y) < 1e-6, 'and so do the shoulders it is levelled against');
});

test('the eye sits behind the rear sight, so the rear sight is actually drawn', () => {
  const { viewmodel, jGun } = buildRig();
  viewmodel.computeAdsAlignment();
  const { front, rear } = aimedSights(viewmodel, jGun);

  // The bug this replaced anchored the eye on tag_sights, which is authored on
  // the *front* sight base: the camera landed between the sights and the rear
  // sight fell ~4 units behind it, outside the near plane and never rendered.
  assert.ok(rear.z < -viewmodel.camera.near, `rear sight is behind the near plane: ${rear.z}`);
  assert.ok(Math.abs(rear.z + viewmodel.adsEyeRelief) < 1e-6, `eye relief: ${rear.z}`);
  // The front post keeps the full sight radius beyond it.
  const radius = new THREE.Vector3(...FRONT_TIP).distanceTo(new THREE.Vector3(...REAR_TOP));
  assert.ok(Math.abs(front.z + viewmodel.adsEyeRelief + radius) < 1e-6, `front post depth: ${front.z}`);
  assert.ok(front.z < rear.z, 'front post should be further from the eye than the rear sight');
});

test('ADS aims along the sight line, not along the barrel', () => {
  const { viewmodel, jGun } = buildRig();
  viewmodel.computeAdsAlignment();
  const { front, rear } = aimedSights(viewmodel, jGun);

  const sightLine = front.clone().sub(rear).normalize();
  assert.ok(sightLine.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-6, `sight line: ${sightLine.toArray()}`);

  // The shoulders stand 0.169 above the post tip over a 11.9 sight radius, so
  // the sight line declines relative to the bore and the barrel is left a touch
  // nose-up. Squaring the barrel to the view instead — what this replaced —
  // would put that tilt into the sight picture rather than the gun's attitude.
  const barrel = new THREE.Vector3(1, 0, 0)
    .applyQuaternion(jGun.getWorldQuaternion(new THREE.Quaternion()))
    .applyQuaternion(viewmodel.adsQuat);
  assert.ok(Math.abs(barrel.y - 0.0142) < 1e-3, `barrel should be a touch nose-up, got ${barrel.y}`);

  // No roll: the gun's up axis stays in the camera's vertical plane.
  const up = new THREE.Vector3(0, 0, 1)
    .applyQuaternion(jGun.getWorldQuaternion(new THREE.Quaternion()))
    .applyQuaternion(viewmodel.adsQuat);
  assert.ok(Math.abs(up.x) < 1e-6, `gun rolled: ${up.toArray()}`);
});

test('the rear sight is found at its shoulders, laterally centred', () => {
  const { viewmodel, jGun } = buildRig();
  const front = jGun.localToWorld(new THREE.Vector3(...FRONT_TIP));
  const rear = jGun.worldToLocal(viewmodel.findRearSight(jGun, front));

  assert.ok(Math.abs(rear.z - REAR_TOP[2]) < 1e-4, `not the shoulder height: ${rear.z}`);
  assert.ok(Math.abs(rear.x - REAR_TOP[0]) < 1e-4, `not the shoulder depth: ${rear.x}`);
  // The winning vertex is one shoulder, 0.198 off centre. Keeping that offset
  // would swing the sight picture 0.198/adsEyeRelief sideways.
  assert.ok(Math.abs(rear.y) < 1e-6, `should be pulled onto the centreline, got ${rear.y}`);
});

test('rigs with no rear sight fall back to centring the front post', () => {
  const { viewmodel, jGun, tagSights } = buildRig({ rear: false });
  viewmodel.computeAdsAlignment();

  // The front sight hood is the only thing left in the search band, and it is
  // too close to the post to be a rear sight, so the barrel stands in for the
  // sight line and tag_sights sets the eye relief.
  const front = jGun.localToWorld(new THREE.Vector3(...FRONT_TIP));
  assert.equal(viewmodel.findRearSight(jGun, front), null);

  const tip = front.clone().applyMatrix4(viewmodel.adsMatrix);
  assert.ok(Math.hypot(tip.x, tip.y) < 1e-6, `post tip should land on the view axis, got ${tip.x}, ${tip.y}`);

  const sight = tagSights.getWorldPosition(new THREE.Vector3()).applyMatrix4(viewmodel.adsMatrix);
  assert.ok(Math.abs(sight.z + viewmodel.adsDistance) < 1e-6, `eye relief moved: ${sight.z}`);
  assert.ok(Math.abs(sight.y + 0.399) < 1e-3, `tag should hang below the axis, got ${sight.y}`);
  assert.ok(Math.abs(sight.x) < 1e-6);
  assert.ok(Math.abs(tip.z + viewmodel.adsDistance - -0.84) < 1e-2, `tip depth: ${tip.z}`);
});

test('rigs without a sight insert still align on tag_sights alone', () => {
  const { viewmodel, tagSights } = buildRig({ insert: false });
  viewmodel.computeAdsAlignment();

  const sight = tagSights.getWorldPosition(new THREE.Vector3()).applyMatrix4(viewmodel.adsMatrix);
  assert.ok(Math.hypot(sight.x, sight.y) < 1e-6, `fallback should centre the tag, got ${sight.x}, ${sight.y}`);
  assert.ok(Math.abs(sight.z + viewmodel.adsDistance) < 1e-6);
});

test('tag_sights_on is the fallback eye anchor when tag_sights is absent', () => {
  const { viewmodel, tagSights } = buildRig({
    insert: false,
    rear: false,
    sightTag: 'tag_sights_on',
  });
  viewmodel.computeAdsAlignment();

  const sight = tagSights.getWorldPosition(new THREE.Vector3()).applyMatrix4(viewmodel.adsMatrix);
  assert.ok(Math.hypot(sight.x, sight.y) < 1e-6, `fallback should centre tag_sights_on, got ${sight.x}, ${sight.y}`);
  assert.ok(Math.abs(sight.z + viewmodel.adsDistance) < 1e-6);
});

// The override exists for rigs with no insert material, which are exactly the
// rigs findSightTip cannot measure. Hanging the rear anchor off a resolved front
// point therefore discarded it on every gun the option was added for.
test('a front anchor alone still drives the two-point solve on an insertless rig', () => {
  const { viewmodel, jGun } = buildRig({
    insert: false,
    sightTag: 'tag_sights_on',
    adsSightAnchors: { front: FRONT_TIP },
  });
  viewmodel.computeAdsAlignment();
  const { front, rear } = aimedSights(viewmodel, jGun);

  // The rear sight still comes from the geometry: findRearSight measures off the
  // post tip, and the anchor supplies exactly that.
  assert.ok(Math.hypot(front.x, front.y) < 1e-6, `front post off axis: ${front.x}, ${front.y}`);
  assert.ok(Math.hypot(rear.x, rear.y) < 1e-6, `rear sight off axis: ${rear.x}, ${rear.y}`);
  assert.ok(Math.abs(rear.z + viewmodel.adsEyeRelief) < 1e-6, `eye relief: ${rear.z}`);
});

test('a rear anchor with no front point is reported rather than dropped', () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const { viewmodel } = buildRig({
      insert: false,
      rear: false,
      sightTag: 'tag_sights_on',
      adsSightAnchors: { rear: REAR_TOP },
    });
    viewmodel.computeAdsAlignment();
    // Nothing can supply the front point here, so the sight line is unsolvable
    // and the fallback runs. That is the picture this solve replaced, so the
    // mis-authored definition has to be audible rather than silent.
    assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}`);
    assert.match(warnings[0], /adsSightAnchors\.rear/);
  } finally {
    console.warn = warn;
  }
});

for (const { id, sightTag, insert, adsSightAnchors } of RIFLE_SIGHT_CONFIGS) {
  test(`${id} produces a finite, non-identity ADS alignment`, () => {
    const { viewmodel, jGun } = buildRig({ sightTag, insert, adsSightAnchors });
    viewmodel.computeAdsAlignment();

    assert.ok(viewmodel.adsMatrix.elements.every(Number.isFinite), `${id} ADS matrix is not finite`);
    assert.ok(!viewmodel.adsMatrix.equals(new THREE.Matrix4()), `${id} ADS matrix is still identity`);

    if (adsSightAnchors) {
      const { front, rear } = aimedSights(viewmodel, jGun);
      assert.ok(Math.hypot(front.x, front.y) < 1e-6, `${id} override front off axis`);
      assert.ok(Math.hypot(rear.x, rear.y) < 1e-6, `${id} override rear off axis`);
    }
  });
}
