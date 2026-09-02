import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ASSAULT_RIFLE_IDS, buildManifest } from '../.tools/weapon_audio_manifest.mjs';
import { FOLEY_ALIASES, FOLEY_URLS, GunAudio, SILENT_CUES } from '../export/web/weapon-effects.js';

const webRoot = path.resolve('export/web');
const animRoot = path.join(webRoot, 'viewmodel/anims');
const weaponDefinitions = path.resolve('artifacts/weapon-data/weapons');
const sourceWeaponData = {
  skip: fs.existsSync(weaponDefinitions) ? false : 'requires local T6 weapon definitions',
};

// './audio/x.wav' as written in the module is relative to export/web.
function resolveWebUrl(url) {
  return path.join(webRoot, url.replace(/^\.\//, ''));
}

function authoredSoundCues() {
  const cues = new Map();
  for (const file of fs.readdirSync(animRoot).filter((name) => name.endsWith('.json'))) {
    const clip = JSON.parse(fs.readFileSync(path.join(animRoot, file), 'utf8'));
    for (const notify of clip.notifies ?? []) {
      if (!notify.name.startsWith('sndnt#')) continue;
      const cue = notify.name.slice('sndnt#'.length);
      if (!cues.has(cue)) cues.set(cue, []);
      cues.get(cue).push(file);
    }
  }
  return cues;
}

// The reload cues are authored into the clips, so a clip can name a sound the
// bundle never ships and the reload just goes quiet at that beat -- silently,
// because playFoley treats a missing buffer as a no-op. This walks the actual
// authored notetracks rather than a hand-kept list so a newly exported weapon
// cannot introduce a mute cue unnoticed.
test('every authored reload cue resolves to a sample that ships', () => {
  const cues = authoredSoundCues();
  assert.ok(cues.size > 0, 'clips should author sound notetracks');

  for (const [cue, clips] of cues) {
    // A cue no soundbank maps is silent in T6 as well, so it is correct here
    // rather than missing. Everything else must reach a real sample.
    if (SILENT_CUES.has(cue)) {
      assert.equal(FOLEY_URLS[cue], undefined, `${cue} is unmapped in the game and should ship no sample`);
      continue;
    }
    const target = FOLEY_ALIASES[cue] ?? cue;
    const urls = FOLEY_URLS[target];
    assert.ok(urls, `cue ${cue} (used by ${clips.join(', ')}) has no sample or alias`);
    // A cue may carry several randomized variants; each must actually ship.
    for (const url of [urls].flat()) {
      assert.ok(fs.existsSync(resolveWebUrl(url)), `cue ${cue} points at a missing file: ${url}`);
    }
  }
});

// T6 authors reload foley per weapon class, not per weapon: the shipped alias
// tables resolve both rifles' mag and bolt cues to the same `fly_assault_*`
// samples. Giving either gun a private set would be the regression -- the
// reload would play, just not the sound the game ships.
test('both rifles share the assault-class mechanical samples', () => {
  for (const cue of ['mag_out', 'mag_in', 'bolt_back', 'bolt_release']) {
    const an94 = FOLEY_ALIASES[`fly_an94_${cue}`];
    const hk416 = FOLEY_ALIASES[`fly_hk416_${cue}`];
    assert.ok(an94, `fly_an94_${cue} should alias onto a shared sample`);
    assert.equal(an94, hk416, `fly_*_${cue} should resolve to one sample for both rifles`);
    assert.match(an94, /^fly_assault_/, `fly_*_${cue} should come from the assault set`);
    assert.ok(fs.existsSync(resolveWebUrl(FOLEY_URLS[an94])), `${an94} sample missing`);
  }
});

test('every assault-rifle notetrack is mapped or explicitly silent', sourceWeaponData, () => {
  const { weapons } = buildManifest();
  for (const id of ASSAULT_RIFLE_IDS) {
    for (const [cue, sources] of Object.entries(weapons[id].cues)) {
      if (!sources.length) {
        assert.ok(SILENT_CUES.has(cue), `${id} cue ${cue} is unresolved but not explicitly silent`);
        continue;
      }

      const target = FOLEY_ALIASES[cue] ?? cue;
      const urls = FOLEY_URLS[target];
      assert.ok(urls, `${id} cue ${cue} has no generated foley mapping`);
      for (const url of [urls].flat()) {
        assert.ok(fs.existsSync(resolveWebUrl(url)), `${id} cue ${cue} points at a missing file: ${url}`);
      }
    }
  }
});

// Sharing is what makes the rest of the roster affordable, so the sample set
// must not grow a per-weapon entry as guns are added.
test('no per-weapon foley sample ships', () => {
  for (const name of Object.keys(FOLEY_URLS)) {
    assert.doesNotMatch(name, /^fly_(an94|hk416)_/, `${name} should alias onto a shared sample instead`);
  }
});

test('each rifle registers its own player-perspective report', () => {
  const audio = new GunAudio();
  for (const weapon of ['m27', ...ASSAULT_RIFLE_IDS]) {
    const url = audio.urls[`shot:${weapon}`];
    assert.ok(url, `${weapon} should register a shot sample`);
    assert.ok(fs.existsSync(resolveWebUrl(url)), `${weapon} shot sample missing: ${url}`);
  }
  assert.notEqual(audio.urls['shot:an94'], audio.urls['shot:m27']);
  for (const weapon of ['sig556', 'xm8']) {
    assert.doesNotMatch(audio.urls[`shot:${weapon}`], /lfe/i, `${weapon} must use its shot report`);
  }
});

// Enemy reports and any weapon added before its own alias is recovered go
// through the shared sample instead of firing silently.
test('shot layers fall back to the shared report when a weapon has no sample', () => {
  const audio = new GunAudio();
  assert.equal(audio.shotLayer('an94'), 'shot', 'unloaded buffers should fall back');

  audio.buffers['shot:an94'] = {};
  assert.equal(audio.shotLayer('an94'), 'shot:an94');
  assert.equal(audio.shotLayer('rpg'), 'shot', 'an unknown weapon should still be audible');
  assert.equal(audio.shotLayer(null), 'shot', 'enemy reports use the shared sample');
});
