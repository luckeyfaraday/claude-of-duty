#!/usr/bin/env node
// Resolves every weapon's player-facing sounds through the shipped alias tables,
// so adding a gun's audio is a lookup rather than per-weapon archaeology.
//
// Three inputs meet here:
//   - `artifacts/weapon-data/weapons/*` -- the T6 weapon files, backslash-
//     delimited key/value records naming each gun's clips and sound aliases.
//   - the compiled xanims in `export_common/xanim/` -- the reload clips author
//     their cues as `sndnt#<alias>` notetracks, which is what actually fires at
//     runtime. Notetrack names are plain strings in the binary, so a scan finds
//     them without converting 3126 clips.
//   - the alias tables from `dump_soundbanks.mjs` -- alias -> raw sound file.
//
// The important structural fact this exposes: foley is shared per archetype,
// not per weapon. `fly_an94_mag_out` and `fly_hk416_mag_out` both resolve to
// `fly_assault_mag_out`, and 27 weapons share that one file. Only the shot
// reports are per-gun, which is why 172 weapons need ~154 samples rather than
// one set each.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBankDir } from './dump_soundbanks.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolsDir, '..');

// Clips whose notetracks the first-person weapon actually plays. Sprint, raise
// and drop clips carry cues too, but nothing in the web viewer fires them yet.
const CLIP_FIELDS = ['idleAnim', 'fireAnim', 'fireIntroAnim', 'reloadAnim', 'reloadEmptyAnim'];

// The shipped mix layers a decay tail and an LFE thump under the report; both
// are derived alias names rather than their own weapon-file fields.
const LAYER_FIELDS = [
  ['shot', (w) => w.fireSoundPlayer],
  ['dryFire', (w) => w.emptyFireSoundPlayer],
  ['decay', (w) => (w.fireSoundPlayer ? `${w.fireSoundPlayer}_decay` : '')],
  ['lfe', (w) => (w.fireSoundPlayer ? w.fireSoundPlayer.replace(/_fire_plr$/, '_lfe') : '')],
];

export const ASSAULT_RIFLE_IDS = Object.freeze([
  'an94', 'hk416', 'sa58', 'saritch', 'scar', 'sig556', 'tar21', 'type95', 'xm8',
]);

// The shipped sig556/xm8 records put their LFE aliases in fireSoundPlayer.
// Those aliases do resolve, but only to the thump layer; the real shot aliases
// are also the names used by each weapon's silenced variant and resolve to the
// report plus the shared assault decay. Keep this small data correction here,
// then verify each replacement against the merged alias tables below instead
// of silently trusting the weapon-file fields.
export const FIRE_SOUND_OVERRIDES = Object.freeze({
  sig556: 'wpn_sig556_fire_plr',
  xm8: 'wpn_xm8_fire_plr',
});

function webSampleName(rawPath) {
  const base = rawPath.split('\\').pop() ?? rawPath;
  return `${base.replace(/\.[A-Z]{2}\d{2}\.pc\.snd(\.wav)?$/i, '')}.wav`;
}

export function loadAliasTables(dir) {
  const bankDir = resolveBankDir(dir);
  const alias = new Map();
  const files = fs.existsSync(bankDir)
    ? fs.readdirSync(bankDir).filter((f) => f.endsWith('.aliases.csv'))
    : [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(bankDir, file), 'utf8').split(/\r?\n/).filter(Boolean);
    const header = lines[0].split(',');
    const nameColumn = header.indexOf('Name');
    const sourceColumn = header.indexOf('FileSource');
    if (nameColumn < 0 || sourceColumn < 0) continue;
    for (const line of lines.slice(1)) {
      // Alias rows never quote these two columns, so a plain split is safe.
      const columns = line.split(',');
      const name = columns[nameColumn];
      const source = columns[sourceColumn];
      if (!name || !source) continue;
      if (!alias.has(name)) alias.set(name, new Set());
      alias.get(name).add(source);
    }
  }
  return { alias, tables: files };
}

export function parseWeaponFile(file) {
  const parts = fs.readFileSync(file, 'utf8').split('\\');
  const weapon = {};
  for (let i = 1; i < parts.length - 1; i += 2) weapon[parts[i]] = parts[i + 1];
  return weapon;
}

