#!/usr/bin/env node
// Re-encodes the viewmodel texture set in `export/web/images/` from PNG to WebP.
//
// Why: the nine-rifle roster took that folder to 28 MB, and index.html loads every
// weapon slot eagerly at startup, so all of it is on the critical path before the
// player can move. The textures are already at their authored 1024 cap, so there
// is nothing to gain by downscaling -- the cost is the container.
//
// Why WebP and not KTX2, which would also cut VRAM: the GLBs reference their
// textures as sibling `.dds` files and viewmodel.js rewrites the suffix at load
// time, so a container the browser decodes natively is a one-line change. KTX2
// needs the GLBs rewritten to declare KHR_texture_basisu and a KTX2Loader wired
// into the viewmodel's own GLTFLoader; worth doing for the VRAM, but it is a
// different job from this one.
//
// Normal maps are encoded losslessly. Lossy WebP quantizes in YUV and normals are
// not colour -- the chroma subsampling lands right on the X/Y channels and shows
// up as banding across flat metal. Lossless still beats PNG by a third or so here
// because the encoder's filters suit these better than PNG's.
//
//   node .tools/pack_web_textures.mjs            # convert, keep the PNGs
//   node .tools/pack_web_textures.mjs --prune    # convert and delete the PNGs
//   node .tools/pack_web_textures.mjs --dry-run

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolsDir, '..');
const IMAGE_DIR = path.join(repoRoot, 'export', 'web', 'images');

// Tangent-space normal maps, by the two suffixes the T6 dump uses.
const NORMAL_MAP = /(_nml|_n)\.png$/i;
const QUALITY = 90;

export function classify(file) {
  return NORMAL_MAP.test(file) ? 'normal' : 'colour';
}

export function encodeArgs(input, output, kind) {
  const common = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-c:v', 'libwebp'];
  return kind === 'normal'
    ? [...common, '-lossless', '1', '-compression_level', '6', output]
    : [...common, '-lossless', '0', '-quality', String(QUALITY), '-compression_level', '6', output];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  const prune = process.argv.includes('--prune');
  const files = fs.readdirSync(IMAGE_DIR).filter((f) => f.endsWith('.png'));

  let before = 0;
  let after = 0;
  const failures = [];

  for (const file of files) {
    const input = path.join(IMAGE_DIR, file);
    const output = input.replace(/\.png$/, '.webp');
    const kind = classify(file);
    const inputBytes = fs.statSync(input).size;
    before += inputBytes;

    if (dryRun) {
      console.log(`${kind.padEnd(6)} ${file}`);
      continue;
    }
    try {
      execFileSync('ffmpeg', encodeArgs(input, output, kind), { stdio: 'pipe' });
    } catch (error) {
      failures.push(`${file}: ${error.stderr?.toString().trim() ?? error.message}`);
      continue;
    }
    const outputBytes = fs.statSync(output).size;
    after += outputBytes;
    const saved = (100 * (1 - outputBytes / inputBytes)).toFixed(0);
    console.log(`${kind.padEnd(6)} ${String(Math.round(inputBytes / 1024)).padStart(5)} KB -> ${String(Math.round(outputBytes / 1024)).padStart(5)} KB  (${saved}%)  ${file}`);
    if (prune) fs.unlinkSync(input);
  }

  if (dryRun) {
    console.log(`\n${files.length} files, ${(before / 1048576).toFixed(1)} MB (dry run)`);
  } else {
    console.log(`\n${files.length - failures.length}/${files.length} converted`);
    console.log(`before: ${(before / 1048576).toFixed(1)} MB   after: ${(after / 1048576).toFixed(1)} MB   saved ${(100 * (1 - after / before)).toFixed(0)}%`);
    if (prune) console.log('source PNGs deleted (--prune)');
  }
  if (failures.length) {
    console.error(`\n${failures.length} failed:\n${failures.join('\n')}`);
    process.exit(1);
  }
}
