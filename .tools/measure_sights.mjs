#!/usr/bin/env node
// Measures a weapon's iron sights off its exported viewmodel GLB and prints the
// two points `adsSightAnchors` wants: the front post tip and the top of the rear
// sight, in j_gun's local frame (X down the barrel, Y left, Z up).
//
// Why this exists: Viewmodel.findSightTip() locates the front post by looking for
// a `tritium` material, and three of the nine assault rifles -- saritch, scar and
// sig556 -- ship no such material at all. There is nothing for the automatic
// solve to key on, so those rigs need the points measured once and pinned in
// WEAPON_DEFINITIONS. See the `adsSightAnchors` comment in export/web/viewmodel.js.
//
// The rear sight is found the way the runtime finds it (highest vertex in a thin
// band behind the post, pulled onto the centreline), so a gun that *does* have an
// insert reproduces what the runtime already computes -- which is what makes
// hk416 usable as a calibration control:
//
//   node .tools/measure_sights.mjs hk416          # control: matches the runtime
//   node .tools/measure_sights.mjs scar --profile # unknown: read the Z profile
//
// GLTFLoader is used rather than a hand-rolled parser so the skinned bind pose
// matches the runtime exactly. It cannot fetch the sibling .dds textures under
// node, so the image/texture tables are stripped before parsing; only positions
// and the skeleton are needed here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolsDir, '..');
const MODEL_DIR = path.join(repoRoot, 'export_common', 'model_export');
const WEAPON_DIR = path.join(repoRoot, 'artifacts', 'weapon-data', 'weapons');

// The front post is a thin blade standing on the centreline, and on most of these
// rigs it is ringed by a hood whose ears stand *higher* than the post itself --
// on the hk416 the post tip is at z 4.999 and the hood tops out at 5.432, about
// 0.4 either side of centre. Taking the highest point in a wide band therefore
// measures the hood and puts the sight picture 0.43 too high. The post is what
// the eye lines up on, so the search band is narrow enough to fall inside the
// hood and catch only the blade.
const FRONT_HALF_WIDTH = 0.1;
// The rear sight is measured the way the runtime does it: a wider band, because
// the winning vertex is one of the two shoulders standing either side of the
// notch, then pulled back onto the centreline. Matches REAR_SIGHT_HALF_WIDTH.
const REAR_HALF_WIDTH = 0.5;
// In rig units, about one per inch. The shipped rifles run a 12-19 unit sight
// radius, so 2 is comfortably inside it.
const MIN_SIGHT_RADIUS = 2;

function parseWeaponFile(file) {
  const parts = fs.readFileSync(file, 'utf8').split('\\');
  const weapon = {};
  for (let i = 1; i < parts.length - 1; i += 2) weapon[parts[i]] = parts[i + 1];
  return weapon;
}

// Re-pack the GLB without its image/texture tables. GLTFLoader would otherwise
// try to resolve `../images/*.dds` relative to a path that does not exist here,
// and node has no image decoder to hand it anyway.
function stripTextures(buffer) {
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
  const binChunk = buffer.subarray(20 + jsonLength);

  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const material of json.materials ?? []) {
    delete material.normalTexture;
    delete material.occlusionTexture;
    delete material.emissiveTexture;
    if (material.pbrMetallicRoughness) {
      delete material.pbrMetallicRoughness.baseColorTexture;
      delete material.pbrMetallicRoughness.metallicRoughnessTexture;
    }
  }

  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const padded = Buffer.concat([
    jsonBytes,
    Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20),
  ]);
  const header = Buffer.alloc(20);
  header.write('glTF', 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length + binChunk.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.write('JSON', 16);
  return Buffer.concat([header, padded, binChunk]);
}

function loadScene(file) {
  const glb = stripTextures(fs.readFileSync(file));
  const array = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(array, '', (gltf) => resolve(gltf.scene), reject);
  });
}

function findNode(root, name) {
  let found = null;
  root.traverse((object) => {
    if (!found && object.name === name) found = object;
  });
  return found;
}

// Every posed vertex expressed in j_gun's local frame, the space the anchors are
// authored in. Skinned meshes go through applyBoneTransform so the bind pose
// matches what the runtime sees.
function gunSpaceVertices(root, jGun) {
  const toGun = new THREE.Matrix4().copy(jGun.matrixWorld).invert();
  const vertex = new THREE.Vector3();
  const points = [];
  root.traverse((object) => {
    if (!object.isMesh) return;
    const position = object.geometry.getAttribute('position');
    const index = object.geometry.getIndex();
    const count = index ? index.count : position.count;
    const toGunLocal = new THREE.Matrix4().multiplyMatrices(toGun, object.matrixWorld);
    const seen = new Set();
    for (let i = 0; i < count; i += 1) {
      const vertexIndex = index ? index.getX(i) : i;
      if (seen.has(vertexIndex)) continue;
      seen.add(vertexIndex);
      vertex.fromBufferAttribute(position, vertexIndex);
      if (object.isSkinnedMesh) object.applyBoneTransform(vertexIndex, vertex);
      vertex.applyMatrix4(toGunLocal);
      points.push(vertex.clone());
    }
  });
  return points;
}

