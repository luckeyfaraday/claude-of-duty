const EMPTY_TOTALS = Object.freeze({ players: 0, plays: 0 });

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

export function totalsFrom(data) {
  const count = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  };
  return { players: count(data?.players), plays: count(data?.plays) };
}

export function counterDatabase(env) {
  return env.CF_PAGES_BRANCH === 'main'
    ? env.PLAY_COUNTER
    : env.PLAY_COUNTER_PREVIEW;
}

export async function increment(database, newPlayer) {
  const row = await database.prepare(`
    UPDATE play_totals
       SET players = players + ?1,
           plays = plays + 1
     WHERE id = 1
     RETURNING players, plays
  `).bind(newPlayer ? 1 : 0).first();
  return totalsFrom(row);
}

export async function onRequest({ request, env }) {
  const database = counterDatabase(env);
  if (!database) return json({ error: 'counter unavailable' }, 503);

  try {
    if (request.method === 'GET') {
      const row = await database.prepare(
        'SELECT players, plays FROM play_totals WHERE id = 1',
      ).first();
      return json(row ? totalsFrom(row) : EMPTY_TOTALS);
    }

    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405);
    }

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

    return json(await increment(database, body?.newPlayer === true));
  } catch {
    return json({ error: 'counter unavailable' }, 503);
  }
}
