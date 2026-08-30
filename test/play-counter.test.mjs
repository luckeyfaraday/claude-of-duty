import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlayCounter } from '../export/web/play-counter.js';
import { increment, totalsFrom } from '../netlify/functions/plays.mjs';

/** In-memory stand-in for localStorage. */
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    size: () => data.size,
  };
}

/** Records every call and replies with whatever the queue holds. */
function fakeFetch(replies) {
  const calls = [];
  const queue = [...replies];
  const fetch = async (url, options) => {
    calls.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
    const reply = queue.shift();
    if (reply instanceof Error) throw reply;
    return {
      ok: reply.ok ?? true,
      json: async () => reply.body,
    };
  };
  fetch.calls = calls;
  return fetch;
}

test('a new browser is counted as both a player and a play', async () => {
  const storage = fakeStorage();
  const fetch = fakeFetch([{ body: { players: 41, plays: 99 } }]);
  const counter = new PlayCounter({ storage, fetch });

  await counter.record();
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].options.method, 'POST');
  assert.deepEqual(fetch.calls[0].body, { newPlayer: true });
  assert.equal(counter.text, '41 players · 99 plays');
  assert.equal(storage.size(), 1, 'the browser is marked so it never counts as new again');
});

test('a returning browser counts a play but not a second player', async () => {
  const storage = fakeStorage({ 'vibeslops:player': '2026-01-01T00:00:00.000Z' });
  const fetch = fakeFetch([{ body: { players: 41, plays: 100 } }]);
  const counter = new PlayCounter({ storage, fetch });

  await counter.record();
  assert.deepEqual(fetch.calls[0].body, { newPlayer: false });
});

test('resuming from the pause menu does not count a second play', async () => {
  const fetch = fakeFetch([{ body: { players: 1, plays: 1 } }]);
  const counter = new PlayCounter({ storage: fakeStorage(), fetch });

  await counter.record();
  await counter.record();
  await counter.record();
  assert.equal(fetch.calls.length, 1, 'the first call latches for the session');
});

test('a failed request leaves the browser countable next time', async () => {
  const storage = fakeStorage();
  const counter = new PlayCounter({ storage, fetch: fakeFetch([new Error('offline')]) });

  assert.equal(await counter.record(), null);
  assert.equal(counter.text, '', 'nothing to show, so the line stays blank');
  assert.equal(storage.size(), 0, 'a player the server never banked must not be retired');
});

test('a rejected response is treated as no answer rather than as totals', async () => {
  const counter = new PlayCounter({
    storage: fakeStorage(),
    fetch: fakeFetch([{ ok: false, body: { error: 'cross-origin' } }]),
  });
  await counter.record();
  assert.equal(counter.text, '');
});

test('storage that throws on access does not take the counter down', async () => {
  const hostile = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  const fetch = fakeFetch([{ body: { players: 5, plays: 5 } }]);
  const counter = new PlayCounter({ storage: hostile, fetch });

  await counter.record();
  assert.deepEqual(fetch.calls[0].body, { newPlayer: true }, 'unreadable storage reads as new');
  assert.equal(counter.text, '5 players · 5 plays');
});

test('load reads the totals without counting anything', async () => {
  const storage = fakeStorage();
  const fetch = fakeFetch([{ body: { players: 1204, plays: 3880 } }]);
  const counter = new PlayCounter({ storage, fetch });

  await counter.load();
  assert.equal(fetch.calls[0].options.method, 'GET');
  assert.equal(counter.text, '1,204 players · 3,880 plays', 'thousands are grouped');
  assert.equal(storage.size(), 0);
});

test('a host with no function behind it leaves the line blank', async () => {
  // The static dev server in the README answers /api/plays with a 404 page.
  const counter = new PlayCounter({
    storage: fakeStorage(),
    fetch: fakeFetch([{ ok: false, body: null }]),
  });
  await counter.load();
  assert.equal(counter.text, '');
});

