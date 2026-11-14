import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GPT_SOVITS_DEFAULTS, type GptSovitsConfigSection } from '../src/config.ts';
import { GptSovitsWorld } from '../src/world.ts';
import { wavBytes } from '../src/wav.ts';

interface Harness {
  world: GptSovitsWorld;
  cfg: GptSovitsConfigSection;
  patches: Record<string, unknown>[];
  warns: string[];
}

function harness(patchTier = false): Harness {
  const cfg = structuredClone(GPT_SOVITS_DEFAULTS);
  if (patchTier) {
    cfg.tier = 'cuda';
    cfg.voiceModel = 'v2ProPlus';
  }
  const patches: Record<string, unknown>[] = [];
  const warns: string[] = [];
  const world = new GptSovitsWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    dataDir: mkdtempSync(join(tmpdir(), 'gsv-world-')),
    botDir: tmpdir(),
    runtimesRoot: () => join(tmpdir(), 'gsv-rt'),
    modelsRoot: () => join(tmpdir(), 'gsv-models'),
    persist: (patch) => {
      patches.push(patch as Record<string, unknown>);
      Object.assign(cfg, patch);
    },
    secret: () => '',
  });
  (world as unknown as { log: unknown }).log = {
    warn: (m: string) => warns.push(m),
    info: () => {},
  };
  return { world, cfg, patches, warns };
}

/** 造一个可用的自备运行时目录（api_v2 + runtime Python + portable_runtime）。 */
function runtimeDir(withWeightsAndRef: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'gsv-folder-'));
  mkdirSync(join(dir, 'runtime'), { recursive: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  writeFileSync(join(dir, 'api_v2.py'), '');
  writeFileSync(join(dir, 'runtime', 'python.exe'), '');
  writeFileSync(join(dir, 'tools', 'portable_runtime.py'), '');
  if (withWeightsAndRef) {
    writeFileSync(join(dir, 'myvoice-e12.ckpt'), Buffer.alloc(1_500_000, 1));
    writeFileSync(join(dir, 'myvoice_e8_s208.pth'), Buffer.concat([Buffer.from('08'), Buffer.alloc(32)]));
    writeFileSync(join(dir, 'myvoice-ref.wav'), wavBytes(Buffer.alloc(32000 * 2 * 6), 32000));
    writeFileSync(join(dir, 'myvoice-ref.txt'), '这是一段参考台本。');
  }
  return dir;
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('applyFolder', () => {
  it('权重 + 参考音频落成自定义音色，官方预设不再挡掉自备权重', async () => {
    const { world, cfg, patches } = harness(true);
    const dir = runtimeDir(true);
    const result = await world.invoke('voice', 'applyFolder', [dir, {
      weights: { gpt: join(dir, 'myvoice-e12.ckpt'), sovits: join(dir, 'myvoice_e8_s208.pth') },
      ref: join(dir, 'myvoice-ref.wav'),
    }]) as { text: string };

    expect(result.text).toContain('已接上');
    const voice = cfg.voices[0];
    expect(cfg.voices).toHaveLength(1);
    expect(voice.weights).toEqual({ gpt: join(dir, 'myvoice-e12.ckpt'), sovits: join(dir, 'myvoice_e8_s208.pth') });
    expect(cfg.voice.preset).toBe(voice.id);
    expect(cfg.voice.audio).toBe(join(dir, 'myvoice-ref.wav'));
    expect(cfg.weights.gpt).toBe(join(dir, 'myvoice-e12.ckpt'));
    expect(cfg.voiceModel).toBe('v5turbo');
    expect(patches.some((p) => Array.isArray(p.voices))).toBe(true);
  });

  it('同一目录再接一次不会重复建音色', async () => {
    const { world, cfg } = harness(true);
    const dir = runtimeDir(true);
    const pick = {
      weights: { gpt: join(dir, 'myvoice-e12.ckpt'), sovits: join(dir, 'myvoice_e8_s208.pth') },
      ref: join(dir, 'myvoice-ref.wav'),
    };
    await world.invoke('voice', 'applyFolder', [dir, pick]);
    await world.invoke('voice', 'applyFolder', [dir, pick]);
    expect(cfg.voices).toHaveLength(1);
  });

  it('只选权重不选参考音频时明确说明这次不生效，且不建音色', async () => {
    const { world, cfg } = harness(true);
    const dir = runtimeDir(true);
    const result = await world.invoke('voice', 'applyFolder', [dir, {
      weights: { gpt: join(dir, 'myvoice-e12.ckpt'), sovits: join(dir, 'myvoice_e8_s208.pth') },
    }]) as { text: string };

    expect(result.text).toContain('不会生效');
    expect(cfg.voices).toHaveLength(0);
    expect(cfg.weights.gpt).toBe(join(dir, 'myvoice-e12.ckpt'));
  });

  it('目录不可用时只说原因，不写配置', async () => {
    const { world, patches } = harness();
    const result = await world.invoke('voice', 'applyFolder', ['C:\\not-a-gsv-dir', {}]) as { text: string; failed?: boolean };
    expect(result.failed).toBe(true);
    expect(patches).toHaveLength(0);
  });
});

describe('probeService / 换权重', () => {
  let server: Server | null = null;
  const listen = async (status: number): Promise<string> => {
    server = createServer((req, res) => {
      res.statusCode = req.url === '/docs' ? status : 404;
      res.end('x');
    });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    return `http://127.0.0.1:${addr.port}`;
  };
  const close = async () => {
    if (server) await new Promise<void>((done) => server!.close(() => done()));
    server = null;
  };
  afterEach(async () => { await close(); });

  it('连上才写 serverUrl 并清掉 runtimeDir', async () => {
    const { world, cfg, patches } = harness();
    cfg.runtimeDir = 'D:\\old';
    const url = await listen(200);
    await world.invoke('voice', 'probeService', [url]);
    expect(cfg.serverUrl).toBe(url);
    expect(cfg.runtimeDir).toBe('');
    expect(patches).toHaveLength(1);
  });

  it('404 / 连不上都不写配置', async () => {
    const { world, cfg, patches } = harness();
    const url404 = await listen(404);
    await world.invoke('voice', 'probeService', [url404]);
    await close();
    const refused = `http://127.0.0.1:1`;
    await world.invoke('voice', 'probeService', [refused]);
    expect(cfg.serverUrl).toBe('');
    expect(patches).toHaveLength(0);
  });

  it('跨机地址换权重只警告，不发请求', async () => {
    const { world, cfg, warns } = harness();
    cfg.serverUrl = 'http://203.0.113.9:9880';
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error('must not fetch'); }) as typeof fetch;
    await (world as unknown as { applyWeights: (url: string) => Promise<void> }).applyWeights(cfg.serverUrl);
    expect(calls).toBe(0);
    expect(warns.some((w) => w.includes('不在本机'))).toBe(true);
  });
});

