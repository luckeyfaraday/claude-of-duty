import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';

import {
  faceDir,
  dirToFace,
  gltfDirToEngine,
  parseVision,
  visionGrade,
  encodePng,
} from '../.tools/bake_env.mjs';

const norm = (d) => {
  const l = Math.hypot(...d);
  return [d[0] / l, d[1] / l, d[2] / l];
};

test('cube face lookup inverts face direction for every face', () => {
  // faceDir and dirToFace are inverses; if they drift the sky resample
  // silently scrambles faces instead of failing.
  for (let f = 0; f < 6; f++) {
    for (const u of [-0.9, -0.3, 0, 0.4, 0.9]) {
      for (const v of [-0.9, -0.3, 0, 0.4, 0.9]) {
        const [gf, gu, gv] = dirToFace(faceDir(f, u, v));
        assert.equal(gf, f, `face ${f} at (${u},${v}) resolved to ${gf}`);
        assert.ok(Math.abs(gu - u) < 1e-9, `u ${gu} != ${u} on face ${f}`);
        assert.ok(Math.abs(gv - v) < 1e-9, `v ${gv} != ${v} on face ${f}`);
      }
    }
  }
});

test('glTF up maps to the engine z-up axis', () => {
  // compose_scene.py maps engine (x,y,z) -> glTF (x, z, -y); the sky resample
  // must use exactly that inverse or the sky ends up on its side.
  // normalise -0 to 0 so signed zero does not fail an otherwise correct axis
  const axis = (d) => gltfDirToEngine(d).map((v) => v + 0);
  assert.deepEqual(axis([0, 1, 0]), [0, 0, 1]);   // glTF up   -> engine +Z
  assert.deepEqual(axis([0, -1, 0]), [0, 0, -1]); // glTF down -> engine -Z
  assert.deepEqual(axis([1, 0, 0]), [1, 0, 0]);   // +X preserved
  assert.deepEqual(axis([0, 0, 1]), [0, -1, 0]);  // glTF +Z   -> engine -Y
});

test('glTF up samples the engine +Z face', () => {
  // Engine is z-up, so "up" in the viewer must land on DDS face 4 (+Z).
  const [face] = dirToFace(gltfDirToEngine(norm([0, 1, 0])));
  assert.equal(face, 4);
});

test('vision set parses the authored tone targets', () => {
  const vision = parseVision([
    'vc_RGBH "0.150000 0.150000 0.150000 2.479999"',
    'vc_YH "0.165000 0.150930 0.124956 1.399999"',
    'vc_YL "0.025591 0.029729 0.032500 1.000000"',
    'not_a_vision_line "1 2 3"',
  ].join('\n'));
  assert.deepEqual(vision.vc_YH, [0.165, 0.15093, 0.124956, 1.399999]);
  assert.equal(vision.not_a_vision_line, undefined);

  const grade = visionGrade(vision);
  assert.equal(grade.exposure, 1.399999);
  assert.deepEqual(grade.highlight, [0.165, 0.15093, 0.124956]);
  assert.deepEqual(grade.lowlight, [0.025591, 0.029729, 0.0325]);
});

test('vision grade falls back to neutral when keys are missing', () => {
  const grade = visionGrade({});
  assert.equal(grade.exposure, 1);
  assert.deepEqual(grade.highlight, [1, 1, 1]);
});

test('encodePng writes a decodable image with the expected pixels', () => {
  const w = 3, h = 2;
  const rgb = Buffer.from([
    255, 0, 0, 0, 255, 0, 0, 0, 255,
    10, 20, 30, 40, 50, 60, 70, 80, 90,
  ]);
  const png = encodePng(rgb, w, h);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR sits right after the signature: length, type, then width/height.
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(png.readUInt32BE(16), w);
  assert.equal(png.readUInt32BE(20), h);
  assert.equal(png[24], 8, 'bit depth');
  assert.equal(png[25], 2, 'colour type: truecolour');

  // Pull IDAT back out and confirm the scanlines round-trip.
  let offset = 8;
  let idat = null;
  while (offset < png.length) {
    const len = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') idat = png.subarray(offset + 8, offset + 8 + len);
    offset += 12 + len;
  }
  assert.ok(idat, 'IDAT chunk present');
  const raw = zlib.inflateSync(idat);
  assert.equal(raw.length, h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    assert.equal(raw[y * (w * 3 + 1)], 0, 'filter byte is none');
    const row = raw.subarray(y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1));
    assert.deepEqual([...row], [...rgb.subarray(y * w * 3, (y + 1) * w * 3)]);
  }
});
