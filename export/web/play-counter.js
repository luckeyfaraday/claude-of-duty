/**
 * Title-screen play counter.
 *
 * Two numbers, from `netlify/functions/plays.mjs`: how many browsers have ever
 * started a match, and how many sessions have. A play is recorded when the
 * game actually starts -- pointer lock granted -- not when the page loads, so
 * link scrapers, bounced tabs and the social-card crawlers never reach it.
 *
 * The counter is decoration. Every path through it swallows its own failure:
 * an offline player, a blocked request, or the plain static dev server from
 * the README -- which has no function and simply 404s -- leaves the line blank
 * rather than breaking the frontend. There is deliberately no "am I in
 * production" check: `netlify dev` serves the function against a local blob
 * store of its own, so running it locally is both testable and harmless.
 *
 * Like `frontend.js` this holds no DOM, so the whole thing tests in node with
 * a fake `fetch` and a fake `storage`.
 */

// Written the first time a browser starts a match. Its presence is the only
// thing separating a returning player from a new one, so clearing site data
// counts you again -- unavoidable without asking anonymous players to sign in.
const STORAGE_KEY = 'vibeslops:player';

function totalsFrom(data) {
  const count = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  };
  return { players: count(data?.players), plays: count(data?.plays) };
}

const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

export class PlayCounter {
  constructor({ endpoint = '/api/plays', storage = null, fetch: fetchImpl = null } = {}) {
    this.endpoint = endpoint;
    this.storage = storage;
    this.fetch = fetchImpl;
    this.totals = null;
    this.recorded = false;
  }

  /** True if this browser has started a match before. */
  get returning() {
    try {
      // Safari with storage blocked throws on access rather than returning
      // null, which would otherwise take the frontend down with it.
      return this.storage?.getItem(STORAGE_KEY) != null;
    } catch {
      return false;
    }
  }

  mark() {
    try {
      this.storage?.setItem(STORAGE_KEY, new Date().toISOString());
    } catch {
      // Nothing to do -- they simply count as new again next time.
    }
  }

  /** The line to show, or '' when there is nothing worth showing. */
  get text() {
    if (!this.totals) return '';
    return `${plural(this.totals.players, 'player')} · ${plural(this.totals.plays, 'play')}`;
  }

  async request(options) {
    if (typeof this.fetch !== 'function') return null;
    try {
      const response = await this.fetch(this.endpoint, options);
      if (!response?.ok) return null;
      return totalsFrom(await response.json());
    } catch {
      return null;
    }
  }

  /** Read the totals for display, without counting anything. */
  async load() {
    const totals = await this.request({ method: 'GET', headers: { accept: 'application/json' } });
    // A player who clicks straight through a slow title screen can have their
    // play counted before this lands. It is then a snapshot from before the
    // increment, and adopting it would walk the number back by one.
    if (totals && !this.recorded) this.totals = totals;
    return this.totals;
  }

  /**
   * Count this session, once. Resuming from the pause menu re-enters the game
   * and would otherwise count again, so the first call latches.
   */
  async record() {
    if (this.recorded) return this.totals;
    this.recorded = true;

    const newPlayer = !this.returning;
    const totals = await this.request({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newPlayer }),
    });
    if (totals) this.totals = totals;
    // Only mark once the server has actually banked it, or a failed request
    // would retire a player who was never counted.
    if (totals && newPlayer) this.mark();
    return totals;
  }
}
