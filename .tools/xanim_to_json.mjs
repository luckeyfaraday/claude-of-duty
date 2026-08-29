#!/usr/bin/env node
// Converts T6 xanim_parts binaries (Pluto Unlinker dumps) into JSON animation
// clips the web viewer loads alongside the viewmodel GLBs.
//
// Format: version-19 compiled xanim (T5/T6 family), as documented by
// OpenAssetTools' CompiledXAnimLoader. Layout:
//   u16 version, u16 numFrames, u16 boneCount, u8 flags, u8 assetType, u16 fps
//   [delta track when flags say so]
//   flipQuat bitmask  align(boneCount,8)/8 bytes
//   halfQuat bitmask  align(boneCount,8)/8 bytes
//   boneCount c-strings (bone names, may be empty)
//   per bone: quat track, then trans track
//   u8 notifyCount, then per notify: c-string + u16 frame
//
// Quat tracks store 3 int16 components (x,y,z); w is reconstructed positive
// and the flipQuat bit / dot-product continuity picks the hemisphere. Half
// (2-component) quats describe a rotation about X only. Trans tracks are
// min/size-quantized vectors (u8 or u16 per component).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const QUAT_ONE_SQUARED = 0x3fff0001;
const HALF_TRANS_SCALE = 1 / 255;
const FULL_TRANS_SCALE = 1 / 65535;

class Reader {
  constructor(buffer) {
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.offset = 0;
    this.text = new TextDecoder('latin1');
  }

  u8() { return this.view.getUint8(this.offset++); }

