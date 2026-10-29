/**
 * 运行时与权重的下载安装，目录约定见 Cortico `docs/runtimes.md`:
 * - 运行时 `<运行时根>/gpt-sovits/<版本>/<档>/`,下到 `<目录>.partial/`、校验、解压、写 `cortico-runtime.json`,最后整个改名到位;
 * - 权重 `<模型根>/gpt-sovits/pretrained_models/<路径>`,每个文件下到 `.partial` 再改名，大小与 SHA-256 对上才算有。
 * 每个文件的来源按顺序尝试，前一个失败(网络、HTTP 状态、校验)才试下一个。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, rmdirSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
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

/** 是不是目录联接/符号链接：lstat 说是就算，老 Node 把联接当目录报时再用 readlink 兜底。 */
export function isLinkEntry(path: string): boolean {
  try {
    if (lstatSync(path).isSymbolicLink()) return true;
  } catch {
    return false;
  }
  try { readlinkSync(path); return true; } catch { return false; }
}

/**
 * 只删联接本身，绝不递归跟着目标走。
 * Windows 上对目录联接 `unlink` 会 EPERM/EISDIR（有的 Node/Electron 版本直接报「Path is a directory」），
 * 这时退到 `rmdir`——RemoveDirectory 只摘掉重解析点，权重目录原地不动。
 */
export function removeLink(path: string): void {
  try {
    unlinkSync(path);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EISDIR' && code !== 'EBUSY' && code !== 'ENOTEMPTY') throw err;
  }
  rmdirSync(path);
}

/**
 * 删目录但绝不跟着联接走。Windows 上 `rmSync(dir, { recursive: true })` 会进入目录联接
 * (运行时的 `GPT_SoVITS/pretrained_models` 就是指向权重目录的 junction)，把目标里的权重一起删掉。
 * 这里先逐层拆掉联接，再删真实目录。
 */
export function removeTreeSafely(dir: string): void {
  let entries: import('node:fs').Dirent[] = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { /* 目录不存在 */ }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (isLinkEntry(path)) { removeLink(path); continue; }
    if (entry.isDirectory()) removeTreeSafely(path);
  }
  rmSync(dir, { recursive: true, force: true });
}

/** 把一个地址下到 `dest`；`resume` 时从已有字节接着下（魔搭的签名地址会过期，重试拿到的是新签名）。 */
async function fetchTo(url: string, dest: string, onBytes: (n: number) => void, signal: AbortSignal, resume = false): Promise<void> {
  const existing = resume && existsSync(dest) ? statSync(dest).size : 0;
  const res = await fetch(url, {
    signal,
    redirect: 'follow',
    headers: existing > 0 ? { range: `bytes=${existing}-` } : undefined,
  });
  if (!res.ok || !res.body) {
    // 416：服务器认为已经下全了（大小校验交给上层）。
    if (res.status === 416 && existing > 0) return;
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  // 服务器认 Range 才追加；不认就整段重来，别把两个副本拼在一起。
  const append = existing > 0 && res.status === 206;
  if (!append && existing > 0) rmSync(dest, { force: true });
  const counter = new Transform({
    transform(chunk: Buffer, _e, cb) { onBytes(chunk.length); cb(null, chunk); },
  });
  mkdirSync(dirname(dest), { recursive: true });
  await pipeline(
    Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
    counter,
    createWriteStream(dest, { flags: append ? 'a' : 'w' }),
    { signal },
  );
}

/**
 * 按顺序试来源，直到下下来的文件大小与 SHA-256 都对。
 *
 * 大文件（运行时 1–4 GB）在国内常见两种死法：
 * 1. 魔搭返回的是带 `auth_key` 的临时地址，下到一半签名过期 → 连接断在 99%；
 * 2. 家宽掉线几秒。
 * 所以每个来源先重试 `attempts` 次，**保留已下字节**、下一轮带 `Range` 续传；
 * 只有校验失败（内容坏了）才删掉重来。
 */
export async function fetchVerified(
  sources: readonly string[],
  dest: string,
  bytes: number,
  sha256: string,
  progress: (n: number) => void,
  signal: AbortSignal,
  opts: { resume?: boolean; attempts?: number; onStart?: (size: number) => void } = {},
): Promise<void> {
  const { resume = false, attempts = 3, onStart } = opts;
  const errors: string[] = [];
  for (const url of sources) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let got = 0;
      try {
        const start = resume && existsSync(dest) ? statSync(dest).size : 0;
        onStart?.(start);
        await fetchTo(url, dest, (n) => { got += n; progress(n); }, signal, resume);
        const size = statSync(dest).size;
        if (bytes && size !== bytes) throw new Error(`大小 ${size},应为 ${bytes}`);
        if (sha256 && await sha256File(dest) !== sha256) {
          // 内容不对，续传也没意义：删掉再来。
          rmSync(dest, { force: true });
          throw new Error('SHA-256 不符');
        }
        return;
      } catch (err) {
        if (signal.aborted) throw err;
        if (!resume) {
          progress(-got);
          rmSync(dest, { force: true });
        }
        errors.push(`${url}${attempt > 1 ? `（第 ${attempt} 次）` : ''}: ${err instanceof Error ? err.message : String(err)}`);
        // 续传模式下保留已下字节，下一轮从断点continue；非续传模式已经清干净了。
        if (!resume) break;
      }
    }
  }
  throw new Error(errors.slice(-6).join('\n') || '没有下载来源');
}

