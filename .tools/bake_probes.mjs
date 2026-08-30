#!/usr/bin/env node
// Bake a spherical-harmonic light probe volume for dynamic objects.
//
// Static world geometry has no lighting baked into it (no lightmap UVs survive
// the dump), but dynamic things - enemies, the viewmodel - still need to know
// that a deck in open sun is brighter than a corridor below decks. This walks
// a lattice over the map and, per cell, integrates the incoming radiance:
//
//   * cast stratified rays over the sphere against the collision geometry
//   * an unoccluded ray takes its radiance from the map's own sky cubemap
//   * an occluded ray contributes a dim bounce tinted by the sky, standing in
//     for the light the surrounding geometry would kick back
//
// The result is projected onto L0+L1 spherical harmonics (4 coefficients per
// channel), which is exactly what THREE.LightProbe consumes - so the runtime
// needs no custom shader.
//
// Outputs (export/web):
//   hijacked_probes.bin   f32, cells * 4 coefficients * 3 channels, x-major
//   hijacked_probes.json  origin, spacing, dims

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'export', 'web');

// ------------------------------- sky source -------------------------------

// Read the converted cube faces written by bake_env.mjs. Kept as linear rgb.
const FACE_ORDER = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// Minimal PNG reader for the faces we wrote ourselves: 8-bit truecolour,
// filter 0 only. Anything else is a bug in bake_env, not input we must handle.
export function decodeOwnPng(buf) {
  let offset = 8;
  let width = 0, height = 0;
  const idat = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 2) throw new Error('expected 8-bit truecolour png');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 3 + 1;
  const px = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    if (raw[y * stride] !== 0) throw new Error('unexpected png filter');
    raw.copy(px, y * width * 3, y * stride + 1, (y + 1) * stride);
  }
  return { px, width, height };
}

export function dirToFace(d) {
  const [x, y, z] = d;
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (ax >= ay && ax >= az) return x > 0 ? [0, -z / ax, -y / ax] : [1, z / ax, -y / ax];
  if (ay >= az) return y > 0 ? [2, x / ay, z / ay] : [3, x / ay, -z / ay];
  return z > 0 ? [4, x / az, -y / az] : [5, -x / az, -y / az];
}

export function makeSkySampler(faces) {
  // faces: [{px,width,height}] in glTF orientation, index matches FACE_ORDER
  return (d) => {
    const [f, u, v] = dirToFace(d);
    const face = faces[f];
    const x = Math.min(face.width - 1, Math.max(0, Math.floor(((u + 1) / 2) * face.width)));
    const y = Math.min(face.height - 1, Math.max(0, Math.floor(((v + 1) / 2) * face.height)));
    const o = (y * face.width + x) * 3;
    return [
      srgbToLinear(face.px[o] / 255),
      srgbToLinear(face.px[o + 1] / 255),
      srgbToLinear(face.px[o + 2] / 255),
    ];
  };
}

// --------------------------------- BVH ------------------------------------

export class BVH {
  constructor(flat) {
    this.tris = Float32Array.from(flat);
    this.count = this.tris.length / 9;
    this.index = new Uint32Array(this.count);
    const cx = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      const o = i * 9;
      cx[i * 3] = (this.tris[o] + this.tris[o + 3] + this.tris[o + 6]) / 3;
      cx[i * 3 + 1] = (this.tris[o + 1] + this.tris[o + 4] + this.tris[o + 7]) / 3;
      cx[i * 3 + 2] = (this.tris[o + 2] + this.tris[o + 5] + this.tris[o + 8]) / 3;
      this.index[i] = i;
    }
    this.centroids = cx;
    this.nodes = [];
    this.root = this.build(0, this.count, 0);
  }

  build(start, end, depth) {
    const node = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const self = this.nodes.length;
    this.nodes.push(node);
    for (let i = start; i < end; i++) {
      const t = this.index[i] * 9;
      for (let k = 0; k < 3; k++) {
        for (let c = 0; c < 3; c++) {
          const v = this.tris[t + k * 3 + c];
          if (v < node.min[c]) node.min[c] = v;
          if (v > node.max[c]) node.max[c] = v;
        }
      }
    }
    const n = end - start;
    if (n <= 4 || depth > 40) {
      node.start = start;
      node.count = n;
      return self;
    }
    let axis = 0, extent = -1;
    for (let c = 0; c < 3; c++) {
      const e = node.max[c] - node.min[c];
      if (e > extent) { extent = e; axis = c; }
    }
    const slice = Array.from(this.index.subarray(start, end));
    slice.sort((a, b) => this.centroids[a * 3 + axis] - this.centroids[b * 3 + axis]);
    for (let i = 0; i < slice.length; i++) this.index[start + i] = slice[i];
    const mid = start + (n >> 1);
    if (mid === start || mid === end) {
      node.start = start;
      node.count = n;
      return self;
    }
    node.left = this.build(start, mid, depth + 1);
    node.right = this.build(mid, end, depth + 1);
    return self;
  }

  occluded(ox, oy, oz, dx, dy, dz, maxDist) {
    const stack = [this.root];
    while (stack.length) {
      const node = this.nodes[stack.pop()];
      if (node.count !== undefined) {
        for (let i = 0; i < node.count; i++) {
          if (rayTri(ox, oy, oz, dx, dy, dz, this.tris, this.index[node.start + i] * 9, maxDist)) return true;
        }
        continue;
      }
      for (const child of [node.left, node.right]) {
        if (slab(ox, oy, oz, dx, dy, dz, this.nodes[child], maxDist)) stack.push(child);
      }
    }
    return false;
  }
}

