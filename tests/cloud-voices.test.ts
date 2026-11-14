import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPENAI_VOICES,
  defaultCloudVoices,
  effectiveCloudVoiceId,
  effectiveCloudVoices,
  fetchCloudVoices,
  isOpenAiBase,
  parseVoiceList,
  voicesUrl,
} from '../src/cloud-voices.ts';
import { isBreezeBlueBase } from '../src/cloud.ts';

const KEY = 'sk-test-secret-123';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('内置默认音色', () => {
  it('只认 OpenAI 官方主机名', () => {
    expect(isOpenAiBase('https://api.openai.com/v1')).toBe(true);
    expect(isOpenAiBase(' https://api.openai.com/v1/ ')).toBe(true);
    expect(isOpenAiBase('https://api.openai.com.evil.test/v1')).toBe(false);
    expect(isOpenAiBase('https://example.com/v1')).toBe(false);
    expect(isOpenAiBase('')).toBe(false);
  });

  it('OpenAI 地址给 6 个官方音色，其他地址不给默认', () => {
    const voices = defaultCloudVoices('https://api.openai.com/v1');
    expect(voices.map((v) => v.id)).toEqual(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
    expect(voices).toHaveLength(OPENAI_VOICES.length);
    expect(defaultCloudVoices('https://tts.example.com/v1')).toEqual([]);
  });
});

describe('生效清单与选中项', () => {
  it('用户清单优先，单独选过的 id 会补进清单', () => {
    expect(effectiveCloudVoices([{ id: 'a', name: 'A' }], 'https://api.openai.com/v1', 'b')).toEqual([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'b' },
    ]);
  });

  it('清单为空时用 OpenAI 默认，换选其他音色也不丢清单', () => {
    const ids = effectiveCloudVoices([], 'https://api.openai.com/v1', 'echo').map((v) => v.id);
    expect(ids).toEqual(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
  });

  it('第三方地址、清单为空时只显示选过的那个', () => {
    expect(effectiveCloudVoices([], 'https://tts.example.com/v1', 'x')).toEqual([{ id: 'x', name: 'x' }]);
    expect(effectiveCloudVoices([], 'https://tts.example.com/v1', '')).toEqual([]);
  });

  it('生效音色 id 缺省用清单第一个', () => {
    expect(effectiveCloudVoiceId('', [{ id: 'alloy', name: 'alloy' }])).toBe('alloy');
    expect(effectiveCloudVoiceId(' nova ', [{ id: 'alloy', name: 'alloy' }])).toBe('nova');
    expect(effectiveCloudVoiceId('', [])).toBe('');
  });
});

describe('清单端点与解析', () => {
  it('自定义 / OpenAI 兼容从基址拼 /audio/voices，兼容已经写到 /audio/speech 的写法', () => {
    expect(voicesUrl('https://x.test/v1')).toBe('https://x.test/v1/audio/voices');
    expect(voicesUrl('https://x.test/v1/')).toBe('https://x.test/v1/audio/voices');
    expect(voicesUrl('https://x.test/v1', 'custom')).toBe('https://x.test/v1/audio/voices');
    expect(voicesUrl('https://x.test/v1/audio/speech', 'custom')).toBe('https://x.test/v1/audio/voices');
    expect(voicesUrl('https://x.test/v1/audio/voices', 'custom')).toBe('https://x.test/v1/audio/voices');
    expect(() => voicesUrl('')).toThrow(/地址没填/);
  });

  it('OpenAI 官方没有清单端点，直接说清楚而不是去撞 404', () => {
    expect(() => voicesUrl('https://api.openai.com/v1')).toThrow(/没有音色清单端点/);
  });

  it('解析裸数组 / voices / data，并去重', () => {
    expect(parseVoiceList(['alloy', { voice_id: 'nova', display_name: 'Nova' }])).toEqual([
      { id: 'alloy', name: 'alloy' },
      { id: 'nova', name: 'Nova' },
    ]);
    expect(parseVoiceList({ voices: [{ id: 'echo', name: 'Echo' }, 'echo'] })).toEqual([{ id: 'echo', name: 'Echo' }]);
    expect(parseVoiceList({ data: [{ name: 'onyx' }] })).toEqual([{ id: 'onyx', name: 'onyx' }]);
    expect(parseVoiceList(null)).toEqual([]);
    expect(parseVoiceList({ nope: true })).toEqual([]);
  });

  it('认 Breeze Blue 的 { voices: [{ voice_id, name }] } 结构', () => {
    const raw = {
      voices: [
        { voice_id: 'voc_xeh3w54cqvnp', name: 'Mia', language_code: 'en', gender: 'female' },
        { voice_id: 'voc_2', name: '晓晓', language_code: 'zh' },
        { voice_id: 'voc_xeh3w54cqvnp', name: '重复' },
      ],
      has_more: false,
      total: 3,
      page: 1,
      page_size: 50,
    };
    expect(parseVoiceList(raw)).toEqual([
      { id: 'voc_xeh3w54cqvnp', name: 'Mia', language: 'en' },
      { id: 'voc_2', name: '晓晓', language: 'zh' },
    ]);
  });

  it('Breeze Blue 的清单地址是 {base}/voices，不是 /audio/voices', () => {
    expect(isBreezeBlueBase('https://api.breeze.blue/v1')).toBe(true);
    expect(isBreezeBlueBase('https://api.breeze.blue.evil.test/v1')).toBe(false);
    expect(voicesUrl('https://api.breeze.blue/v1')).toBe('https://api.breeze.blue/v1/voices');
    expect(voicesUrl('https://api.breeze.blue/v1/text-to-speech/voc_1')).toBe('https://api.breeze.blue/v1/voices');
  });

  it('Azure 按区域拼 voices/list；ElevenLabs 是 {base}/voices；MiniMax 没有清单端点', () => {
    expect(voicesUrl('', 'azure', 'eastasia')).toBe('https://eastasia.tts.speech.microsoft.com/cognitiveservices/voices/list');
    expect(() => voicesUrl('', 'azure')).toThrow(/区域没填/);
    expect(voicesUrl('https://api.elevenlabs.io/v1', 'elevenlabs')).toBe('https://api.elevenlabs.io/v1/voices');
    expect(() => voicesUrl('https://api.minimax.cn/v1/t2a_v2', 'minimax')).toThrow(/没有音色清单端点/);
    for (const [base, id] of [
      ['https://openspeech.bytedance.com/api/v1/tts', 'volcengine'],
      ['https://api.xiaomimimo.com/v1', 'mimo'],
      ['https://api.fish.audio/v1', 'fish'],
    ] as const) {
      expect(() => voicesUrl(base, id)).toThrow(/没有音色清单端点/);
    }
  });

  it('认 Azure 的 ShortName / LocalName 结构', () => {
    expect(parseVoiceList([{ ShortName: 'zh-CN-XiaoxiaoNeural', LocalName: '晓晓', DisplayName: 'Xiaoxiao' }])).toEqual([
      { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓' },
    ]);
  });

  it('顺带取出语种字段（Breeze language_code / Azure Locale / ElevenLabs labels.language）', () => {
    expect(parseVoiceList([{ voice_id: 'a', name: 'A', language_code: 'zh' }])[0]?.language).toBe('zh');
    expect(parseVoiceList([{ ShortName: 'zh-CN-X', LocalName: 'X', Locale: 'zh-CN' }])[0]?.language).toBe('zh-CN');
    expect(parseVoiceList([{ voice_id: 'b', name: 'B', labels: { language: 'en' } }])[0]?.language).toBe('en');
    expect(parseVoiceList([{ voice_id: 'c', name: 'C' }])[0]?.language).toBeUndefined();
  });
});

describe('从服务商拉取', () => {
  it('带上 Bearer 密钥，解析成功后返回清单', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ voices: [{ voice_id: 'alloy', name: 'Alloy' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const voices = await fetchCloudVoices('https://tts.example.com/v1', KEY, 10_000);
    expect(voices).toEqual([{ id: 'alloy', name: 'Alloy' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it('404 说明服务商没有这个端点，且不回显密钥', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    await expect(fetchCloudVoices('https://tts.example.com/v1', KEY)).rejects.toThrow(/没有提供音色清单端点/);
    await expect(fetchCloudVoices('https://tts.example.com/v1', KEY)).rejects.not.toThrow(new RegExp(KEY));
  });

  it('401 归为鉴权问题', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`bad key ${KEY}`, { status: 401 })));
    let message = '';
    await fetchCloudVoices('https://tts.example.com/v1', KEY).catch((err: Error) => { message = err.message; });
    expect(message).toMatch(/拒绝鉴权/);
    expect(message).not.toContain(KEY);
  });

  it('网络错误里的密钥会被脱敏', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(`connect failed with ${KEY}`); }));
    let message = '';
    await fetchCloudVoices('https://tts.example.com/v1', KEY).catch((err: Error) => { message = err.message; });
    expect(message).toMatch(/拉取音色清单失败/);
    expect(message).not.toContain(KEY);
  });

  it('Breeze Blue 用 xi-api-key 拉 /v1/voices，返回它的 voice_id 清单', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      voices: [{ voice_id: 'voc_xeh3w54cqvnp', name: 'Mia' }],
      has_more: false,
      total: 1,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const voices = await fetchCloudVoices('https://api.breeze.blue/v1', KEY, 10_000);
    expect(voices).toEqual([{ id: 'voc_xeh3w54cqvnp', name: 'Mia' }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.breeze.blue/v1/voices');
    const headers = init.headers as Record<string, string>;
    expect(headers['xi-api-key']).toBe(KEY);
    expect(headers.authorization).toBeUndefined();
  });

  it('没有密钥就不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchCloudVoices('https://tts.example.com/v1', '')).rejects.toThrow(/密钥还没设置/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Azure 用 Ocp-Apim-Subscription-Key 拉区域清单', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      { ShortName: 'zh-CN-XiaoxiaoNeural', LocalName: '晓晓' },
    ]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const voices = await fetchCloudVoices('', KEY, 10_000, 'azure', 'eastasia');
    expect(voices).toEqual([{ id: 'zh-CN-XiaoxiaoNeural', name: '晓晓' }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://eastasia.tts.speech.microsoft.com/cognitiveservices/voices/list');
    const headers = init.headers as Record<string, string>;
    expect(headers['Ocp-Apim-Subscription-Key']).toBe(KEY);
    expect(headers.authorization).toBeUndefined();
  });

  it('ElevenLabs 用 xi-api-key 拉 {base}/voices', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      voices: [{ voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const voices = await fetchCloudVoices('https://api.elevenlabs.io/v1', KEY, 10_000, 'elevenlabs');
    expect(voices).toEqual([{ id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George' }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/voices');
    const headers = init.headers as Record<string, string>;
    expect(headers['xi-api-key']).toBe(KEY);
    expect(headers.authorization).toBeUndefined();
  });

  it('Breeze 把语种与关键词交给服务端 language_code / search', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      voices: [{ voice_id: 'v1', name: 'Calm Narrator', language_code: 'zh' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const voices = await fetchCloudVoices('https://api.breeze.blue/v1', KEY, 10_000, 'breeze', '', {
      language: 'zh',
      keyword: 'calm',
    });
    expect(voices.map((v) => v.id)).toEqual(['v1']);
    const url = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0];
    expect(url).toBe('https://api.breeze.blue/v1/voices?language_code=zh&search=calm');
  });

  it('不支持服务端语种的厂商在本地按 language 过滤，缺字段的保留', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      voices: [
        { voice_id: 'a', name: 'A', language_code: 'zh' },
        { voice_id: 'b', name: 'B', language_code: 'en' },
        { voice_id: 'c', name: 'C' },
        { voice_id: 'd', name: 'D', language_code: 'zh-CN' },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const voices = await fetchCloudVoices('https://tts.example.com/v1', KEY, 10_000, 'custom', '', { language: 'zh' });
    expect(voices.map((v) => v.id)).toEqual(['a', 'c', 'd']);
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe('https://tts.example.com/v1/audio/voices');
  });

  it('本地关键词只影响排序：命中的在前，其余保持原顺序', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      voices: [
        { voice_id: 'x1', name: 'Bright' },
        { voice_id: 'calm_2', name: 'Second' },
        { voice_id: 'x3', name: 'CALM Narrator' },
      ],
    }), { status: 200 })));
    const voices = await fetchCloudVoices('https://tts.example.com/v1', KEY, 10_000, 'custom', '', { keyword: 'calm' });
    expect(voices.map((v) => v.id)).toEqual(['calm_2', 'x3', 'x1']);
  });

  it('关键词留空时保持返回顺序', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      voices: [{ voice_id: 'b' }, { voice_id: 'a' }],
    }), { status: 200 })));
    const voices = await fetchCloudVoices('https://tts.example.com/v1', KEY, 10_000, 'custom', '', { keyword: '  ' });
    expect(voices.map((v) => v.id)).toEqual(['b', 'a']);
  });
});
