// T6 xanims carry their audio and rumble cues as notetracks rather than in the
// weapon definition, so the reload's sound timing is authored data that ships
// with the clip. `.tools/xanim_to_json.mjs` preserves them as `notifies`.
//
//   sndnt#fly_hk416_mag_out   sound cue
//   rmbnt#reload_large        controller rumble cue

const PREFIX_TYPES = {
  'sndnt#': 'sound',
  'rmbnt#': 'rumble',
};

export function parseNotetracks(notifies = []) {
  return (Array.isArray(notifies) ? notifies : [])
    .map((notify) => {
      const raw = String(notify?.name ?? '');
      const separator = raw.indexOf('#');
      const prefix = separator >= 0 ? raw.slice(0, separator + 1) : '';
      return {
        type: PREFIX_TYPES[prefix] ?? 'other',
        name: separator >= 0 ? raw.slice(separator + 1) : raw,
        time: Number(notify?.time) || 0,
      };
    })
    .sort((a, b) => a.time - b.time);
}

// Fires cues as an action's playhead passes them. Driven from the mixer's own
// time rather than accumulated deltas, so a clip that is restarted, clamped, or
// interrupted stays in sync instead of drifting away from the animation.
export class NotetrackTimeline {
  constructor(events = []) {
    this.events = [...events].sort((a, b) => a.time - b.time);
    this.cursor = 0;
    this.lastTime = 0;
  }

  reset() {
    this.cursor = 0;
    this.lastTime = 0;
  }

  // Returns every cue between the previous call and `time`. Time moving
  // backwards means the clip restarted, so the cursor rewinds with it.
  advance(time) {
    const now = Number(time) || 0;
    if (now < this.lastTime) this.reset();
    this.lastTime = now;
    const fired = [];
    while (this.cursor < this.events.length && this.events[this.cursor].time <= now) {
      fired.push(this.events[this.cursor]);
      this.cursor += 1;
    }
    return fired;
  }
}

export default NotetrackTimeline;
