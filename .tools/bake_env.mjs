#!/usr/bin/env node
// Convert the map's own lighting assets into things the web viewer can load:
//
//   export/web/textures/env/{px,nx,py,ny,pz,nz}.png   sky cubemap, glTF axes
//   export/web/textures/probe/{...}.png               reflection probe cubemap
//   export/web/textures/mp_hijacked_lut.png           vision-set colour grade
//   export/web/vision.json                            parsed .vision constants
//
// The DDS files are BC3 cubemaps in the engine's z-up space. Rather than guess
// per-face flips, every output texel is resampled: take the glTF direction for
// the texel, rotate it back into engine space with the inverse of compose's
// (x, z, -y) swap, then sample whichever engine face that direction lands on.
//
// texconv.exe does the BC3 -> RGBA8 decompression (it will not split cube faces
// itself, which is why the resample lives here).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGES = path.join(ROOT, 'export', 'images');
const OUT = path.join(ROOT, 'export', 'web', 'textures');
const TEXCONV = path.join(ROOT, '.tools', 'texconv.exe');
const TMP = path.join(ROOT, '.tools', '.env_tmp');

// glTF/Three cube face order; engine DDS order is +X -X +Y -Y +Z -Z (z-up).
const FACE_NAMES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

// ------------------------------- PNG output -------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// rgb: Uint8Array of w*h*3
export function encodePng(rgb, w, h) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    rgb.copy
      ? rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3)
      : Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------- DDS input --------------------------------

// Decompress to RGBA8 via texconv, then read the flat face array.
function readCubeRGBA(ddsPath) {
  fs.mkdirSync(TMP, { recursive: true });
  execFileSync(TEXCONV, ['-y', '-ft', 'dds', '-f', 'R8G8B8A8_UNORM', '-m', '1', '-o', TMP, ddsPath], {
    stdio: 'pipe',
  });
  const out = path.join(TMP, path.basename(ddsPath));
  const buf = fs.readFileSync(out);
  const h = buf.readUInt32LE(12);
  const w = buf.readUInt32LE(16);
  const faceBytes = w * h * 4;
  const faces = buf.length - 128 >= faceBytes * 6 ? 6 : 1;
  return { buf, w, h, faces, offset: 128, faceBytes };
}

// Direction for a texel on engine face `f` at [-1,1] coords (D3D convention).
export function faceDir(f, u, v) {
  switch (f) {
    case 0: return [1, -v, -u];
    case 1: return [-1, -v, u];
    case 2: return [u, 1, v];
    case 3: return [u, -1, -v];
    case 4: return [u, -v, 1];
    default: return [-u, -v, -1];
  }
}

// Inverse: which face does this direction hit, and where.
export function dirToFace(d) {
  const [x, y, z] = d;
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (ax >= ay && ax >= az) {
    return x > 0 ? [0, -z / ax, -y / ax] : [1, z / ax, -y / ax];
  }
  if (ay >= az) {
    return y > 0 ? [2, x / ay, z / ay] : [3, x / ay, -z / ay];
  }
  return z > 0 ? [4, x / az, -y / az] : [5, -x / az, -y / az];
}

// compose_scene.py maps engine (x,y,z) -> glTF (x, z, -y).
// Inverse: glTF (dx,dy,dz) -> engine (dx, -dz, dy).
export const gltfDirToEngine = (d) => [d[0], -d[2], d[1]];

function resampleCube(src, size) {
  const { buf, w, h, offset, faceBytes } = src;
  const out = [];
  for (let f = 0; f < 6; f++) {
    const px = Buffer.alloc(size * size * 3);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = ((x + 0.5) / size) * 2 - 1;
        const v = ((y + 0.5) / size) * 2 - 1;
        const [ef, eu, ev] = dirToFace(gltfDirToEngine(faceDir(f, u, v)));
        const sx = Math.min(w - 1, Math.max(0, Math.floor(((eu + 1) / 2) * w)));
        const sy = Math.min(h - 1, Math.max(0, Math.floor(((ev + 1) / 2) * h)));
        const so = offset + ef * faceBytes + (sy * w + sx) * 4;
        const to = (y * size + x) * 3;
        px[to] = buf[so];
        px[to + 1] = buf[so + 1];
        px[to + 2] = buf[so + 2];
      }
    }
    out.push(px);
  }
  return out;
}

