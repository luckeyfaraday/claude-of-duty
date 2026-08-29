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

test('horizon seam repair removes a dark band but keeps a large dark mass', async () => {
  const { repairHorizonSeam } = await import('../.tools/bake_env.mjs');
  const w = 32, h = 64;
  const make = (darkFrom, darkTo, value) => {
    const px = Buffer.alloc(w * h * 3, 200);
    for (let y = darkFrom; y < darkTo; y++) {
      for (let x = 0; x < w; x++) px.fill(value, (y * w + x) * 3, (y * w + x) * 3 + 3);
    }
    return px;
  };
  const rowMean = (px, y) => {
    let s = 0;
    for (let x = 0; x < w; x++) s += px[(y * w + x) * 3];
    return s / w;
  };

  // A thin dark band - the seam - must be interpolated away.
  const seam = make(30, 33, 10);
  const rows = repairHorizonSeam(seam, w, h);
  assert.equal(rows, 3, 'the three-row band is repaired');
  for (let y = 30; y < 33; y++) {
    assert.ok(rowMean(seam, y) > 150, `row ${y} should be filled in, got ${rowMean(seam, y)}`);
  }

  // A soft dip, not pure black, must also be caught - that is what stayed
  // visible when the test was on absolute darkness rather than a relative dip.
  const soft = make(30, 33, 140);
  assert.ok(repairHorizonSeam(soft, w, h) > 0, 'a soft dark band is still a seam');
  assert.ok(rowMean(soft, 31) > 180, 'soft band lifted toward its neighbours');

  // A tall dark mass is real content and must survive untouched.
  const mass = make(20, 50, 10);
  const before = rowMean(mass, 35);
  assert.equal(repairHorizonSeam(mass, w, h), 0, 'a 30-row mass exceeds maxRows');
  assert.equal(rowMean(mass, 35), before, 'and is left exactly as it was');
});

test('vision tone lifts shadows cool and tints highlights warm', async () => {
  const { visionTone, parseVisionGrade } = await import('../export/web/lighting.js');
  // the real mp_hijacked values
  const grade = parseVisionGrade({
    highlight: [0.165, 0.15093, 0.124956],
    lowlight: [0.025591, 0.029729, 0.0325],
    exposure: 1.399999,
  });
  const tone = visionTone(grade);

  // vc_YL is the black lift: small, and blue must sit above red or shadows
  // come out warm instead of the cool the vision set asks for.
  assert.ok(tone.lift[2] > tone.lift[0], 'lift should be cool (B > R)');
  assert.ok(tone.lift.every((v) => v > 0 && v < 0.1), 'lift stays a few percent');

  // vc_YH is the highlight tint, normalised so the brightest channel is 1.
  assert.ok(Math.abs(Math.max(...tone.highlightTint) - 1) < 1e-9, 'tint peaks at 1');
  assert.ok(tone.highlightTint[0] > tone.highlightTint[2], 'tint should be warm (R > B)');

  // vc_YH.w is NOT an exposure - it is reported, never applied as one.
  assert.equal(grade.visionExposure, 1.399999);
  assert.equal(grade.exposure, undefined, 'exposure must not be derived from the vision set');
});

test('vision tone survives a missing or empty vision set', async () => {
  const { visionTone } = await import('../export/web/lighting.js');
  const tone = visionTone(null);
  assert.deepEqual(tone.lift, [0, 0, 0], 'no lift without data');
  assert.deepEqual(tone.highlightTint, [1, 1, 1], 'neutral tint without data');
});

test('material classes make chrome metallic and leave dielectrics alone', async () => {
  const { classifyMaterial } = await import('../export/web/lighting.js');
  const metal = (n) => classifyMaterial(n)?.metalness;

  // The railing that rendered as a black silhouette.
  assert.equal(metal('p6_hijacked_railing_front02_right:mc/metal_chrome_boat'), 1);
  assert.equal(classifyMaterial('mc/metal_chrome_boat').roughness, 0.16);

  // A decal overlay must not veto the real material in the other half.
  assert.equal(metal('*33n_95(wpc/com_metal_chrome_trim:wpc/pb_decal_wall_fillet_2'), 1,
    'chrome trim under a decal is still chrome');
  assert.equal(metal('wpc/metal_brushed_blue:wpc/ao_decal_ramp'), 1,
    'brushed metal under an ao decal is still metal');

  // Named metals that are really painted or plastic stay dielectric.
  assert.equal(metal('wpc/metal_wall_panel_painted'), 0);
  assert.equal(metal('wpc/metal_whitetrim_ext'), 0);
  assert.equal(metal('wpc/wood_teak_decking_dark'), 0);

  // Anything unrecognised is left exactly as the exporter set it.
  assert.equal(classifyMaterial('mlv/fiberglass_boat_white'), null);
  assert.equal(classifyMaterial('wpc/water_ocean_mp_hijacked'), null);
  assert.equal(classifyMaterial(''), null);
  assert.equal(classifyMaterial(undefined), null);
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
