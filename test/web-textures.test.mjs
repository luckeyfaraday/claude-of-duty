import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { classify, encodeArgs } from '../.tools/pack_web_textures.mjs';

const repo = path.join(import.meta.dirname, '..');
const viewmodelDir = path.join(repo, 'export', 'web', 'viewmodel');
const imageDir = path.join(repo, 'export', 'web', 'images');

// viewmodel.js rewrites the GLBs' authored `.dds` references to this suffix at
// load time. A texture missing from the shipped set does not throw -- three.js
// just draws the surface untextured -- so the only way it surfaces is a check
// like this one.
const SHIPPED_SUFFIX = '.webp';

function glbImageUris(file) {
  const buffer = fs.readFileSync(file);
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
  return (json.images ?? []).map((image) => image.uri).filter(Boolean);
}

test('every texture the shipped viewmodels reference exists in the web export', () => {
  const models = fs.readdirSync(viewmodelDir).filter((name) => name.endsWith('.glb'));
  assert.ok(models.length >= 19, `expected the nine rifles, their magazines and the hands, found ${models.length}`);

  const missing = [];
  let checked = 0;
  for (const model of models) {
    for (const uri of glbImageUris(path.join(viewmodelDir, model))) {
      const shipped = path.basename(uri).replace(/\.dds$/i, SHIPPED_SUFFIX);
      checked += 1;
      if (!fs.existsSync(path.join(imageDir, shipped))) missing.push(`${model} -> ${shipped}`);
    }
  }
  assert.ok(checked > 0, 'no texture references found; the GLBs did not parse');
  assert.deepEqual(missing, [], `textures referenced but not shipped:\n${missing.join('\n')}`);
});

test('the web image set is entirely the shipped format', () => {
  const stray = fs.readdirSync(imageDir).filter((name) => !name.endsWith(SHIPPED_SUFFIX));
  assert.deepEqual(stray, [], `unconverted images left in the export: ${stray.join(', ')}`);
});

// Normal maps are the one class that must not be quantized: lossy WebP works in
// YUV, and chroma subsampling lands directly on a tangent-space map's X/Y.
test('normal maps are encoded losslessly and colour maps are not', () => {
  assert.equal(classify('mtl_t6_wpn_ar_an94_nml.png'), 'normal');
  assert.equal(classify('viewarm_usa_mp_fbi_shortsleeve_n.png'), 'normal');
  assert.equal(classify('~-gmtl_t6_wpn_ar_an94_col.png'), 'colour');
  assert.equal(classify('~-gmtl_t6_wpn_ar_xm8_c.png'), 'colour');

  assert.ok(encodeArgs('in.png', 'out.webp', 'normal').join(' ').includes('-lossless 1'));
  assert.ok(encodeArgs('in.png', 'out.webp', 'colour').join(' ').includes('-lossless 0'));
});
