import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlayerHealth } from '../export/web/player-health.js';

test('player health applies damage, dies, and respawns after its delay', () => {
  const events = [];
  const health = new PlayerHealth({
    maxHealth: 100,
    respawnDelay: 1,
    onDamage: ({ amount }) => events.push(`damage:${amount}`),
    onDeath: () => events.push('death'),
    onRespawn: () => events.push('respawn'),
  });

  assert.equal(health.takeDamage(35), 35);
  assert.equal(health.health, 65);
  assert.equal(health.dead, false);
  assert.equal(health.takeDamage(100), 65);
  assert.equal(health.health, 0);
  assert.equal(health.dead, true);
  assert.equal(health.takeDamage(20), 0, 'dead players ignore further damage');

  health.update(0.25);
  assert.equal(health.dead, true);
  health.update(0.25);
  health.update(0.25);
  health.update(0.25);
  assert.equal(health.dead, false);
  assert.equal(health.health, 100);
  assert.deepEqual(events, ['damage:35', 'damage:65', 'death', 'respawn']);
});

test('manual respawn immediately restores full health', () => {
  let respawns = 0;
  const health = new PlayerHealth({ onRespawn: () => { respawns += 1; } });
  health.takeDamage(20);
  health.respawn();
  assert.equal(health.health, 100);
  assert.equal(health.dead, false);
  assert.equal(respawns, 1);
});

test('spawn protection temporarily ignores damage after a respawn', () => {
  const health = new PlayerHealth({ spawnProtection: 1 });
  assert.equal(health.takeDamage(40), 0);
  health.update(0.25);
  health.update(0.25);
  health.update(0.25);
  assert.equal(health.takeDamage(40), 0);
  health.update(0.25);
  assert.equal(health.takeDamage(40), 40);
  health.respawn();
  assert.equal(health.takeDamage(40), 0);
});

test('health regenerates after its recovery delay', () => {
  const health = new PlayerHealth({ regenDelay: 1, regenPerSecond: 20 });
  health.takeDamage(50);
  health.update(0.25);
  health.update(0.25);
  health.update(0.25);
  assert.equal(health.health, 50);
  health.update(0.25);
  assert.equal(health.health, 55);
  health.update(0.25);
  assert.equal(health.health, 60);
});