function slab(ox, oy, oz, dx, dy, dz, box, maxDist) {
  let tmin = 0, tmax = maxDist;
  for (let c = 0; c < 3; c++) {
    const o = c === 0 ? ox : c === 1 ? oy : oz;
    const d = c === 0 ? dx : c === 1 ? dy : dz;
    if (Math.abs(d) < 1e-9) {
      if (o < box.min[c] || o > box.max[c]) return false;
      continue;
    }
    let t1 = (box.min[c] - o) / d;
    let t2 = (box.max[c] - o) / d;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  return true;
}

export function rayTri(ox, oy, oz, dx, dy, dz, tris, t, maxDist, minDist = 1e-3) {
  const ax = tris[t], ay = tris[t + 1], az = tris[t + 2];
  const e1x = tris[t + 3] - ax, e1y = tris[t + 4] - ay, e1z = tris[t + 5] - az;
  const e2x = tris[t + 6] - ax, e2y = tris[t + 7] - ay, e2z = tris[t + 8] - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-9 && det < 1e-9) return false;
  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-6 || u > 1 + 1e-6) return false;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -1e-6 || u + v > 1 + 1e-6) return false;
  const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return dist > minDist && dist < maxDist;
}

// ------------------------------ glTF reading ------------------------------

export function parseGltfTriangles(gltfPath) {
  const gltf = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
  const bin = fs.readFileSync(path.join(path.dirname(gltfPath), gltf.buffers[0].uri));
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out = [];

  const apply = (m, p) => (m ? [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ] : p);

  const mul = (a, b) => {
    const r = new Array(16);
    for (let c = 0; c < 4; c++) {
      for (let k = 0; k < 4; k++) {
        r[c * 4 + k] = a[k] * b[c * 4] + a[4 + k] * b[c * 4 + 1] + a[8 + k] * b[c * 4 + 2] + a[12 + k] * b[c * 4 + 3];
      }
    }
    return r;
  };

  function mesh(m, matrix) {
    for (const prim of m.primitives) {
      const pos = gltf.accessors[prim.attributes.POSITION];
      const idx = prim.indices !== undefined ? gltf.accessors[prim.indices] : null;
      const pv = gltf.bufferViews[pos.bufferView];
      const pOff = (pv.byteOffset || 0) + (pos.byteOffset || 0);
      const pStride = pv.byteStride || 12;
      const read = (i) => apply(matrix, [
        view.getFloat32(pOff + i * pStride, true),
        view.getFloat32(pOff + i * pStride + 4, true),
        view.getFloat32(pOff + i * pStride + 8, true),
      ]);
      if (idx) {
        const iv = gltf.bufferViews[idx.bufferView];
        const iOff = (iv.byteOffset || 0) + (idx.byteOffset || 0);
        const u16 = idx.componentType === 5123;
        for (let i = 0; i + 2 < idx.count; i += 3) {
          for (let k = 0; k < 3; k++) {
            const j = u16 ? view.getUint16(iOff + (i + k) * 2, true) : view.getUint32(iOff + (i + k) * 4, true);
            out.push(...read(j));
          }
        }
      } else {
        for (let i = 0; i + 2 < pos.count; i += 3) for (let k = 0; k < 3; k++) out.push(...read(i + k));
      }
    }
  }

  function walk(n, parent) {
    const node = gltf.nodes[n];
    const matrix = node.matrix ? (parent ? mul(node.matrix, parent) : node.matrix) : parent;
    if (node.mesh !== undefined) mesh(gltf.meshes[node.mesh], matrix);
    for (const c of node.children || []) walk(c, matrix);
  }
  for (const n of gltf.scenes?.[gltf.scene ?? 0]?.nodes || []) walk(n, undefined);
  return out;
}

