import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { extractT6SabPcm16, findT6SabEntry } from '../.tools/extract_t6_sab_audio.mjs';

const bank = path.resolve('sound/cmn_root.all.sabl');
const sourceBank = {
  skip: fs.existsSync(bank) ? false : 'requires a local T6 common sound bank dump',
};

test('finds the authentic M27 player-shot entry in the T6 common bank', sourceBank, () => {
  const entry = findT6SabEntry(bank, 0x31b17f1b);
  assert.deepEqual(
    {
      size: entry.size,
      samples: entry.samples,
      sampleRate: entry.sampleRate,
      channels: entry.channels,
      format: entry.format,
    },
    { size: 216116, samples: 54029, sampleRate: 48000, channels: 2, format: 0 },
  );
});

test('wraps T6 PCM16 sound data in a browser-decodable WAV container', sourceBank, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't6-sab-'));
  const output = path.join(directory, 'm27.wav');
  try {
    const entry = extractT6SabPcm16(bank, 0x31b17f1b, output);
    const wav = fs.readFileSync(output);
    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
    assert.equal(wav.readUInt16LE(22), 2);
    assert.equal(wav.readUInt32LE(24), 48000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), entry.size);
    assert.equal(wav.length, entry.size + 44);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
