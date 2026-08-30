/**
 * The title screen's play counter.
 *
 * Two totals live behind one key: `players`, which the client increments only
 * the first time a given browser starts a match, and `plays`, which it
 * increments every session it starts one. They are kept together so a reader
 * cannot catch the pair mid-update and show more players than plays.
 *
 * Netlify Blobs is the whole backend -- it needs no configuration inside a
 * function, and the free tier is far past anything this site will do.
 */
import { getStore } from '@netlify/blobs';

const KEY = 'totals';

// A conditional write only loses to a genuinely simultaneous one, and the
// loser re-reads immediately, so a short ladder covers far more contention
// than this site will ever see. It is bounded so a pathological run cannot
// hold the function open until the platform kills it.
const ATTEMPTS = 6;

export const config = { path: '/api/plays' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // The point of the thing is a number that moves. Without this the
      // Netlify edge would cache one snapshot and hand it to everybody.
      'cache-control': 'no-store',
    },
  });
}

/**
 * Coerce whatever is in the store into two sane counts.
 *
 * Exported, like `increment`, only so the concurrency behaviour can be tested
 * against a fake store. Netlify reads `default` and `config` and ignores the
 * rest of the module's exports.
 */
export function totalsFrom(data) {
  const count = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  };
  return { players: count(data?.players), plays: count(data?.plays) };
}

/**
 * Increment under optimistic concurrency: read the entry with its ETag, then
 * write back only if nothing else has written since. Blobs has no atomic add,
 * and a plain read-modify-write would drop counts -- two players starting at
 * the same moment would both read N and both store N+1.
 */
export async function increment(store, newPlayer) {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const entry = await store.getWithMetadata(KEY, { type: 'json', consistency: 'strong' });
    const totals = totalsFrom(entry?.data);
    const next = {
      players: totals.players + (newPlayer ? 1 : 0),
      plays: totals.plays + 1,
    };
    // No entry yet means this is the first play ever recorded; `onlyIfNew`
    // makes the racing writers on a cold store behave like any other pair.
    const guard = entry?.etag ? { onlyIfMatch: entry.etag } : { onlyIfNew: true };
    const { modified } = await store.setJSON(KEY, next, guard);
    if (modified) return next;
  }
  return null;
}

export default async (request) => {
  const store = getStore({ name: 'play-counter', consistency: 'strong' });

  if (request.method === 'GET') {
    return json(totalsFrom(await store.get(KEY, { type: 'json', consistency: 'strong' })));
  }

  if (request.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405);
  }

  // A casual guard, not a real one: an Origin header is trivial to forge, so
  // this stops another page driving the counter by embedding ours, and stops
  // nothing else. An anonymous browser game has no identity to check.
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return json({ error: 'cross-origin' }, 403);
  }

  let body = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const totals = await increment(store, body?.newPlayer === true);
  if (!totals) return json({ error: 'contended' }, 503);
  return json(totals);
};
