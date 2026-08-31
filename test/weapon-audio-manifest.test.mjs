import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  ASSAULT_RIFLE_IDS,
  FIRE_SOUND_OVERRIDES,
  buildFoleyMap,
  buildManifest,
  loadAliasTables,
  parseWeaponFile,
} from '../.tools/weapon_audio_manifest.mjs';
import { webSampleName } from '../.tools/extract_weapon_audio.mjs';

const bankDir = path.resolve('artifacts/soundbanks');
const weaponDir = path.resolve('artifacts/weapon-data/weapons');
const foleyMapPath = path.resolve('export/web/audio/foley-map.json');

// The alias tables are a local dump (`node .tools/dump_soundbanks.mjs`), not
// committed data, so these assertions only run where that dump exists.
const dumped = loadAliasTables(bankDir).tables.length > 0;
const options = { skip: dumped ? false : 'run .tools/dump_soundbanks.mjs first' };

test('weapon files carry the stats the web export hardcodes', { skip: options.skip }, () => {
  const an94 = parseWeaponFile(path.join(weaponDir, 'an94_mp'));
  // 60/fireTime is the RPM the controller is built from, and introFireTime is
  // what makes the AN-94's first two rounds leave faster than the rest.
  assert.equal(60 / Number(an94.fireTime), 625);
  assert.equal(60 / Number(an94.introFireTime), 937.5);
  assert.equal(Number(an94.clipSize), 30);
  // The magazine attachment offset the viewmodel welds `tag_clip` with.
  assert.deepEqual(
    [an94.attachViewModelOffsetX7, an94.attachViewModelOffsetY7, an94.attachViewModelOffsetZ7].map(Number),
    [4.473, -1.085, -1.5],
  );
});

// The load-bearing structural fact: T6 shares reload foley across a whole weapon
// class rather than authoring it per gun. Missing this is what led to five
// hand-cut AN-94 samples standing in for sounds the game plays from the shared
// assault-rifle set, so it is worth asserting rather than rediscovering.
test('assault-rifle reload foley resolves to one shared sample per cue', { skip: options.skip }, () => {
  const { weapons } = buildManifest({ bankDir });
  for (const cue of ['mag_out', 'mag_in', 'bolt_back', 'bolt_release']) {
    const resolved = ASSAULT_RIFLE_IDS
      .map((id) => weapons[id].cues[`fly_${id}_${cue}`])
      .filter(Boolean);
    for (const sources of resolved) {
      assert.deepEqual(sources, resolved[0], `fly_*_${cue} should resolve to one shared sample`);
      assert.match(sources[0], /fly_assault_/, `fly_*_${cue} should come from the shared assault set`);
    }
  }
});

test('sig556 and xm8 overrides resolve to real shot reports', { skip: options.skip }, () => {
  const { alias } = loadAliasTables(bankDir);
  const { weapons } = buildManifest({ bankDir });

  for (const [id, soundAlias] of Object.entries(FIRE_SOUND_OVERRIDES)) {
    const original = parseWeaponFile(path.join(weaponDir, `${id}_mp`));
    assert.match(original.fireSoundPlayer, /lfe/i, `${id} fixture should exercise the bad LFE field`);
    const sources = [...(alias.get(soundAlias) ?? [])];
    assert.equal(sources.length, 1, `${soundAlias} should resolve exactly one source`);
    assert.match(sources[0], /\\shot\\/i, `${soundAlias} must resolve to a shot report`);
    assert.doesNotMatch(sources[0], /lfe/i, `${soundAlias} must not resolve to an LFE sample`);
    assert.equal(weapons[id].layers.shot.alias, soundAlias);
    assert.deepEqual(weapons[id].layers.shot.sources, sources);
  }
});

test('generated foley map covers every assault-rifle cue', { skip: options.skip }, () => {
  const { weapons } = buildManifest({ bankDir });
  const generated = JSON.parse(fs.readFileSync(foleyMapPath, 'utf8'));
  const rebuilt = buildFoleyMap({ manifest: { weapons } });
  assert.deepEqual(generated, rebuilt, 'checked-in foley map should come from the current manifest');

  for (const id of ASSAULT_RIFLE_IDS) {
    for (const [cue, sources] of Object.entries(weapons[id].cues)) {
      if (!sources.length) {
        assert.ok(generated.silentCues.includes(cue), `${id} cue ${cue} should be explicitly silent`);
        continue;
      }
      const target = generated.aliases[cue];
      assert.ok(target, `${id} cue ${cue} should have a generated alias`);
      assert.ok(generated.samples[target], `${id} cue ${cue} target ${target} should have samples`);
    }
  }
});

