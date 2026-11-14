import { describe, expect, it } from 'vitest';
import {
  CLOUD_PROVIDERS,
  CUSTOM_PROVIDER_ID,
  cloudProvider,
  detectCloudProvider,
  hiddenCloudProviderId,
  listedCloudProviders,
  providerIdForStore,
  resolveCloudProvider,
} from '../src/cloud-providers.ts';

describe('厂商目录', () => {
  it('第一家是自定义，Breeze Blue 必须在内置名单里', () => {
    expect(CLOUD_PROVIDERS[0]?.id).toBe(CUSTOM_PROVIDER_ID);
    expect(CLOUD_PROVIDERS.map((p) => p.id)).toContain('breeze');
  });

  it('每家都有可用的默认值与明确的 WAV 能力', () => {
    for (const p of CLOUD_PROVIDERS) {
      expect(p.name.trim()).not.toBe('');
      expect(typeof p.voiceList).toBe('boolean');
      expect(['ok', 'beta', 'unsupported']).toContain(p.status);
    }
  });

  it('Azure 用区域拼主机、不用 model；MiniMax 有可选 GroupId', () => {
    const azure = cloudProvider('azure');
    expect(azure.extras).toEqual(['region']);
    expect(azure.showBaseUrl).toBe(false);
    expect(azure.showModel).toBe(false);
    expect(azure.voice).toBe('zh-CN-YunxiaNeural');
    const minimax = cloudProvider('minimax');
    expect(minimax.extras).toEqual(['groupId']);
    expect(minimax.baseUrl).toBe('https://api.minimax.cn/v1/t2a_v2');
    expect(minimax.voiceList).toBe(false);
  });

  it('火山引擎要 appId + 集群；Fish 是实验；拿不到 WAV 的都标未支持并带原因', () => {
    expect(cloudProvider('volcengine').extras).toEqual(['appId', 'cluster']);
    expect(cloudProvider('fish').status).toBe('beta');
    for (const id of ['gemini', 'dashscope', 'gsv', 'gsvi', 'genie', 'edge']) {
      const p = cloudProvider(id);
      expect(p.status).toBe('unsupported');
      expect(p.note).toBeTruthy();
    }
  });

  it('未开放的厂商不出现在下拉里，但目录与实现保留', () => {
    expect(listedCloudProviders().map((p) => p.id)).toEqual([
      'custom', 'openai', 'breeze', 'azure', 'minimax', 'elevenlabs', 'volcengine', 'mimo', 'fish',
    ]);
    for (const id of ['gemini', 'dashscope', 'gsv', 'gsvi', 'genie', 'edge']) {
      expect(CLOUD_PROVIDERS.map((p) => p.id)).toContain(id);
      expect(cloudProvider(id).listed).toBe(false);
    }
  });
});

describe('回退与推断', () => {
  it('不认识的 id 回退自定义', () => {
    expect(cloudProvider('nope').id).toBe(CUSTOM_PROVIDER_ID);
    expect(cloudProvider('').id).toBe(CUSTOM_PROVIDER_ID);
  });

  it('按地址认已知主机', () => {
    expect(detectCloudProvider('https://api.breeze.blue/v1')).toBe('breeze');
    expect(detectCloudProvider('https://api.openai.com/v1')).toBe('openai');
    expect(detectCloudProvider('https://eastasia.tts.speech.microsoft.com/x')).toBe('azure');
    expect(detectCloudProvider('https://api.minimax.cn/v1')).toBe('minimax');
    expect(detectCloudProvider('https://api.elevenlabs.io/v1')).toBe('elevenlabs');
    expect(detectCloudProvider('https://openspeech.bytedance.com/api/v1/tts')).toBe('volcengine');
    expect(detectCloudProvider('https://api.xiaomimimo.com/v1')).toBe('mimo');
    expect(detectCloudProvider('https://api.fish.audio/v1')).toBe('fish');
    expect(detectCloudProvider('https://generativelanguage.googleapis.com/v1beta')).toBe('gemini');
    expect(detectCloudProvider('https://dashscope.aliyuncs.com/api/v1')).toBe('dashscope');
    expect(detectCloudProvider('https://tts.example.com/v1')).toBe(CUSTOM_PROVIDER_ID);
    expect(detectCloudProvider('')).toBe(CUSTOM_PROVIDER_ID);
  });

  it('老配置（没有 provider）按地址推断；显式选了就以配置为准', () => {
    expect(resolveCloudProvider('', 'https://api.breeze.blue/v1').id).toBe('breeze');
    expect(resolveCloudProvider('', 'https://api.openai.com/v1').id).toBe('openai');
    expect(resolveCloudProvider('custom', 'https://api.openai.com/v1').id).toBe('custom');
    expect(resolveCloudProvider('something-new', 'https://tts.example.com/v1').id).toBe(CUSTOM_PROVIDER_ID);
  });

  it('自定义存空串，已知厂商存 id', () => {
    expect(providerIdForStore(cloudProvider('custom'))).toBe('');
    expect(providerIdForStore(cloudProvider('azure'))).toBe('azure');
  });

  it('旧配置存了未开放的厂商：回退自定义，并给出可读的旧值', () => {
    expect(resolveCloudProvider('gemini', 'https://x.test/v1').id).toBe(CUSTOM_PROVIDER_ID);
    expect(resolveCloudProvider('edge', '').id).toBe(CUSTOM_PROVIDER_ID);
    expect(resolveCloudProvider('gemini', '').baseUrl).toBe('https://api.openai.com/v1');
    expect(hiddenCloudProviderId('gemini')).toBe('gemini');
    expect(hiddenCloudProviderId('azure')).toBe('');
    expect(hiddenCloudProviderId('')).toBe('');
  });
});
