#!/usr/bin/env node
/**
 * Bake climbable ladder volumes out of the static collision glTF.
 *
 * The T6 dump carries no ladder surface flags or trigger volumes, so the only
 * thing identifying a ladder at runtime is the prop's node name.  Each matching
 * node becomes one upright box: a world centre, a horizontal `right` axis along
 * the rungs, a horizontal `normal` axis out of the climbing face, and the Y
 * span the player may climb through.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INPUT = 'export/web/hijacked_collision.gltf';
const DEFAULT_OUTPUT = 'export/web/hijacked_ladders.json';
const DEFAULT_PATTERN = 'ladder';

function absolute(filename) {
  return path.isAbsolute(filename) ? filename : path.resolve(ROOT, filename);
}

function parseArgs(argv) {
  const args = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT, pattern: DEFAULT_PATTERN };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' || arg === '-i') args.input = argv[++i];
    else if (arg === '--output' || arg === '-o') args.output = argv[++i];
    else if (arg === '--pattern' || arg === '-p') args.pattern = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node .tools/bake_ladders.mjs [--input collision.gltf] [--output ladders.json] [--pattern ladder]');
      return null;
    } else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

// glTF matrices are column-major: element (row r, column c) lives at a[c * 4 + r].
// Only a handful of operations are needed here, so they are spelled out rather
// than pulling three.js into a build script the browser never runs.
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

function column(matrix, index) {
  return [matrix[index * 4], matrix[index * 4 + 1], matrix[index * 4 + 2]];
}

function transformPoint(matrix, point) {
  const [x, y, z] = point;
  return [0, 1, 2].map((r) => (
    matrix[r] * x + matrix[4 + r] * y + matrix[8 + r] * z + matrix[12 + r]
  ));
}

function length(vector) {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function fromQuaternion(translation, rotation, scale) {
  const [x, y, z, w] = rotation;
  const [sx, sy, sz] = scale;
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    translation[0], translation[1], translation[2], 1,
  ];
}

/** Local-space bounding box of a mesh, read from accessor min/max only. */
function meshBounds(gltf, meshIndex) {
  const mesh = gltf.meshes?.[meshIndex];
  if (!mesh) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const primitive of mesh.primitives ?? []) {
    const accessor = gltf.accessors?.[primitive.attributes?.POSITION];
    if (!accessor?.min || !accessor?.max) continue;
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i], accessor.min[i]);
      max[i] = Math.max(max[i], accessor.max[i]);
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

function localMatrix(node) {
  if (Array.isArray(node.matrix)) return node.matrix;
  return fromQuaternion(
    node.translation ?? [0, 0, 0],
    node.rotation ?? [0, 0, 0, 1],
    node.scale ?? [1, 1, 1],
  );
}

/** Walk the default scene, yielding every node with its accumulated transform. */
function* walkScene(gltf) {
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  const stack = (scene?.nodes ?? []).map((index) => ({ index, parent: IDENTITY }));
  while (stack.length > 0) {
    const { index, parent } = stack.pop();
    const node = gltf.nodes?.[index];
    if (!node) continue;
    const world = multiply(parent, localMatrix(node));
    yield { index, node, world };
    for (const child of node.children ?? []) stack.push({ index: child, parent: world });
  }
}

/**
 * Turn a node's local box plus its world matrix into an upright climb volume.
 *
 * The axis closest to world up is the climb direction; of the remaining two the
 * wider one runs along the rungs and the thinner one is the face normal.
 */
function volumeFor(name, box, world) {
  const axes = [];
  for (let i = 0; i < 3; i += 1) {
    const axis = column(world, i);
    const scale = length(axis);
    if (scale < 1e-8) return null;
    axes.push({
      axis: axis.map((component) => component / scale),
      half: ((box.max[i] - box.min[i]) / 2) * scale,
    });
  }

  const upIndex = axes
    .map((entry, i) => ({ i, alignment: Math.abs(entry.axis[1]) }))
    .sort((a, b) => b.alignment - a.alignment)[0].i;
  const up = axes[upIndex];
  if (Math.abs(up.axis[1]) < 0.9) return null; // a tilted ladder is not supported

  const [width, depth] = axes.filter((_, i) => i !== upIndex).sort((a, b) => b.half - a.half);

  const center = transformPoint(world, [0, 1, 2].map((i) => (box.min[i] + box.max[i]) / 2));
  // Flatten the horizontal axes so the runtime never has to renormalise them.
  const right = flatten(width.axis);
  const normal = flatten(depth.axis);
  if (!right || !normal) return null;

  return {
    name,
    center: center.map(round),
    right: right.map(round),
    normal: normal.map(round),
    halfWidth: round(width.half),
    halfDepth: round(depth.half),
    bottom: round(center[1] - up.half),
    top: round(center[1] + up.half),
  };
}

/** Drop the Y component and renormalise, or null if the axis was vertical. */
function flatten(axis) {
  const level = [axis[0], 0, axis[2]];
  const size = length(level);
  if (size < 1e-6) return null;
  return level.map((component) => component / size);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) return;
  const input = absolute(args.input);
  const output = absolute(args.output);
  const gltf = JSON.parse(fs.readFileSync(input, 'utf8'));
  const pattern = args.pattern.toLowerCase();

  const volumes = [];
  const skipped = [];
  for (const { node, world } of walkScene(gltf)) {
    const name = node.name ?? '';
    if (!name.toLowerCase().includes(pattern)) continue;
    if (node.mesh === undefined) continue;
    const box = meshBounds(gltf, node.mesh);
    if (!box) {
      skipped.push(`${name}: mesh ${node.mesh} has no position bounds`);
      continue;
    }
    const volume = volumeFor(name, box, world);
    if (!volume) {
      skipped.push(`${name}: not an upright box`);
      continue;
    }
    volumes.push(volume);
  }

  volumes.sort((a, b) => a.center[0] - b.center[0] || a.center[2] - b.center[2]);
  const metadata = {
    format: 'hijacked-ladders-v1',
    source: path.relative(ROOT, input).replaceAll('\\', '/'),
    coordinateSystem: 'three-y-up',
    pattern: args.pattern,
    count: volumes.length,
    volumes,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`);

  for (const note of skipped) console.warn(`skipped ${note}`);
  console.log(`found ${volumes.length} ladder volume(s) matching "${args.pattern}"`);
  for (const volume of volumes) {
    console.log(
      `  ${volume.name} at ${volume.center.join(', ')} ` +
        `rise ${round(volume.top - volume.bottom)} width ${round(volume.halfWidth * 2)}`,
    );
  }
  console.log(`wrote ${path.relative(ROOT, output)}`);
}

try {
  await main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.stack ?? error.message : error}`);
  process.exitCode = 1;
}
