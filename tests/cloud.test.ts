import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudError, redact, speechUrl, synthCloud, type CloudOptions } from '../src/cloud.ts';
import { wavBytes } from '../src/wav.ts';

const KEY = 'sk-test-1234567890';

const opts = (patch: Partial<CloudOptions> = {}): CloudOptions => ({
  baseUrl: 'https://api.example.com/v1',
  model: 'tts-1',
  voice: 'alloy',
  speed: 1,
  timeoutMs: 60_000,
  key: KEY,
  ...patch,
});

/** 一段 24 kHz 立体声 WAV：左右声道各给一个样本。 */
function stereoWav(samples: Array<[number, number]>): Buffer {
  const pcm = Buffer.alloc(samples.length * 4);
  samples.forEach(([left, right], i) => {
    pcm.writeInt16LE(left, i * 4);
    pcm.writeInt16LE(right, i * 4 + 2);
  });
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(2, 22);
  head.writeUInt32LE(24_000, 24);
  head.writeUInt32LE(24_000 * 4, 28);
  head.writeUInt16LE(4, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

const okWav = (): Buffer => wavBytes(Buffer.alloc(2400 * 2), 24_000);

/** 替换全局 fetch，并记录请求；返回最后一次的调用参数。 */
function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>): ReturnType<typeof vi.fn> {
  const spy = vi.fn(handler);
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('云端接口地址', () => {
  it('基址补成 /audio/speech，末尾斜杠不影响', () => {
    expect(speechUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/audio/speech');
    expect(speechUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/audio/speech');
    expect(speechUrl('  https://api.openai.com/v1//  ')).toBe('https://api.openai.com/v1/audio/speech');
  });

  it('已经写到端点的地址原样使用（不再叠一层）', () => {
    expect(speechUrl('https://tts.example.com/audio/speech')).toBe('https://tts.example.com/audio/speech');
  });

  it('地址为空是配置错误', () => {
    expect(() => speechUrl('')).toThrow(CloudError);
    try { speechUrl(''); } catch (err) { expect((err as CloudError).kind).toBe('config'); }
  });
});

describe('密钥脱敏', () => {
  it('把文本里出现的密钥全部抹掉', () => {
    expect(redact(`bad key ${KEY}; again ${KEY}`, KEY)).toBe('bad key [redacted]; again [redacted]');
  });

  it('没有密钥时原样返回（避免把空串塞进 split 后每个字符都变标记）', () => {
    const text = 'plain message';
    expect(redact(text, '')).toBe(text);
  });
});

describe('云端合成', () => {
  it('请求带 model / voice / input 与 response_format=wav，返回 PCM 与采样率', async () => {
    const spy = stubFetch(async () => new Response(new Uint8Array(okWav()), { status: 200 }));
    const audio = await synthCloud('念这一句', opts());
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/audio/speech');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'tts-1', voice: 'alloy', input: '念这一句', response_format: 'wav', speed: 1 });
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(audio.sampleRate).toBe(24_000);
    expect(audio.pcm.length).toBe(2400 * 2);
    expect(audio.wav.length).toBe(2400 * 2 + 44);
    expect(audio.ms).toBeGreaterThanOrEqual(0);
  });

  it('厂商回了立体声就降成单声道（播放器只吃单声道）', async () => {
    stubFetch(async () => new Response(new Uint8Array(stereoWav([[1000, -1000], [3000, 3000]]))));
    const audio = await synthCloud('念这一句', opts());
    expect(audio.sampleRate).toBe(24_000);
    expect(audio.pcm.length).toBe(4);
    expect(audio.pcm.readInt16LE(0)).toBe(0);
    expect(audio.pcm.readInt16LE(2)).toBe(3000);
  });

  it('模型名留空时回落到 tts-1', async () => {
    const spy = stubFetch(async () => new Response(new Uint8Array(okWav())));
    await synthCloud('念这一句', opts({ model: '  ' }));
    const body = JSON.parse(String((spy.mock.calls[0] as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body.model).toBe('tts-1');
  });

  it('没填密钥/音色直接按配置错误拦下，不发请求', async () => {
    const spy = stubFetch(async () => new Response(new Uint8Array(okWav())));
    await expect(synthCloud('念这一句', opts({ key: '' }))).rejects.toMatchObject({ kind: 'config' });
    await expect(synthCloud('念这一句', opts({ voice: ' ' }))).rejects.toMatchObject({ kind: 'config' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('401/403 是鉴权错误，错误文本里不留密钥', async () => {
    const spy = stubFetch(async () => new Response(
      JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ));
    const err = await synthCloud('念这一句', opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudError);
    expect((err as CloudError).kind).toBe('auth');
    expect((err as CloudError).message).toContain('[redacted]');
    expect((err as CloudError).message).not.toContain(KEY);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('402 是额度不足、429 是限流、500 是普通失败', async () => {
    for (const [status, kind] of [[402, 'quota'], [429, 'rate'], [500, 'failed']] as const) {
      stubFetch(async () => new Response('{"error":{"message":"nope"}}', { status }));
      const err = await synthCloud('念这一句', opts()).catch((e: unknown) => e);
      expect((err as CloudError).kind).toBe(kind);
    }
  });

  it('不是 WAV 就明确报错（厂商常常默认回 mp3）', async () => {
    stubFetch(async () => new Response(new Uint8Array(Buffer.from('ID3 mp3 bytes'))));
    await expect(synthCloud('念这一句', opts())).rejects.toMatchObject({ kind: 'bad-audio' });
  });

  it('WAV 头合法但音频为空也算坏音频', async () => {
    stubFetch(async () => new Response(new Uint8Array(wavBytes(Buffer.alloc(0), 24_000))));
    await expect(synthCloud('念这一句', opts())).rejects.toMatchObject({ kind: 'bad-audio' });
  });

  it('DNS 失败与连接被拒归到网络错误', async () => {
    stubFetch(async () => { throw new Error('getaddrinfo ENOTFOUND api.example.com'); });
    await expect(synthCloud('念这一句', opts())).rejects.toMatchObject({ kind: 'network' });
    stubFetch(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:443'); });
    const err = await synthCloud('念这一句', opts()).catch((e: unknown) => e);
    expect((err as CloudError).kind).toBe('network');
    expect((err as CloudError).message).toContain('连不上云端');
  });
});
