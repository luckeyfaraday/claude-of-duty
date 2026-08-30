import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FreeForAllMatch } from '../export/web/free-for-all-match.js';

test('FFA records kills, deaths, streaks, placement, and feed events', () => {
  const match = new FreeForAllMatch({ scoreLimit: 3, timeLimitSeconds: 60 });
  match.register('player', 'You', { human: true });
  match.register('bot-0', 'Admiral');
  match.recordKill('player', 'bot-0');
  match.recordKill('player', 'bot-0');

  const state = match.getState();
  assert.equal(state.standings[0].id, 'player');
  assert.equal(state.standings[0].kills, 2);
  assert.equal(state.standings[1].deaths, 2);
  assert.equal(state.feed[0].killer, 'You');
});

test('FFA ends at the score limit or when time expires', () => {
  const scoreMatch = new FreeForAllMatch({ scoreLimit: 1 });
  scoreMatch.register('a', 'A');
  scoreMatch.register('b', 'B');
  scoreMatch.recordKill('a', 'b');
  assert.equal(scoreMatch.phase, 'ended');
  assert.equal(scoreMatch.winnerId, 'a');

  const timed = new FreeForAllMatch({ timeLimitSeconds: 1 });
  timed.register('a', 'A');
  timed.register('b', 'B');
  timed.recordKill('b', 'a');
  for (let i = 0; i < 4; i += 1) timed.update(0.25);
  assert.equal(timed.phase, 'ended');
  assert.equal(timed.winnerId, 'b');
});

test('suicides count as a death without awarding a kill', () => {
  const match = new FreeForAllMatch();
  match.register('player', 'You');
  match.recordKill('player', 'player');
  const player = match.getState().standings[0];
  assert.equal(player.kills, 0);
  assert.equal(player.deaths, 1);
});
