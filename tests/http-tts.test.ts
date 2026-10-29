import { afterEach, describe, expect, it } from 'vitest';
import { startHttpTts, type HttpTtsHandle, type TtsJob } from '../src/http-tts.ts';
import { parseWavHeader } from '../src/synth.ts';
import { wavBytes } from '../src/wav.ts';

const log = (() => {
  const l = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, emit: () => {}, child: () => l };
  return l;
})() as never;

/** 一段 48 kHz 单声道 0.05 s 的静音 WAV。 */
const fakeWav = (): Buffer => wavBytes(Buffer.alloc(2400 * 2), 48000);

let handle: HttpTtsHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

async function boot(opts: { token?: string; ready?: boolean; slow?: boolean; post?: (wav: Buffer) => Promise<Buffer>; sing?: (lyrics: string) => Promise<Buffer> } = {}): Promise<{ base: string; jobs: TtsJob[]; order: string[]; sang: string[] }> {
  const jobs: TtsJob[] = [];
  const order: string[] = [];
  const sang: string[] = [];
  let busy = false;
  handle = await startHttpTts({
    port: 0,
    token: opts.token,
    deps: {
      log,
      ready: () => opts.ready !== false,
      stateText: () => 'starting',
      post: opts.post,
      sing: opts.sing && (async (lyrics) => { sang.push(lyrics); return opts.sing!(lyrics); }),
      synthesize: async (job) => {
        if (busy) order.push('overlap');
        busy = true;
        jobs.push(job);
        if (opts.slow) await new Promise((r) => setTimeout(r, 30));
        busy = false;
        return fakeWav();
      },
    },
  });
  return { base: `http://127.0.0.1:${handle.port}`, jobs, order, sang };
}

describe('HTTP 语音接口', () => {
  it('OpenAI 形状：POST /audio/speech（含 /v1 前缀）返回 WAV', async () => {
    const { base, jobs } = await boot();
    const res = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', voice: 'xll', input: '你好', speed: 1.2, seed: 7 }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/wav');
    const head = parseWavHeader(Buffer.from(await res.arrayBuffer()));
    expect(head?.sampleRate).toBe(48000);
    expect(jobs).toEqual([{ text: '你好', voice: 'xll', speed: 1.2, seed: 7 }]);
  });

  it('VoxCPM 形状：GET /health 与 POST /tts', async () => {
    const { base, jobs } = await boot();
    const health = await fetch(`${base}/health`);
    expect(await health.json()).toEqual({ ready: true, state: 'starting' });
    const res = await fetch(`${base}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '念这一句', voice_desc: '大肥鱼', speed: 0.95, inference_timesteps: 10 }),
    });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    // voice_desc 是描述而不是点名：只作为 hint 交给世界层，避免把「温柔女声」当音色名告警。
    expect(jobs[0]?.voice).toBeUndefined();
    expect(jobs[0]?.voiceHint).toBe('大肥鱼');
    expect(jobs[0]?.speed).toBe(0.95);
  });

  it('OpenAI 模型列表：GET /models 与 /v1/models 都能探活', async () => {
    const { base } = await boot();
    for (const path of ['/models', '/v1/models']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
      expect(body.object).toBe('list');
      expect(body.data.length).toBeGreaterThan(0);
    }
  });

  it('缺文本 400、没就绪 503、别的路由 404', async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/tts`, { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    await handle?.close();
    handle = null;
    const notReady = await boot({ ready: false });
    expect((await fetch(`${notReady.base}/tts`, { method: 'POST', body: JSON.stringify({ text: 'x' }) })).status).toBe(503);
  });

  it('配了 token 就要凭证：空手 401，Bearer 与 ?token= 都行', async () => {
    const { base } = await boot({ token: 'secret' });
    const body = JSON.stringify({ input: 'hi' });
    expect((await fetch(`${base}/tts`, { method: 'POST', body })).status).toBe(401);
    expect((await fetch(`${base}/tts`, { method: 'POST', headers: { authorization: 'Bearer secret' }, body })).status).toBe(200);
    expect((await fetch(`${base}/tts?token=secret`, { method: 'POST', body })).status).toBe(200);
    expect((await fetch(`${base}/health`)).status).toBe(401);
  });

  it('并发请求排队串行，不叠着合成', async () => {
    const { base, order } = await boot({ slow: true });
    await Promise.all(['第一句', '第二句', '第三句'].map((t) => fetch(`${base}/tts`, { method: 'POST', body: JSON.stringify({ text: t }) })));
    expect(order).toEqual([]);
  });

  it('出口后处理成功时返回替换后的字节', async () => {
    const replaced = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(16, 0x33)]);
    const { base } = await boot({ post: async () => replaced });
    const res = await fetch(`${base}/tts`, { method: 'POST', body: JSON.stringify({ text: '试试' }) });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(replaced)).toBe(true);
  });

  it('出口后处理抛错时照样回原音频，链路不断', async () => {
    const { base } = await boot({ post: async () => { throw new Error('rvc broke'); } });
    const res = await fetch(`${base}/tts`, { method: 'POST', body: JSON.stringify({ text: '试试' }) });
    expect(res.status).toBe(200);
    expect(parseWavHeader(Buffer.from(await res.arrayBuffer()))?.sampleRate).toBe(48000);
  });

  it('点歌标记：正文以【唱】开头时交给唱歌插件，不走 TTS', async () => {
    const sung = wavBytes(Buffer.alloc(4410 * 2), 44100);
    const { base, jobs, sang } = await boot({ sing: async () => sung });
    const res = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: '【唱】晚风吹过旧时光', voice: 'dfy' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-sovits-sing')).toBe('1');
    expect(parseWavHeader(Buffer.from(await res.arrayBuffer()))?.sampleRate).toBe(44100);
    // 只有标记后面那段是歌词，标记与「语音」参数都不进合成。
    expect(sang).toEqual(['晚风吹过旧时光']);
    expect(jobs).toEqual([]);
  });

  it('唱歌插件失败时退回普通语音，正文去掉标记', async () => {
    const { base, jobs } = await boot({ sing: async () => { throw new Error('singer down'); } });
    const res = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: '[sing]晚风吹过旧时光' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-sovits-sing')).toBeNull();
    expect(jobs.map((j) => j.text)).toEqual(['晚风吹过旧时光']);
  });

  it('只写标记不写歌词：400', async () => {
    const { base, sang } = await boot({ sing: async () => fakeWav() });
    const res = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: '【唱】' }),
    });
    expect(res.status).toBe(400);
    expect(sang).toEqual([]);
  });
});
