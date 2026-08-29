#!/usr/bin/env node
/**
 * Bake the Hijacked collision mesh into a serialized Detour navmesh.
 *
 * The browser must never rebake this data. Run this script after the
 * collision exporter has produced export/web/hijacked_collision.gltf (or a
 * JSON source containing positions/indices):
 *
 *   npm run bake:navmesh
 *   npm run bake:navmesh -- --input export/web/hijacked_collision.gltf
 *
 * Input geometry is expected to be in Three.js coordinates (x, y-up, z).
 * JSON sources may set coordinateSystem to "t6"/"t6-z-up" when their
 * vertices still use the game's x, y, z-up coordinates. The same metadata
 * is accepted for off-mesh candidates.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportNavMesh, init, NavMeshQuery } from '@recast-navigation/core';
import { generateSoloNavMesh } from '@recast-navigation/generators';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INPUTS = [
  'export/web/hijacked_collision.gltf',
  'export/web/hijacked_collision.glb',
  'export/web/hijacked_nav_source.json',
  'export/web/nav_source.json',
];
const DEFAULT_OFFMESH_INPUTS = [
  'export/web/hijacked_navigation_hints.json',
  'export/web/hijacked_nav_hints.json',
  'export/web/hijacked_offmesh.json',
  'export/web/hijacked_off_mesh.json',
  'export/web/nav_links.json',
];
const DEFAULT_OUTPUT = 'export/web/hijacked.navmesh.bin';
const PATHNODE_BOUNDS_PADDING = Object.freeze({ x: 384, y: 256, z: 384 });

// T6 world units. Recast's height/radius fields below are voxel counts.
const NAV_CONFIG = Object.freeze({
  cs: 4,
  ch: 2,
  walkableSlopeAngle: 45,
  walkableHeight: Math.ceil(72 / 2),
  walkableClimb: Math.floor(18 / 2),
  walkableRadius: Math.ceil(16 / 4),
  maxEdgeLen: 12,
  maxSimplificationError: 1.3,
  minRegionArea: 8,
  mergeRegionArea: 20,
  maxVertsPerPoly: 6,
  detailSampleDist: 6,
  detailSampleMaxError: 1,
  buildBvTree: true,
});

const COMPONENT_TYPES = {
  5120: { size: 1, read: 'getInt8' },
  5121: { size: 1, read: 'getUint8' },
  5122: { size: 2, read: 'getInt16' },
  5123: { size: 2, read: 'getUint16' },
  5125: { size: 4, read: 'getUint32' },
  5126: { size: 4, read: 'getFloat32' },
};
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(`usage: node .tools/bake_navmesh.mjs [options]

options:
  --input <file>       collision .gltf/.glb or JSON nav source
  --offmesh <file>     JSON off-mesh candidates/links
  --output <file>      serialized output (default ${DEFAULT_OUTPUT})
  --meta <file>        metadata output (default output with .json suffix)
  --coordinate-system <auto|three|t6>
                       override geometry coordinate system
  --help`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const args = { input: undefined, offmesh: undefined, output: DEFAULT_OUTPUT, meta: undefined, coordinateSystem: 'auto' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      return null;
    }
    if (arg === '--input' || arg === '-i') args.input = argv[++i];
    else if (arg === '--offmesh' || arg === '--off-mesh') args.offmesh = argv[++i];
    else if (arg === '--output' || arg === '-o') args.output = argv[++i];
    else if (arg === '--meta') args.meta = argv[++i];
    else if (arg === '--coordinate-system' || arg === '--coords') args.coordinateSystem = argv[++i];
    else if (arg.startsWith('-')) usage(`unknown option ${arg}`);
    else if (!args.input) args.input = arg;
    else usage(`unexpected argument ${arg}`);
    if (process.exitCode === 2) return null;
  }
  return args;
}

function absolute(candidate) {
  return path.isAbsolute(candidate) ? candidate : path.resolve(ROOT, candidate);
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    const full = absolute(candidate);
    if (fs.existsSync(full)) return full;
  }
  return undefined;
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function normalizeCoordinateSystem(value, fallback = 'three') {
  if (value && typeof value === 'object') {
    // The collision exporter records a small provenance object, e.g.
    // { source: "T6 z-up", target: "Three.js y-up" }. Geometry and hints
    // in that file are already in the target coordinate system.
    const target = value.target ?? value.output ?? value.to;
    if (target !== undefined) return normalizeCoordinateSystem(target, fallback);
    const source = value.source ?? value.input ?? value.from;
    if (source !== undefined) return normalizeCoordinateSystem(source, fallback);
  }
  const text = String(value ?? fallback).toLowerCase().replace(/[_\s]/g, '-');
  if (text === 'auto') return 'auto';
  if (text === 't6' || text === 'game' || text === 'z-up' || text === 't6-z-up' || text.includes('t6') || text.includes('z-up')) return 't6';
  if (text === 'three' || text === 'gltf' || text === 'y-up' || text === 'three-y-up' || text.includes('three') || text.includes('y-up')) return 'three';
  throw new Error(`unsupported coordinate system ${JSON.stringify(value)}; use three or t6`);
}

function asVector(value, label = 'vector') {
  if (Array.isArray(value) && value.length >= 3) {
    const result = { x: Number(value[0]), y: Number(value[1]), z: Number(value[2]) };
    if (Object.values(result).every(Number.isFinite)) return result;
  }
  if (value && typeof value === 'object') {
    const result = { x: Number(value.x), y: Number(value.y), z: Number(value.z) };
    if (Object.values(result).every(Number.isFinite)) return result;
  }
  throw new Error(`${label} must be [x,y,z] or {x,y,z}`);
}

function toThreeVector(value, coordinateSystem, label = 'vector') {
  const vector = asVector(value, label);
  return coordinateSystem === 't6'
    ? { x: vector.x, y: vector.z, z: -vector.y }
    : vector;
}

function flattenVectors(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  if (!values.length) return [];
  if (typeof values[0] === 'number') return values.map(Number);
  const output = [];
  for (const value of values) {
    const vector = asVector(value, label);
    output.push(vector.x, vector.y, vector.z);
  }
  return output;
}

function transformFlatPositions(values, coordinateSystem) {
  const positions = flattenVectors(values, 'positions');
  if (positions.length % 3 !== 0) throw new Error('positions length must be a multiple of 3');
  if (coordinateSystem !== 't6') return positions;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    positions[i] = x;
    positions[i + 1] = z;
    positions[i + 2] = -y;
  }
  return positions;
}

function normalizeIndices(values, vertexCount) {
  if (values === undefined || values === null) {
    const generated = [];
    for (let i = 0; i < vertexCount; i += 1) generated.push(i);
    values = generated;
  }
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) throw new Error('indices must be an array');
  const indices = Array.from(values, Number);
  if (indices.length % 3 !== 0) throw new Error('indices length must be a multiple of 3');
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
      throw new Error(`index ${index} is outside the ${vertexCount}-vertex source`);
    }
  }
  return indices;
}

function appendGeometry(target, positions, indices) {
  const base = target.positions.length / 3;
  target.positions.push(...positions);
  for (const index of indices) target.indices.push(index + base);
}

function findGeometryObject(source) {
  if (source && typeof source === 'object') {
    if (source.positions || source.vertices) return source;
    if (source.geometry) {
      const nested = findGeometryObject(source.geometry);
      if (nested) return nested;
    }
  }
  return undefined;
}

function parsePathnodes(values, coordinateSystem) {
  if (!Array.isArray(values)) return [];
  return values.map((value, index) => toThreeVector(value?.origin ?? value?.position ?? value, coordinateSystem, `pathnode ${index}`));
}

function parseOffMeshList(values, coordinateSystem) {
  if (!values) return [];
  const list = Array.isArray(values)
    ? values
    : values.offMeshConnections ?? values.offmeshConnections ?? values.connections ?? values.links ?? values.navigationLinks ?? values.negotiation ?? values.negotiations ?? [];
  if (!Array.isArray(list)) return [];
  return list.map((item, index) => {
    const endpoints = Array.isArray(item)
      ? { start: item[0], end: item[1] }
      : { start: item?.startPosition ?? item?.start ?? item?.a, end: item?.endPosition ?? item?.end ?? item?.b };
    if (!endpoints.start || !endpoints.end) throw new Error(`off-mesh candidate ${index} has no start/end`);
    return {
      startPosition: toThreeVector(endpoints.start, coordinateSystem, `off-mesh ${index} start`),
      endPosition: toThreeVector(endpoints.end, coordinateSystem, `off-mesh ${index} end`),
      radius: Number(item?.radius ?? 20),
      bidirectional: item?.bidirectional === undefined ? true : Boolean(item.bidirectional),
      area: Number(item?.area ?? 0),
      flags: Number(item?.flags ?? 1),
      ...(item?.userId === undefined ? {} : { userId: Number(item.userId) }),
    };
  });
}

function parseJsonGeometry(source, filename, forcedCoordinateSystem) {
  const metadataSystem = source.coordinateSystem ?? source.extras?.coordinateSystem;
  const coordinateSystem = forcedCoordinateSystem !== 'auto'
    ? normalizeCoordinateSystem(forcedCoordinateSystem)
    : normalizeCoordinateSystem(metadataSystem ?? 'three');
  const target = { positions: [], indices: [], offMeshConnections: [], pathnodes: [] };
  const rootGeometry = findGeometryObject(source);
  if (rootGeometry) {
    const positions = transformFlatPositions(rootGeometry.positions ?? rootGeometry.vertices, coordinateSystem);
    appendGeometry(target, positions, normalizeIndices(rootGeometry.indices ?? rootGeometry.triangles, positions.length / 3));
  } else if (Array.isArray(source.meshes)) {
    for (const mesh of source.meshes) {
      const geometry = findGeometryObject(mesh);
      if (!geometry) continue;
      const positions = transformFlatPositions(geometry.positions ?? geometry.vertices, coordinateSystem);
      appendGeometry(target, positions, normalizeIndices(geometry.indices ?? geometry.triangles, positions.length / 3));
    }
  } else {
    throw new Error(`${filename} has no positions/vertices geometry`);
  }
  if (!target.positions.length || !target.indices.length) throw new Error(`${filename} contains no triangles`);
  target.coordinateSystem = coordinateSystem;
  target.offMeshConnections.push(...parseOffMeshList(source.offMeshConnections ?? source.offmeshConnections ?? source.links, coordinateSystem));
  target.pathnodes.push(...parsePathnodes(source.pathnodes ?? source.pathNodes, coordinateSystem));
  target.bounds = source.bounds;
  return target;
}

function decodeDataUri(uri) {
  const comma = uri.indexOf(',');
  if (comma < 0) throw new Error('invalid data URI');
  const header = uri.slice(0, comma);
  const body = uri.slice(comma + 1);
  return header.toLowerCase().includes(';base64')
    ? Buffer.from(body, 'base64')
    : Buffer.from(decodeURIComponent(body), 'utf8');
}

function parseGlb(filename) {
  const bytes = fs.readFileSync(filename);
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) throw new Error(`${filename} is not a glTF 2.0 binary`);
  const chunks = new Map();
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    chunks.set(type, bytes.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  const jsonChunk = chunks.get(0x4e4f534a);
  if (!jsonChunk) throw new Error(`${filename} has no JSON glTF chunk`);
  const json = JSON.parse(Buffer.from(jsonChunk).toString('utf8').replace(/\0+$/, '').trim());
  return { json, binary: chunks.get(0x004e4942) };
}

function readGltfBuffers(gltf, filename, glbBinary) {
  return (gltf.buffers ?? []).map((buffer, index) => {
    if (buffer.uri) {
      return buffer.uri.startsWith('data:')
        ? decodeDataUri(buffer.uri)
        : fs.readFileSync(path.resolve(path.dirname(filename), decodeURIComponent(buffer.uri)));
    }
    if (index === 0 && glbBinary) return glbBinary;
    throw new Error(`${filename} buffer ${index} has no URI and no GLB BIN chunk`);
  });
}

function accessorValues(gltf, buffers, accessorIndex) {
  const accessor = gltf.accessors?.[accessorIndex];
  if (!accessor) throw new Error(`missing glTF accessor ${accessorIndex}`);
  const view = accessor.bufferView === undefined ? undefined : gltf.bufferViews?.[accessor.bufferView];
  const component = COMPONENT_TYPES[accessor.componentType];
  const components = TYPE_COMPONENTS[accessor.type];
  if (!component || !components) throw new Error(`unsupported glTF accessor ${accessorIndex}`);
  if (!view) throw new Error(`sparse/standalone glTF accessor ${accessorIndex} is not supported`);
  const buffer = buffers[view.buffer ?? 0];
  const baseOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? component.size * components;
  const data = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const values = new Array(accessor.count * components);
  for (let item = 0; item < accessor.count; item += 1) {
    for (let c = 0; c < components; c += 1) {
      const byteOffset = baseOffset + item * stride + c * component.size;
      values[item * components + c] = data[component.read](byteOffset, true);
    }
  }
  return { values, components };
}

function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiplyMatrix(a, b) {
  const result = new Array(16).fill(0);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      result[col * 4 + row] = a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    }
  }
  return result;
}

function nodeMatrix(node) {
  if (node.matrix) return Array.from(node.matrix, Number);
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  const [x, y, z, w] = r;
  const x2 = x + x; const y2 = y + y; const z2 = z + z;
  const xx = x * x2; const xy = x * y2; const xz = x * z2;
  const yy = y * y2; const yz = y * z2; const zz = z * z2;
  const wx = w * x2; const wy = w * y2; const wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

function transformPoint(matrix, x, y, z) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function primitiveTriangles(mode, indices) {
  const triangles = [];
  if (mode === 4) {
    for (let i = 0; i + 2 < indices.length; i += 3) triangles.push(indices[i], indices[i + 1], indices[i + 2]);
  } else if (mode === 5) {
    for (let i = 0; i + 2 < indices.length; i += 1) {
      if (i % 2) triangles.push(indices[i + 1], indices[i], indices[i + 2]);
      else triangles.push(indices[i], indices[i + 1], indices[i + 2]);
    }
  } else if (mode === 6) {
    for (let i = 1; i + 1 < indices.length; i += 1) triangles.push(indices[0], indices[i], indices[i + 1]);
  } else throw new Error(`unsupported glTF primitive mode ${mode}; only triangles/strip/fan are supported`);
  return triangles;
}

export function parseGltfGeometry(filename, forcedCoordinateSystem = 'auto') {
  const extension = path.extname(filename).toLowerCase();
  const glb = extension === '.glb' ? parseGlb(filename) : { json: readJson(filename), binary: undefined };
  const gltf = glb.json;
  const metadataSystem = gltf.extras?.coordinateSystem ?? gltf.asset?.extras?.coordinateSystem;
  const coordinateSystem = forcedCoordinateSystem !== 'auto'
    ? normalizeCoordinateSystem(forcedCoordinateSystem)
    : normalizeCoordinateSystem(metadataSystem ?? 'three');
  const buffers = readGltfBuffers(gltf, filename, glb.binary);
  const target = { positions: [], indices: [], offMeshConnections: [], pathnodes: [], coordinateSystem, worldBounds: undefined };
  const meshes = gltf.meshes ?? [];
  const nodes = gltf.nodes ?? [];
  const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? nodes.map((_, index) => index);
  const visited = new Set();
  const visit = (nodeIndex, parentMatrix) => {
    if (visited.has(nodeIndex)) return;
    visited.add(nodeIndex);
    const node = nodes[nodeIndex];
    if (!node) return;
    const matrix = multiplyMatrix(parentMatrix, nodeMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = meshes[node.mesh];
      const isWorldMesh = node.mesh === 0 || /world|shell/i.test(`${node.name ?? ''} ${mesh?.name ?? ''}`);
      for (const primitive of mesh?.primitives ?? []) {
        const positionAccessor = primitive.attributes?.POSITION;
        if (positionAccessor === undefined) continue;
        const positionData = accessorValues(gltf, buffers, positionAccessor);
        if (positionData.components !== 3) throw new Error(`glTF POSITION accessor ${positionAccessor} is not VEC3`);
        const base = target.positions.length / 3;
        for (let i = 0; i < positionData.values.length; i += 3) {
          const point = transformPoint(matrix, positionData.values[i], positionData.values[i + 1], positionData.values[i + 2]);
          const finalPoint = coordinateSystem === 't6' ? [point[0], point[2], -point[1]] : point;
          target.positions.push(...finalPoint);
          if (isWorldMesh) {
            if (!target.worldBounds) target.worldBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
            for (let axis = 0; axis < 3; axis += 1) {
              target.worldBounds.min[axis] = Math.min(target.worldBounds.min[axis], finalPoint[axis]);
              target.worldBounds.max[axis] = Math.max(target.worldBounds.max[axis], finalPoint[axis]);
            }
          }
        }
        let indices;
        if (primitive.indices !== undefined) indices = accessorValues(gltf, buffers, primitive.indices).values;
        else {
          indices = [];
          for (let i = 0; i < positionData.values.length / 3; i += 1) indices.push(i);
        }
        for (const index of primitiveTriangles(primitive.mode ?? 4, indices)) target.indices.push(base + index);
      }
    }
    for (const child of node.children ?? []) visit(child, matrix);
  };
  for (const root of roots) visit(root, identityMatrix());
  if (!target.positions.length || !target.indices.length) throw new Error(`${filename} contains no triangle POSITION geometry`);
  if (target.worldBounds) target.bounds = [target.worldBounds.min, target.worldBounds.max];
  target.offMeshConnections.push(...parseOffMeshList(gltf.extras?.offMeshConnections, coordinateSystem));
  target.pathnodes.push(...parsePathnodes(gltf.extras?.pathnodes, coordinateSystem));
  return target;
}

function loadInput(filename, coordinateSystem) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.gltf' || extension === '.glb') return parseGltfGeometry(filename, coordinateSystem);
  const source = readJson(filename);
  // The collision exporter also emits a provenance/source manifest. Accept
  // that manifest directly so callers do not need to know the glTF filename.
  if (!findGeometryObject(source) && source.files?.collisionGltf) {
    const collision = path.resolve(path.dirname(filename), source.files.collisionGltf);
    const parsed = loadInput(collision, coordinateSystem);
    if (!parsed.offMeshConnections.length && source.files.navHints) {
      const hints = path.resolve(path.dirname(filename), source.files.navHints);
      if (fs.existsSync(hints)) parsed.offMeshConnections.push(...loadOffMesh(hints, coordinateSystem).connections);
    }
    return parsed;
  }
  return parseJsonGeometry(source, filename, coordinateSystem);
}

function loadOffMesh(filename, coordinateSystem) {
  if (!filename) return { connections: [], pathnodes: [] };
  const source = readJson(filename);
  const system = coordinateSystem !== 'auto'
    ? normalizeCoordinateSystem(coordinateSystem)
    : normalizeCoordinateSystem(source.coordinateSystem ?? source.extras?.coordinateSystem ?? 'three');
  return {
    connections: parseOffMeshList(source, system),
    pathnodes: parsePathnodes(source.pathnodes ?? source.pathNodes ?? source.nodes, system),
  };
}

function computeBounds(positions, indices) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const index of indices) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index * 3 + axis];
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

function computePathnodeBounds(pathnodes) {
  if (!pathnodes.length) return undefined;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const point of pathnodes) {
    min[0] = Math.min(min[0], point.x);
    min[1] = Math.min(min[1], point.y);
    min[2] = Math.min(min[2], point.z);
    max[0] = Math.max(max[0], point.x);
    max[1] = Math.max(max[1], point.y);
    max[2] = Math.max(max[2], point.z);
  }
  return [
    min.map((value, axis) => value - PATHNODE_BOUNDS_PADDING[['x', 'y', 'z'][axis]]),
    max.map((value, axis) => value + PATHNODE_BOUNDS_PADDING[['x', 'y', 'z'][axis]]),
  ];
}

function makeGeneratorConfig(source, offMeshConnections) {
  const config = { ...NAV_CONFIG, offMeshConnections };
  if (Array.isArray(source.bounds) && source.bounds.length === 2) {
    config.bounds = [Array.from(source.bounds[0], Number), Array.from(source.bounds[1], Number)];
  } else if (source.bounds?.min && source.bounds?.max) {
    config.bounds = [Array.from(source.bounds.min, Number), Array.from(source.bounds.max, Number)];
  } else {
    // Collision exports can contain decorative/far vehicle collision LODs
    // hundreds of units beyond the playable ship. Pathnodes describe the
    // intended playable envelope; padding preserves the map shell while
    // keeping those isolated triangles out of the heightfield.
    config.bounds = computePathnodeBounds(source.pathnodes);
  }
  return config;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) return;
  const inputWasExplicit = Boolean(args.input);
  const input = inputWasExplicit ? absolute(args.input) : firstExisting(DEFAULT_INPUTS);
  if (!input) {
    usage(`no collision input found. Expected one of: ${DEFAULT_INPUTS.join(', ')}. Pass --input explicitly.`);
    return;
  }
  if (!fs.existsSync(input)) {
    usage(`input does not exist: ${input}`);
    return;
  }
  const output = absolute(args.output);
  const metaOutput = absolute(args.meta ?? (output.toLowerCase().endsWith('.bin') ? output.replace(/\.bin$/i, '.json') : `${output}.json`));
  // A map-wide sidecar is auto-discovered for the default collision input.
  // Explicit test/alternate sources should be self-contained unless the
  // caller opts in with --offmesh.
  const offMeshFile = args.offmesh ? absolute(args.offmesh) : (inputWasExplicit ? undefined : firstExisting(DEFAULT_OFFMESH_INPUTS));
  if (offMeshFile && !fs.existsSync(offMeshFile)) throw new Error(`off-mesh file does not exist: ${offMeshFile}`);

  const source = loadInput(input, args.coordinateSystem);
  const sidecarHints = loadOffMesh(offMeshFile, args.coordinateSystem);
  const links = [...source.offMeshConnections, ...sidecarHints.connections];
  source.pathnodes.push(...sidecarHints.pathnodes);
  const uniquePathnodes = [];
  const seenPathnodes = new Set();
  for (const point of source.pathnodes) {
    const key = `${point.x}|${point.y}|${point.z}`;
    if (!seenPathnodes.has(key)) {
      seenPathnodes.add(key);
      uniquePathnodes.push(point);
    }
  }
  source.pathnodes = uniquePathnodes;
  const uniqueLinks = [];
  const seenLinks = new Set();
  for (const link of links) {
    const key = JSON.stringify([link.startPosition.x, link.startPosition.y, link.startPosition.z, link.endPosition.x, link.endPosition.y, link.endPosition.z, link.radius, link.bidirectional]);
    if (!seenLinks.has(key)) {
      seenLinks.add(key);
      uniqueLinks.push(link);
    }
  }
  if (!Number.isFinite(source.positions[0])) throw new Error('input geometry contains no finite coordinates');
  await init();
  const config = makeGeneratorConfig(source, uniqueLinks);
  console.log(`baking ${path.relative(ROOT, input)}: ${source.positions.length / 3} vertices, ${source.indices.length / 3} triangles`);
  console.log(`config: cs=${config.cs}, ch=${config.ch}, height=${config.walkableHeight * config.ch}, climb=${config.walkableClimb * config.ch}, radius=${config.walkableRadius * config.cs}`);
  if (uniqueLinks.length) console.log(`off-mesh connections: ${uniqueLinks.length}`);
  const generated = generateSoloNavMesh(source.positions, source.indices, config);
  if (!generated.success || !generated.navMesh) throw new Error(`navmesh generation failed: ${generated.error ?? 'unknown error'}`);
  const bytes = exportNavMesh(generated.navMesh);

  const bounds = computeBounds(source.positions, source.indices);
  let pathnodeValidation;
  if (source.pathnodes.length) {
    const query = new NavMeshQuery(generated.navMesh);
    let projected = 0;
    for (const point of source.pathnodes) {
      const result = query.findNearestPoly(point, { halfExtents: { x: 48, y: 128, z: 48 } });
      if (result.success && result.nearestRef) projected += 1;
    }
    query.destroy();
    pathnodeValidation = { total: source.pathnodes.length, projected };
    if (projected !== source.pathnodes.length) console.warn(`warning: ${source.pathnodes.length - projected}/${source.pathnodes.length} pathnodes did not project onto the navmesh`);
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, Buffer.from(bytes));
  const metadata = {
    format: 'detour-navmesh',
    recastNavigationVersion: '0.43.1',
    coordinateSystem: 'three-y-up',
    source: path.relative(ROOT, input).replaceAll('\\', '/'),
    geometry: { vertices: source.positions.length / 3, triangles: source.indices.length / 3 },
    bounds,
    config: { ...config, bounds: config.bounds, offMeshConnections: undefined },
    offMeshConnections: uniqueLinks,
    pathnodes: pathnodeValidation,
    byteLength: bytes.length,
  };
  fs.mkdirSync(path.dirname(metaOutput), { recursive: true });
  fs.writeFileSync(metaOutput, `${JSON.stringify(metadata, null, 2)}\n`);
  generated.navMesh.destroy();
  console.log(`wrote ${path.relative(ROOT, output)} (${bytes.length} bytes)`);
  console.log(`wrote ${path.relative(ROOT, metaOutput)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