describe('云端音色拉取', () => {
  it('合并后超过上限会给出截断提示，且关键词标明只影响排序', async () => {
    const { world, cfg } = harness();
    cfg.cloudProvider = 'custom';
    cfg.cloudBaseUrl = 'https://tts.example.com/v1';
    cfg.cloudVoices = Array.from({ length: 48 }, (_, i) => ({ id: `old${i}`, name: `old${i}` }));
    cfg.cloudVoiceId = 'old0';
    await world.invoke('voice', 'saveCloudKey', ['k-1']);
    globalThis.fetch = (async () => new Response(JSON.stringify({
      voices: Array.from({ length: 10 }, (_, i) => ({ voice_id: `new${i}`, name: `new${i}` })),
    }), { status: 200 })) as typeof fetch;
    const state = await world.invoke('voice', 'refreshCloudVoices', ['new']) as {
      notice?: { code: string; count: number; kept: number; total: number; keywordMode: string };
    };
    expect(state.notice).toEqual({ code: 'cloudVoicesPulled', count: 10, kept: 50, total: 58, keywordMode: 'local' });
    expect(cfg.cloudVoices).toHaveLength(50);
    expect(cfg.cloudVoices?.at(-1)?.id).toBe('new1');
    expect(cfg.cloudVoiceId).toBe('old0');
  });

  it('面板给出拉取用的语种：显式语种照抄，自动识别时给推断结果', async () => {
    const { world, cfg } = harness();
    cfg.textLang = 'ja';
    let state = await world.invoke('voice', 'state', []) as { cloud: { language: string; languageAuto: boolean } };
    expect(state.cloud.language).toBe('ja');
    expect(state.cloud.languageAuto).toBe(false);
    cfg.textLang = 'auto';
    cfg.voice = { ...cfg.voice, text: '你好，今天过得怎么样？' };
    state = await world.invoke('voice', 'state', []) as { cloud: { language: string; languageAuto: boolean } };
    expect(state.cloud.language).toBe('zh');
    expect(state.cloud.languageAuto).toBe(true);
  });
});

