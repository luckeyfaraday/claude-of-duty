#!/usr/bin/env node
/** Bake the static collision glTF into one compact, serialized mesh BVH. */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import * as THREE from 'three';
import { MeshBVH, SAH } from 'three-mesh-bvh';

import { parseGltfGeometry } from './bake_navmesh.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INPUT = 'export/web/hijacked_collision.gltf';
const DEFAULT_OUTPUT = 'export/web/hijacked_collision_bvh.bin';

function absolute(filename) {
  return path.isAbsolute(filename) ? filename : path.resolve(ROOT, filename);
}

function parseArgs(argv) {
  const args = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT, meta: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' || arg === '-i') args.input = argv[++i];
    else if (arg === '--output' || arg === '-o') args.output = argv[++i];
    else if (arg === '--meta') args.meta = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node .tools/bake_collision_bvh.mjs [--input collision.gltf] [--output collision_bvh.bin] [--meta collision_bvh.json]');
      return null;
    } else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

function appendPart(parts, metadata, name, typedArray) {
  const byteOffset = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  parts.push(bytes);
  metadata[name] = {
    byteOffset,
    byteLength: bytes.byteLength,
    type: typedArray.constructor.name,
    count: typedArray.length,
  };
}

function boundsOf(geometry) {
  geometry.computeBoundingBox();
  return {
    min: geometry.boundingBox.min.toArray(),
    max: geometry.boundingBox.max.toArray(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) return;
  const input = absolute(args.input);
  const output = absolute(args.output);
  const metaOutput = absolute(args.meta ?? output.replace(/\.bin$/i, '.json'));
  const source = parseGltfGeometry(input, 'auto');
  const positions = new Float32Array(source.positions);
  const indices = new Uint32Array(source.indices);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  const started = performance.now();
  const bvh = new MeshBVH(geometry, {
    strategy: SAH,
    maxDepth: 40,
    targetLeafSize: 12,
    setBoundingBox: true,
  });
  const buildMilliseconds = performance.now() - started;
  const serialized = MeshBVH.serialize(bvh, { cloneBuffers: false });
  const parts = [];
  const layout = {};
  appendPart(parts, layout, 'position', positions);
  appendPart(parts, layout, 'index', serialized.index);
  layout.roots = [];
  for (const root of serialized.roots) {
    const byteOffset = parts.reduce((total, part) => total + part.byteLength, 0);
    const bytes = Buffer.from(root);
    parts.push(bytes);
    layout.roots.push({ byteOffset, byteLength: bytes.byteLength });
  }

  const binary = Buffer.concat(parts);
  const metadata = {
    format: 'hijacked-collision-bvh-v1',
    threeMeshBvhVersion: '0.9.14',
    source: path.relative(ROOT, input).replaceAll('\\', '/'),
    binary: path.basename(output),
    coordinateSystem: 'three-y-up',
    vertices: positions.length / 3,
    triangles: indices.length / 3,
    bounds: boundsOf(geometry),
    buildMilliseconds: Math.round(buildMilliseconds),
    byteLength: binary.byteLength,
    layout,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, binary);
  fs.writeFileSync(metaOutput, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`baked ${metadata.vertices} vertices / ${metadata.triangles} triangles in ${metadata.buildMilliseconds} ms`);
  console.log(`wrote ${path.relative(ROOT, output)} (${binary.byteLength} bytes)`);
  console.log(`wrote ${path.relative(ROOT, metaOutput)}`);
}

try {
  await main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.stack ?? error.message : error}`);
  process.exitCode = 1;
}
