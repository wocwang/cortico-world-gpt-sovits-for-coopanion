import { mkdtempSync } from 'node:fs';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GPT_SOVITS_DEFAULTS, type GptSovitsConfigSection } from '../src/config.ts';
import { wavBytes } from '../src/wav.ts';
import { GptSovitsWorld } from '../src/world.ts';

type SynthCloud = typeof import('../src/cloud.ts')['synthCloud'];

const mock = vi.hoisted(() => ({ synth: null as SynthCloud | null }));

vi.mock('../src/cloud.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/cloud.ts')>();
  return {
    ...real,
    synthCloud: (text: string, opts: Parameters<SynthCloud>[1], signal?: AbortSignal) => {
      if (!mock.synth) throw new Error('synthCloud mock 未设置');
      return mock.synth(text, opts, signal);
    },
  };
});

const AUDIO = (() => {
  const pcm = Buffer.alloc(2400);
  return { sampleRate: 24_000, pcm, wav: wavBytes(pcm, 24_000), ms: 50 };
})();

function world(engine: 'cloud' | 'local'): { world: GptSovitsWorld; cfg: GptSovitsConfigSection } {
  const cfg = structuredClone(GPT_SOVITS_DEFAULTS);
  cfg.ttsEngine = engine;
  cfg.playLocally = true;
  cfg.textLang = 'zh';
  cfg.shareAudio = false;
  cfg.saveAudio = false;
  const w = new GptSovitsWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    dataDir: mkdtempSync(join(tmpdir(), 'gsv-speak-')),
    botDir: tmpdir(),
    runtimesRoot: () => join(tmpdir(), 'gsv-rt'),
    modelsRoot: () => join(tmpdir(), 'gsv-models'),
    persist: (patch) => { Object.assign(cfg, patch); },
    secret: () => '',
  });
  (w as unknown as { log: unknown }).log = { warn: () => {}, info: () => {} };
  (w as unknown as { player: unknown }).player = {
    write: async () => {},
    flush: () => {},
    cut: () => {},
  };
  return { world: w, cfg };
}

async function cloudWorld(): Promise<{ world: GptSovitsWorld; cfg: GptSovitsConfigSection }> {
  const h = world('cloud');
  h.cfg.cloudBaseUrl = 'https://api.openai.com/v1';
  h.cfg.cloudModel = 'tts-1';
  h.cfg.cloudVoiceId = 'alloy';
  h.cfg.cloudTimeoutMs = 60_000;
  await h.world.invoke('voice', 'saveCloudKey', ['sk-test-123456']);
  return h;
}

const within = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`超时 ${ms} ms`)), ms))]);

afterEach(() => {
  mock.synth = null;
  vi.useRealTimers();
});

describe('sovits_speak 何时返回', () => {
  it('云端：整句音频没回来前不返回，回来后回执并写声卡', async () => {
    vi.useFakeTimers();
    const { world: w } = await cloudWorld();
    let release!: (v: typeof AUDIO) => void;
    mock.synth = () => new Promise((resolve) => { release = resolve; });
    let settled = false;
    const p = w.invoke('voice', 'test', ['你好']).then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    // 不推进 3 秒计时器：云端没有首块上限，音频一回来就应结束等待。
    release(AUDIO);
    const out = await p as { text: string };
    expect(settled).toBe(true);
    expect(out.text).toContain('Said');
  });

  it('云端：合成失败立刻返回，错误仍留在状态里', async () => {
    const { world: w } = await cloudWorld();
    mock.synth = async () => { throw new Error('云端炸了-42'); };
    const out = await within(w.invoke('voice', 'test', ['你好']), 1000) as { text: string };
    expect(out.text).toContain('Said');
    const state = await w.invoke('voice', 'state', []) as { lastError: string | null };
    expect(state.lastError).toContain('云端炸了-42');
  });

  it('云端：合成的超时/取消会让等待结束，不会卡死工具', async () => {
    const { world: w } = await cloudWorld();
    mock.synth = (_text, _opts, signal) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const p = w.invoke('voice', 'test', ['你好']);
    await new Promise((r) => setTimeout(r, 20));
    await w.invoke('voice', 'hush', []);
    await expect(within(p, 1000)).resolves.toBeTruthy();
  });

  it('云端：hush 打断的等待即使合成端不响应 abort 也会结束', async () => {
    const { world: w } = await cloudWorld();
    mock.synth = () => new Promise(() => {});
    const p = w.invoke('voice', 'test', ['你好']);
    await new Promise((r) => setTimeout(r, 20));
    await w.invoke('voice', 'hush', []);
    await expect(within(p, 1000)).resolves.toBeTruthy();
  });

  it('本地：仍按首块音频的 3 秒上限回执，行为不变', async () => {
    vi.useFakeTimers();
    const { world: w } = world('local');
    (w as unknown as { pump: () => void }).pump = () => {}; // 本地合成不启动：模拟一直等不到首块音频
    (w as unknown as { url: () => string }).url = () => 'http://127.0.0.1:9';
    (w as unknown as { voice: () => { audio: string; text: string } }).voice = () => ({ audio: 'ref.wav', text: '参考' });
    let settled = false;
    const p = w.invoke('voice', 'test', ['你好']).then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const out = await p as { text: string };
    expect(out.text).toContain('Said');
  });
});

describe('本地服务按需拉起', () => {
  function localWorld(): { w: GptSovitsWorld; state: { ready: boolean; starts: number } } {
    const { world: w } = world('local');
    const state = { ready: false, starts: 0 };
    (w as unknown as { voice: () => { audio: string; text: string } }).voice = () => ({ audio: 'ref.wav', text: '参考' });
    (w as unknown as { canStart: () => boolean }).canStart = () => true;
    (w as unknown as { url: () => string | null }).url = () => (state.ready ? 'http://127.0.0.1:9' : null);
    (w as unknown as { startServer: () => Promise<void> }).startServer = () => {
      state.starts += 1;
      state.ready = true;
      return Promise.resolve();
    };
    // 队列里的句子直接“合成完”：silent 会等 finish，不能让它等 45 秒。
    (w as unknown as { pump: () => void }).pump = () => {
      const item = (w as unknown as { queue: Array<{ started: () => void; finish?: (wav: Buffer) => void }> }).queue.shift();
      item?.started();
      item?.finish?.(AUDIO.wav);
    };
    return { w, state };
  }

  const speak = (w: GptSovitsWorld): Promise<{ text: string; failed?: boolean }> =>
    w.tools().find((tool) => tool.name === 'sovits_speak')!.handler(
      { text: '你好', silent: true },
      {} as unknown as ToolCallContext,
    ) as Promise<{ text: string; failed?: boolean }>;

  it('引擎没起但可启动：先拉起再合成', async () => {
    const { w, state } = localWorld();
    const out = await within(speak(w), 1000);
    expect(state.starts).toBe(1);
    expect(out.failed).toBeUndefined();
    expect(out.text).toContain('Said');
  });

  it('手动停止后：桌宠调用不覆盖，并说明原因', async () => {
    const { w, state } = localWorld();
    (w as unknown as { serviceHeld: boolean }).serviceHeld = true;
    const out = await within(speak(w), 1000);
    expect(state.starts).toBe(0);
    expect(out.failed).toBe(true);
    expect(out.text).toContain('stopped manually');
  });
});
