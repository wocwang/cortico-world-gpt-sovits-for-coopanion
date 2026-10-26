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

async function boot(opts: { token?: string; ready?: boolean; slow?: boolean } = {}): Promise<{ base: string; jobs: TtsJob[]; order: string[] }> {
  const jobs: TtsJob[] = [];
  const order: string[] = [];
  let busy = false;
  handle = await startHttpTts({
    port: 0,
    token: opts.token,
    deps: {
      log,
      ready: () => opts.ready !== false,
      stateText: () => 'starting',
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
  return { base: `http://127.0.0.1:${handle.port}`, jobs, order };
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
    expect(jobs[0]).toMatchObject({ text: '念这一句', voice: '大肥鱼', speed: 0.95 });
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
});