describe('云端音色「使用」', () => {
  it('点使用就写入 id、选中，并把清单里没有的音色补进去', async () => {
    const { world, cfg } = harness();
    cfg.cloudVoices = [{ id: 'voice_a', name: 'A' }];
    const state = await world.invoke('voice', 'useCloudVoice', ['voc_9', '九号']) as {
      cloud: { voiceId: string };
      notice?: { code: string; name?: string };
    };
    expect(cfg.cloudVoiceId).toBe('voc_9');
    expect(cfg.cloudVoices).toContainEqual({ id: 'voc_9', name: '九号' });
    expect(state.cloud.voiceId).toBe('voc_9');
    expect(state.notice).toMatchObject({ code: 'cloudVoiceSelected', name: '九号' });
  });

  it('id 为空时报错，不改动已有选择', async () => {
    const { world, cfg } = harness();
    cfg.cloudVoices = [{ id: 'voice_a', name: 'A' }];
    cfg.cloudVoiceId = 'voice_a';
    await expect(world.invoke('voice', 'useCloudVoice', ['  ', '空'])).rejects.toThrow(/不能为空/);
    expect(cfg.cloudVoiceId).toBe('voice_a');
    expect(cfg.cloudVoices).toEqual([{ id: 'voice_a', name: 'A' }]);
  });

  it('从「音色」面板点使用也生效（面板 id 是 voices，走转发）', async () => {
    const { world, cfg } = harness();
    cfg.cloudVoices = [{ id: 'voice_a', name: 'A' }, { id: 'voice_b', name: 'B' }];
    cfg.cloudVoiceId = 'voice_a';
    const state = await world.invoke('voices', 'useCloudVoice', ['voice_b', 'B']) as {
      cloud: { voiceId: string; voices: Array<{ id: string }> };
      notice?: { code: string; name?: string };
    };
    expect(cfg.cloudVoiceId).toBe('voice_b');
    expect(state.cloud.voiceId).toBe('voice_b');
    expect(state.cloud.voices.map((v) => v.id)).toContain('voice_b');
    expect(state.notice).toMatchObject({ code: 'cloudVoiceSelected', name: 'B' });
  });

  it('无清单厂商手填 id 保存后写入并立刻选中', async () => {
    const { world, cfg } = harness();
    cfg.cloudProvider = 'minimax';
    cfg.cloudBaseUrl = 'https://api.minimax.cn/v1/t2a_v2';
    cfg.cloudVoices = [];
    cfg.cloudVoiceId = '';
    const state = await world.invoke('voices', 'useCloudVoice', ['female-shaonv', 'female-shaonv']) as {
      cloud: { voiceId: string; voices: Array<{ id: string; name: string }> };
    };
    expect(cfg.cloudVoiceId).toBe('female-shaonv');
    expect(cfg.cloudVoices).toContainEqual({ id: 'female-shaonv', name: 'female-shaonv' });
    expect(state.cloud.voiceId).toBe('female-shaonv');
    expect(state.cloud.voices.map((v) => v.id)).toContain('female-shaonv');
  });
});

describe('云端音色旧条目', () => {
  it('删除手动新增后，配置里已有的音色仍保留并在拉取后继续选中', async () => {
    const { world, cfg } = harness();
    cfg.cloudProvider = 'custom';
    cfg.cloudBaseUrl = 'https://tts.example.com/v1';
    cfg.cloudVoices = [{ id: 'manual_1', name: '以前手填的' }];
    cfg.cloudVoiceId = 'manual_1';
    await world.invoke('voice', 'saveCloudKey', ['k-2']);
    globalThis.fetch = (async () => new Response(JSON.stringify({
      voices: [{ voice_id: 'pulled_1', name: '拉到的' }],
    }), { status: 200 })) as typeof fetch;
    const state = await world.invoke('voice', 'refreshCloudVoices', []) as {
      cloud: { voiceId: string; voices: Array<{ id: string; name: string }> };
    };
    expect(cfg.cloudVoices).toContainEqual({ id: 'manual_1', name: '以前手填的' });
    expect(cfg.cloudVoices).toContainEqual({ id: 'pulled_1', name: '拉到的' });
    expect(cfg.cloudVoiceId).toBe('manual_1');
    expect(state.cloud.voiceId).toBe('manual_1');
  });
});