// The front post, told apart from its hood by width rather than height.
//
// Height alone does not work. The hood's ears stand above the post, and on the
// scar the hood carries vertices at exactly y=0, so no centreline band however
// tight excludes it — taking the highest point there measured a plateau 0.54
// above the rear notch and produced a sight line that climbed toward the muzzle.
//
// What actually separates them is lateral extent: a post is a blade a few
// hundredths wide, while the hood around it spans 0.3 to 1.0. So the rig is
// sliced into height bands, each band measured across its *full* width, and the
// highest band still narrow enough to be a blade is the post. On the scar that
// picks z 4.80..4.90, extent 0.026, with every band above it 0.15 to 0.51 wide.
// The band has to be local along the barrel as well as in height, or unrelated
// structure at the same height poisons it: on the sig556 the handguard sits level
// with the post but a foot further back, and a full-length band picked that up and
// rejected every candidate. Cells are one unit long and one band tall.
const POST_MAX_HALF_WIDTH = 0.06;
const BAND_HEIGHT = 0.05;
const CELL_LENGTH = 1;

// The plain reading: the highest thing sitting on the centreline ahead of the
// receiver. Right on eight of the nine rifles, and the one it misses it misses
// loudly (see the slope check in measure()).
function findFrontPeak(points, split) {
  let best = null;
  for (const p of points) {
    if (Math.abs(p.y) > FRONT_HALF_WIDTH || p.x < split) continue;
    if (!best || p.z > best.z + 1e-4 || (Math.abs(p.z - best.z) <= 1e-4 && p.x > best.x)) best = p;
  }
  if (!best) return null;
  const centred = best.clone();
  centred.y = 0;
  return centred;
}

function findFrontPost(points, split) {
  const forward = points.filter((p) => p.x >= split);
  if (!forward.length) return null;

  const cellKey = (p) => `${Math.floor(p.x / CELL_LENGTH)}:${Math.floor(p.z / BAND_HEIGHT)}`;
  const cells = new Map();
  for (const p of forward) {
    const key = cellKey(p);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(p);
  }

  // Widest point of each cell, then the highest cell still blade-narrow.
  let blade = null;
  for (const members of [...cells.values()].sort(
    (a, b) => Math.max(...b.map((p) => p.z)) - Math.max(...a.map((p) => p.z)),
  )) {
    if (Math.max(...members.map((p) => Math.abs(p.y))) > POST_MAX_HALF_WIDTH) continue;
    blade = members;
    break;
  }
  if (!blade) return null;

  // Mirror findSightTip: the tip is the top of the blade, taken at its centre
  // rather than at whichever corner happened to win. The post is symmetric about
  // the weapon's centreline and that is where the eye looks — the same correction
  // findRearSight applies to the rear shoulders, and worth making, since an 0.018
  // offset is already a third of a degree once divided by the eye relief.
  const box = new THREE.Box3();
  for (const p of blade) box.expandByPoint(p);
  const tip = box.getCenter(new THREE.Vector3());
  tip.z = box.max.z;
  tip.y = 0;
  return tip;
}

// The rear sight, found the way Viewmodel.findRearSight does: the highest vertex
// in a thin horizontal band behind the post, then pulled onto the centreline
// because the winning vertex is one of the two symmetric shoulders.
function findRearSight(points, front, band) {
  let best = null;
  for (const p of points) {
    if (p.x > front.x - MIN_SIGHT_RADIUS) continue;
    if (Math.abs(p.y - front.y) > REAR_HALF_WIDTH) continue;
    if (Math.abs(p.z - front.z) > band) continue;
    if (!best || p.z > best.z) best = p;
  }
  if (!best) return null;
  const centred = best.clone();
  centred.y = front.y;
  return centred;
}

// A coarse height profile down the barrel, for eyeballing where the sights are on
// a rig whose posts cannot be identified by material.
function profile(points, bins = 26) {
  const xs = points.map((p) => p.x);
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  const step = (max - min) / bins;
  const rows = [];
  for (let i = 0; i < bins; i += 1) {
    const lo = min + i * step;
    const hi = lo + step;
    let top = null;
    for (const p of points) {
      if (p.x < lo || p.x >= hi || Math.abs(p.y) > REAR_HALF_WIDTH) continue;
      if (!top || p.z > top.z) top = p;
    }
    if (top) rows.push({ x: `${lo.toFixed(1)}..${hi.toFixed(1)}`, maxZ: Number(top.z.toFixed(3)) });
  }
  return rows;
}

