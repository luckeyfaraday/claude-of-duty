import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Frontend, SCREENS } from '../export/web/frontend.js';

test('frontend exposes the class screen and keeps its selected rifle across routes', () => {
  const selected = [];
  const frontend = new Frontend({
    onSelectWeapon: (id) => {
      selected.push(id);
      return id;
    },
  });
  assert.ok(SCREENS.includes('class'));
  frontend.setWeapons([
    { id: 'm27', name: 'M27', ready: true },
    { id: 'sa58', name: 'FAL OSW', ready: true },
    { id: 'xm8', name: 'M8A1', ready: false },
  ], 'm27');
  frontend.setReady();

  assert.equal(frontend.getState().selectedWeapon, 'm27');
  assert.equal(frontend.openClass(), true);
  assert.equal(frontend.screen, 'class');
  assert.equal(frontend.visible, true);
  assert.equal(frontend.ready, false, 'the class picker should not start the game by itself');
  assert.equal(frontend.chooseWeapon('xm8'), false, 'an unloaded card cannot be equipped');
  assert.equal(frontend.chooseWeapon('sa58'), 'sa58');
  assert.equal(frontend.getState().selectedWeapon, 'sa58');
  assert.equal(frontend.confirmClass(), 'sa58');
  assert.deepEqual(selected, ['sa58']);
  assert.equal(frontend.screen, 'title', 'confirming from title returns to title');

  frontend.enter();
  frontend.suspend();
  assert.equal(frontend.screen, 'pause');
  assert.equal(frontend.action('class'), true);
  assert.equal(frontend.screen, 'class');
  assert.equal(frontend.action('class-back'), 'pause');
  assert.equal(frontend.screen, 'pause');
});

test('frontend aggregates load progress and names the heaviest source', () => {
  const frontend = new Frontend();
  assert.equal(frontend.screen, 'loading');
  assert.equal(frontend.visible, true);
  assert.equal(frontend.ready, false);
  assert.equal(frontend.getState().percent, 0);
  assert.equal(frontend.caption, 'connecting');

  frontend.progress('map', { loaded: 10, total: 40 });
  assert.equal(frontend.getState().percent, 25);
  assert.equal(frontend.getState().caption, 'map geometry', 'labels map to readable captions');

  // A second source registering mid-load must not drag the bar backwards.
  frontend.progress('collision', { loaded: 0, total: 60 });
  assert.equal(frontend.getState().percent, 25);
  assert.equal(frontend.caption, 'collision', 'the caption follows the most bytes outstanding');

  frontend.progress('map', { loaded: 40, total: 40 });
  frontend.progress('collision', { loaded: 30, total: 60 });
  assert.equal(frontend.getState().percent, 70);

  // Sources with no reported total contribute nothing rather than skewing it.
  frontend.progress('magazine', { loaded: 512 });
  assert.equal(frontend.getState().percent, 70);
});

test('frontend progress never regresses once a source reports fewer bytes', () => {
  const frontend = new Frontend();
  frontend.progress('render', { loaded: 90, total: 100 });
  assert.equal(frontend.getState().percent, 90);
  frontend.progress('render', { loaded: 5, total: 100 });
  assert.equal(frontend.getState().percent, 90, 'a stale event cannot rewind the bar');
});

test('declared stages fix the denominator and gate completion on stage()', () => {
  const frontend = new Frontend();
  frontend.expect({ map: 8, collision: 2 });
  assert.equal(frontend.determinate, true, 'declared stages give a bar to draw immediately');
  assert.equal(frontend.getState().percent, 0);
  assert.equal(frontend.caption, 'map geometry', 'the first unfinished stage names the bar');

  // Byte progress moves a stage but is capped short of completing it, so a
  // source whose bytes finish before its work does cannot fill the bar.
  frontend.progress('map', { loaded: 100, total: 100 });
  assert.equal(frontend.getState().percent, 72, '8/10 of the bar, held at 90% of the stage');
  assert.equal(frontend.caption, 'map geometry', 'a fully reported stage is still the one to name');

  frontend.stage('map');
  assert.equal(frontend.getState().percent, 80);
  assert.equal(frontend.caption, 'collision');

  frontend.stage('collision');
  assert.equal(frontend.getState().percent, 100);
  assert.equal(frontend.caption, 'finishing up');

  assert.equal(frontend.stage('nonexistent'), false, 'undeclared stages are ignored');
});

test('frontend runs indeterminate when no source reports a total', () => {
  const frontend = new Frontend();
  assert.equal(frontend.determinate, false);

  frontend.progress('map', { loaded: 2 * 1048576 });
  frontend.progress('collision', { loaded: 1048576 });
  assert.equal(frontend.determinate, false);
  assert.equal(frontend.getState().percent, 0, 'there is nothing to take a percentage of');
  assert.equal(frontend.loadedBytes, 3 * 1048576);
  assert.equal(frontend.caption, 'map geometry', 'the biggest download still names the bar');

  // The first total switches the bar over, and sources without one drop out
  // of the caption so they cannot mislabel it.
  frontend.progress('collision', { loaded: 1048576, total: 4 * 1048576 });
  assert.equal(frontend.determinate, true);
  assert.equal(frontend.getState().percent, 25);
  assert.equal(frontend.caption, 'collision');
});

test('frontend waits for the game to confirm before dropping the shell', () => {
  const events = [];
  const frontend = new Frontend({
    onPlay: () => events.push('play'),
    onResume: () => events.push('resume'),
  });

  assert.equal(frontend.play(), false, 'the shell cannot be dismissed while loading');
  assert.deepEqual(events, []);

  frontend.setReady(['WASD move']);
  assert.equal(frontend.screen, 'title');
  assert.equal(frontend.getState().percent, 100);
  assert.equal(frontend.ready, true);

  // play() only asks; a refused pointer lock must leave the shell on screen.
  assert.equal(frontend.play(), true);
  assert.deepEqual(events, ['play']);
  assert.equal(frontend.visible, true, 'the shell stays up until the lock lands');

  frontend.enter();
  assert.equal(frontend.visible, false);
  assert.equal(frontend.screen, 'title');

  frontend.suspend();
  assert.equal(frontend.screen, 'pause');
  assert.equal(frontend.visible, true);

  frontend.play();
  assert.deepEqual(events, ['play', 'resume'], 'resuming from pause reports separately');
  frontend.enter();
  assert.equal(frontend.visible, false);
});

test('frontend suspend is inert before the game is ready', () => {
  const frontend = new Frontend();
  assert.equal(frontend.suspend(), false);
  assert.equal(frontend.screen, 'loading');

  frontend.setReady();
  assert.equal(frontend.suspend(), false, 'nothing to pause until play has started');
  assert.equal(frontend.screen, 'title');
});

test('frontend failure is terminal and reports its message', () => {
  const frontend = new Frontend();
  frontend.progress('render', { loaded: 5, total: 10 });
  frontend.fail('nav hints HTTP 404');

  assert.equal(frontend.screen, 'error');
  assert.equal(frontend.message, 'nav hints HTTP 404');
  assert.equal(frontend.visible, true);
  assert.equal(frontend.ready, false);

  frontend.setReady(['WASD move']);
  assert.equal(frontend.screen, 'error', 'a late success cannot clear a failure');
  frontend.progress('render', { loaded: 10, total: 10 });
  assert.equal(frontend.getState().percent, 50, 'progress stops once loading is over');
});
