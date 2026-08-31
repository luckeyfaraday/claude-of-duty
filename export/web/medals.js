// Medal award logic for the player, fed by `ui/medals/medals.json` (generated
// from the game's own `mp/scoreinfo.csv` by `.tools/export_medals.py`). Like
// `free-for-all-match.js` this module holds no DOM and no clock of its own, so
// the whole behaviour tests in node with an injected `now`.

// The multikill window the shipped game feels like: chained kills inside it
// climb Double -> Triple -> Fury -> Frenzy -> Super -> Mega -> Ultra -> Kill
// Chain; a slower kill starts a new chain at one.
const DEFAULT_MULTIKILL_WINDOW_MS = 4200;

const sizePattern = /^(multikill|killstreak)_(\d+)$/;
const moreThanPattern = /^(multikill|killstreak)_more_than_(\d+)$/;

function parseDefinitions(defs) {
  const tables = {
    multikill: new Map(),
    multikillMoreThan: new Map(),
    killstreak: new Map(),
    killstreakMoreThan: new Map(),
  };
  const byRef = new Map();
  for (const def of Array.isArray(defs) ? defs : []) {
    if (!def || typeof def.ref !== 'string') continue;
    byRef.set(def.ref, def);
    const size = sizePattern.exec(def.ref);
    if (size) tables[`${size[1]}`].set(Number(size[2]), def);
    const more = moreThanPattern.exec(def.ref);
    if (more) tables[`${more[1]}MoreThan`].set(Number(more[2]), def);
  }
  return { tables, byRef };
}

export class MedalTracker {
  constructor({ defs = [], now = () => performance.now(), multikillWindowMs } = {}) {
    this.now = now;
    const window = Number(multikillWindowMs);
    this.multikillWindowMs = Number.isFinite(window) && window >= 0
      ? window
      : DEFAULT_MULTIKILL_WINDOW_MS;
    this.defs = parseDefinitions(defs);
    this.reset();
  }

  /** Definition lookup by scoreinfo reference, for debug grants. */
  def(ref) {
    return this.defs.byRef.get(String(ref)) ?? null;
  }

  /** Exact multikill medal for a chain length, if the data defines one. */
  multikillFor(chain) {
    if (chain < 2) return null;
    const exact = this.defs.tables.multikill.get(Math.min(chain, 8));
    if (chain > 8) {
      const chainMedal = this.defs.tables.multikillMoreThan.get(8);
      if (chainMedal) return chainMedal;
    }
    return exact ?? null;
  }

  /**
   * Killstreak medals newly crossed by this streak, highest first. Thresholds
   * are read from the data (5 Bloodthirsty, 10 Merciless, ... 30 Nuclear) and
   * each is awarded at most once per life, the way the game latches them.
   */
  killstreaksFor(streak) {
    const earned = [];
    for (const threshold of this.defs.tables.killstreak.keys()) {
      if (streak >= threshold && !this.awardedStreaks.has(threshold)) {
        this.awardedStreaks.add(threshold);
        earned.push(this.defs.tables.killstreak.get(threshold));
      }
    }
    for (const [threshold, def] of this.defs.tables.killstreakMoreThan) {
      if (streak > threshold && !this.awardedStreaks.has(`>${threshold}`)) {
        this.awardedStreaks.add(`>${threshold}`);
        earned.push(def);
      }
    }
    return earned;
  }

  /**
   * Count a player kill. Extends the multikill chain when it lands inside the
   * window, bumps the streak, and returns the definitions earned by this
   * particular kill (possibly several, usually none).
   */
  onKill() {
    const at = this.now();
    this.chain = at - this.lastKillAt <= this.multikillWindowMs ? this.chain + 1 : 1;
    this.lastKillAt = at;
    this.streak += 1;
    this.killCount += 1;

    const earned = [];
    const multikill = this.multikillFor(this.chain);
    if (multikill) earned.push(multikill);
    earned.push(...this.killstreaksFor(this.streak));
    if (earned.length) this.noteEarned(earned, at);
    return earned;
  }

  /** The player died: the streak and its latched medals start over. */
  onDeath() {
    this.streak = 0;
    this.chain = 0;
    this.lastKillAt = Number.NEGATIVE_INFINITY;
    this.awardedStreaks.clear();
  }

  /** Full reset, as a match restart wants it. */
  reset() {
    this.streak = 0;
    this.chain = 0;
    this.killCount = 0;
    this.lastKillAt = Number.NEGATIVE_INFINITY;
    this.awardedStreaks = new Set();
    this.earnedTotal = 0;
    this.recent = [];
  }

  noteEarned(defs, at = this.now()) {
    for (const def of defs) {
      this.earnedTotal += 1;
      this.recent.unshift({ ref: def.ref, name: def.name ?? null, at });
    }
    this.recent.length = Math.min(this.recent.length, 8);
  }

  getState() {
    return {
      multikillWindowMs: this.multikillWindowMs,
      streak: this.streak,
      chain: this.chain,
      killCount: this.killCount,
      earnedTotal: this.earnedTotal,
      recent: this.recent.map((entry) => ({ ...entry })),
    };
  }
}

export default MedalTracker;
