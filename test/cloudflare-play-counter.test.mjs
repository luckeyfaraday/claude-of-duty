import assert from 'node:assert/strict';
import test from 'node:test';

import {
  counterDatabase,
  increment,
  onRequest,
  totalsFrom,
} from '../functions/api/plays.js';

class FakeStatement {
  constructor(database, query) {
    this.database = database;
    this.query = query;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    if (this.query.includes('UPDATE play_totals')) {
      this.database.totals.players += this.values[0];
      this.database.totals.plays += 1;
    }
    return { ...this.database.totals };
  }
}

class FakeDatabase {
  constructor(players = 0, plays = 0) {
    this.totals = { players, plays };
  }

  prepare(query) {
    return new FakeStatement(this, query);
  }
}

function environment(branch = 'preview') {
  return {
    CF_PAGES_BRANCH: branch,
    PLAY_COUNTER: new FakeDatabase(7, 11),
    PLAY_COUNTER_PREVIEW: new FakeDatabase(2, 3),
  };
}

test('totalsFrom sanitizes persisted values', () => {
  assert.deepEqual(totalsFrom({ players: '4.9', plays: -2 }), { players: 4, plays: 0 });
  assert.deepEqual(totalsFrom(null), { players: 0, plays: 0 });
});

test('counterDatabase keeps previews out of production totals', () => {
  const env = environment('feature-branch');
  assert.equal(counterDatabase(env), env.PLAY_COUNTER_PREVIEW);
  env.CF_PAGES_BRANCH = 'main';
  assert.equal(counterDatabase(env), env.PLAY_COUNTER);
});

test('increment atomically advances plays and optionally players', async () => {
  const database = new FakeDatabase(5, 8);
  assert.deepEqual(await increment(database, true), { players: 6, plays: 9 });
  assert.deepEqual(await increment(database, false), { players: 6, plays: 10 });
});

test('GET reads totals and POST increments the selected database', async () => {
  const env = environment('preview');
  const getResponse = await onRequest({
    request: new Request('https://preview.example/api/plays'),
    env,
  });
  assert.equal(getResponse.status, 200);
  assert.deepEqual(await getResponse.json(), { players: 2, plays: 3 });

  const postResponse = await onRequest({
    request: new Request('https://preview.example/api/plays', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://preview.example' },
      body: JSON.stringify({ newPlayer: true }),
    }),
    env,
  });
  assert.equal(postResponse.status, 200);
  assert.deepEqual(await postResponse.json(), { players: 3, plays: 4 });
  assert.deepEqual(env.PLAY_COUNTER.totals, { players: 7, plays: 11 });
});

test('POST rejects a cross-origin counter increment', async () => {
  const response = await onRequest({
    request: new Request('https://preview.example/api/plays', {
      method: 'POST',
      headers: { origin: 'https://other.example' },
    }),
    env: environment(),
  });
  assert.equal(response.status, 403);
});
