import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchVerified, isRuntimeDir, removeTreeSafely, rocmPathProblem, SourceRanker } from '../src/install.ts';

describe('removeTreeSafely', () => {
  it('先拆掉目录联接再删运行时，不碰联接目标里的权重', () => {
    const root = mkdtempSync(join(tmpdir(), 'gpt-sovits-'));
    const weights = join(root, 'models', 'pretrained_models');
    const runtime = join(root, 'runtimes', 'cuda');
    mkdirSync(weights, { recursive: true });
    writeFileSync(join(weights, 's1v3.ckpt'), 'weights');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, 'api_v2.py'), 'runtime');
    symlinkSync(weights, join(runtime, 'pretrained_models'), 'junction');

    removeTreeSafely(runtime);

    expect(existsSync(join(weights, 's1v3.ckpt'))).toBe(true);
    expect(existsSync(runtime)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('联接藏在 GPT_SoVITS 里、目标已被删掉时也能删干净', () => {
    const root = mkdtempSync(join(tmpdir(), 'gpt-sovits-'));
    const weights = join(root, 'models', 'pretrained_models');
    const runtime = join(root, 'runtimes', 'cuda');
    mkdirSync(weights, { recursive: true });
    mkdirSync(join(runtime, 'GPT_SoVITS'), { recursive: true });
    writeFileSync(join(runtime, 'GPT_SoVITS', 'TTS.py'), 'x');
    symlinkSync(weights, join(runtime, 'GPT_SoVITS', 'pretrained_models'), 'junction');
    rmSync(weights, { recursive: true, force: true });

    expect(() => removeTreeSafely(runtime)).not.toThrow();
    expect(existsSync(runtime)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('ROCm 档的路径预检', () => {
  const longDir = `D:\\Coopanion\\${'x'.repeat(220)}`;

  it('路径超限且没开长路径时拒绝，并给出开启命令', () => {
    const problem = rocmPathProblem(longDir, false);
    expect(problem).toContain('安装路径太长');
    expect(problem).toContain('LongPathsEnabled');
    expect(problem).toContain('不会自己改注册表');
  });

  it('读不到开关时同样拒绝，不赌系统状态', () => {
    expect(rocmPathProblem(longDir, null)).toContain('读不到长路径开关');
  });

  it('开了长路径或路径够短就放行', () => {
    expect(rocmPathProblem(longDir, true)).toBeNull();
    expect(rocmPathProblem('D:\\rt', false)).toBeNull();
  });

  it('默认安装在 Program Files 下的路径超限，没开长路径时拒绝', () => {
    const defaultDir = 'D:\\Program Files\\Coopanion\\data\\home\\runtimes\\gpt-sovits\\e91506f-1\\rocm';
    expect(rocmPathProblem(defaultDir, false)).toContain('安装路径太长');
    expect(rocmPathProblem(defaultDir, true)).toBeNull();
  });
});

describe('isRuntimeDir 按平台认解释器', () => {
  it('macOS 认 runtime/bin/python3，不认 runtime/python.exe', () => {
    const root = mkdtempSync(join(tmpdir(), 'gpt-sovits-rt-'));
    writeFileSync(join(root, 'api_v2.py'), 'x');
    mkdirSync(join(root, 'runtime', 'bin'), { recursive: true });
    writeFileSync(join(root, 'runtime', 'bin', 'python3'), 'x');
    expect(isRuntimeDir(root, 'darwin')).toBe(true);
    expect(isRuntimeDir(root, 'win32')).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('Windows 认 runtime/python.exe', () => {
    const root = mkdtempSync(join(tmpdir(), 'gpt-sovits-rt-'));
    writeFileSync(join(root, 'api_v2.py'), 'x');
    mkdirSync(join(root, 'runtime'), { recursive: true });
    writeFileSync(join(root, 'runtime', 'python.exe'), 'x');
    expect(isRuntimeDir(root, 'win32')).toBe(true);
    expect(isRuntimeDir(root, 'darwin')).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('缺 api_v2.py 时哪个平台都不算装好', () => {
    const root = mkdtempSync(join(tmpdir(), 'gpt-sovits-rt-'));
    mkdirSync(join(root, 'runtime', 'bin'), { recursive: true });
    writeFileSync(join(root, 'runtime', 'bin', 'python3'), 'x');
    expect(isRuntimeDir(root, 'darwin')).toBe(false);
    expect(isRuntimeDir(root, 'win32')).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

/** 一个本地文件服务：`ranges` 为 false 时无视 Range 直接返回整包（很多 CDN 就是这样）。 */
async function fileServer(body: Buffer, { ranges = true } = {}) {
  const state = { requests: 0, active: 0, maxActive: 0, from: [] as number[] };
  const server = createServer((req, res) => {
    state.requests += 1;
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    res.on('close', () => { state.active -= 1; });
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (ranges && match) {
      const from = Number(match[1]);
      const to = match[2] ? Number(match[2]) : body.length - 1;
      state.from.push(from);
      res.writeHead(206, {
        'content-length': to - from + 1,
        'content-range': `bytes ${from}-${to}/${body.length}`,
        'accept-ranges': 'bytes',
      });
      res.end(body.subarray(from, to + 1));
      return;
    }
    state.from.push(0);
    res.writeHead(200, { 'content-length': body.length });
    res.end(body);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/pkg.bin`;
  const close = (): Promise<void> => new Promise<void>((ok) => {
    server.closeAllConnections();
    server.close(() => ok());
  });
  return { url, state, close };
}

describe('fetchVerified 多连接下载', () => {
  const body = Buffer.alloc(20 * 1024 * 1024, 3);
  const root = mkdtempSync(join(tmpdir(), 'gsv-fetch-'));
  const dest = (name: string): string => join(root, name);

  it('大文件走并发分段，落盘内容一致', async () => {
    const srv = await fileServer(body);
    const file = dest('multi.bin');
    let reported = 0;
    try {
      await fetchVerified([srv.url], file, body.length, '', (n) => { reported += n; }, new AbortController().signal);
      expect(statSync(file).size).toBe(body.length);
      expect(readFileSync(file).equals(body)).toBe(true);
      // 探测(0-0) + 两段区间：一半大小正好由第二段起点体现。
      expect(srv.state.from.length).toBeGreaterThanOrEqual(3);
      expect(srv.state.from).toContain(10 * 1024 * 1024);
      expect(reported).toBe(body.length);
      expect(existsSync(`${file}.chunk0`)).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it('服务端不认 Range 时退回单流，不拼出坏文件', async () => {
    const srv = await fileServer(body, { ranges: false });
    const file = dest('single.bin');
    try {
      await fetchVerified([srv.url], file, body.length, '', () => {}, new AbortController().signal);
      expect(readFileSync(file).equals(body)).toBe(true);
      // 探测 + 一次整包下载；没有分片留下的临时文件。
      expect(srv.state.requests).toBeLessThanOrEqual(3);
      expect(existsSync(`${file}.chunk0`)).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it('续传在已有断点上继续，多连接只补剩余部分', async () => {
    const srv = await fileServer(body);
    const file = dest('resume.bin');
    const have = 8 * 1024 * 1024;
    writeFileSync(file, body.subarray(0, have));
    try {
      await fetchVerified([srv.url], file, body.length, '', () => {}, new AbortController().signal, { resume: true });
      expect(readFileSync(file).equals(body)).toBe(true);
      // 探测是 0 起，其余的读取都不该从 0 重新拉。
      expect(srv.state.from.filter((n) => n > 0 && n < have)).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it('SHA-256 不符时抛错并删掉坏文件', async () => {
    const srv = await fileServer(body);
    const file = dest('bad.bin');
    try {
      await expect(fetchVerified([srv.url], file, body.length, 'deadbeef', () => {}, new AbortController().signal, { attempts: 1, connections: 1 }))
        .rejects.toThrow(/SHA-256/);
      expect(existsSync(file)).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it('全部小文件不进分段路径', async () => {
    const small = Buffer.alloc(1024 * 1024, 7);
    const srv = await fileServer(small);
    const file = dest('small.bin');
    try {
      await fetchVerified([srv.url], file, small.length, '', () => {}, new AbortController().signal);
      expect(readFileSync(file).equals(small)).toBe(true);
      expect(srv.state.maxActive).toBe(1);
    } finally {
      await srv.close();
    }
  });
});

describe('权重源测速排序', () => {
  const root = mkdtempSync(join(tmpdir(), 'gsv-rank-'));
  const cache = join(root, 'source-speed.json');
  const signal = new AbortController().signal;
  const now = Date.now();

  it('有缓存时按速度从快到慢，不再访问网络', async () => {
    writeFileSync(cache, JSON.stringify({
      'slow.example': { score: 1, at: now },
      'fast.example': { score: 9, at: now },
      'dead.example': { score: 0, at: now },
    }));
    const ranker = new SourceRanker(cache);
    const sources = ['https://dead.example/a', 'https://slow.example/a', 'https://fast.example/a'];
    expect(await ranker.order(sources, signal)).toEqual([
      'https://fast.example/a',
      'https://slow.example/a',
      'https://dead.example/a',
    ]);
  });

  it('都没测出速度时保持清单原顺序', async () => {
    writeFileSync(cache, JSON.stringify({
      'a.example': { score: 0, at: now },
      'b.example': { score: 0, at: now },
    }));
    const ranker = new SourceRanker(cache);
    const sources = ['https://a.example/x', 'https://b.example/x'];
    expect(await ranker.order(sources, signal)).toEqual(sources);
  });

  it('同一主机只算一个候选，路径不同不拆开', async () => {
    writeFileSync(cache, JSON.stringify({ 'one.example': { score: 4, at: now } }));
    const ranker = new SourceRanker(cache);
    const sources = ['https://one.example/a', 'https://one.example/b'];
    expect(await ranker.order(sources, signal)).toEqual(sources);
  });
});