// ------------------------------ SH projection -----------------------------

// Matches THREE.SphericalHarmonics3.getBasisAt for the first four bands.
export function shBasis(d) {
  return [0.282095, 0.488603 * d[1], 0.488603 * d[2], 0.488603 * d[0]];
}

// Fibonacci sphere: even coverage without the clumping of naive random rays.
export function sphereDirections(count) {
  const dirs = new Array(count);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * i + 1) / count;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = golden * i;
    dirs[i] = [Math.cos(a) * r, y, Math.sin(a) * r];
  }
  return dirs;
}

/**
 * Integrate radiance at one point into L0+L1 SH.
 * Returns 4 coefficients x 3 channels, flattened as [c0rgb, c1rgb, c2rgb, c3rgb].
 */
export function probeAt(point, dirs, bvh, sky, options = {}) {
  const { maxDist = 8000, bounce = 0.18 } = options;
  const out = new Float64Array(12);
  const weight = (4 * Math.PI) / dirs.length;
  for (const d of dirs) {
    let rgb;
    if (bvh.occluded(point[0], point[1], point[2], d[0], d[1], d[2], maxDist)) {
      // Blocked: approximate the bounce off whatever was hit as a dim,
      // sky-tinted term rather than pure black, so interiors stay readable.
      const ambient = sky([0, 1, 0]);
      rgb = [ambient[0] * bounce, ambient[1] * bounce, ambient[2] * bounce];
    } else {
      rgb = sky(d);
    }
    const basis = shBasis(d);
    for (let b = 0; b < 4; b++) {
      const w = basis[b] * weight;
      out[b * 3] += rgb[0] * w;
      out[b * 3 + 1] += rgb[1] * w;
      out[b * 3 + 2] += rgb[2] * w;
    }
  }
  return out;
}

// --------------------------------- main -----------------------------------

function run() {
  const spacing = Number(process.env.PROBE_SPACING || 160);
  const rays = Number(process.env.PROBE_RAYS || 128);

  console.log('loading occluders...');
  const tris = parseGltfTriangles(path.join(WEB, 'hijacked_collision.gltf'));
  console.log(`  ${tris.length / 9} triangles`);
  const bvh = new BVH(tris);

  console.log('loading sky...');
  const faces = FACE_ORDER.map((f) =>
    decodeOwnPng(fs.readFileSync(path.join(WEB, 'textures', 'env', `${f}.png`))));
  const sky = makeSkySampler(faces);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      if (tris[i + c] < min[c]) min[c] = tris[i + c];
      if (tris[i + c] > max[c]) max[c] = tris[i + c];
    }
  }
  const margin = spacing;
  const origin = min.map((v) => v - margin);
  const dims = [0, 1, 2].map((c) => Math.max(2, Math.ceil((max[c] + margin - origin[c]) / spacing) + 1));
  const cells = dims[0] * dims[1] * dims[2];
  console.log(`grid ${dims.join('x')} = ${cells} cells, spacing ${spacing}, ${rays} rays/cell`);

  const dirs = sphereDirections(rays);
  const data = new Float32Array(cells * 12);
  const started = Date.now();
  let done = 0;
  for (let x = 0; x < dims[0]; x++) {
    for (let y = 0; y < dims[1]; y++) {
      for (let z = 0; z < dims[2]; z++) {
        const cell = (x * dims[1] + y) * dims[2] + z;
        const point = [origin[0] + x * spacing, origin[1] + y * spacing, origin[2] + z * spacing];
        const sh = probeAt(point, dirs, bvh, sky);
        for (let i = 0; i < 12; i++) data[cell * 12 + i] = sh[i];
        if (++done % 2000 === 0) {
          const rate = done / ((Date.now() - started) / 1000);
          console.log(`  ${done}/${cells} (${rate.toFixed(0)}/s)`);
        }
      }
    }
  }

  fs.writeFileSync(path.join(WEB, 'hijacked_probes.bin'), Buffer.from(data.buffer));
  fs.writeFileSync(path.join(WEB, 'hijacked_probes.json'), JSON.stringify({
    origin, spacing, dims,
    coefficients: 4,
    layout: 'x-major, then y, then z; 4 SH coefficients of rgb float32',
  }));
  console.log(`baked ${cells} probes in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

function invokedDirectly() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
if (invokedDirectly()) run();