test('a slow initial read cannot walk the total back after a play lands', async () => {
  // The title-screen GET is still in flight when the player clicks through.
  let releaseGet;
  const pending = new Promise((resolve) => { releaseGet = resolve; });
  const counter = new PlayCounter({
    storage: fakeStorage(),
    fetch: async (_url, options) => {
      if (options.method === 'POST') return { ok: true, json: async () => ({ players: 10, plays: 42 }) };
      await pending;
      return { ok: true, json: async () => ({ players: 9, plays: 41 }) };
    },
  });

  const loading = counter.load();
  await counter.record();
  assert.equal(counter.text, '10 players · 42 plays');

  releaseGet();
  await loading;
  assert.equal(counter.text, '10 players · 42 plays', 'the stale snapshot is dropped');
});

test('one play renders singular', async () => {
  const counter = new PlayCounter({
    storage: fakeStorage(),
    fetch: fakeFetch([{ body: { players: 1, plays: 1 } }]),
  });
  await counter.load();
  assert.equal(counter.text, '1 player · 1 play');
});

// ---------- the function's side ----------

/**
 * Fake Netlify Blobs store with the ETag semantics the real one has, plus a
 * hook to fire a competing write in between a read and its matching write.
 */
function fakeStore({ value = null, etag = null, onRead = null } = {}) {
  const state = { value, etag };
  let reads = 0;
  return {
    state,
    get reads() { return reads; },
    async getWithMetadata() {
      reads += 1;
      // Snapshot first, then let the competing writer land: the whole point is
      // that the caller is holding an ETag the store has already moved past.
      const snapshot = state.value === null ? null : { data: state.value, etag: state.etag };
      onRead?.(state);
      return snapshot;
    },
    async setJSON(_key, next, options = {}) {
      const matches = options.onlyIfNew
        ? state.value === null
        : options.onlyIfMatch === state.etag && state.value !== null;
      if (!matches) return { modified: false };
      state.value = next;
      state.etag = `etag-${Math.random()}`;
      return { modified: true, etag: state.etag };
    },
  };
}

test('the first play ever recorded creates the entry', async () => {
  const store = fakeStore();
  assert.deepEqual(await increment(store, true), { players: 1, plays: 1 });
  assert.deepEqual(store.state.value, { players: 1, plays: 1 });
});

test('a returning player raises plays alone', async () => {
  const store = fakeStore({ value: { players: 7, plays: 20 }, etag: 'a' });
  assert.deepEqual(await increment(store, false), { players: 7, plays: 21 });
});

test('a write that loses a race is retried rather than dropped', async () => {
  // Someone else lands a play between our read and our write, exactly once.
  let interfered = false;
  const store = fakeStore({
    value: { players: 3, plays: 3 },
    etag: 'a',
    onRead: (state) => {
      if (interfered) return;
      interfered = true;
      state.value = { players: 4, plays: 4 };
      state.etag = 'b';
    },
  });

  const totals = await increment(store, true);
  assert.deepEqual(totals, { players: 5, plays: 5 }, 'built on the winner, not on the stale read');
  assert.equal(store.reads, 2, 'the loser re-read instead of overwriting');
});

test('a store that never lets a write land gives up instead of hanging', async () => {
  const store = fakeStore({
    value: { players: 1, plays: 1 },
    etag: 'a',
    // Every read is followed by someone else's write, forever.
    onRead: (state) => { state.etag = `etag-${Math.random()}`; },
  });
  assert.equal(await increment(store, true), null);
});

test('a corrupt or absent entry reads as zero rather than NaN', () => {
  assert.deepEqual(totalsFrom(null), { players: 0, plays: 0 });
  assert.deepEqual(totalsFrom({ players: 'x', plays: -4 }), { players: 0, plays: 0 });
  assert.deepEqual(totalsFrom({ players: 2.7, plays: 9 }), { players: 2, plays: 9 });
});