export function notetrackCues(animDir, name) {
  if (!name) return [];
  const file = path.join(animDir, name);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file).toString('latin1');
  return [...new Set([...text.matchAll(/sndnt#([A-Za-z0-9_]+)/g)].map((m) => m[1]))];
}

export function buildManifest({
  bankDir = path.join(repoRoot, 'artifacts', 'soundbanks'),
  weaponDir = path.join(repoRoot, 'artifacts', 'weapon-data', 'weapons'),
  animDir = path.join(repoRoot, 'export_common', 'xanim'),
} = {}) {
  const { alias, tables } = loadAliasTables(bankDir);
  const resolve = (name) => [...(alias.get(name) ?? [])];

  // Do this check against the actual merged CSVs so a typo in this corrective
  // table cannot turn a rifle into a silent weapon while still looking valid.
  if (tables.length) {
    for (const [id, soundAlias] of Object.entries(FIRE_SOUND_OVERRIDES)) {
      const sources = resolve(soundAlias);
      if (!sources.length || sources.some((source) => !/\\shot\\/i.test(source))) {
        throw new Error(`${id} override ${soundAlias} does not resolve to a shot report`);
      }
    }
  }

  const weapons = {};
  const samples = new Set();
  const silentCues = new Set();

  for (const file of fs.readdirSync(weaponDir)) {
    const weapon = parseWeaponFile(path.join(weaponDir, file));
    const id = file.replace(/_mp$/, '');
    const resolvedWeapon = FIRE_SOUND_OVERRIDES[id]
      ? { ...weapon, fireSoundPlayer: FIRE_SOUND_OVERRIDES[id] }
      : weapon;
    const entry = { displayName: weapon.displayName, gunModel: weapon.gunModel, cues: {}, layers: {} };

    for (const field of CLIP_FIELDS) {
      for (const cue of notetrackCues(animDir, weapon[field])) {
        const sources = resolve(cue);
        entry.cues[cue] = sources;
        // A cue with no alias in any bank is silent in the shipped game too --
        // `fly_<gun>_futz` is authored by 19 weapons and mapped by none.
        if (!sources.length) silentCues.add(cue);
        for (const source of sources) samples.add(source);
      }
    }

    for (const [label, pick] of LAYER_FIELDS) {
      const name = pick(resolvedWeapon);
      if (!name) continue;
      const sources = resolve(name);
      entry.layers[label] = { alias: name, sources };
      for (const source of sources) samples.add(source);
    }

    weapons[id] = entry;
  }

  return { tables, weapons, samples: [...samples].sort(), silentCues: [...silentCues].sort() };
}

// The reload xanims author cue aliases, while the merged soundbank tables
// resolve those aliases to raw sample paths. T6 shares these sounds per weapon
// class: the AN-94, HK416, and the other assault rifles all land on the same
// assault mechanical and cloth groups where the tables say they do. The map is
// therefore generated from the nine rifle entries instead of growing a
// hand-written per-gun alias list as more viewmodels are exported.
//
// The first shared set was recovered from the contiguous mono entries following
// the M27's stereo shot cluster in `cmn_root.all.sabl`, in the bank's own order.
// The alias tables now confirm both that run and each basename, so extraction
// can use the names here rather than relying on that structural recovery.
//
// The `fly_<gun>_futz` notetracks are authored by every rifle here but none of
// their aliases resolves in the merged tables. Other weapon families do have
// futz aliases, so these are authored-cue rot in the shipped data, not a gap in
// extraction; they stay explicitly silent rather than gaining an invented cue.
//
// Samples with several raw sources (the cloth randomization sets) become one
// generated group keyed by the first web basename. T6 chooses one variant per
// play, which preserves the original non-repeating reload texture.
export function buildFoleyMap({
  manifest = null,
  bankDir = path.join(repoRoot, 'artifacts', 'soundbanks'),
  rifleIds = ASSAULT_RIFLE_IDS,
} = {}) {
  const sourceManifest = manifest ?? buildManifest({ bankDir });
  const groupsBySources = new Map();
  const groups = new Map();
  const aliases = {};
  const authored = new Set();

  for (const id of rifleIds) {
    const entry = sourceManifest.weapons[id];
    if (!entry) throw new Error(`${id} is not in the manifest`);

    for (const [cue, sources] of Object.entries(entry.cues)) {
      authored.add(cue);
      const sampleNames = [...new Set(sources.map(webSampleName))].sort();
      if (!sampleNames.length) continue;

      const signature = sampleNames.join('\0');
      let group = groupsBySources.get(signature);
      if (!group) {
        const baseKey = sampleNames[0].replace(/\.wav$/i, '');
        let key = baseKey;
        let suffix = 2;
        while (groups.has(key) && groups.get(key).signature !== signature) {
          key = `${baseKey}_${suffix}`;
          suffix += 1;
        }
        group = { key, signature, urls: sampleNames.map((name) => `./audio/${name}`) };
        groupsBySources.set(signature, group);
        groups.set(key, group);
      }
      aliases[cue] = group.key;
    }
  }

  const samples = Object.fromEntries(
    [...groups.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((group) => [group.key, group.urls.length === 1 ? group.urls[0] : group.urls]),
  );
  const sortedAliases = Object.fromEntries(
    Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b)),
  );
  const silentCues = [...authored].filter((cue) => !sortedAliases[cue]).sort();
  return { aliases: sortedAliases, samples, silentCues };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'artifacts', 'soundbanks'));
  const manifest = buildManifest({ bankDir: outDir });
  const { tables, weapons, samples, silentCues } = manifest;

  if (!tables.length) {
    console.error(`No alias tables in ${path.relative(repoRoot, outDir)}. Run dump_soundbanks.mjs first.`);
    process.exit(1);
  }

  fs.writeFileSync(path.join(outDir, 'weapon-audio-manifest.json'), `${JSON.stringify(weapons, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'required-samples.txt'), `${samples.join('\n')}\n`);
  const webAudioDir = path.join(repoRoot, 'export', 'web', 'audio');
  fs.mkdirSync(webAudioDir, { recursive: true });
  fs.writeFileSync(
    path.join(webAudioDir, 'foley-map.json'),
    `${JSON.stringify(buildFoleyMap({ manifest }), null, 2)}\n`,
  );

  const resolved = Object.values(weapons).filter((w) => Object.keys(w.cues).length || Object.keys(w.layers).length);
  console.log(`alias tables merged : ${tables.length}`);
  console.log(`weapons             : ${Object.keys(weapons).length} (${resolved.length} with sounds)`);
  console.log(`unique samples needed: ${samples.length}`);
  console.log(`cues with no alias   : ${silentCues.length}${silentCues.length ? ` (${silentCues.slice(0, 4).join(', ')}, ...)` : ''}`);
  console.log('foley map emitted    : export/web/audio/foley-map.json');
}
