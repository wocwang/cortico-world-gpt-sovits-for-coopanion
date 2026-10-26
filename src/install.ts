/**
 * 运行时与权重的下载安装，目录约定见 Cortico `docs/runtimes.md`:
 * - 运行时 `<运行时根>/gpt-sovits/<版本>/<档>/`,下到 `<目录>.partial/`、校验、解压、写 `cortico-runtime.json`,最后整个改名到位;
 * - 权重 `<模型根>/gpt-sovits/pretrained_models/<路径>`,每个文件下到 `.partial` 再改名，大小与 SHA-256 对上才算有。
 * 每个文件的来源按顺序尝试，前一个失败(网络、HTTP 状态、校验)才试下一个。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MODEL_FILES, RUNTIME_ASSETS, RUNTIME_VERSION, UPSTREAM_COMMIT, type ModelVersion, type PinnedFile } from './catalog.ts';
import type { Tier } from './config.ts';

export interface JobState {
  phase: 'absent' | 'working' | 'ready' | 'error';
  /** 已下载字节与总字节。 */
  done: number;
  total: number;
  /** 正在做的事或失败原因。 */
  detail: string | null;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** 把一个地址下到 `dest`,`onBytes` 收到每块的长度。 */
async function fetchTo(url: string, dest: string, onBytes: (n: number) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${url}`);
  const counter = new Transform({
    transform(chunk: Buffer, _e, cb) { onBytes(chunk.length); cb(null, chunk); },
  });
  mkdirSync(dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), counter, createWriteStream(dest), { signal });
}

/** 按顺序试来源，直到下下来的文件大小与 SHA-256 都对。 */
async function fetchVerified(sources: readonly string[], dest: string, bytes: number, sha256: string, progress: (n: number) => void, signal: AbortSignal): Promise<void> {
  const errors: string[] = [];
  for (const url of sources) {
    let got = 0;
    try {
      await fetchTo(url, dest, (n) => { got += n; progress(n); }, signal);
      const size = statSync(dest).size;
      if (bytes && size !== bytes) throw new Error(`大小 ${size},应为 ${bytes}`);
      if (sha256 && await sha256File(dest) !== sha256) throw new Error('SHA-256 不符');
      return;
    } catch (err) {
      if (signal.aborted) throw err;
      progress(-got);
      rmSync(dest, { force: true });
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(errors.join('\n') || '没有下载来源');
}

/** Windows 10 起自带 bsdtar,能解 zip;PATH 上靠前的 Git tar 不认 zip,所以写全路径。 */
function extract(archive: string, into: string): Promise<void> {
  const tar = process.platform === 'win32' ? resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return new Promise((done, fail) => {
    const child = spawn(tar, ['-xf', archive, '-C', into], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(`tar 退出码 ${code}: ${err.trim().slice(0, 300)}`))));
  });
}

/** 一件安装任务的进度与取消。 */
abstract class Job {
  protected state: JobState = { phase: 'absent', done: 0, total: 0, detail: null };
  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;

  protected abstract present(): boolean;
  protected abstract work(signal: AbortSignal): Promise<void>;

  status(): JobState {
    if (this.running) return { ...this.state };
    if (this.present()) return { phase: 'ready', done: 0, total: 0, detail: null };
    return { ...this.state, phase: this.state.phase === 'error' ? 'error' : 'absent' };
  }

  install(): Promise<void> {
    if (this.running) return this.running;
    this.abort = new AbortController();
    this.state = { phase: 'working', done: 0, total: 0, detail: null };
    this.running = this.work(this.abort.signal)
      .then(() => { this.state = { phase: 'ready', done: this.state.total, total: this.state.total, detail: null }; })
      .catch((err: unknown) => {
        this.state = { ...this.state, phase: 'error', detail: this.abort?.signal.aborted ? '已取消' : err instanceof Error ? err.message : String(err) };
      })
      .finally(() => { this.running = null; this.abort = null; });
    return this.running;
  }

  cancel(): void {
    this.abort?.abort();
  }
}

/** 一档运行时;`dir()` 下有 `runtime/python.exe` 与 `api_v2.py` 才算装好。 */
export class RuntimeJob extends Job {
  constructor(private readonly root: () => string, private readonly tier: () => Tier) { super(); }

  dir(): string {
    return join(this.root(), 'gpt-sovits', RUNTIME_VERSION, this.tier());
  }

  /** 这一档有没有发布包。 */
  published(): boolean {
    return RUNTIME_ASSETS[this.tier()].bytes > 0;
  }

  bytes(): number {
    return RUNTIME_ASSETS[this.tier()].bytes;
  }

  protected present(): boolean {
    return isRuntimeDir(this.dir());
  }

  protected async work(signal: AbortSignal): Promise<void> {
    const asset = RUNTIME_ASSETS[this.tier()];
    if (!asset.bytes) throw new Error('这一档还没有发布运行时包');
    const dir = this.dir();
    const partial = `${dir}.partial`;
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    const archive = join(partial, asset.file);
    this.state.total = asset.bytes;
    this.state.detail = asset.file;
    const progress = (n: number) => { this.state.done += n; };
    try {
      await fetchVerified(asset.sources, archive, asset.bytes, asset.sha256, progress, signal);
    } catch (whole) {
      if (!asset.parts?.length || signal.aborted) throw whole;
      await this.fetchParts(asset.parts, archive, asset.sha256, progress, signal);
    }
    this.state.detail = '正在解压';
    await extract(archive, partial);
    rmSync(archive, { force: true });
    writeFileSync(join(partial, 'cortico-runtime.json'), JSON.stringify({ id: 'gpt-sovits', version: RUNTIME_VERSION, upstream: UPSTREAM_COMMIT, tier: this.tier() }, null, 2));
    rmSync(dir, { recursive: true, force: true });
    renameSync(partial, dir);
  }

  /** 分片逐个下完拼回整包，再校验整包的 SHA-256。 */
  private async fetchParts(parts: NonNullable<(typeof RUNTIME_ASSETS)[Tier]['parts']>, archive: string, sha256: string, progress: (n: number) => void, signal: AbortSignal): Promise<void> {
    this.state.done = 0;
    rmSync(archive, { force: true });
    for (const [i, part] of parts.entries()) {
      const file = `${archive}.part${i + 1}`;
      await fetchVerified(part.sources, file, part.bytes, '', progress, signal);
      await pipeline(createReadStream(file), createWriteStream(archive, { flags: 'a' }));
      rmSync(file, { force: true });
    }
    if (await sha256File(archive) !== sha256) throw new Error('拼回的运行时包 SHA-256 不符');
  }
}

export const isRuntimeDir = (dir: string): boolean =>
  existsSync(join(dir, 'runtime', 'python.exe')) && existsSync(join(dir, 'api_v2.py'));

/** 一个模型版本要的权重文件，放在 `dir()` 下；选中官模预设时再加它那两份。 */
export class WeightsJob extends Job {
  constructor(
    private readonly root: () => string,
    private readonly version: () => ModelVersion,
    /** 当前选中预设的官模权重；没有官模就是空数组。 */
    private readonly official: () => readonly PinnedFile[],
  ) { super(); }

  dir(): string {
    return join(this.root(), 'gpt-sovits', 'pretrained_models');
  }

  /** 还缺的文件。 */
  missing(): PinnedFile[] {
    return [...MODEL_FILES[this.version()], ...this.official()].filter((f) => !this.has(f));
  }

  /** 还要下载的字节数。 */
  bytes(): number {
    return this.missing().reduce((n, f) => n + f.bytes, 0);
  }

  /** 底模齐了就能起服务；官模权重没下完时先用底模，不影响出声。 */
  baseReady(): boolean {
    return MODEL_FILES[this.version()].every((f) => this.has(f));
  }

  private has(f: PinnedFile): boolean {
    const path = join(this.dir(), f.path);
    return existsSync(path) && (!f.bytes || statSync(path).size === f.bytes);
  }

  protected present(): boolean {
    return this.missing().length === 0;
  }

  protected async work(signal: AbortSignal): Promise<void> {
    const todo = this.missing();
    this.state.total = todo.reduce((n, f) => n + f.bytes, 0);
    for (const f of todo) {
      this.state.detail = f.path;
      const dest = join(this.dir(), f.path);
      const partial = `${dest}.partial`;
      await fetchVerified(f.sources, partial, f.bytes, f.sha256, (n) => { this.state.done += n; }, signal);
      renameSync(partial, dest);
    }
  }
}