/** 下载前看一眼目标盘的剩余空间：运行时要「下载 + 解压」双份余量。 */
export function assertFreeSpace(dir: string, needBytes: number): void {
  try {
    const stats = statfsSync(dir);
    const free = Number(stats.bavail) * Number(stats.bsize);
    const need = Math.ceil(needBytes * 2.2) + 512 * 1024 * 1024;
    if (free < need) {
      const gb = (n: number): string => (n / 1024 ** 3).toFixed(1);
      throw new Error(`磁盘空间不足：还要约 ${gb(need)} GB（下载 + 解压），目标盘只剩 ${gb(free)} GB`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('磁盘空间不足')) throw err;
    // 盘符读不到统计（网络盘、权限）就当没问题，交给下载自己报错。
  }
}

/** Windows 10 起自带 bsdtar,能解 zip;PATH 上靠前的 Git tar 不认 zip,所以写全路径。 */
export function extract(archive: string, into: string): Promise<void> {
  const tar = process.platform === 'win32' ? resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return new Promise((done, fail) => {
    const child = spawn(tar, ['-xf', archive, '-C', into], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') fail(new Error('系统里找不到 tar.exe（Windows 10 1803 起自带）；请升级系统或用「自备运行时目录」'));
      else fail(err);
    });
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
    // 先把上一轮留下的半成品清掉（下载的是压缩包本身，不跨次续传）。
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    // 空间不够时，下载到 100% 才会在解压那一步炸——先看盘，直接说清楚。
    assertFreeSpace(dir, asset.bytes);
    const archive = join(partial, asset.file);
    this.state.total = asset.bytes;
    this.state.detail = asset.file;
    const progress = (n: number) => { this.state.done = Math.max(0, this.state.done + n); };
    const onStart = (size: number) => { this.state.done = size; };
    try {
      await fetchVerified(asset.sources, archive, asset.bytes, asset.sha256, progress, signal, { resume: true, onStart });
    } catch (whole) {
      if (!asset.parts?.length || signal.aborted) throw whole;
      await this.fetchParts(asset.parts, archive, asset.sha256, progress, signal, onStart);
    }
    this.state.detail = '正在解压';
    await extract(archive, partial);
    rmSync(archive, { force: true });
    if (!isRuntimeDir(partial)) {
      throw new Error('压缩包解压后没有 runtime/python.exe，疑似下载或解压不完整；请重试，仍失败可换用「自备运行时目录」');
    }
    writeFileSync(join(partial, 'cortico-runtime.json'), JSON.stringify({ id: 'gpt-sovits', version: RUNTIME_VERSION, upstream: UPSTREAM_COMMIT, tier: this.tier() }, null, 2));
    this.state.detail = '正在替换运行时目录';
    let stale: string | null = null;
    try {
      try {
        removeTreeSafely(dir);
      } catch {
        // 旧目录里有删不掉的东西（多半是被占用的目录联接）：改名不需要删除权限，先整个挪开，装完再清。
        if (existsSync(dir)) {
          stale = `${dir}.old-${Date.now()}`;
          renameSync(dir, stale);
        }
      }
      renameSync(partial, dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EBUSY') {
        throw new Error('替换运行时目录失败：推理服务还在占用文件。请先在「语音」页停止推理服务，再重装运行时。');
      }
      throw err;
    }
    if (stale) {
      try { removeTreeSafely(stale); } catch { /* 清不掉就留着，不影响这次安装 */ }
    }
  }

  /** 分片逐个下完拼回整包，再校验整包的 SHA-256；每个分片也支持续传。 */
  private async fetchParts(
    parts: NonNullable<(typeof RUNTIME_ASSETS)[Tier]['parts']>,
    archive: string,
    sha256: string,
    progress: (n: number) => void,
    signal: AbortSignal,
    onStart: (size: number) => void,
  ): Promise<void> {
    this.state.done = 0;
    rmSync(archive, { force: true });
    for (const [i, part] of parts.entries()) {
      const file = `${archive}.part${i + 1}`;
      await fetchVerified(part.sources, file, part.bytes, '', progress, signal, { resume: true, onStart });
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
    assertFreeSpace(this.dir(), this.state.total);
    for (const f of todo) {
      this.state.detail = f.path;
      const dest = join(this.dir(), f.path);
      const partial = `${dest}.partial`;
      const base = this.state.done;
      await fetchVerified(f.sources, partial, f.bytes, f.sha256, (n) => { this.state.done += n; }, signal, {
        resume: true,
        onStart: (size) => { this.state.done = base + size; },
      });
      renameSync(partial, dest);
    }
  }
}