/**
 * Repair the dark seam the engine's skybox carries at its horizon.
 *
 * The source cubemap has a band at the horizon whose core is ~(8,8,8) - the
 * join between the two halves of the sky art. In game the ocean geometry
 * covers it; here it magnifies into a dark line across the horizon.
 *
 * The seam is a soft dark band, not just a run of black texels. Repairing only
 * the near-black core leaves rows at ~160 luma between neighbours at ~210,
 * which still reads as a dark line across the horizon. So the test is a
 * per-row dip against a baseline taken from outside the band, and the whole
 * row is rebuilt rather than individual texels.
 *
 * Runs longer than maxRows are left alone, so a genuine dark mass (a storm
 * front, a landmass) is not smoothed away - only a thin band that is darker
 * than both sides qualifies.
 */
export function repairHorizonSeam(px, w, h, { dip = 0.88, maxRows = 20, gap = 8 } = {}) {
  const rowMean = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      s += 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
    }
    rowMean[y] = s / w;
  }

  // baseline from rows well clear of the band on both sides
  const baselineAt = (y) => {
    const a = rowMean[Math.max(0, y - gap - 4)];
    const b = rowMean[Math.min(h - 1, y + gap + 4)];
    return (a + b) / 2;
  };

  const suspect = new Uint8Array(h);
  for (let y = gap; y < h - gap; y++) {
    if (rowMean[y] < dip * baselineAt(y)) suspect[y] = 1;
  }

  let repaired = 0;
  let y = 0;
  while (y < h) {
    if (!suspect[y]) { y++; continue; }
    let end = y;
    while (end < h && suspect[end]) end++;
    const above = y - 1;
    const below = end;
    // Both brackets must be meaningfully brighter than the run. Testing only
    // the row above lets the edge of a large dark mass qualify - bright on one
    // side, still dark on the other - and the repair then eats into real
    // content instead of a seam.
    let runMean = 0;
    for (let k = y; k < end; k++) runMean += rowMean[k];
    runMean /= (end - y);
    const bracketed = above >= 0 && below < h
      && rowMean[above] > runMean / dip
      && rowMean[below] > runMean / dip;
    if (end - y <= maxRows && bracketed) {
      for (let k = y; k < end; k++) {
        const t = (k - above) / (below - above);
        for (let x = 0; x < w; x++) {
          for (let c = 0; c < 3; c++) {
            px[(k * w + x) * 3 + c] = Math.round(
              px[(above * w + x) * 3 + c] * (1 - t) + px[(below * w + x) * 3 + c] * t,
            );
          }
        }
      }
      repaired += end - y;
    }
    y = end;
  }
  return repaired;
}

/**
 * Wash the sky into atmospheric haze toward and below the horizon.
 *
 * Two problems, one fix. The lower hemisphere of the skybox is never seen in
 * game - the ocean covers it - so the artists left junk down there, including
 * a black cloud mass on the -X face that reads as smoke sitting on our
 * horizon. And the band just above the horizon is the most saturated part of
 * the art, which is what makes the sky look unnatural next to the real game,
 * where distance washes out into pale haze.
 *
 * Blending toward the measured horizon colour handles both: everything below
 * the horizon becomes clean haze, and the vivid band above it is muted with a
 * falloff that leaves the zenith alone.
 */
export function applySkyHaze(faces, size, { strength = 0.6, falloff = 0.30 } = {}) {
  // Horizon colour: mean of the texels sitting within a narrow elevation band.
  // The band widens until it catches something, because at small face sizes no
  // texel direction may land inside a fixed narrow band at all.
  let haze = null;
  for (let band = 0.02; band <= 0.5 && !haze; band *= 2) {
    let hr = 0, hg = 0, hb = 0, n = 0;
    for (let f = 0; f < 6; f++) {
      const px = faces[f];
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const u = ((x + 0.5) / size) * 2 - 1;
          const v = ((y + 0.5) / size) * 2 - 1;
          const d = faceDir(f, u, v);
          const e = d[1] / Math.hypot(d[0], d[1], d[2]);
          if (Math.abs(e) > band) continue;
          const o = (y * size + x) * 3;
          hr += px[o]; hg += px[o + 1]; hb += px[o + 2];
          n++;
        }
      }
    }
    if (n) haze = [hr / n, hg / n, hb / n];
  }
  if (!haze) return null;

  for (let f = 0; f < 6; f++) {
    const px = faces[f];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = ((x + 0.5) / size) * 2 - 1;
        const v = ((y + 0.5) / size) * 2 - 1;
        const d = faceDir(f, u, v);
        const len = Math.hypot(d[0], d[1], d[2]);
        const e = d[1] / len;
        // Below the horizon go fully to haze; above it, fade out with height.
        const t = e < 0 ? 1 : strength * Math.exp(-e / falloff);
        if (t <= 0.001) continue;
        const o = (y * size + x) * 3;
        for (let c = 0; c < 3; c++) {
          px[o + c] = Math.round(px[o + c] * (1 - t) + haze[c] * t);
        }
      }
    }
  }
  return haze.map((v) => Math.round(v));
}

