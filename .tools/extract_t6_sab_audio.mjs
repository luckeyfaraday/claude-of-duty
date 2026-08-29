import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const T6_MAGIC = 0x23585532;
const T6_VERSION = 14;
const ENTRY_SIZE = 20;
const HEADER_SIZE = 0x40;
const SAMPLE_RATES = [8000, 12000, 16000, 24000, 32000, 44100, 48000, 96000];

function parseIdentifier(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 0);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new Error(`Invalid 32-bit sound identifier: ${value}`);
  }
  return parsed >>> 0;
}

export function findT6SabEntry(bankPath, identifier) {
  const id = parseIdentifier(identifier);
  const handle = fs.openSync(bankPath, 'r');
  try {
    const header = Buffer.alloc(HEADER_SIZE);
    if (fs.readSync(handle, header, 0, header.length, 0) !== header.length) {
      throw new Error(`${bankPath} is too small to be a T6 SAB bank`);
    }
    const magic = header.readUInt32LE(0);
    const version = header.readUInt32LE(4);
    const entrySize = header.readUInt32LE(8);
    const entryCount = header.readUInt32LE(20);
    const tableOffset = Number(header.readBigUInt64LE(40));
    if (magic !== T6_MAGIC || version !== T6_VERSION || entrySize !== ENTRY_SIZE) {
      throw new Error(
        `Unsupported SAB header (magic=0x${magic.toString(16)}, version=${version}, entrySize=${entrySize})`,
      );
    }

    const table = Buffer.alloc(entryCount * ENTRY_SIZE);
    if (fs.readSync(handle, table, 0, table.length, tableOffset) !== table.length) {
      throw new Error(`${bankPath} has a truncated entry table`);
    }

    for (let index = 0; index < entryCount; index += 1) {
      const base = index * ENTRY_SIZE;
      if (table.readUInt32LE(base) !== id) continue;
      const rateFlag = table.readUInt8(base + 16);
      const entry = {
        id,
        index,
        size: table.readUInt32LE(base + 4),
        offset: table.readUInt32LE(base + 8),
        samples: table.readUInt32LE(base + 12),
        sampleRate: SAMPLE_RATES[rateFlag],
        channels: table.readUInt8(base + 17),
        loop: table.readUInt8(base + 18),
        format: table.readUInt8(base + 19),
      };
      if (!entry.sampleRate) throw new Error(`Unsupported SAB sample-rate flag ${rateFlag}`);
      if (entry.format !== 0) throw new Error(`Sound 0x${id.toString(16)} is not PCM16 (format ${entry.format})`);
      if (![1, 2].includes(entry.channels)) throw new Error(`Unsupported channel count ${entry.channels}`);
      if (entry.size !== entry.samples * entry.channels * 2) {
        throw new Error(`PCM size mismatch for sound 0x${id.toString(16)}`);
      }
      return entry;
    }
    throw new Error(`Sound 0x${id.toString(16).padStart(8, '0')} was not found in ${bankPath}`);
  } finally {
    fs.closeSync(handle);
  }
}

function makePcm16WavHeader(dataSize, sampleRate, channels) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(dataSize + 36, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return header;
}

export function extractT6SabPcm16(bankPath, identifier, outputPath) {
  const entry = findT6SabEntry(bankPath, identifier);
  const handle = fs.openSync(bankPath, 'r');
  const pcm = Buffer.alloc(entry.size);
  try {
    if (fs.readSync(handle, pcm, 0, pcm.length, entry.offset) !== pcm.length) {
      throw new Error(`Sound data for 0x${entry.id.toString(16)} is truncated`);
    }
  } finally {
    fs.closeSync(handle);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.concat([
    makePcm16WavHeader(pcm.length, entry.sampleRate, entry.channels),
    pcm,
  ]));
  return entry;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  if (process.argv.length !== 5) {
    console.error('Usage: node .tools/extract_t6_sab_audio.mjs <bank.sabl> <0xID> <output.wav>');
    process.exitCode = 1;
  } else {
    const entry = extractT6SabPcm16(process.argv[2], process.argv[3], process.argv[4]);
    console.log(
      `Extracted 0x${entry.id.toString(16).padStart(8, '0')} (${entry.channels}ch, ${entry.sampleRate}Hz, ${entry.samples} samples) to ${process.argv[4]}`,
    );
  }
}
