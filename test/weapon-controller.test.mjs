import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WeaponController } from '../export/web/weapon-controller.js';

test('automatic fire starts immediately and respects its cadence', () => {
  const shots = [];
  const weapon = new WeaponController({ roundsPerMinute: 600, onFire: (shot) => shots.push(shot) });
  weapon.setTrigger(true);

  assert.equal(weapon.update(0.001), 1);
  assert.equal(weapon.update(0.05), 0);
  assert.equal(weapon.update(0.05), 1);
  assert.equal(weapon.magazine, 28);
  assert.equal(shots.length, 2);
});

test('fire is blocked while sprinting or reloading', () => {
  const weapon = new WeaponController();
  weapon.setTrigger(true);
  assert.equal(weapon.update(0.016, { canFire: false }), 0);
  assert.equal(weapon.magazine, 30);

  weapon.magazine = 12;
  assert.equal(weapon.startReload(), true);
  assert.equal(weapon.update(0.2), 0);
  assert.equal(weapon.magazine, 12);
});

test('reload transfers only available reserve ammunition', () => {
  const weapon = new WeaponController({ magazineSize: 30, reserveAmmo: 7 });
  weapon.magazine = 4;

  assert.equal(weapon.startReload(), true);
  assert.equal(weapon.finishReload(), 7);
  assert.equal(weapon.magazine, 11);
  assert.equal(weapon.reserveAmmo, 0);
  assert.equal(weapon.canReload, false);
});

test('empty trigger notifies once until released', () => {
  let emptyCount = 0;
  const weapon = new WeaponController({ reserveAmmo: 0, onEmpty: () => { emptyCount += 1; } });
  weapon.magazine = 0;
  weapon.setTrigger(true);
  weapon.update(0.1);
  weapon.update(0.1);
  assert.equal(emptyCount, 1);

  weapon.setTrigger(false);
  weapon.setTrigger(true);
  weapon.update(0.1);
  assert.equal(emptyCount, 2);
});

test('a new life restores the complete loadout and clears weapon activity', () => {
  const weapon = new WeaponController({ magazineSize: 30, reserveAmmo: 240 });
  weapon.magazine = 3;
  weapon.reserveAmmo = 17;
  weapon.setTrigger(true);
  weapon.startReload();

  assert.deepEqual(weapon.resetLoadout(), { magazine: 30, reserveAmmo: 240 });
  assert.equal(weapon.triggerHeld, false);
  assert.equal(weapon.reloading, false);
});
