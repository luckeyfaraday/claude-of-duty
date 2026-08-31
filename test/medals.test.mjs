import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MedalTracker } from '../export/web/medals.js';

// A clock the tests step by hand: the tracker must never read a real one.
function fakeClock(startMs = 0) {
  let now = startMs;
  return {
    get now() { return now; },
    advance(ms) { now += ms; return now; },
  };
}

function defsFromGame() {
  const url = new URL('../export/web/ui/medals/medals.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

function refs(earned) {
  return earned.map((def) => def.ref);
}

// The subset of scoreinfo the tracker understands, for logic tests that stay
// independent of the exported table.
const LOGIC_DEFS = [
  { ref: 'multikill_2', name: 'Double Kill', xp: 100 },
  { ref: 'multikill_3', name: 'Triple Kill', xp: 250 },
  { ref: 'multikill_8', name: 'Ultra Kill', xp: 1500 },
  { ref: 'multikill_more_than_8', name: 'Kill Chain', xp: 2000 },
  { ref: 'killstreak_5', name: 'Bloodthirsty', xp: 250 },
  { ref: 'killstreak_10', name: 'Merciless', xp: 500 },
  { ref: 'killstreak_more_than_10', name: 'Overachiever' },
];

function makeTracker(windowMs = 4200, defs = LOGIC_DEFS) {
  const clock = fakeClock();
  return { clock, tracker: new MedalTracker({ defs, now: () => clock.now, multikillWindowMs: windowMs }) };
}

test('single kills never medal', () => {
  const { clock, tracker } = makeTracker();
  assert.deepEqual(refs(tracker.onKill()), []);
  clock.advance(30_000);
  assert.deepEqual(refs(tracker.onKill()), []);
  assert.equal(tracker.getState().killCount, 2);
});

test('kills inside the window climb the multikill chain', () => {
  const { clock, tracker } = makeTracker();
  assert.deepEqual(refs(tracker.onKill()), []);
  clock.advance(1000);
  assert.deepEqual(refs(tracker.onKill()), ['multikill_2']);
  clock.advance(1000);
  assert.deepEqual(refs(tracker.onKill()), ['multikill_3']);
});

test('a slow kill starts a new chain instead of extending one', () => {
  const { clock, tracker } = makeTracker(4200);
  tracker.onKill();
  clock.advance(4200); // exactly the window still chains
  assert.deepEqual(refs(tracker.onKill()), ['multikill_2']);
  clock.advance(4201); // one past it does not
  assert.deepEqual(refs(tracker.onKill()), []);
  assert.equal(tracker.getState().chain, 1);
});

test('chains past the top award Kill Chain and nothing lower', () => {
  const { clock, tracker } = makeTracker();
  tracker.onKill();
  for (let kills = 2; kills <= 8; kills += 1) {
    clock.advance(500);
    tracker.onKill();
  }
  clock.advance(500);
  assert.deepEqual(refs(tracker.onKill()), ['multikill_more_than_8']);
});

test('killstreak thresholds latch once per life, highest included', () => {
  const { clock, tracker } = makeTracker();
  const seen = [];
  for (let kill = 1; kill <= 10; kill += 1) {
    clock.advance(10_000); // every kill its own chain
    seen.push(...refs(tracker.onKill()));
  }
  assert.deepEqual(seen, ['killstreak_5', 'killstreak_10']);
});

test('the more-than threshold awards above, not at, its size', () => {
  const { clock, tracker } = makeTracker();
  for (let kill = 0; kill < 10; kill += 1) {
    clock.advance(10_000);
    tracker.onKill();
  }
  clock.advance(10_000);
  assert.deepEqual(refs(tracker.onKill()), ['killstreak_more_than_10']);
});

// A streak that crosses several rungs at once has to pop the biggest medal
// first, and that must not depend on the order the exporter happened to emit:
// scoreinfo lists killstreaks descending, LOGIC_DEFS ascending.
test('several rungs crossed at once come back highest first, whatever the table order', () => {
  const ascending = LOGIC_DEFS;
  const descending = [...LOGIC_DEFS].reverse();
  const expected = ['killstreak_more_than_10', 'killstreak_10', 'killstreak_5'];
  for (const defs of [ascending, descending]) {
    const { tracker } = makeTracker(4200, defs);
    assert.deepEqual(refs(tracker.killstreaksFor(11)), expected);
  }
});

test('dying resets streak, chain and latched streak medals', () => {
  const { clock, tracker } = makeTracker();
  tracker.onKill();
  clock.advance(1000);
  tracker.onKill();
  assert.deepEqual(tracker.getState().recent.map((e) => e.ref), ['multikill_2']);
  tracker.onDeath();
  const state = tracker.getState();
  assert.equal(state.streak, 0);
  assert.equal(state.chain, 0);
  // The next life can earn Bloodthirsty again; the recent list is history
  // across lives, so only check the newest entry.
  for (let kill = 0; kill < 5; kill += 1) {
    clock.advance(10_000);
    tracker.onKill();
  }
  assert.equal(tracker.getState().recent[0].ref, 'killstreak_5');
});

test('multikill and killstreak medals from the same kill arrive together', () => {
  const { clock, tracker } = makeTracker();
  tracker.onKill(); // 1
  clock.advance(1000);
  tracker.onKill(); // 2 -- double kill
  clock.advance(1000);
  tracker.onKill(); // 3 -- triple
  clock.advance(1000);
  tracker.onKill(); // 4
  clock.advance(1000);
  tracker.onKill(); // 5 -- frenzy threshold on a chain kill
  const recent = tracker.getState().recent.map((e) => e.ref);
  assert.ok(recent.includes('killstreak_5'));
  assert.ok(recent.includes('multikill_2'));
  assert.ok(recent.includes('multikill_3'));
});

test('reset forgets history and totals, unlike death', () => {
  const { clock, tracker } = makeTracker();
  tracker.onKill();
  clock.advance(1000);
  tracker.onKill();
  assert.ok(tracker.getState().earnedTotal >= 1);
  tracker.reset();
  const state = tracker.getState();
  assert.equal(state.killCount, 0);
  assert.equal(state.earnedTotal, 0);
  assert.deepEqual(state.recent, []);
});

test('an empty or failed definition table leaves the tracker inert', () => {
  const tracker = new MedalTracker({ defs: null, now: () => 0 });
  assert.deepEqual(tracker.onKill(), []);
  assert.equal(tracker.def('multikill_2'), null);
});

test('def() looks definitions up by scoreinfo reference', () => {
  const { tracker } = makeTracker();
  assert.equal(tracker.def('multikill_2').name, 'Double Kill');
  assert.equal(tracker.def('nope'), null);
});

test('the exported medals.json carries the shipped multikill and killstreak sets', async () => {
  const defs = defsFromGame();
  const tracker = new MedalTracker({ defs, now: () => 0 });
  const expected = [
    'multikill_2', 'multikill_3', 'multikill_4', 'multikill_5',
    'multikill_6', 'multikill_7', 'multikill_8', 'multikill_more_than_8',
    'killstreak_5', 'killstreak_10', 'killstreak_15', 'killstreak_20',
    'killstreak_25', 'killstreak_30', 'killstreak_more_than_30',
  ];
  for (const ref of expected) {
    const def = tracker.def(ref);
    assert.ok(def, `${ref} missing from medals.json`);
    assert.ok(def.name, `${ref} has no localized name`);
  }
  // The iconic pair the feature exists for.
  assert.equal(tracker.def('multikill_2').name, 'Double Kill');
  assert.equal(tracker.def('killstreak_30').name, 'Nuclear');
  // Every medal the tracker can award has its icon on disk, so a popup can
  // never reference missing art.
  for (const def of defs) {
    if (!def.icon) continue;
    const iconPath = fileURLToPath(new URL(`../export/web/ui/medals/${def.icon}`, import.meta.url));
    assert.ok(existsSync(iconPath), `${def.ref} icon ${def.icon} missing`);
  }
});

test('medals.js has no DOM dependency', () => {
  const source = readFileSync(fileURLToPath(new URL('../export/web/medals.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /(?:document|window)\./);
});
