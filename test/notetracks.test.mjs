import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { parseNotetracks, NotetrackTimeline } from '../export/web/notetracks.js';

test('splits notetrack cues into their authored type and name', () => {
  const events = parseNotetracks([
    { name: 'rmbnt#reload_large', time: 1.4333 },
    { name: 'sndnt#fly_hk416_mag_out', time: 0.4667 },
    { name: 'bare_cue', time: 0.1 },
  ]);
  assert.deepEqual(events, [
    { type: 'other', name: 'bare_cue', time: 0.1 },
    { type: 'sound', name: 'fly_hk416_mag_out', time: 0.4667 },
    { type: 'rumble', name: 'reload_large', time: 1.4333 },
  ]);
});

test('tolerates clips that carry no notetracks', () => {
  assert.deepEqual(parseNotetracks(), []);
  assert.deepEqual(parseNotetracks([]), []);
  assert.deepEqual(new NotetrackTimeline().advance(5), []);
});

test('fires each cue once as the playhead passes it', () => {
  const timeline = new NotetrackTimeline(parseNotetracks([
    { name: 'sndnt#a', time: 0.1 },
    { name: 'sndnt#b', time: 0.2 },
  ]));
  assert.deepEqual(timeline.advance(0.05).map((e) => e.name), []);
  assert.deepEqual(timeline.advance(0.15).map((e) => e.name), ['a']);
  assert.deepEqual(timeline.advance(0.15).map((e) => e.name), [], 'a cue must not repeat');
  assert.deepEqual(timeline.advance(0.25).map((e) => e.name), ['b']);
});

test('a long frame delivers every cue it skipped over', () => {
  const timeline = new NotetrackTimeline(parseNotetracks([
    { name: 'sndnt#a', time: 0.1 },
    { name: 'sndnt#b', time: 0.2 },
    { name: 'sndnt#c', time: 0.3 },
  ]));
  assert.deepEqual(timeline.advance(0.9).map((e) => e.name), ['a', 'b', 'c']);
});

test('a restarted clip replays its cues from the top', () => {
  const timeline = new NotetrackTimeline(parseNotetracks([{ name: 'sndnt#a', time: 0.1 }]));
  assert.deepEqual(timeline.advance(0.5).map((e) => e.name), ['a']);
  // The mixer rewinds an action rather than creating a new one, so time going
  // backwards is the only signal that the reload started again.
  assert.deepEqual(timeline.advance(0.05).map((e) => e.name), []);
  assert.deepEqual(timeline.advance(0.2).map((e) => e.name), ['a']);
});

test('the exported reload clips carry the authored M27 audio cues', () => {
  const reload = JSON.parse(fs.readFileSync('export/web/viewmodel/anims/viewmodel_hk416_reload.json', 'utf8'));
  const empty = JSON.parse(fs.readFileSync('export/web/viewmodel/anims/viewmodel_hk416_reload_empty.json', 'utf8'));

  const sounds = (data) => parseNotetracks(data.notifies)
    .filter((e) => e.type === 'sound')
    .map((e) => [e.name, Number(e.time.toFixed(4))]);

  assert.deepEqual(sounds(reload), [
    ['fly_reload_cloth_sm', 0.0333],
    ['fly_hk416_mag_out', 0.4667],
    ['fly_hk416_futz', 1.3],
    ['fly_hk416_mag_in', 1.4],
  ]);
  // The empty reload continues past the magazine change into the bolt.
  assert.deepEqual(sounds(empty).slice(4), [
    ['fly_hk416_bolt_back', 2],
    ['fly_hk416_bolt_release', 2.1667],
  ]);
  assert.ok(empty.duration >= 2.1667, 'cues must fall inside the clip');
});

test('every cue the reload clips fire has a shipped audio file', async () => {
  const { FOLEY_ALIASES, FOLEY_URLS, SILENT_CUES } = await import('../export/web/weapon-effects.js');
  const cues = new Set();
  for (const name of [
    'viewmodel_hk416_reload',
    'viewmodel_hk416_reload_empty',
    'viewmodel_an94_reload',
    'viewmodel_an94_reload_empty',
  ]) {
    const data = JSON.parse(fs.readFileSync(`export/web/viewmodel/anims/${name}.json`, 'utf8'));
    for (const cue of parseNotetracks(data.notifies)) if (cue.type === 'sound') cues.add(cue.name);
  }
  for (const cue of cues) {
    // No soundbank maps `fly_<gun>_futz`, so it is silent in T6 too and must
    // not acquire an invented sample here.
    if (SILENT_CUES.has(cue)) {
      assert.equal(FOLEY_URLS[cue], undefined, `${cue} is unmapped in the game and should ship no sample`);
      continue;
    }
    const resolved = FOLEY_ALIASES[cue] ?? cue;
    assert.ok(FOLEY_URLS[resolved], `cue ${cue} has no mapped audio file`);
    // Randomized cues carry a variant list; every variant must be a real WAV.
    for (const url of [FOLEY_URLS[resolved]].flat()) {
      const file = `export/web/${url.replace(/^\.\//, '')}`;
      assert.ok(fs.existsSync(file), `${file} is missing`);
      assert.equal(fs.readFileSync(file).subarray(0, 4).toString('ascii'), 'RIFF', `${file} is not a WAV`);
    }
  }
});
