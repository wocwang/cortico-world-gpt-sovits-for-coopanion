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
