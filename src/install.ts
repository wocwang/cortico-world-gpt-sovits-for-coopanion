/**
 * 运行时与权重的下载安装，目录约定见 Cortico `docs/runtimes.md`:
 * - 运行时 `<运行时根>/gpt-sovits/<版本>/<档>/`,下到 `<目录>.partial/`、校验、解压、写 `cortico-runtime.json`,最后整个改名到位;
 * - 权重 `<模型根>/gpt-sovits/pretrained_models/<路径>`,每个文件下到 `.partial` 再改名，大小与 SHA-256 对上才算有。
 * 每个文件的来源按顺序尝试，前一个失败(网络、HTTP 状态、校验)才试下一个。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, rmdirSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Logger } from 'cortico/core/types.ts';
import { MODEL_FILES, NLTK_ASSET, RUNTIME_ASSETS, RUNTIME_VERSION, UPSTREAM_COMMIT, type ModelVersion, type PinnedFile } from './catalog.ts';
import type { Tier } from './config.ts';
import { longPathsEnabled, pathTooLong } from './gpu.ts';
import { pythonInRuntime, runtimePublished, tarBinary, type Platform } from './platform.ts';

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

/**
 * ROCm 运行时的路径预检。hipBLASLt 的 TensileLibrary 文件名让绝对路径达到 272 字符，
 * 系统没开长路径时进程会在第一个线性层直接 `0xC0000005`（安装期则是 pip 的 OSError）。
 * Cortico 不改系统策略，所以这里只拒绝安装、把开关命令交给操作者；换短路径也行。
 */
export function rocmPathProblem(installDir: string, longPaths: boolean | null): string | null {
  if (!pathTooLong(installDir)) return null;
  if (longPaths === true) return null;
  const reason = longPaths === false ? '系统没有开启长路径支持' : '读不到长路径开关，请先确认已开启';
  return [
    `安装路径太长（${installDir.length} 字符）：ROCm 内核库的文件名会超过 Windows 的 260 字符上限，${reason}。`,
    '两条路：把 Coopanion 装到更短的目录，或由你自己开启长路径后重试：',
    'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f',
    '改完建议重启系统。插件不会自己改注册表。',
  ].join('\n');
}

/** 装 ROCm 档前调用；路径超限且开关没开时抛出带解决步骤的错误。长路径是 Windows 的限制，别的平台不用查。 */
export async function assertRocmPaths(dir: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const problem = rocmPathProblem(dir, await longPathsEnabled());
  if (problem) throw new Error(problem);
}

