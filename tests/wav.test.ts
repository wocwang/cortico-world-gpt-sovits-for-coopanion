import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSeconds, secondsOf, wavBytes } from '../src/wav.ts';

/** 一份 PCM16 WAV；`declared` 可以覆盖 `data` 长度字段(流式写的文件是 0)。 */
function wav(rate: number, channels: number, seconds: number, declared?: number): Buffer {
  const bits = 16;
  const byteRate = rate * channels * bits / 8;
  const dataSize = Math.round(byteRate * seconds);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(byteRate, 28); buf.writeUInt16LE(channels * bits / 8, 32); buf.writeUInt16LE(bits, 34);
  buf.write('data', 36); buf.writeUInt32LE(declared ?? dataSize, 40);
  return buf;
}

describe('secondsOf', () => {
  it('reads the duration from sample rate and data size', () => {
    expect(secondsOf(wav(16000, 1, 3), wav(16000, 1, 3).length)).toBeCloseTo(3, 3);
    expect(secondsOf(wav(44100, 2, 5), wav(44100, 2, 5).length)).toBeCloseTo(5, 3);
  });

  it('falls back to the file size when the data length field is 0', () => {
    const buf = wav(32000, 1, 4, 0);
    expect(secondsOf(buf, buf.length)).toBeCloseTo(4, 3);
  });

  it('returns null for something that is not a WAV', () => {
    expect(secondsOf(Buffer.from('ID3\u0004not a wave file at all'), 30)).toBeNull();
    expect(secondsOf(Buffer.alloc(0), 0)).toBeNull();
  });

  it('returns null when the header stops before the data chunk', () => {
    const buf = wav(16000, 1, 3);
    expect(secondsOf(buf.subarray(0, 30), buf.length)).toBeNull();
  });

  it('returns null when fmt is missing, so there is no byte rate', () => {
    const buf = wav(16000, 1, 3);
    buf.write('junk', 12); // 顶掉 fmt 块
    expect(secondsOf(buf, buf.length)).toBeNull();
  });
});

describe('wavBytes', () => {
  it('wraps mono PCM16 into a WAV the same reader understands', () => {
    const pcm = Buffer.from(Int16Array.from([1, -2, 3]).buffer);
    const out = wavBytes(pcm, 32000);
    expect(out.length).toBe(44 + pcm.length);
    expect(out.toString('ascii', 0, 4)).toBe('RIFF');
    expect(out.toString('ascii', 8, 12)).toBe('WAVE');
    expect(out.readUInt16LE(22)).toBe(1);
    expect(out.readUInt32LE(24)).toBe(32000);
    expect(out.readUInt32LE(40)).toBe(pcm.length);
    expect(secondsOf(out, out.length)).toBeCloseTo(pcm.length / 64000, 5);
  });
});

describe('readSeconds', () => {
  it('measures a real file on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsv-wav-'));
    const file = join(dir, 'ref.wav');
    try {
      writeFileSync(file, wav(32000, 1, 5));
      expect(readSeconds(file)).toBeCloseTo(5, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a file that is not a WAV', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsv-wav-'));
    const file = join(dir, 'ref.txt');
    try {
      writeFileSync(file, 'not a wave');
      expect(readSeconds(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the shipped preset references inside the 3–10 s window', () => {
    for (const name of ['dfy.zh.wav', 'dfy.en.wav', 'xll.zh.wav', 'xll.en.wav']) {
      const seconds = readSeconds(join(process.cwd(), 'assets', 'voices', name));
      expect(seconds).not.toBeNull();
      expect(seconds!).toBeGreaterThanOrEqual(3);
      expect(seconds!).toBeLessThanOrEqual(10);
    }
  });
});
