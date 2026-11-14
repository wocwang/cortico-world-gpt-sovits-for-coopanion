import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CloudError,
  audioKind,
  azureSpeechUrl,
  breezeSpeechUrl,
  elevenLabsSpeechUrl,
  minimaxSpeechUrl,
  redact,
  speechUrl,
  synthCloud,
  type CloudOptions,
} from '../src/cloud.ts';
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

describe('Breeze Blue', () => {
  it('合成端点是 /text-to-speech/{voice_id}，已经写到端点的原样用', () => {
    expect(breezeSpeechUrl('https://api.breeze.blue/v1', 'voc_1')).toBe('https://api.breeze.blue/v1/text-to-speech/voc_1');
    expect(breezeSpeechUrl('https://api.breeze.blue/v1/text-to-speech/voc_1', 'voc_2')).toBe('https://api.breeze.blue/v1/text-to-speech/voc_1');
    expect(() => breezeSpeechUrl('', 'voc_1')).toThrow(CloudError);
  });

  it('用 xi-api-key 与 text 字段请求 WAV；默认模型 tts-1 不发 model_id', async () => {
    const spy = stubFetch(async () => new Response(new Uint8Array(okWav()), { status: 200 }));
    const audio = await synthCloud('你好', opts({ baseUrl: 'https://api.breeze.blue/v1', voice: 'voc_1', model: 'tts-1', language: 'zh' }));
    expect(audio.wav.subarray(0, 4).toString()).toBe('RIFF');
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.breeze.blue/v1/text-to-speech/voc_1?output_format=wav');
    const headers = init.headers as Record<string, string>;
    expect(headers['xi-api-key']).toBe(KEY);
    expect(headers.authorization).toBeUndefined();
    expect(JSON.parse(String(init.body))).toEqual({ text: '你好', language_code: 'zh' });
  });

  it('填了 Breeze 模型就原样送 model_id，语言留空就不发 language_code', async () => {
    const spy = stubFetch(async () => new Response(new Uint8Array(okWav())));
    await synthCloud('hi', opts({ baseUrl: 'https://api.breeze.blue/v1', voice: 'voc_1', model: 'breeze-tts-2', language: '' }));
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ text: 'hi', model_id: 'breeze-tts-2' });
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

describe('厂商端点', () => {
  it('Azure 按区域拼主机，区域为空或含空格都按配置错误', () => {
    expect(azureSpeechUrl('eastasia')).toBe('https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1');
    expect(azureSpeechUrl(' EastUS ')).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');
    expect(() => azureSpeechUrl('')).toThrow(CloudError);
    expect(() => azureSpeechUrl('east us')).toThrow(/区域格式不对/);
  });

  it('MiniMax 从 /v1 补 /t2a_v2，GroupId 走查询参数', () => {
    expect(minimaxSpeechUrl('https://api.minimax.cn/v1')).toBe('https://api.minimax.cn/v1/t2a_v2');
    expect(minimaxSpeechUrl('https://api.minimax.cn/v1/t2a_v2')).toBe('https://api.minimax.cn/v1/t2a_v2');
    expect(minimaxSpeechUrl('https://api.minimax.cn/v1', ' g1 ')).toBe('https://api.minimax.cn/v1/t2a_v2?GroupId=g1');
  });

  it('ElevenLabs 补 /text-to-speech/{voice}，已写到端点的原样用', () => {
    expect(elevenLabsSpeechUrl('https://api.elevenlabs.io/v1', 'v1')).toBe('https://api.elevenlabs.io/v1/text-to-speech/v1');
    expect(elevenLabsSpeechUrl('https://api.elevenlabs.io/v1/text-to-speech/v0', 'v1'))
      .toBe('https://api.elevenlabs.io/v1/text-to-speech/v0');
  });

  it('按字节判断厂商实际回了什么格式', () => {
    expect(audioKind(okWav())).toBe('WAV');
    expect(audioKind(Buffer.from('ID3xxxx'))).toBe('MP3');
    expect(audioKind(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe('MP3');
    expect(audioKind(Buffer.from('OggS....'))).toBe('OGG');
    expect(audioKind(Buffer.from('not audio'))).toBe('未知格式');
  });
});

describe('Azure 合成', () => {
  it('发 SSML、用订阅密钥头，并按 riff（WAV）索取', async () => {
    const spy = stubFetch(async () => new Response(new Uint8Array(okWav())));
    const audio = await synthCloud('你好 & <世界>', opts({
      provider: 'azure',
      baseUrl: '',
      region: 'eastasia',
      voice: 'zh-CN-YunxiaNeural',
      model: '',
    }));
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1');
    const headers = init.headers as Record<string, string>;
    expect(headers['Ocp-Apim-Subscription-Key']).toBe(KEY);
    expect(headers['X-Microsoft-OutputFormat']).toBe('riff-24khz-16bit-mono-pcm');
    expect(headers['content-type']).toBe('application/ssml+xml');
    expect(headers.authorization).toBeUndefined();
    const body = String(init.body);
    expect(body).toContain('xml:lang="zh-CN"');
    expect(body).toContain('name="zh-CN-YunxiaNeural"');
    expect(body).toContain('你好 &amp; &lt;世界&gt;');
    expect(audio.sampleRate).toBe(24_000);
  });

  it('区域没填或格式不对：配置错误，不发请求', async () => {
    const spy = stubFetch(async () => new Response(new Uint8Array(okWav())));
    await expect(synthCloud('你好', opts({ provider: 'azure', baseUrl: '', region: '' }))).rejects.toMatchObject({ kind: 'config' });
    await expect(synthCloud('你好', opts({ provider: 'azure', baseUrl: '', region: 'east us' }))).rejects.toMatchObject({ kind: 'config' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('MiniMax 合成', () => {
  it('请求体声明 wav + hex，响应里的 hex 解成 WAV 字节', async () => {
    const wav = okWav();
    const spy = stubFetch(async () => new Response(JSON.stringify({
      base_resp: { status_code: 0, status_msg: 'success' },
      data: { audio: wav.toString('hex') },
    })));
    const audio = await synthCloud('你好', opts({
      provider: 'minimax',
      baseUrl: 'https://api.minimax.cn/v1',
      model: 'speech-2.8-turbo',
      voice: 'female-shaonv',
      groupId: 'g1',
    }));
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.minimax.cn/v1/t2a_v2?GroupId=g1');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init.body)) as Record<string, any>;
    expect(body).toMatchObject({ model: 'speech-2.8-turbo', text: '你好', stream: false, output_format: 'hex' });
    expect(body.voice_setting.voice_id).toBe('female-shaonv');
    expect(body.audio_setting).toMatchObject({ format: 'wav', sample_rate: 32000, channel: 1 });
    expect(audio.wav.equals(wav)).toBe(true);
  });

  it('base_resp 非 0 是可见失败，错误里的密钥脱敏', async () => {
    stubFetch(async () => new Response(JSON.stringify({
      base_resp: { status_code: 1004, status_msg: `bad key ${KEY}` },
    })));
    const err = await synthCloud('你好', opts({ provider: 'minimax', baseUrl: 'https://api.minimax.cn/v1', voice: 'female-shaonv' }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudError);
    expect((err as CloudError).kind).toBe('auth');
    expect((err as CloudError).message).toContain('[redacted]');
    expect((err as CloudError).message).not.toContain(KEY);
  });

  it('没有 hex 音频时按坏音频报错', async () => {
    stubFetch(async () => new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: {} })));
    await expect(synthCloud('你好', opts({ provider: 'minimax', baseUrl: 'https://api.minimax.cn/v1', voice: 'female-shaonv' })))
      .rejects.toMatchObject({ kind: 'bad-audio' });
  });
});

describe('ElevenLabs 合成', () => {
  it('用 wav_24000 与 xi-api-key，body 是 text + model_id', async () => {
    const spy = stubFetch(async () => new Response(new Uint8Array(okWav())));
    await synthCloud('hi', opts({
      provider: 'elevenlabs',
      baseUrl: 'https://api.elevenlabs.io/v1',
      voice: 'JBFqnCBsd6RMkjVDRZzb',
      model: 'eleven_multilingual_v2',
    }));
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=wav_24000');
    const headers = init.headers as Record<string, string>;
    expect(headers['xi-api-key']).toBe(KEY);
    expect(headers.authorization).toBeUndefined();
    expect(JSON.parse(String(init.body))).toEqual({ text: 'hi', model_id: 'eleven_multilingual_v2' });
  });
});

describe('厂商选择与回退', () => {
  it('显式选「自定义」时，即使地址是 OpenAI 官方也走 /audio/speech', async () => {
    const spy = stubFetch(async () => new Response(new Uint8Array(okWav())));
    await synthCloud('hi', opts({ provider: 'custom', baseUrl: 'https://api.openai.com/v1' }));
    expect((spy.mock.calls[0] as [string, RequestInit])[0]).toBe('https://api.openai.com/v1/audio/speech');
  });

  it('旧配置没有 provider 字段：Breeze 地址仍按 Breeze 协议发送', async () => {
    const spy = stubFetch(async () => new Response(new Uint8Array(okWav())));
    await synthCloud('hi', opts({ baseUrl: 'https://api.breeze.blue/v1', voice: 'voc_1' }));
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/text-to-speech/voc_1');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe(KEY);
  });

  it('厂商回 mp3 时明确说「不提供 WAV」，不静默转码', async () => {
    stubFetch(async () => new Response(new Uint8Array(Buffer.from('ID3 fake mp3'))));
    const err = await synthCloud('hi', opts({ provider: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io/v1', voice: 'v1' }))
      .catch((e: unknown) => e);
    expect((err as CloudError).kind).toBe('bad-audio');
    expect((err as CloudError).message).toContain('收到 MP3');
    expect((err as CloudError).message).toContain('暂不支持');
  });
});

describe('火山引擎合成', () => {
  it('Bearer; 鉴权，body 带 appid/cluster，wav 编码，base64 解成 WAV', async () => {
    const wav = okWav();
    const spy = stubFetch(async () => new Response(JSON.stringify({ code: 3000, message: 'Success', data: wav.toString('base64') })));
    const audio = await synthCloud('你好', opts({
      provider: 'volcengine',
      baseUrl: 'https://openspeech.bytedance.com/api/v1/tts',
      model: '',
      voice: 'zh_female_wanqudashu_moon_bigtts',
      appId: 'app-1',
    }));
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openspeech.bytedance.com/api/v1/tts');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer; ${KEY}`);
    const body = JSON.parse(String(init.body)) as Record<string, any>;
    expect(body.app).toMatchObject({ appid: 'app-1', cluster: 'volcano_tts' });
    expect(body.audio).toMatchObject({ voice_type: 'zh_female_wanqudashu_moon_bigtts', encoding: 'wav' });
    expect(body.request.text).toBe('你好');
    expect(audio.wav.equals(wav)).toBe(true);
  });

  it('没填 appId 是配置错误，不发请求', async () => {
    const spy = stubFetch(async () => new Response(JSON.stringify({ code: 3000, data: '' })));
    await expect(synthCloud('你好', opts({ provider: 'volcengine', voice: 'v1' }))).rejects.toMatchObject({ kind: 'config' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('非成功码是可见失败', async () => {
    stubFetch(async () => new Response(JSON.stringify({ code: 3001, message: 'invalid token' })));
    const err = await synthCloud('你好', opts({ provider: 'volcengine', voice: 'v1', appId: 'a' })).catch((e: unknown) => e);
    expect((err as CloudError).kind).toBe('failed');
    expect((err as CloudError).message).toContain('火山引擎合成失败');
  });
});

describe('小米 MiMo 合成', () => {
  it('走 chat/completions + api-key，audio.format=wav，base64 解成 WAV', async () => {
    const wav = okWav();
    const spy = stubFetch(async () => new Response(JSON.stringify({
      choices: [{ message: { audio: { data: wav.toString('base64') } } }],
    })));
    const audio = await synthCloud('你好', opts({
      provider: 'mimo',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2.5-tts',
      voice: 'mimo_default',
    }));
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers['api-key']).toBe(KEY);
    const body = JSON.parse(String(init.body)) as Record<string, any>;
    expect(body.model).toBe('mimo-v2.5-tts');
    expect(body.messages).toEqual([{ role: 'assistant', content: '你好' }]);
    expect(body.audio).toEqual({ format: 'wav', voice: 'mimo_default' });
    expect(audio.wav.equals(wav)).toBe(true);
  });

  it('没有音频字段时按坏音频报错', async () => {
    stubFetch(async () => new Response(JSON.stringify({ choices: [{ message: {} }] })));
    await expect(synthCloud('你好', opts({ provider: 'mimo', voice: 'mimo_default' }))).rejects.toMatchObject({ kind: 'bad-audio' });
  });
});

describe('Fish Audio 合成', () => {
  it('发 MessagePack 到 /tts，format=wav，Bearer 鉴权', async () => {
    const spy = stubFetch(async () => new Response(new Uint8Array(okWav())));
    await synthCloud('你好', opts({
      provider: 'fish',
      baseUrl: 'https://api.fish.audio/v1',
      model: 's2-pro',
      voice: 'ref-1',
    }));
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.fish.audio/v1/tts');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/msgpack');
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers.model).toBe('s2-pro');
    const body = Buffer.from(init.body as Uint8Array);
    // fixmap(3) + 三个字符串键；值里能读出音色与格式。
    expect(body[0]).toBe(0x83);
    const text = body.toString('utf8');
    expect(text).toContain('reference_id');
    expect(text).toContain('ref-1');
    expect(text).toContain('format');
    expect(text).toContain('wav');
  });
});

describe('未开放的厂商', () => {
  it('旧配置里的未开放厂商值回退成自定义，按 OpenAI 兼容发出请求', async () => {
    const spy = stubFetch(async () => new Response(new Uint8Array(okWav())));
    for (const provider of ['gemini', 'dashscope', 'gsv', 'gsvi', 'genie', 'edge']) {
      await synthCloud('你好', opts({ provider, baseUrl: 'https://tts.example.com/v1', model: 'tts-1', voice: 'v1' }));
    }
    expect(spy).toHaveBeenCalledTimes(6);
    for (const [url, init] of spy.mock.calls as Array<[string, RequestInit]>) {
      expect(url).toBe('https://tts.example.com/v1/audio/speech');
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    }
  });
});