test('all assault-rifle shot layers resolve 32 unique class samples', { skip: options.skip }, () => {
  const { weapons } = buildManifest({ bankDir });
  const samples = new Set();
  for (const id of ASSAULT_RIFLE_IDS) {
    const entry = weapons[id];
    assert.equal(entry.layers.shot.sources.length, 1, `${id} should resolve one shot report`);
    assert.match(entry.layers.shot.sources[0], /\\shot\\/i, `${id} should use a shot report`);
    assert.doesNotMatch(entry.layers.shot.sources[0], /lfe/i, `${id} shot must not be an LFE sample`);
    for (const source of Object.values(entry.cues).flat()) samples.add(source);
    for (const layer of Object.values(entry.layers)) {
      for (const source of layer.sources) samples.add(source);
    }
  }
  assert.equal(samples.size, 32);
});

test('the futz notetrack is unmapped, so shipping a sample for it is wrong', { skip: options.skip }, () => {
  const { weapons, silentCues } = buildManifest({ bankDir });
  assert.deepEqual(weapons.an94.cues.fly_an94_futz, [], 'no bank maps fly_an94_futz');
  assert.deepEqual(weapons.hk416.cues.fly_hk416_futz, [], 'no bank maps fly_hk416_futz');
  // 18 of the 19 dangling cues are `_futz`; `fly_minigun_tap` is the lone
  // outlier. Guns that do map a futz alias (hamr, lsat, mk48, evoskorpion)
  // resolve normally, so this is authored-cue rot rather than a dump gap.
  const unexpected = silentCues.filter((cue) => !cue.endsWith('_futz') && cue !== 'fly_minigun_tap');
  assert.deepEqual(unexpected, [], 'no cue family beyond futz should be unmapped');
  assert.ok(loadAliasTables(bankDir).alias.has('fly_hamr_futz'), 'futz aliases do exist for other guns');
});

test('the whole weapon roster needs far fewer samples than it has weapons', { skip: options.skip }, () => {
  const { weapons, samples } = buildManifest({ bankDir });
  assert.equal(Object.keys(weapons).length, 172);
  // Sharing is what makes a full roster affordable; if this ever approaches the
  // weapon count, the resolution has silently stopped deduplicating.
  assert.ok(samples.length < 250, `expected sharing to keep the sample set small, got ${samples.length}`);
  assert.ok(samples.length > 100, `expected a full roster of samples, got ${samples.length}`);
});

// Once the sound banks are present the tables name the extension the dump
// actually wrote, so the path is directly openable rather than a stem.
test('every sample the manifest asks for is a raw sound path', { skip: options.skip }, () => {
  const { samples } = buildManifest({ bankDir });
  for (const sample of samples) assert.match(sample, /^raw\\sound\\.+\.snd(\.(wav|flac))?$/);
});

test('the manifest covers the weapons that already ship in the browser', { skip: options.skip }, () => {
  const { weapons } = buildManifest({ bankDir });
  for (const id of ['an94', 'hk416']) {
    assert.ok(weapons[id].layers.shot.sources.length === 1, `${id} should resolve exactly one shot report`);
  }
  // The web export names the M27 by its model, and the alias table confirms the
  // HK416 fires the M27's recorded report.
  assert.match(weapons.hk416.layers.shot.sources[0], /wpn_m27_shot_plr/);
  assert.match(weapons.an94.layers.shot.sources[0], /wpn_an94_shot_plr/);
});

test('sample names drop the platform infix the web has no use for', () => {
  assert.equal(webSampleName('raw\\sound\\wpn\\assault\\reload\\fly_assault_bb.LN65.pc.snd.wav'),
    'fly_assault_bb.wav');
  // Pre-extraction tables name the stem without an extension.
  assert.equal(webSampleName('raw\\sound\\wpn\\assault\\an94\\plr\\shot\\wpn_an94_shot_plr.LN65.pc.snd'),
    'wpn_an94_shot_plr.wav');
});

// The Unlinker writes a constant 0x30 RIFF size instead of the payload length,
// so anything copied straight out of a dump can be rejected by decodeAudioData.
test('extracted samples carry a RIFF size matching their payload', () => {
  const dir = path.resolve('export/web/audio');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.wav'))) {
    const buffer = fs.readFileSync(path.join(dir, file));
    assert.equal(buffer.subarray(0, 4).toString('ascii'), 'RIFF', `${file} is not a WAV`);
    assert.equal(buffer.readUInt32LE(4), buffer.length - 8, `${file} has a bad RIFF chunk size`);
    const data = buffer.indexOf('data', 12, 'ascii');
    assert.ok(data > 0, `${file} has no data chunk`);
    assert.equal(buffer.readUInt32LE(data + 4), buffer.length - data - 8, `${file} has a bad data size`);
  }
});

test('dumped alias tables exist for the banks weapon audio needs', { skip: options.skip }, () => {
  const { tables } = loadAliasTables(bankDir);
  // `mpl_common` carries the weapon aliases; without it no `fly_<gun>_*` or
  // `wpn_<gun>_fire_plr` name resolves at all.
  assert.ok(tables.includes('mpl_common.all.aliases.csv'), 'the common bank must be dumped');
  assert.ok(fs.existsSync(path.join(bankDir, 'soundbank')));
});
