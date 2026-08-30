import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enemyShotSpread, engagementPlan } from '../export/web/enemy-tactics.js';

test('engagement plans spread a squad across different angles and ranges', () => {
  const plans = Array.from({ length: 6 }, (_, index) => engagementPlan(index, 850));
  assert.equal(new Set(plans.map(({ angle }) => angle)).size, 6);
  assert.ok(plans.every(({ radius }) => radius >= 450 && radius <= 650));
});

test('enemy accuracy degrades naturally with distance and movement', () => {
  const close = enemyShotSpread(250);
  const far = enemyShotSpread(800);
  const moving = enemyShotSpread(800, { playerSpeed: 300, shooterSpeed: 230 });
  assert.ok(far > close);
  assert.ok(moving > far);
});

test('suppression adds an accuracy penalty instead of disabling fire', () => {
  const normal = enemyShotSpread(500);
  const suppressed = enemyShotSpread(500, { suppressed: true });
  assert.equal(suppressed - normal, 18);
});

test('newly acquired targets start inaccurate and converge to settled spread', () => {
  const acquiring = enemyShotSpread(500, { aimConvergence: 0 });
  const settling = enemyShotSpread(500, { aimConvergence: 0.5 });
  const settled = enemyShotSpread(500, { aimConvergence: 1 });
  assert.equal(acquiring - settled, 20);
  assert.equal(settling, (acquiring + settled) / 2);
});
