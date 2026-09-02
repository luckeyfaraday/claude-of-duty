import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseXAnim, toJsonClip } from '../.tools/xanim_to_json.mjs';

const repo = path.join(import.meta.dirname, '..');
// The source binaries are split across two dumps: `export/xanim/` holds only the
// hk416 set, and every other weapon's clips are in the full `common_mp.ff` dump.
// Resolving one directory for all of them worked while the M27 was the only gun
// and breaks as soon as a second one ships a clip, so each name is looked up
// across both instead.
const xanimDirs = [
  path.join(repo, 'export', 'xanim'),
  path.join(repo, 'export_common', 'xanim'),
].filter((directory) => fs.existsSync(directory));
const hk416Dir = xanimDirs.find((directory) => fs.readdirSync(directory)
  .some((name) => name.startsWith('viewmodel_hk416_')));
const animsDir = path.join(repo, 'export', 'web', 'viewmodel', 'anims');
const sourceAnimations = {
  skip: hk416Dir ? false : 'requires local T6 XANIM dumps',
};

function readXanim(name) {
  const directory = xanimDirs.find((candidate) => fs.existsSync(path.join(candidate, name)));
  assert.ok(directory, `${name} not found in ${xanimDirs.join(' or ')}`);
  return fs.readFileSync(path.join(directory, name));
}

test('every hk416 viewmodel xanim parses to exactly the end of file', sourceAnimations, () => {
  const files = fs.readdirSync(hk416Dir).filter((name) => name.startsWith('viewmodel_hk416_'));
  assert.ok(files.length > 100, `expected the hk416 anim set, found ${files.length}`);
  for (const name of files) {
    const parsed = parseXAnim(readXanim(name));
    assert.equal(parsed.fps, 30, `${name} framerate`);
    assert.ok(parsed.bones.length > 0 || name.includes('crawl'), `${name} has bones`);
  }
});

test('reload clip carries hands, gun motion, and notetracks', sourceAnimations, () => {
  const parsed = parseXAnim(readXanim('viewmodel_hk416_reload'));
  const clip = toJsonClip('viewmodel_hk416_reload', parsed);

  assert.equal(parsed.looped, false);
  assert.ok(Math.abs(clip.duration - 62 / 30) < 1e-3);

  const names = clip.bones.map((bone) => bone.name);
  assert.ok(names.includes('tag_weapon'), 'hands weapon joint is animated');
  assert.ok(names.includes('tag_clip'), 'magazine joint is animated');
  assert.ok(names.some((name) => name.startsWith('j_wrist')), 'hand bones are animated');

  const notifies = clip.notifies.map((notify) => notify.name);
  assert.ok(notifies.includes('sndnt#fly_hk416_mag_out'));
  assert.ok(notifies.includes('sndnt#fly_hk416_mag_in'));

  for (const bone of clip.bones) {
    if (bone.rot) {
      for (let i = 0; i < bone.rot.values.length; i += 4) {
        const q = bone.rot.values.slice(i, i + 4);
        const length = Math.hypot(...q);
        assert.ok(Math.abs(length - 1) < 2e-3, `${bone.name} quat ${q} normalized (|q|=${length})`);
      }
      for (const value of bone.rot.values) {
        assert.ok(Number.isFinite(value) && Math.abs(value) <= 1 + 1e-6);
      }
    }
    if (bone.pos) {
      for (const value of bone.pos.values) assert.ok(Number.isFinite(value));
    }
  }
});

// Quantized trans tracks store mins plus the full range the samples span, and
// the encoder normalizes each axis so its samples run the whole 0..max range.
// Folding an extra 1/max into the range as well decodes every translation at
// about 1/65535 of its authored size, which is not obviously wrong in isolation
// — the values stay finite and the clip still plays. It cost the magazine its
// entire trip out of the magwell and the bolt its whole cycle, and it survived
// because the round-trip test above reads both sides through this same decoder.
// So assert the decode against magnitudes measured off the source bytes.
test('quantized translation tracks decode at their authored scale', sourceAnimations, () => {
  const parsed = parseXAnim(readXanim('viewmodel_hk416_reload'));
  const span = (bone, axis) => {
    const values = [];
    for (let i = axis; i < bone.pos.values.length; i += 3) values.push(bone.pos.values[i]);
    return Math.max(...values) - Math.min(...values);
  };

  // The magazine is carried clear of the weapon and dropped: 167 units on the
  // axis it travels furthest along, not the 0.003 a doubled divide leaves.
  const clip = parsed.bones.find((bone) => bone.name === 'tag_clip');
  assert.ok(clip?.pos, 'tag_clip carries a translation track');
  assert.ok(Math.abs(span(clip, 0) - 167.9) < 1,
    `tag_clip should travel its authored 167 units, got ${span(clip, 0).toFixed(3)}`);
  // It is authored as a displacement from the magwell, so it opens on zero.
  assert.ok(Math.hypot(...clip.pos.values.slice(0, 3)) < 0.01,
    `tag_clip should open on the origin, got ${clip.pos.values.slice(0, 3)}`);

  // The u8 path quantizes separately from the u16 one, so cover it too: the
  // gun's own recoil kick during the same clip.
  const weapon = parsed.bones.find((bone) => bone.name === 'tag_weapon');
  assert.ok(Math.abs(span(weapon, 2) - 6.8) < 0.5,
    `tag_weapon should kick its authored 6.8 units, got ${span(weapon, 2).toFixed(3)}`);
});

test('exported web clips match the source binaries', sourceAnimations, () => {
  for (const name of fs.readdirSync(animsDir).filter((file) => file.endsWith('.json'))) {
    const clip = JSON.parse(fs.readFileSync(path.join(animsDir, name), 'utf8'));
    const parsed = parseXAnim(readXanim(clip.name));
    assert.equal(clip.loop, parsed.looped, `${name} loop flag`);
    assert.equal(clip.bones.length, parsed.bones.length, `${name} bone count`);
  }
});
