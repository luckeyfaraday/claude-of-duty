import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseXAnim, toJsonClip } from '../.tools/xanim_to_json.mjs';

const repo = path.join(import.meta.dirname, '..');
const xanimDir = path.join(repo, 'export', 'xanim');
const animsDir = path.join(repo, 'export', 'web', 'viewmodel', 'anims');

test('every hk416 viewmodel xanim parses to exactly the end of file', () => {
  const files = fs.readdirSync(xanimDir).filter((name) => name.startsWith('viewmodel_hk416_'));
  assert.ok(files.length > 100, `expected the hk416 anim set, found ${files.length}`);
  for (const name of files) {
    const parsed = parseXAnim(fs.readFileSync(path.join(xanimDir, name)));
    assert.equal(parsed.fps, 30, `${name} framerate`);
    assert.ok(parsed.bones.length > 0 || name.includes('crawl'), `${name} has bones`);
  }
});

test('reload clip carries hands, gun motion, and notetracks', () => {
  const parsed = parseXAnim(fs.readFileSync(path.join(xanimDir, 'viewmodel_hk416_reload')));
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

test('exported web clips match the source binaries', () => {
  for (const name of fs.readdirSync(animsDir).filter((file) => file.endsWith('.json'))) {
    const clip = JSON.parse(fs.readFileSync(path.join(animsDir, name), 'utf8'));
    const parsed = parseXAnim(fs.readFileSync(path.join(xanimDir, clip.name)));
    assert.equal(clip.loop, parsed.looped, `${name} loop flag`);
    assert.equal(clip.bones.length, parsed.bones.length, `${name} bone count`);
  }
});
