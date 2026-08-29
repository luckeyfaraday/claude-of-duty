import * as THREE from 'three';
import { acceleratedRaycast, MeshBVH } from 'three-mesh-bvh';

const _bounds = new THREE.Box3();
const _segment = new THREE.Line3();
const _trianglePoint = new THREE.Vector3();
const _capsulePoint = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _originalCenter = new THREE.Vector3();
const _resolvedCenter = new THREE.Vector3();
const _segmentCenter = new THREE.Vector3();

function typedArray(buffer, descriptor) {
  const constructors = { Float32Array, Uint16Array, Uint32Array, Int32Array };
  const Constructor = constructors[descriptor.type];
  if (!Constructor) throw new Error(`unsupported collision array type ${descriptor.type}`);
  return new Constructor(buffer, descriptor.byteOffset, descriptor.count);
}

function sliceBuffer(buffer, descriptor) {
  return buffer.slice(descriptor.byteOffset, descriptor.byteOffset + descriptor.byteLength);
}

export function deserializeCollisionWorld(metadata, binary) {
  if (metadata?.format !== 'hijacked-collision-bvh-v1') {
    throw new Error(`unsupported collision format ${metadata?.format ?? 'unknown'}`);
  }
  const positions = typedArray(binary, metadata.layout.position);
  const index = typedArray(binary, metadata.layout.index);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(...metadata.bounds.min),
    new THREE.Vector3(...metadata.bounds.max),
  );
  geometry.boundsTree = MeshBVH.deserialize({
    version: 1,
    roots: metadata.layout.roots.map((root) => sliceBuffer(binary, root)),
    index,
    indirectBuffer: null,
  }, geometry, { setIndex: false });
  return new CollisionWorld(geometry, metadata);
}

export async function loadCollisionWorld({
  metadataUrl = 'hijacked_collision_bvh.json',
  onProgress = null,
} = {}) {
  const started = performance.now();
  const metadataResponse = await fetch(metadataUrl);
  if (!metadataResponse.ok) throw new Error(`collision metadata HTTP ${metadataResponse.status}`);
  const metadata = await metadataResponse.json();
  const binaryResponse = await fetch(new URL(metadata.binary, metadataResponse.url));
  if (!binaryResponse.ok) throw new Error(`collision BVH HTTP ${binaryResponse.status}`);
  const total = Number(binaryResponse.headers.get('content-length')) || metadata.byteLength || 0;
  onProgress?.({ loaded: 0, total });
  const binary = await binaryResponse.arrayBuffer();
  onProgress?.({ loaded: binary.byteLength, total: total || binary.byteLength });
  const world = deserializeCollisionWorld(metadata, binary);
  world.loadMilliseconds = performance.now() - started;
  return world;
}

export class CollisionWorld {
  constructor(geometry, metadata = {}) {
    if (!geometry?.attributes?.position) throw new TypeError('CollisionWorld requires position geometry');
    if (!geometry.boundsTree) geometry.boundsTree = new MeshBVH(geometry, { targetLeafSize: 12 });
    this.geometry = geometry;
    this.bvh = geometry.boundsTree;
    this.metadata = metadata;
    this.loadMilliseconds = 0;
    this._hitTriangle = new THREE.Triangle();
    this.mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      color: 0xff3b30,
      wireframe: true,
      transparent: true,
      opacity: 0.24,
      depthTest: false,
    }));
    this.mesh.name = 'collision_bvh_debug';
    this.mesh.visible = false;
    this.mesh.renderOrder = 40;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.raycast = acceleratedRaycast;
  }

  get stats() {
    return {
      format: this.metadata.format ?? 'runtime-bvh',
      vertices: this.geometry.attributes.position.count,
      triangles: this.geometry.index ? this.geometry.index.count / 3 : this.geometry.attributes.position.count / 3,
      bytes: this.metadata.byteLength ?? 0,
      loadMilliseconds: Math.round(this.loadMilliseconds),
    };
  }

  setDebugVisible(visible) {
    this.mesh.visible = Boolean(visible);
  }

  capsuleIntersect(capsule) {
    _segment.start.copy(capsule.start);
    _segment.end.copy(capsule.end);
    _originalCenter.addVectors(capsule.start, capsule.end).multiplyScalar(0.5);
    _bounds.makeEmpty();
    _bounds.expandByPoint(capsule.start);
    _bounds.expandByPoint(capsule.end);
    _bounds.min.addScalar(-capsule.radius);
    _bounds.max.addScalar(capsule.radius);
    let hit = false;

    this.bvh.shapecast({
      intersectsBounds: (box) => box.intersectsBox(_bounds),
      intersectsTriangle: (triangle) => {
        const distance = triangle.closestPointToSegment(_segment, _trianglePoint, _capsulePoint);
        if (distance >= capsule.radius) return false;
        const depth = capsule.radius - distance;
        _normal.subVectors(_capsulePoint, _trianglePoint);
        if (_normal.lengthSq() < 1e-12) {
          triangle.getNormal(_normal);
          _segmentCenter.addVectors(_segment.start, _segment.end).multiplyScalar(0.5);
          if (_normal.dot(_segmentCenter.sub(triangle.a)) < 0) _normal.negate();
        } else {
          _normal.multiplyScalar(1 / Math.max(distance, 1e-12));
        }
        _segment.start.addScaledVector(_normal, depth);
        _segment.end.addScaledVector(_normal, depth);
        hit = true;
        return false;
      },
    });

    if (!hit) return false;
    _resolvedCenter.addVectors(_segment.start, _segment.end).multiplyScalar(0.5);
    _normal.subVectors(_resolvedCenter, _originalCenter);
    const depth = _normal.length();
    return depth > 0 ? { normal: _normal.multiplyScalar(1 / depth).clone(), depth } : false;
  }

  raycastFirst(ray, near = 0, far = Infinity, side = THREE.DoubleSide) {
    return this.bvh.raycastFirst(ray, side, near, far);
  }

  rayIntersect(ray, near = 0, far = Infinity) {
    const hit = this.raycastFirst(ray, near, far);
    if (!hit) return false;
    const index = this.geometry.index;
    const position = this.geometry.attributes.position;
    const triangleOffset = hit.faceIndex * 3;
    const a = index ? index.getX(triangleOffset) : triangleOffset;
    const b = index ? index.getX(triangleOffset + 1) : triangleOffset + 1;
    const c = index ? index.getX(triangleOffset + 2) : triangleOffset + 2;
    this._hitTriangle.a.fromBufferAttribute(position, a);
    this._hitTriangle.b.fromBufferAttribute(position, b);
    this._hitTriangle.c.fromBufferAttribute(position, c);
    return {
      distance: hit.distance,
      position: hit.point.clone(),
      point: hit.point.clone(),
      faceIndex: hit.faceIndex,
      triangle: this._hitTriangle,
    };
  }
}

export default CollisionWorld;
