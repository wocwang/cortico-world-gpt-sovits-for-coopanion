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
  it('从基址拼 /audio/voices，兼容已经写到 /audio/speech 的写法', () => {
    expect(voicesUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/audio/voices');
    expect(voicesUrl('https://x.test/v1/')).toBe('https://x.test/v1/audio/voices');
    expect(voicesUrl('https://x.test/v1/audio/speech')).toBe('https://x.test/v1/audio/voices');
    expect(voicesUrl('https://x.test/v1/audio/voices')).toBe('https://x.test/v1/audio/voices');
    expect(() => voicesUrl('')).toThrow(/地址没填/);
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
    await expect(fetchCloudVoices('https://api.openai.com/v1', KEY)).rejects.toThrow(/没有提供音色清单端点/);
    await expect(fetchCloudVoices('https://api.openai.com/v1', KEY)).rejects.not.toThrow(new RegExp(KEY));
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

  it('没有密钥就不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchCloudVoices('https://tts.example.com/v1', '')).rejects.toThrow(/密钥还没设置/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