  u16() {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  i16() {
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32() {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f32() {
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  cstring() {
    const end = this.buffer().indexOf(0, this.offset);
    if (end === -1) throw new Error('unterminated string');
    const value = this.text.decode(this.buffer().subarray(this.offset, end));
    this.offset = end + 1;
    return value;
  }

  bytes(count) {
    const value = this.buffer().subarray(this.offset, this.offset + count);
    if (value.length !== count) throw new Error('unexpected end of file');
    this.offset += count;
    return value;
  }

  buffer() { return new Uint8Array(this.view.buffer, this.view.byteOffset, this.view.byteLength); }

  get remaining() { return this.view.byteLength - this.offset; }
}

function reconstructQuatW(x, y, z) {
  let temp = QUAT_ONE_SQUARED - (x * x + y * y + z * z);
  if (temp <= 0) return 0;
  return Math.floor(Math.sqrt(temp) + 0.5);
}

function readQuat(reader, flip) {
  const x = reader.i16();
  const y = reader.i16();
  const z = reader.i16();
  const w = reconstructQuatW(x, y, z);
  const scale = 1 / 32767;
  const quat = [x * scale, y * scale, z * scale, w * scale];
  if (flip) return quat.map((v) => -v);
  return quat;
}

function readQuat2(reader, flip) {
  const x = reader.i16();
  const w = reconstructQuatW(x, 0, 0);
  const scale = 1 / 32767;
  const quat = [x * scale, 0, 0, w * scale];
  if (flip) return quat.map((v) => -v);
  return quat;
}

function readIndices(reader, count, useBytes, numLoopFrames) {
  // Indices are omitted when the track covers every loop frame in order.
  if (count >= numLoopFrames) return Array.from({ length: count }, (_, i) => i);
  const indices = [];
  for (let i = 0; i < count; i += 1) {
    indices.push(useBytes ? reader.u8() : reader.u16());
  }
  return indices;
}

function readQuatTrack(reader, useBytes, numLoopFrames, flip, half) {
  const count = reader.u16();
  if (count === 0) return null;

  if (count === 1) {
    const value = half ? readQuat2(reader, flip) : readQuat(reader, flip);
    return { frames: [0], values: value };
  }

  const frames = readIndices(reader, count, useBytes, numLoopFrames);
  const values = [];
  let previous = null;
  for (let i = 0; i < count; i += 1) {
    let value = half ? readQuat2(reader, false) : readQuat(reader, false);
    if (i === 0 && flip) value = value.map((v) => -v);
    if (previous) {
      const dot = previous.reduce((sum, v, j) => sum + v * value[j], 0);
      if (dot < 0) value = value.map((v) => -v);
    }
    previous = value;
    values.push(...value);
  }
  return { frames, values };
}

function readTransTrack(reader, useBytes, numLoopFrames) {
  const count = reader.u16();
  if (count === 0) return null;

  if (count === 1) {
    return { frames: [0], values: [reader.f32(), reader.f32(), reader.f32()] };
  }

  const frames = readIndices(reader, count, useBytes, numLoopFrames);
  const small = reader.u8() !== 0;
  const mins = [reader.f32(), reader.f32(), reader.f32()];
  const rawSize = [reader.f32(), reader.f32(), reader.f32()];
  const scale = small ? HALF_TRANS_SCALE : FULL_TRANS_SCALE;
  const size = rawSize.map((v) => v * scale);
  const values = [];
  for (let i = 0; i < count; i += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const sample = small ? reader.u8() : reader.u16();
      values.push(mins[axis] + size[axis] * (sample / (small ? 255 : 65535)));
    }
  }
  return { frames, values };
}

function readBitmask(reader, boneCount) {
  const bytes = reader.bytes(Math.ceil(boneCount / 8));
  return (boneIndex) => Boolean(bytes[boneIndex >> 3] & (1 << (boneIndex & 7)));
}

export function parseXAnim(buffer) {
  const reader = new Reader(buffer);
  const version = reader.u16();
  if (version !== 19) throw new Error(`unsupported xanim version ${version}`);

  const numFrames = reader.u16();
  const boneCount = reader.u16();
  const flags = reader.u8();
  const assetType = reader.u8();
  const framerate = reader.u16();
  if (framerate === 0) throw new Error('invalid framerate');

  const looped = (flags & 0x1) !== 0;
  // Bit 0x2 marks a root delta track; bit 0x4 is left-hand-grip IK (no
  // data). Delta-3D would additionally need the T6 compatibility bit 0x80,
  // which the Unlinker never sets, so it is treated as plain delta here.
  const hasDelta = (flags & 0x2) !== 0;
  const hasDelta3D = (flags & 0x80) !== 0 && (flags & 0x4) !== 0;
  const numLoopFrames = looped ? numFrames + 1 : numFrames;
  const useBytes = numLoopFrames - 1 < 256;

  let delta = null;
  if (hasDelta || hasDelta3D) {
    delta = {
      quat: readQuatTrack(reader, useBytes, numLoopFrames, false, !hasDelta3D),
      trans: readTransTrack(reader, useBytes, numLoopFrames),
    };
  }

  const flipQuat = readBitmask(reader, boneCount);
  const halfQuat = readBitmask(reader, boneCount);

  const names = [];
  for (let i = 0; i < boneCount; i += 1) {
    const name = reader.cstring();
    if (name && !/^[a-z0-9_]+$/i.test(name)) throw new Error(`suspicious bone name ${JSON.stringify(name)}`);
    names.push(name);
  }

  const bones = [];
  for (let i = 0; i < boneCount; i += 1) {
    const quat = readQuatTrack(reader, useBytes, numLoopFrames, flipQuat(i), halfQuat(i));
    const trans = readTransTrack(reader, useBytes, numLoopFrames);
    if (names[i] && (quat || trans)) bones.push({ name: names[i], rot: quat, pos: trans });
  }

  const notifies = [];
  const notifyCount = reader.u8();
  for (let i = 0; i < notifyCount; i += 1) {
    const name = reader.cstring();
    const frame = reader.u16();
    notifies.push({ name, frame });
  }

  if (reader.remaining !== 0) {
    throw new Error(`${reader.remaining} unparsed bytes at end of file`);
  }

  return {
    version,
    numFrames,
    looped,
    assetType,
    fps: framerate,
    duration: (numLoopFrames - 1) / framerate,
    delta,
    bones,
    notifies,
  };
}

function roundTrack(track, precision) {
  if (!track) return null;
  const factor = 10 ** precision;
  return {
    frames: track.frames,
    values: track.values.map((v) => Math.round(v * factor) / factor),
  };
}

export function toJsonClip(source, parsed) {
  return {
    name: path.basename(source),
    fps: parsed.fps,
    loop: parsed.looped,
    duration: Number(parsed.duration.toFixed(4)),
    notifies: parsed.notifies.map((notify) => ({
      name: notify.name,
      time: Number((notify.frame / parsed.fps).toFixed(4)),
    })),
    bones: parsed.bones.map((bone) => ({
      name: bone.name,
      rot: roundTrack(bone.rot, 5),
      pos: roundTrack(bone.pos, 4),
    })),
  };
}

function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('-o');
  const output = outIndex !== -1 ? args[outIndex + 1] : null;
  const inputs = args.filter((_, i) => i !== outIndex && i !== outIndex + 1);
  if (!output || inputs.length === 0) {
    console.error('usage: xanim_to_json.mjs <xanim_parts>... -o <output-dir>');
    process.exit(1);
  }

  fs.mkdirSync(output, { recursive: true });
  for (const input of inputs) {
    const parsed = parseXAnim(fs.readFileSync(input));
    const clip = toJsonClip(input, parsed);
    const target = path.join(output, `${clip.name}.json`);
    fs.writeFileSync(target, `${JSON.stringify(clip)}\n`);
    console.log(
      `${clip.name}: ${parsed.numFrames} frames @${parsed.fps}fps ` +
      `${parsed.looped ? 'loop ' : ''}${parsed.bones.length} bones ` +
      `${parsed.notifies.length} notifies -> ${path.relative(process.cwd(), target)} ` +
      `(${(fs.statSync(target).size / 1024).toFixed(1)} KB)`,
    );
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const script = path.resolve(process.argv[1]);
  const self = fileURLToPath(import.meta.url);
  return process.platform === 'win32'
    ? script.toLowerCase() === self.toLowerCase()
    : script === self;
}

if (isMainModule()) {
  main();
}
