#!/usr/bin/env node
// Copies the samples a weapon actually plays out of a soundbank dump and into
// the web export, resolved through the shipped alias tables.
//
//   node .tools/dump_soundbanks.mjs          # alias tables + samples
//   node .tools/weapon_audio_manifest.mjs    # weapon -> cues -> sample files
//   node .tools/extract_weapon_audio.mjs an94 hk416
//
// Two things need fixing on the way through:
//
//   - The Unlinker writes a bogus RIFF chunk size (a constant 0x30 rather than
//     the real payload length). Browsers mostly tolerate it, but WebAudio's
//     decodeAudioData is entitled not to, so the header is rebuilt from the
//     actual data length. The PCM payload is copied through untouched.
//   - Sample paths carry a `.LN65.pc.snd` platform infix that means nothing on
//     the web, so files land under their plain basename.
//
// Every sample in the weapon set is PCM16 WAV; the streamed FLAC entries in the
// bank are ambience, which the viewmodel never plays.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from './weapon_audio_manifest.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolsDir, '..');

export function webSampleName(rawPath) {
  const base = rawPath.split('\\').pop() ?? rawPath;
  return `${base.replace(/\.[A-Z]{2}\d{2}\.pc\.snd(\.wav)?$/i, '')}.wav`;
}

// A RIFF header the browser will accept, sized from the payload we actually
// have rather than from the field the dump wrote.
function repairWav(buffer) {
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF') return null;
  const dataOffset = buffer.indexOf('data', 12, 'ascii');
  if (dataOffset < 0) return null;
  const payload = buffer.subarray(dataOffset + 8);
  const repaired = Buffer.from(buffer);
  repaired.writeUInt32LE(buffer.length - 8, 4);
  repaired.writeUInt32LE(payload.length, dataOffset + 4);
  return repaired;
}

export function extractWeaponAudio({
  weapons,
  dumpDir = path.join(repoRoot, 'artifacts', 'soundbanks'),
  outDir = path.join(repoRoot, 'export', 'web', 'audio'),
  dryRun = false,
} = {}) {
  const manifest = buildManifest({ bankDir: dumpDir });
  const wanted = new Map(); // web filename -> source path

  for (const id of weapons) {
    const entry = manifest.weapons[id];
    if (!entry) throw new Error(`${id} is not in the manifest`);
    const sources = [
      ...Object.values(entry.cues).flat(),
      ...Object.values(entry.layers).flatMap((layer) => layer.sources),
    ];
    for (const source of sources) wanted.set(webSampleName(source), source);
  }

  const written = [];
  const missing = [];
  for (const [name, source] of [...wanted].sort()) {
    const from = path.join(dumpDir, source.replace(/^raw\\/, '').split('\\').join(path.sep));
    if (!fs.existsSync(from)) { missing.push(source); continue; }
    const repaired = repairWav(fs.readFileSync(from));
    if (!repaired) { missing.push(`${source} (not a RIFF WAV)`); continue; }
    const to = path.join(outDir, name);
    const changed = !fs.existsSync(to) || !fs.readFileSync(to).equals(repaired);
    if (changed && !dryRun) fs.writeFileSync(to, repaired);
    written.push({ name, source, changed, bytes: repaired.length });
  }
  return { written, missing };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const weapons = args.filter((a) => !a.startsWith('--'));
  if (!weapons.length) {
    console.error('Usage: node .tools/extract_weapon_audio.mjs [--dry-run] <weaponId>...');
    process.exit(1);
  }

  const { written, missing } = extractWeaponAudio({ weapons, dryRun });
  for (const { name, changed, bytes } of written) {
    console.log(`  ${changed ? (dryRun ? 'would write' : 'wrote     ') : 'unchanged '} ${name.padEnd(30)} ${bytes}`);
  }
  console.log(`\n${written.filter((w) => w.changed).length} changed, ${written.length} total`);
  if (missing.length) {
    console.log(`${missing.length} sample(s) not in the dump:`);
    for (const m of missing) console.log('   ', m);
  }
}
