import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from 'cortico/core/types.ts';
import { RvcLink, type RvcLinkConfig } from '../src/rvc-link.ts';

const wav = (): Buffer => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(64, 0x11)]);
const converted = (): Buffer => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(32, 0x22)]);

const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of servers.splice(0)) await close();
});

interface Logged {
  warns: string[];
  infos: string[];
}

function makeLogger(): { log: Logger; out: Logged } {
  const out: Logged = { warns: [], infos: [] };
  const log: Logger = {
    trace: () => {},
    debug: () => {},
    info: (m: string) => { out.infos.push(m); },
    warn: (m: string) => { out.warns.push(m); },
    error: () => {},
    emit: () => {},
    child: () => log,
  };
  return { log, out };
}

/** 一个只会回固定字节的本地服务；`handler` 决定状态码与内容。 */
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(() => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

/** 拿一个肯定没人监听的端口：先占住再关掉。 */
async function deadEndpoint(): Promise<string> {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 1;
  await new Promise<void>((done) => server.close(() => done()));
  return `http://127.0.0.1:${port}`;
}

const cfg = (patch: Partial<RvcLinkConfig> = {}): RvcLinkConfig => ({
  enabled: true, endpoint: '', token: '', timeoutMs: 8000, pitch: 0, indexRate: 0.3, protect: 0.33, ...patch,
});

describe('RVC 出口变声', () => {
  it('没启用就原样返回，不发请求', async () => {
    const { log, out } = makeLogger();
    const link = new RvcLink(() => cfg({ enabled: false }), () => log);
    const input = wav();
    expect(await link.convert(input)).toBe(input);
    expect(out.infos).toEqual([]);
  });

  it('成功时换成对方回的音频，并把变调参数发过去', async () => {
    let seen = '';
    const base = await serve((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(converted());
      });
    });
    const { log } = makeLogger();
    const link = new RvcLink(() => cfg({ endpoint: base, pitch: 5, indexRate: 0.42, protect: 0.2 }), () => log);
    const out = await link.convert(wav());
    expect(out.equals(converted())).toBe(true);
    expect(seen).toContain('name="pitch"');
    expect(seen).toContain('\r\n\r\n5\r\n');
    expect(seen).toContain('0.42');
  });

  it('RVC 没启动（连不上）时原样返回', async () => {
    const { log, out } = makeLogger();
    const endpoint = await deadEndpoint();
    const link = new RvcLink(() => cfg({ endpoint }), () => log);
    const input = wav();
    expect(await link.convert(input)).toBe(input);
    expect(out.warns.length).toBe(1);
    // 同一句错误 60 秒内只记一条。
    await link.convert(input);
    expect(out.warns.length).toBe(1);
  });

  it('超时就放弃这一次变声，原样返回', async () => {
    const base = await serve(() => { /* 永不回包 */ });
    const { log, out } = makeLogger();
    const link = new RvcLink(() => cfg({ endpoint: base, timeoutMs: 300 }), () => log);
    const input = wav();
    const at = Date.now();
    expect(await link.convert(input)).toBe(input);
    expect(Date.now() - at).toBeLessThan(3000);
    expect(out.warns.length).toBe(1);
  });

  it('对方回 500 时原样返回', async () => {
    const base = await serve((_req, res) => { res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}'); });
    const { log } = makeLogger();
    const link = new RvcLink(() => cfg({ endpoint: base }), () => log);
    const input = wav();
    expect(await link.convert(input)).toBe(input);
  });

  it('对方回了不是 WAV 的 200 时原样返回', async () => {
    const base = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }).end('nope'); });
    const { log } = makeLogger();
    const link = new RvcLink(() => cfg({ endpoint: base }), () => log);
    const input = wav();
    expect(await link.convert(input)).toBe(input);
  });

  it('探测：就绪、没就绪、连不上三种状态', async () => {
    const { log } = makeLogger();
    const ready = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/health' ? { ready: true, device: 'cuda:0', model: 'daifeiyu' } : {}));
    });
    const warm = new RvcLink(() => cfg({ endpoint: ready }), () => log);
    expect(await warm.probe()).toEqual({ state: 'ready', detail: '', device: 'cuda:0', model: 'daifeiyu' });

    const cold = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ready: false })); });
    const coldLink = new RvcLink(() => cfg({ endpoint: cold }), () => log);
    expect((await coldLink.probe()).state).toBe('not-ready');

    const downEndpoint = await deadEndpoint();
    const down = new RvcLink(() => cfg({ endpoint: downEndpoint }), () => log);
    expect((await down.probe()).state).toBe('absent');
  });

  it('探测：非 2xx 与空端点', async () => {
    const { log } = makeLogger();
    const denied = await serve((_req, res) => { res.writeHead(401).end(); });
    const link = new RvcLink(() => cfg({ endpoint: denied }), () => log);
    expect(await link.probe()).toMatchObject({ state: 'error', detail: 'HTTP 401' });
    const empty = new RvcLink(() => cfg({ endpoint: '  ' }), () => log);
    expect((await empty.probe()).state).toBe('off');
  });
});
