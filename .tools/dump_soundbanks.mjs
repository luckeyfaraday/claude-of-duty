#!/usr/bin/env node
// Dumps every soundbank the local zones carry, which is what turns weapon audio
// from guesswork into a lookup.
//
// A soundbank dump is two things at once:
//   - `<bank>.aliases.csv` -- the alias table. `Name` is what an xanim notetrack
//     or a weapon file's *SoundPlayer field says; `FileSource` is the raw sound
//     it resolves to, plus every mix parameter (volume, pitch, distance,
//     randomization) the shipped game uses.
//   - the sample data itself, when `sound/*.sabl|.sabs` are present next to the
//     zones. Without those banks the Unlinker still writes the CSV but warns
//     `Could not find data for sound ...` on every entry, so the alias table is
//     recoverable from zones alone and the audio is not.
//
// The banks are split across zones and none of them is complete on its own:
// `common_mp` carries the weapon aliases, `patch_mp` and `code_post_gfx*` carry
// late additions, and each map zone carries only what that map plays. Merging
// all of them is what makes `fly_<gun>_*` resolve for weapons the current map
// never loads.
//
// Aliases and data also live in different places. `common_mp` declares every
// weapon alias but its own bank holds almost none of the samples -- the gun
// audio sits in `cmn_root.all.sabl`, which `code_post_gfx_mp` is the zone that
// declares. Dumping `common_mp` alone reports 733 `Could not find data for
// sound` warnings even with a complete `sound/` folder; preloading
// `code_post_gfx_mp` first drops that to zero.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolsDir, '..');
const unlinker = path.join(toolsDir, 'Unlinker.exe');

// Ordered so the broadest banks land first; later zones only add aliases.
export const BANK_ZONES = [
  'common_mp',
  'patch_mp',
  'code_post_gfx_mp',
  'code_post_gfx',
  'mp_hijacked',
];

export function soundDataAvailable(root = repoRoot) {
  const dir = path.join(root, 'sound');
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((f) => f.endsWith('.sabl') || f.endsWith('.sabs'));
}

// Holds `cmn_root.all`, the bank the weapon samples actually live in.
const DATA_ZONE = 'code_post_gfx_mp';

function dumpZone(zone, outDir) {
  const zonePath = path.join(repoRoot, 'zone', 'all', `${zone}.ff`);
  if (!fs.existsSync(zonePath)) return { zone, skipped: 'no such zone' };

  const preload = zone === DATA_ZONE
    ? []
    : ['--load', path.join(repoRoot, 'zone', 'all', `${DATA_ZONE}.ff`)];

  let output = '';
  try {
    output = execFileSync(
      unlinker,
      [...preload, '--include-assets', 'soundbank', '-o', outDir, zonePath],
      { cwd: toolsDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (!/Dumped soundbank/.test(output)) return { zone, error: output.trim().split('\n').slice(-3).join(' ') };
  }

  // Every missing sample is reported individually, so the warning count is a
  // direct measure of how much of the bank data is actually present.
  const missing = [...output.matchAll(/Could not find data for sound "([^"]+)"/g)].map((m) => m[1]);
  const banks = [...output.matchAll(/Dumped soundbank "([^"]+)"/g)].map((m) => m[1]);
  return { zone, banks, missing: missing.length };
}

export function dumpSoundbanks(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  return BANK_ZONES.map((zone) => dumpZone(zone, outDir));
}

// The Unlinker nests its dump under a `soundbank/` folder, so callers that were
// handed the output root still find the alias tables.
export function resolveBankDir(outDir) {
  const nested = path.join(outDir, 'soundbank');
  return fs.existsSync(nested) ? nested : outDir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'artifacts', 'soundbanks'));
  const hasData = soundDataAvailable();
  console.log(hasData
    ? 'sound/ carries .sab banks: alias tables AND samples will be written'
    : 'sound/ has no .sab banks: alias tables only, every sample will warn');

  let totalMissing = 0;
  for (const result of dumpSoundbanks(outDir)) {
    if (result.error) { console.log(`  ${result.zone.padEnd(18)} ERROR ${result.error}`); continue; }
    if (result.skipped) { console.log(`  ${result.zone.padEnd(18)} skipped (${result.skipped})`); continue; }
    totalMissing += result.missing;
    console.log(`  ${result.zone.padEnd(18)} ${result.banks.join(', ')}  missingSamples=${result.missing}`);
  }

  const bankDir = resolveBankDir(outDir);
  const csvs = fs.readdirSync(bankDir).filter((f) => f.endsWith('.aliases.csv'));
  console.log(`\nalias tables: ${csvs.length} in ${path.relative(repoRoot, bankDir)}`);
  if (totalMissing > 0) {
    console.log(`${totalMissing} samples had no data. Restore the BO2 sound/ folder and re-run to extract audio.`);
  }
}