function writeCube(dir, faces, size) {
  fs.mkdirSync(dir, { recursive: true });
  faces.forEach((px, i) => {
    fs.writeFileSync(path.join(dir, `${FACE_NAMES[i]}.png`), encodePng(px, size, size));
  });
}

// ------------------------------ vision set --------------------------------

// mp_hijacked.vision holds the map's authored filmic curve. vc_YH / vc_YL are
// the highlight and lowlight tone targets (rgb + exposure scale in .w).
export function parseVision(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(vc_\w+)\s+"([^"]+)"/);
    if (m) out[m[1]] = m[2].trim().split(/\s+/).map(Number);
  }
  return out;
}

export function visionGrade(vision) {
  const yh = vision.vc_YH || [1, 1, 1, 1];
  const yl = vision.vc_YL || [0, 0, 0, 1];
  // .w on the highlight target is the engine's exposure multiplier.
  return {
    highlight: yh.slice(0, 3),
    lowlight: yl.slice(0, 3),
    exposure: yh[3] ?? 1,
    lowlightScale: yl[3] ?? 1,
  };
}

// --------------------------------- main -----------------------------------

function run() {
  fs.mkdirSync(OUT, { recursive: true });

  // --- sky cubemap
  const skyPath = path.join(IMAGES, 'skybox_mp_hijacked_ft.dds');
  if (fs.existsSync(skyPath)) {
    const src = readCubeRGBA(skyPath);
    console.log(`sky: ${src.w}x${src.h} x${src.faces} faces`);
    if (src.faces === 6) {
      const faces = resampleCube(src, src.w);
      let fixed = 0;
      for (const face of faces) fixed += repairHorizonSeam(face, src.w, src.w);
      const haze = applySkyHaze(faces, src.w);
      writeCube(path.join(OUT, 'env'), faces, src.w);
      console.log(`  -> textures/env/*.png (${src.w}px, glTF axes), ${fixed} seam rows repaired`);
      console.log(`     horizon haze rgb(${haze.join(', ')})`);
    }
  } else {
    console.warn('sky: skybox_mp_hijacked_ft.dds not found');
  }

  // --- reflection probe. No positions survive the dump, so probe 1 (the first
  // non-stub) stands in as a single global specular source.
  const probePath = path.join(IMAGES, '_reflection_probe1.dds');
  if (fs.existsSync(probePath)) {
    const src = readCubeRGBA(probePath);
    console.log(`probe: ${src.w}x${src.h} x${src.faces} faces`);
    if (src.faces === 6) {
      writeCube(path.join(OUT, 'probe'), resampleCube(src, src.w), src.w);
      console.log(`  -> textures/probe/*.png (${src.w}px)`);
    }
  }

  // --- colour grading LUT
  const lutPath = path.join(IMAGES, 'mp_hijacked_lut_win.dds');
  if (fs.existsSync(lutPath)) {
    const src = readCubeRGBA(lutPath);
    const px = Buffer.alloc(src.w * src.h * 3);
    for (let i = 0; i < src.w * src.h; i++) {
      px[i * 3] = src.buf[src.offset + i * 4];
      px[i * 3 + 1] = src.buf[src.offset + i * 4 + 1];
      px[i * 3 + 2] = src.buf[src.offset + i * 4 + 2];
    }
    fs.writeFileSync(path.join(OUT, 'mp_hijacked_lut.png'), encodePng(px, src.w, src.h));
    console.log(`lut: ${src.w}x${src.h} -> textures/mp_hijacked_lut.png`);
  }

  // --- vision set
  const visionPath = path.join(ROOT, 'export', 'vision', 'mp_hijacked.vision');
  if (fs.existsSync(visionPath)) {
    const vision = parseVision(fs.readFileSync(visionPath, 'utf8'));
    const grade = visionGrade(vision);
    fs.writeFileSync(
      path.join(ROOT, 'export', 'web', 'vision.json'),
      JSON.stringify({ ...grade, raw: vision }, null, 2),
    );
    console.log(`vision: exposure ${grade.exposure}, highlight ${grade.highlight.map((v) => v.toFixed(3))}`);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
}

function invokedDirectly() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
if (invokedDirectly()) run();