/** Windows 10 起自带 bsdtar,能解 zip;PATH 上靠前的 Git tar 不认 zip,所以写全路径。macOS 用系统自带的 /usr/bin/tar。 */
export function extract(archive: string, into: string): Promise<void> {
  const tar = tarBinary();
  return new Promise((done, fail) => {
    const child = spawn(tar, ['-xf', archive, '-C', into], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') fail(new Error(`系统里找不到 ${tar}（Windows 10 1803 起自带 tar，macOS 用系统自带的 /usr/bin/tar）；请升级系统或改用「自备运行时目录」`));
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

/** 一档运行时;`dir()` 下有 `runtime/python.exe`（macOS 是 `runtime/bin/python3`）与 `api_v2.py` 才算装好。 */
export class RuntimeJob extends Job {
  constructor(private readonly root: () => string, private readonly tier: () => Tier) { super(); }

  dir(): string {
    return join(this.root(), 'gpt-sovits', RUNTIME_VERSION, this.tier());
  }

  /** 这个平台这一档有没有发布包：内置运行时包都是 win-x64，macOS 只能填「自备运行时目录」。 */
  published(): boolean {
    return runtimePublished(RUNTIME_ASSETS[this.tier()].bytes);
  }

  bytes(): number {
    return RUNTIME_ASSETS[this.tier()].bytes;
  }

  protected present(): boolean {
    return isRuntimeDir(this.dir());
  }

  protected async work(signal: AbortSignal): Promise<void> {
    const asset = RUNTIME_ASSETS[this.tier()];
    if (process.platform !== 'win32') throw new Error('内置运行时包只有 Windows 版；请在配置里填写「自备运行时目录」（含 runtime/ 与 api_v2.py 的 GPT-SoVITS 目录）');
    if (!asset.bytes) throw new Error('这一档还没有发布运行时包');
    const dir = this.dir();
    const partial = `${dir}.partial`;
    // 先把上一轮留下的半成品清掉（下载的是压缩包本身，不跨次续传）。
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    // ROCm 的库文件名会撞 260 字符上限；装完才发现就白下几个 GB。
    if (this.tier() === 'rocm') await assertRocmPaths(dir);
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

export const isRuntimeDir = (dir: string, platform: Platform = process.platform): boolean =>
  existsSync(pythonInRuntime(dir, platform)) && existsSync(join(dir, 'api_v2.py'));

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

/**
 * g2p_en 处理英文单词时要的两份资源。ROCm 运行包曾经一份都没有（CPU 包有全套），
 * 中文里夹一个英文词就整句失败。
 */
const NLTK_REQUIRED: ReadonlyArray<readonly [string, string]> = [
  ['corpora', 'cmudict'],
  ['taggers', 'averaged_perceptron_tagger_eng'],
];

/** 目录里缺哪些语料（返回 `kind/name` 列表，空表示齐了）。 */
export function missingNltkResources(root: string): string[] {
  return NLTK_REQUIRED.filter(([kind, name]) => !existsSync(join(root, kind, name))).map(([kind, name]) => `${kind}/${name}`);
}

/** 运行时自带语料且齐全——不满就当作「缺」，因为缺一份和缺全部对 g2p_en 是一样的。 */
export function hasNltkData(runtimeDir: string): boolean {
  return missingNltkResources(join(runtimeDir, 'runtime', 'nltk_data')).length === 0;
}

/**
 * 把语料复制进运行时目录，已存在的文件不覆盖（运行包自带的优先）。返回复制的文件数。
 * 之所以要复制：上游 `tools/portable_runtime.py` 在 `activate()` 里把 `NLTK_DATA` **硬赋值**成
 * `<运行时>/runtime/nltk_data`，插件通过环境变量指过去的目录会被覆盖——只补到数据目录等于没补
 * （0.6.3–0.6.6 的 ROCm 档就是这样：补了、变量也设了，一句英文学名照样整句失败）。
 */
export function mirrorNltkData(from: string, to: string): number {
  let copied = 0;
  const walk = (src: string, dest: string): void => {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const source = join(src, entry.name);
      const target = join(dest, entry.name);
      if (entry.isDirectory()) walk(source, target);
      else if (entry.isFile() && !existsSync(target)) {
        copyFileSync(source, target);
        copied += 1;
      }
    }
  };
  walk(from, to);
  return copied;
}

/**
 * 缺 NLTK 语料时下一份补齐包到 `dataDir/nltk_data`，并**同步进运行时目录**
 * （`<runtime>/runtime/nltk_data`，即运行时自己硬指的那个位置）。
 * 只影响「台词里夹英文」的句子；任何一步失败只记日志，不拦启动。
 */
export async function ensureNltkData(runtimeDir: string, dataDir: string, log: Logger): Promise<string | null> {
  const bundled = join(runtimeDir, 'runtime', 'nltk_data');
  if (missingNltkResources(bundled).length === 0) return null;

  const dir = join(dataDir, 'nltk_data');
  if (missingNltkResources(dir).length > 0) {
    const zip = join(dataDir, NLTK_ASSET.path);
    try {
      mkdirSync(dataDir, { recursive: true });
      await fetchVerified(NLTK_ASSET.sources, zip, NLTK_ASSET.bytes, NLTK_ASSET.sha256, () => {}, new AbortController().signal);
      await extract(zip, dataDir);
      rmSync(zip, { force: true });
      if (missingNltkResources(dir).length > 0) throw new Error('补齐包里语料不全');
      log.info('已补齐 NLTK 语料（cmudict / averaged_perceptron_tagger_eng）', { dir });
    } catch (err) {
      rmSync(zip, { force: true });
      log.warn('NLTK 语料没下成，含英文的台词可能合成失败', { err: String(err) });
      return null;
    }
  }

  try {
    const copied = mirrorNltkData(dir, bundled);
    log.info('已把 NLTK 语料同步进运行时（运行时会把 NLTK_DATA 指回这里）', { into: bundled, files: copied });
  } catch (err) {
    log.warn('NLTK 语料没能同步进运行时目录，含英文的台词可能仍会失败', { err: String(err) });
  }
  return dir;
}
