import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findFolders, fsPath, inspectFolder, isLocalService, pairWeights, probeService } from '../src/gptsovits-folder.ts';
import { wavBytes } from '../src/wav.ts';

const roots: string[] = [];
const temp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `gsv-${name}-`));
  roots.push(dir);
  return dir;
};
afterAll(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

/** 造一个能过 `checkWeights` 的 `.ckpt`（s1 权重实际一百多 MB，这里只保证过大小检查）。 */
function ckpt(dir: string, name: string, bytes = 1.5 * 1024 * 1024): string {
  const file = join(dir, name);
  writeFileSync(file, Buffer.alloc(Math.ceil(bytes), 1));
  return file;
}

/** 造一个带两字节版本头的 `.pth`。 */
function pth(dir: string, name: string, head: string): string {
  const file = join(dir, name);
  writeFileSync(file, Buffer.concat([Buffer.from(head, 'ascii'), Buffer.alloc(32, 7)]));
  return file;
}

function wav(dir: string, name: string, seconds: number): string {
  const rate = 32000;
  const file = join(dir, name);
  writeFileSync(file, wavBytes(Buffer.alloc(rate * 2 * seconds), rate));
  return file;
}

describe('fsPath', () => {
  it('非 Windows 原样返回绝对路径', () => {
    expect(fsPath('some/dir', 'linux')).toBe(resolve('some/dir'));
  });

  it('Windows 短路径不加前缀', () => {
    expect(fsPath('C:\\GPT-SoVITS', 'win32')).toBe(resolve('C:\\GPT-SoVITS'));
  });

  it('Windows 超长路径加 \\\\?\\ 前缀，UNC 走 \\\\?\\UNC\\', () => {
    const long = `C:\\${'a'.repeat(260)}`;
    expect(fsPath(long, 'win32').startsWith('\\\\?\\C:\\')).toBe(true);
    const unc = `\\\\server\\${'b'.repeat(260)}`;
    expect(fsPath(unc, 'win32').startsWith('\\\\?\\UNC\\server\\')).toBe(true);
  });
});

describe('pairWeights', () => {
  it('按去掉训练后缀的主干配对', () => {
    expect(pairWeights(['C:/w/myvoice-e12.ckpt'], ['C:/w/myvoice_e8_s208.pth']))
      .toEqual([{ gpt: 'C:/w/myvoice-e12.ckpt', sovits: 'C:/w/myvoice_e8_s208.pth' }]);
  });

  it('配不上的丢弃，不硬凑', () => {
    expect(pairWeights(['C:/w/aaa.ckpt'], ['C:/w/zzz_e8.pth'])).toEqual([]);
  });

  it('一个 ckpt 只配一个 pth', () => {
    const pairs = pairWeights(['C:/w/voice-e1.ckpt', 'C:/w/voice-e2.ckpt'], ['C:/w/voice_e8.pth']);
    expect(pairs).toHaveLength(1);
  });

  it('主干只有 2–3 个字符但完全相同时也配对', () => {
    expect(pairWeights(['C:/w/foo-e10.ckpt'], ['C:/w/foo_e8_s100.pth']))
      .toEqual([{ gpt: 'C:/w/foo-e10.ckpt', sovits: 'C:/w/foo_e8_s100.pth' }]);
  });

  it('主干为空（只有训练后缀）时不硬配', () => {
    expect(pairWeights(['C:/w/-e1.ckpt'], ['C:/w/_e8.pth'])).toEqual([]);
  });
});

describe('inspectFolder', () => {
  it('认出整合包根目录、成对权重与参考音频', () => {
    const dir = temp('full');
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    mkdirSync(join(dir, 'tools'), { recursive: true });
    writeFileSync(join(dir, 'api_v2.py'), '# api');
    writeFileSync(join(dir, 'runtime', 'python.exe'), '');
    writeFileSync(join(dir, 'tools', 'portable_runtime.py'), '');
    ckpt(dir, 'myvoice-e12.ckpt');
    pth(dir, 'myvoice_e8_s208.pth', '08');
    wav(dir, 'myvoice-ref.wav', 5);
    writeFileSync(join(dir, 'myvoice-ref.txt'), '你好，这是参考台本。');

    const report = inspectFolder(dir, 'win32');
    expect(report.runtime.usable).toBe(true);
    expect(report.runtime.hasApi).toBe(true);
    expect(report.runtime.python).toContain('python.exe');
    expect(report.weights).toHaveLength(1);
    expect(report.weights[0]).toMatchObject({ version: 'v5turbo', problem: null });
    expect(report.refs).toHaveLength(1);
    expect(report.refs[0]).toMatchObject({ text: '你好，这是参考台本。' });
    expect(report.refs[0].seconds).toBeCloseTo(5, 1);
  });

  it('缺 tools/portable_runtime.py 时判为不可用，并给出转端口接入的原因', () => {
    const dir = temp('noportable');
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    writeFileSync(join(dir, 'api_v2.py'), '# api');
    writeFileSync(join(dir, 'runtime', 'python.exe'), '');
    const report = inspectFolder(dir, 'win32');
    expect(report.runtime.hasApi).toBe(true);
    expect(report.runtime.python).not.toBeNull();
    expect(report.runtime.portable).toBe(false);
    expect(report.runtime.usable).toBe(false);
    expect(report.runtime.problem).toContain('portable_runtime.py');
  });

  it('不是 GPT-SoVITS 根目录时指出没有 api_v2.py', () => {
    const dir = temp('notroot');
    writeFileSync(join(dir, 'readme.txt'), 'hello');
    const report = inspectFolder(dir, 'win32');
    expect(report.runtime.usable).toBe(false);
    expect(report.runtime.problem).toContain('api_v2.py');
  });

  it('目录不存在时返回问题而不是抛出', () => {
    const report = inspectFolder(join(tmpdir(), 'definitely-not-here-gsv'), 'linux');
    expect(report.runtime.usable).toBe(false);
    expect(report.problems[0]).toContain('不存在');
  });

  it('小于 1 MB 的 ckpt 与不在 3–10 秒的 wav 都不收', () => {
    const dir = temp('small');
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    mkdirSync(join(dir, 'tools'), { recursive: true });
    writeFileSync(join(dir, 'api_v2.py'), '');
    writeFileSync(join(dir, 'runtime', 'python.exe'), '');
    writeFileSync(join(dir, 'tools', 'portable_runtime.py'), '');
    ckpt(dir, 'tiny-e1.ckpt', 1024);
    pth(dir, 'tiny_e8.pth', '06');
    wav(dir, 'too-short.wav', 1);
    wav(dir, 'too-long.wav', 12);

    const report = inspectFolder(dir, 'win32');
    expect(report.weights).toEqual([]);
    expect(report.refs).toEqual([]);
  });
});

describe('isLocalService', () => {
  it('回环地址算本机', () => {
    for (const url of ['http://127.0.0.1:9880', 'http://localhost:9880', 'http://[::1]:9880', 'https://LOCALHOST:443']) {
      expect(isLocalService(url)).toBe(true);
    }
  });

  it('其它地址与非法输入都不算本机', () => {
    for (const url of ['http://192.168.1.8:9880', 'http://example.com', '', 'not-a-url']) {
      expect(isLocalService(url)).toBe(false);
    }
  });
});

describe('findFolders', () => {
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  afterEach(() => {
    for (const [key, value] of [['USERPROFILE', saved.USERPROFILE], ['HOME', saved.HOME]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('在桌面/下载/文档下一层找名字像 GPT-SoVITS 的目录', async () => {
    const home = temp('home');
    mkdirSync(join(home, 'Desktop', 'GPT-SoVITS-v2', 'api_v2.py'), { recursive: true });
    mkdirSync(join(home, 'Downloads', 'gpt_sovits_pack'), { recursive: true });
    mkdirSync(join(home, 'Documents', 'unrelated'), { recursive: true });
    process.env.USERPROFILE = home;
    process.env.HOME = home;

    const hits = await findFolders('linux');
    expect(hits).toContain(join(home, 'Desktop', 'GPT-SoVITS-v2'));
    expect(hits).toContain(join(home, 'Downloads', 'gpt_sovits_pack'));
    expect(hits.some((hit) => hit.includes('unrelated'))).toBe(false);
  });

  it('找不到时返回空数组', async () => {
    const home = temp('empty-home');
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    expect(await findFolders('linux')).toEqual([]);
  });
});

describe('probeService', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((done) => server!.close(() => done()));
    server = null;
  });

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

  it('空的或没有协议头时直接给可读结论，不发请求', async () => {
    expect((await probeService('')).ok).toBe(false);
    expect((await probeService('127.0.0.1:9880')).detail).toContain('http');
  });

  it('/docs 返回 200 时连上', async () => {
    const base = await listen(200);
    const result = await probeService(base);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain(base);
  });

  it('/docs 返回 404 时提示可能不是 api_v2', async () => {
    const base = await listen(404);
    expect((await probeService(base)).detail).toContain('/docs');
  });

  it('其它 HTTP 状态原样报出来', async () => {
    const base = await listen(500);
    const result = await probeService(base);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('500');
  });

  it('连不上时提示服务没启动或端口不对', async () => {
    const base = await listen(200);
    await new Promise<void>((done) => server!.close(() => done()));
    server = null;
    const result = await probeService(base);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('连不上');
  });
});