const round = (v) => [Number(v.x.toFixed(3)), Number(v.y.toFixed(3)), Number(v.z.toFixed(3))];

export async function measure(id, { band = 0.45, showProfile = false } = {}) {
  const weapon = parseWeaponFile(path.join(WEAPON_DIR, `${id}_mp`));
  const scene = await loadScene(path.join(MODEL_DIR, `${weapon.gunModel}_lod0.glb`));
  scene.updateMatrixWorld(true);
  const jGun = findNode(scene, 'j_gun');
  if (!jGun) throw new Error(`${id}: no j_gun in ${weapon.gunModel}`);

  const points = gunSpaceVertices(scene, jGun);
  const xs = points.map((p) => p.x);
  // Sights straddle the receiver, so split the rig at its midpoint and look for
  // the post in the forward half.
  const split = (Math.min(...xs) + Math.max(...xs)) / 2;

  // Two readings, and the slope decides between them rather than a hand-picked
  // rule per gun. The centreline peak is right on eight of nine; where a hood
  // stands over the post and reaches the centreline — the scar — that reading
  // climbs toward the muzzle and the narrow-blade search is tried instead. Doing
  // it the other way round breaks the sig556, whose post is a wider blade than
  // the filter admits, so neither heuristic is trusted on its own.
  const slopeOf = (f, r) => (f && r ? (f.z - r.z) / (f.x - r.x) : null);
  const isSightLine = (s) => s !== null && s < 0 && s > -0.05;

  const readings = [findFrontPeak(points, split), findFrontPost(points, split)]
    .filter(Boolean)
    .map((candidate) => {
      const candidateRear = findRearSight(points, candidate, band);
      return { front: candidate, rear: candidateRear, slope: slopeOf(candidate, candidateRear) };
    });
  const chosen = readings.find((r) => isSightLine(r.slope)) ?? readings[0] ?? {};
  const front = chosen.front ?? null;
  const rear = chosen.rear ?? null;

  const tags = {};
  for (const name of ['tag_sights', 'tag_sights_on', 'tag_sights_off', 'tag_flash']) {
    const node = findNode(scene, name);
    if (node) tags[name] = round(jGun.worldToLocal(node.getWorldPosition(new THREE.Vector3())));
  }

  // Sanity check, and the reason this tool reports rather than just emits: iron
  // sights decline very slightly toward the muzzle, so the sight line's slope is
  // a small negative number. Every rig that measures cleanly lands between -0.014
  // and -0.021 (hk416 -0.014, saritch -0.021, sig556 -0.017). A positive slope
  // means the front pick is not the post -- on the scar it caught a flat plateau
  // on the rail standing 0.6 above the rear notch, which would have aimed the gun
  // into the ground. Anything outside the band wants eyes on it before it ships.
  const slope = front && rear
    ? Number(((front.z - rear.z) / (front.x - rear.x)).toFixed(4))
    : null;

  return {
    id,
    model: weapon.gunModel,
    vertices: points.length,
    tags,
    front: front && round(front),
    rear: rear && round(rear),
    sightRadius: front && rear ? Number(front.distanceTo(rear).toFixed(3)) : null,
    slope,
    plausible: slope !== null && slope < 0 && slope > -0.05,
    profile: showProfile ? profile(points) : null,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const showProfile = args.includes('--profile');
  const bandArg = args.find((a) => a.startsWith('--band='));
  const ids = args.filter((a) => !a.startsWith('--'));
  if (!ids.length) {
    console.error('usage: node .tools/measure_sights.mjs <weapon-id>... [--profile] [--band=0.45]');
    process.exit(1);
  }
  for (const id of ids) {
    const result = await measure(id, {
      showProfile,
      band: bandArg ? Number(bandArg.split('=')[1]) : 0.45,
    });
    console.log(`\n${result.id}  (${result.model}, ${result.vertices} verts)`);
    console.log(`  tags        : ${JSON.stringify(result.tags)}`);
    console.log(`  front tip   : ${JSON.stringify(result.front)}`);
    console.log(`  rear top    : ${JSON.stringify(result.rear)}`);
    console.log(`  sight radius: ${result.sightRadius}`);
    console.log(`  sight slope : ${result.slope} ${result.plausible ? '(plausible)' : '<-- NOT A SIGHT LINE, check the front pick'}`);
    if (result.profile) {
      console.log('  height profile down the barrel (max Z near centreline):');
      for (const row of result.profile) console.log(`    x ${row.x.padStart(14)}  z ${row.maxZ}`);
    }
  }
}
