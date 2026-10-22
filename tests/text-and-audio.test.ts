import { describe, expect, it } from 'vitest';
import { INLINE_TAG_MAX, speechText } from '../src/speech-text.ts';
import { parseWavHeader, pcmChunks, STREAMING_MODE, ttsBody } from '../src/synth.ts';
import { applyGain, upmix } from '../src/player.ts';

describe('speechText', () => {
  it('drops the bubble markup the pet parses as actions', () => {
    expect(speechText('【开心, 挥手】今天也辛苦啦!<眨眼>要不要歇一会儿?')).toBe('今天也辛苦啦!要不要歇一会儿?');
  });

  it('reads angle brackets the pet would print as text', () => {
    const long = `<${'字'.repeat(INLINE_TAG_MAX + 1)}>`;
    expect(speechText(`a ${long} b`)).toBe(`a ${long} b`);
    expect(speechText('1 < 2 and 3 > 2\n<x\ny>')).toContain('<x');
  });
});

/** 44 字节的单声道 PCM16 头，数据长度字段写 0(流式回应就是这样)。 */
function header(rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
  return h;
}

async function* parts(buf: Buffer, sizes: number[]): AsyncGenerator<Uint8Array> {
  let at = 0;
  for (const n of sizes) { yield buf.subarray(at, at + n); at += n; }
  if (at < buf.length) yield buf.subarray(at);
}

describe('ttsBody', () => {
  const base = { text: '你好。', refAudio: 'main.wav', refText: '你好', speed: 1 };

  it('sends an empty aux list so api_v2 keeps the single-reference path', () => {
    expect(ttsBody(base).aux_ref_audio_paths).toEqual([]);
  });

  it('passes the auxiliary reference through when one is set', () => {
    expect(ttsBody({ ...base, auxRefs: ['aux.wav'] }).aux_ref_audio_paths).toEqual(['aux.wav']);
  });

  it('keeps the speed factor and the streaming tier', () => {
    const body = ttsBody({ ...base, speed: 1.2 });
    expect(body.speed_factor).toBe(1.2);
    expect(body.streaming_mode).toBe(STREAMING_MODE);
    expect(body.ref_audio_path).toBe('main.wav');
  });
});

describe('pcmChunks', () => {
  it('keeps samples whole when the header and samples split at odd offsets', async () => {
    const samples = Int16Array.from({ length: 50 }, (_, i) => i * 1000 - 25000);
    const body = Buffer.concat([header(48000), Buffer.from(samples.buffer)]);
    const got: Buffer[] = [];
    for await (const c of pcmChunks(parts(body, [10, 37, 3, 9, 1]))) {
      expect(c.sampleRate).toBe(48000);
      expect(c.pcm.length % 2).toBe(0);
      got.push(c.pcm);
    }
    const all = Buffer.concat(got);
    expect(Array.from(new Int16Array(all.buffer, all.byteOffset, all.length / 2))).toEqual(Array.from(samples));
  });

  it('reads the data offset past extra chunks', () => {
    const h = header(32000);
    const list = Buffer.alloc(12); list.write('LIST', 0); list.writeUInt32LE(4, 4);
    const withList = Buffer.concat([h.subarray(0, 36), list, h.subarray(36)]);
    expect(parseWavHeader(withList)).toEqual({ sampleRate: 32000, channels: 1, dataStart: 56 });
  });
});

describe('applyGain', () => {
  it('stays inside the 16-bit range at full-scale input', () => {
    const pcm = Buffer.from(Int16Array.from([32767, -32768, 12000, -12000, 100]).buffer);
    const out = applyGain(pcm, 8);
    const v = Array.from(new Int16Array(out.buffer, out.byteOffset, 5));
    expect(v.every((x) => x >= -32768 && x <= 32767)).toBe(true);
    expect(v[4]).toBe(800);
    expect(v[0]).toBeGreaterThanOrEqual(v[2]!);
    expect(v[2]).toBeGreaterThan(24000);
  });
});

// 单声道流在立体声设备上只进左声道(10-18 操作员听出来的),播放器改为开双声道并复制样本
describe('upmix', () => {
  it('copies every mono sample to both channels in order', () => {
    const out = upmix(Buffer.from(Int16Array.from([1, -2, 300]).buffer), 2);
    expect(Array.from(new Int16Array(out.buffer, out.byteOffset, 6))).toEqual([1, 1, -2, -2, 300, 300]);
  });
});
