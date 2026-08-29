import * as THREE from 'three';

const _rootInverse = new THREE.Matrix4();
const _relativeMatrix = new THREE.Matrix4();
const _position = new THREE.Vector3();

function identityFor(value, ids, cursor) {
  if (!ids.has(value)) ids.set(value, cursor.value++);
  return ids.get(value);
}

function opaqueMaterial(material) {
  const materials = Array.isArray(material) ? material : [material];
  return materials.length > 0 && materials.every((entry) => entry && !entry.transparent && entry.opacity >= 1);
}

/**
 * Collapse repeated static meshes into spatially bounded InstancedMesh groups.
 * Keeping each batch inside one cell preserves coarse frustum culling while
 * removing most per-prop Object3D traversal and matrix work.
 */
export function optimizeStaticScene(root, {
  cellSize = 640,
  verticalCellSize = 256,
  minInstances = 2,
} = {}) {
  if (!root?.isObject3D) throw new TypeError('optimizeStaticScene requires an Object3D');
  root.updateWorldMatrix(true, true);
  _rootInverse.copy(root.matrixWorld).invert();
  const geometryIds = new WeakMap();
  const materialIds = new WeakMap();
  const cursor = { value: 1 };
  const groups = new Map();
  const meshes = [];
  let objectsBefore = 0;

  root.traverse((object) => {
    objectsBefore += 1;
    if (!object.isMesh || object.isSkinnedMesh || object.isInstancedMesh || !object.visible) return;
    if (!object.geometry || !opaqueMaterial(object.material) || object.morphTargetInfluences) return;
    _relativeMatrix.multiplyMatrices(_rootInverse, object.matrixWorld);
    _position.setFromMatrixPosition(_relativeMatrix);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const materialKey = materials.map((material) => identityFor(material, materialIds, cursor)).join(',');
    const key = [
      identityFor(object.geometry, geometryIds, cursor),
      materialKey,
      Math.floor(_position.x / cellSize),
      Math.floor(_position.y / verticalCellSize),
      Math.floor(_position.z / cellSize),
      object.castShadow ? 1 : 0,
      object.receiveShadow ? 1 : 0,
      object.renderOrder,
      object.layers.mask,
    ].join('|');
    if (!groups.has(key)) groups.set(key, []);
    const entry = { object, matrix: _relativeMatrix.clone() };
    groups.get(key).push(entry);
    meshes.push(entry);
  });

  let batches = 0;
  let removedMeshes = 0;
  for (const entries of groups.values()) {
    if (entries.length < minInstances) continue;
    const source = entries[0].object;
    const batch = new THREE.InstancedMesh(source.geometry, source.material, entries.length);
    batch.name = `static_batch_${batches}`;
    batch.castShadow = source.castShadow;
    batch.receiveShadow = source.receiveShadow;
    batch.renderOrder = source.renderOrder;
    batch.layers.mask = source.layers.mask;
    batch.matrixAutoUpdate = false;
    batch.matrix.identity();
    for (let i = 0; i < entries.length; i += 1) batch.setMatrixAt(i, entries[i].matrix);
    batch.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    batch.instanceMatrix.needsUpdate = true;
    batch.computeBoundingBox();
    batch.computeBoundingSphere();
    root.add(batch);
    for (const { object } of entries) object.removeFromParent();
    batches += 1;
    removedMeshes += entries.length;
  }

  root.updateWorldMatrix(true, true);
  let objectsAfter = 0;
  root.traverse((object) => {
    objectsAfter += 1;
    object.matrixAutoUpdate = false;
  });
  return {
    cellSize,
    inputMeshes: meshes.length,
    batches,
    instances: removedMeshes,
    retainedMeshes: meshes.length - removedMeshes,
    objectsBefore,
    objectsAfter,
  };
}

export default optimizeStaticScene;
