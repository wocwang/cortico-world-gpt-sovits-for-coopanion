/**
 * 训练面板的后端：可选装训练依赖、可选下训练资源、在本机起上游训练 WebUI。
 *
 * 训练 WebUI 就是运行时里的 `webui.py`，起法与推理服务同款(工作目录为运行时根,`runtime/` 在 PATH 最前，
 * `-I` 下环境变量不生效，端口只能走补丁读环境变量)。启动前给它打一处(只绑回环)的补丁，
 * 打不上就退回上游默认端口 9874。
 *
 * 装依赖与下资源都是长任务：方法立刻返回，面板轮询 `state()` 看进度；同一时间只跑一份(重复调用拿同一个 promise)。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { RUNTIME_VERSION, TRAIN_ASSETS, UPSTREAM_COMMIT, type ModelVersion, type PinnedFile } from './catalog.ts';
import { extract, fetchVerified, sourceLabel } from './install.ts';
import { envWithRuntime, pythonInRuntime } from './platform.ts';
import { patchTrainer, TRAINER_PATCH_MARKER } from './runtime-patch.ts';
import { freePort } from './server.ts';

export interface TrainerState {
  deps: 'missing' | 'installing' | 'ready';
  depsError: string | null;
  assets: Array<{ name: string; bytes: number; ready: boolean }>;
  assetsReady: boolean;
  assetsWorking: boolean;
  assetsError: string | null;
  running: boolean;
  starting: boolean;
  port: number | null;
  url: string | null;
  /** 上次启动失败的原因（含 `No module named …` 这类依赖缺失），面板直接显示；重试/成功时清空。 */
  startError: string | null;
  logTail: string[];
}

/**
 * 训练 WebUI 要的依赖；上游 `requirements.txt` 里与本面板相关的那几个。
 * fastapi/starlette 必须钉住：gradio 4.44.1 配新版(0.143/1.8)时首页模板渲染报
 * `unhashable type: 'dict'`，launch() 自检失败直接退出——2026-10-27 实机踩过。
 */
const TRAIN_PACKAGES = ['gradio<5', 'tensorboard', 'funasr>=1.3.7', 'modelscope', 'ctranslate2>=4.0,<5', 'fastapi==0.115.2', 'starlette==0.40.0', 'faster-whisper==1.2.1'];

/**
 * 训练依赖的 pip 源，按顺序尝试：阿里云 → 清华 → 官方 PyPI。
 * 国内直连 PyPI 下几十到几百 MB 的包经常卡住；两个镜像都可能临时限流/抽风，所以互为备份，
 * 都失败才回官方。网络参数收紧，免得默认重试把面板卡在「安装中」。
 */
const PIP_SOURCES = [
  'https://mirrors.aliyun.com/pypi/simple/',
  'https://pypi.tuna.tsinghua.edu.cn/simple',
  'https://pypi.org/simple',
];
const PIP_NET_ARGS = ['--timeout', '30', '--retries', '2'];

/** faster-whisper 的模型托管在 Hugging Face；训练 WebUI 里指向国内镜像，缺模型时才下得动。 */
const HF_ENDPOINT_MIRROR = 'https://hf-mirror.com';

/** 依赖装好的标记文件，放在数据目录。 */
const DEPS_FILE = 'trainer-deps.json';

/**
 * 依赖清单的修订号。`TRAIN_PACKAGES` 增删后 +1:光比运行时版本的话，
 * 老用户标记仍算「已装好」，新加的那几个包永远落不了地(0.5.11 加 faster-whisper 时踩到)。
 */
export const DEPS_REVISION = 2;

/** 上游 `webui.py` 写死的默认端口；补丁没生效时才用它兜底。 */
const UPSTREAM_PORT = 9874;

/**
 * 训练 WebUI 要的工具目录。老运行时包只打进了推理要用的东西，这两个目录不在里面，
 * 而 `webui.py` 一启动就 `from tools.asr.config import asr_dict`——缺了就是一句 ModuleNotFoundError 后静默退出。
 */
const TOOL_DIRS = ['asr', 'uvr5'];

/**
 * 补齐用的上游整包：钉住 `UPSTREAM_COMMIT` 的归档（不是会变的 main），大小与 SHA-256 固定，
 * 下载后要校验通过才解压。缺哪个目录就下一份整包、解出目录复制过去。
 * 归档在国内走 ghfast / gh-proxy，最后才回官方 GitHub。
 */
const UPSTREAM_ZIP = 'gpt-sovits-upstream.zip';
const UPSTREAM_ARCHIVE = `https://github.com/RVC-Boss/GPT-SoVITS/archive/${UPSTREAM_COMMIT}.zip`;
const UPSTREAM_SOURCES = [
  `https://ghfast.top/${UPSTREAM_ARCHIVE}`,
  `https://gh-proxy.com/${UPSTREAM_ARCHIVE}`,
  UPSTREAM_ARCHIVE,
];
/** 实测 6,875,312 字节；两个镜像与官方归档的 SHA-256 一致（2026-10-31 实核）。 */
const UPSTREAM_BYTES = 6_875_312;
const UPSTREAM_SHA256 = 'f15d53e6c8947f71d0b956b3becabb7d3e6829048ae83d36c72d02c21fa324bd';

/** 首次加载要读模型进内存，慢的机器上要一两分钟。 */
const READY_TIMEOUT_MS = 300_000;
const POLL_MS = 500;
const LOG_RING = 200;
const LOG_TAIL = 40;

/** 运行时目录归一化：Windows 不区分大小写与斜杠，避免同一个目录因写法不同被判成两个。 */
function runtimeKey(dir: string): string {
  const full = resolve(dir).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? full.replace(/\//g, '\\').toLowerCase() : full;
}

/**
 * 当前运行时自带的 site-packages。包名目录是「装没装」的可信证据：
 * 运行时目录被整目录替换/换档后，标记文件可能还在，但这些目录会一起消失。
 */
function sitePackages(runtimeDir: string): string[] {
  const root = join(runtimeDir, 'runtime');
  if (process.platform === 'win32') return [join(root, 'Lib', 'site-packages')];
  try {
    return readdirSync(join(root, 'lib'))
      .filter((name) => /^python\d+\.\d+$/.test(name))
      .map((name) => join(root, 'lib', name, 'site-packages'));
  } catch {
    return [];
  }
}

/** site-packages 里某个包的已装版本；没有 `dist-info` 就返回 null（手动拷进去的目录不算数）。 */
function packageVersion(runtimeDir: string, name: string): string | null {
  const pattern = new RegExp(`^${name.replace(/[-_.]/g, '[-_.]')}-(\\d[^-]*)\\.dist-info$`, 'i');
  for (const dir of sitePackages(runtimeDir)) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const found = pattern.exec(entry);
      if (found) return found[1];
    }
  }
  return null;
}

/** 版本号按数字段比大小；解析不出的段按 0 算。 */
function versionAtLeast(version: string, want: readonly [number, number, number]): boolean {
  const parts = version.split(/[.+-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const got = parts[i] ?? 0;
    if (got !== want[i]) return got > want[i];
  }
  return true;
}

/**
 * 依赖是否真的可用：标记文件只说明「曾经装过」且必须绑定到**当前运行时目录**，
 * 还要在它的 `site-packages` 里看到 gradio / funasr。旧标记没有目录字段，一律视为过期。
 */
export function depsReady(dataDir: string, runtimeDir: string): boolean {
  if (!runtimeDir) return false;
  const file = join(dataDir, DEPS_FILE);
  if (!existsSync(file)) return false;
  try {
    const mark = JSON.parse(readFileSync(file, 'utf8')) as { runtime?: unknown; revision?: unknown; dir?: unknown };
    if (mark.runtime !== RUNTIME_VERSION || mark.revision !== DEPS_REVISION) return false;
    if (typeof mark.dir !== 'string' || runtimeKey(mark.dir) !== runtimeKey(runtimeDir)) return false;
    // 版本口径与 TRAIN_PACKAGES 对齐：手动装了 gradio 6.x 的机器上目录存在，但 webui.py 起不来。
    const gradio = packageVersion(runtimeDir, 'gradio');
    if (!gradio || !versionAtLeast(gradio, [4, 0, 0]) || versionAtLeast(gradio, [5, 0, 0])) return false;
    const funasr = packageVersion(runtimeDir, 'funasr');
    return !!funasr && versionAtLeast(funasr, [1, 3, 7]);
  } catch {
    return false;
  }
}

/** 一个训练资源是否已在权重目录里就位。 */
function assetReady(weightsDir: string, f: PinnedFile): boolean {
  const path = join(weightsDir, f.path);
  return existsSync(path) && (!f.bytes || statSync(path).size === f.bytes);
}

/** 就绪探测：补丁生效时只认期望端口；没生效时同时试上游默认端口。`GET /` 状态码小于 500 就算起来了。 */
async function trainerAnswers(port: number, patched: boolean): Promise<{ url: string; port: number } | null> {
  for (const p of patched ? [port] : [port, UPSTREAM_PORT]) {
    const url = `http://127.0.0.1:${p}`;
    try {
      const res = await fetch(`${url}/`, { signal: AbortSignal.timeout(2000) });
      await res.body?.cancel();
      if (res.status < 500) return { url, port: p };
    } catch { /* 还没起来 */ }
  }
  return null;
}

export class TrainerManager {
  private readonly tail: string[] = [];
  private child: ChildProcess | null = null;
  private running = false;
  private starting = false;
  private port: number | null = null;
  private url: string | null = null;
  private depsInstalling = false;
  private depsError: string | null = null;
  private depsPromise: Promise<void> | null = null;
  private assetsWorking = false;
  private assetsError: string | null = null;
  private assetsPromise: Promise<void> | null = null;
  private startError: string | null = null;

  constructor(
    private readonly opts: {
      runtimeDir: () => string;
      weightsDir: () => string;
      dataDir: string;
      log: Logger;
      stopInference: () => Promise<void>;
      /** 本档的推理模型版本(v5turbo/v2ProPlus)：训练页默认版本跟着它走。 */
      modelVersion: () => ModelVersion;
    },
  ) {}

  state(): TrainerState {
    const weightsDir = this.opts.weightsDir();
    const assets = TRAIN_ASSETS.map((f) => ({ name: f.path, bytes: f.bytes, ready: assetReady(weightsDir, f) }));
    return {
      deps: this.depsInstalling ? 'installing'
        : depsReady(this.opts.dataDir, this.opts.runtimeDir()) ? 'ready' : 'missing',
      depsError: this.depsError,
      assets,
      assetsReady: assets.every((a) => a.ready),
      assetsWorking: this.assetsWorking,
      assetsError: this.assetsError,
      running: this.running,
      starting: this.starting,
      port: this.port,
      url: this.url,
      startError: this.startError,
      logTail: this.tail.slice(-LOG_TAIL),
    };
  }

  /** 装训练依赖；已在装时返回同一份 promise。 */
  installDeps(): Promise<void> {
    if (this.depsPromise) return this.depsPromise;
    this.depsInstalling = true;
    this.depsError = null;
    this.startError = null;
    this.depsPromise = this.runInstall().finally(() => {
      this.depsInstalling = false;
      this.depsPromise = null;
    });
    return this.depsPromise;
  }

  /** 下训练资源；已在跑时返回同一份 promise。 */
  downloadAssets(): Promise<void> {
    if (this.assetsPromise) return this.assetsPromise;
    this.assetsWorking = true;
    this.assetsError = null;
    this.assetsPromise = this.runDownload().finally(() => {
      this.assetsWorking = false;
      this.assetsPromise = null;
    });
    return this.assetsPromise;
  }

  async start(opts: { stopInference?: boolean }): Promise<void> {
    if (this.running || this.starting) return;
    this.starting = true;
    this.startError = null;
    this.port = null;
    this.url = null;
    let child: ChildProcess | null = null;
    try {
      if (opts.stopInference) await this.opts.stopInference();
      const runtimeDir = this.opts.runtimeDir();
      // webui.py 启动即 `from tools.asr.config import asr_dict`；老运行时包不带这两个目录，
      // 直接起就是一句 ModuleNotFoundError 后静默退出，日志很难看懂。缺了就先从上游补。
      const missingTools = TOOL_DIRS.filter((d) => !existsSync(join(runtimeDir, 'tools', d)));
      if (missingTools.length) {
        try {
          await this.repairTools(runtimeDir, missingTools);
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          this.push(`运行时不完整，缺少 tools/${missingTools.join('、tools/')}，自动补齐失败：${why}`);
          this.startError = this.tail[this.tail.length - 1] ?? why;
          this.opts.log.warn('训练 WebUI 缺工具目录且补齐失败', { missing: missingTools, error: why });
          this.running = false;
          this.starting = false;
          return;
        }
        // 补齐期间可能被 stop() 叫停。
        if (!this.starting) return;
      }
      const port = await freePort();
      const result = patchTrainer(runtimeDir);
      const patched = result === 'patched' || result === 'already';
      if (result === 'patched') this.opts.log.info('训练 WebUI 已打补丁', { marker: TRAINER_PATCH_MARKER, port });
      else if (result !== 'already') this.opts.log.warn('训练 WebUI 补丁未生效，改用上游默认端口探测', { result });
      this.push(`启动训练 WebUI，期望端口 ${port}`);
      child = spawn(pythonInRuntime(runtimeDir), ['-I', '-X', 'utf8', '-u', 'webui.py'], {
        cwd: runtimeDir,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...envWithRuntime(runtimeDir),
          COOPANION_TRAINER_PORT: String(port),
          COOPANION_TRAINER_VERSION: this.opts.modelVersion(),
          // faster-whisper 缺模型时会从 Hugging Face 拉；国内直连不通，统一指向镜像。
          HF_ENDPOINT: HF_ENDPOINT_MIRROR,
        },
      });
      this.child = child;
      const onLine = (chunk: Buffer) => this.pushLines(chunk.toString('utf8'));
      child.stdout!.on('data', onLine);
      child.stderr!.on('data', onLine);
      child.on('exit', (code) => {
        if (this.child !== child) return;
        this.child = null;
        this.running = false;
        this.starting = false;
        this.port = null;
        this.url = null;
        this.push(`训练 WebUI 退出(${code})：${this.tail.slice(-3).join(' | ')}`);
        this.startError = this.failureFromTail();
        this.opts.log.warn('训练 WebUI 退出', { code, tail: this.tail.slice(-10) });
      });
      child.on('error', (err) => {
        if (this.child !== child) return;
        this.child = null;
        this.running = false;
        this.starting = false;
        this.port = null;
        this.url = null;
        this.push(`训练服务启动失败：${err.message}`);
        this.startError = `训练服务启动失败：${err.message}`;
        this.opts.log.warn('训练 WebUI 启动失败', { error: err.message });
      });
      const started = Date.now();
      while (this.child === child && Date.now() - started < READY_TIMEOUT_MS) {
        const hit = await trainerAnswers(port, patched);
        if (this.child !== child) break;
        if (hit) {
          this.running = true;
          this.starting = false;
          this.startError = null;
          this.port = hit.port;
          this.url = hit.url;
          this.push(`训练 WebUI 就绪：${hit.url}`);
          this.opts.log.info('训练 WebUI 就绪', { url: hit.url, ms: Date.now() - started });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      if (this.child !== child) {
        // 进程自己退了，或被 stop() 收了尾；原因已由退出钩子/stop() 写进日志。
        this.running = false;
        this.starting = false;
        this.port = null;
        this.url = null;
        return;
      }
      this.child = null;
      await TrainerManager.kill(child);
      this.running = false;
      this.starting = false;
      this.port = null;
      this.url = null;
      const tail = this.tail.slice(-3).join(' | ');
      this.push(`${READY_TIMEOUT_MS / 1000} 秒内没有就绪：${tail}`);
      this.startError = this.failureFromTail();
      this.opts.log.warn('训练 WebUI 超时未就绪', { tail });
    } catch (err) {
      if (child && this.child === child) {
        this.child = null;
        await TrainerManager.kill(child);
      }
      this.running = false;
      this.starting = false;
      this.port = null;
      this.url = null;
      const message = err instanceof Error ? err.message : String(err);
      this.push(`启动训练 WebUI 失败：${message}`);
      this.startError = `启动训练 WebUI 失败：${message}`;
      this.opts.log.warn('启动训练 WebUI 失败', { error: message });
    }
  }

  /**
   * 缺的工具目录从上游整包补：解开后是一层 `GPT-SoVITS-main/`，把缺的目录整个复制进运行时根。
   * 解不出来或里面没有该目录都算失败，让调用方把原因说清楚。
   */
  private async repairTools(runtimeDir: string, dirs: string[]): Promise<void> {
    const cache = join(this.opts.dataDir, 'cache');
    const archive = join(cache, UPSTREAM_ZIP);
    const unpack = join(cache, 'upstream');
    const label = `tools/${dirs.join('、tools/')}`;
    mkdirSync(cache, { recursive: true });
    this.push(`缺少 ${label}，正在从上游整包补齐（约 ${Math.round(UPSTREAM_BYTES / 1024 ** 2)} MB）`);
    let got = 0;
    let shown = 0;
    let source = '';
    const signal = new AbortController().signal;
    try {
      await fetchVerified(UPSTREAM_SOURCES, archive, UPSTREAM_BYTES, UPSTREAM_SHA256, (n) => {
        got += n;
        // 每过 25% 报一次，别把日志尾巴刷满。
        const step = Math.floor((got / UPSTREAM_BYTES) * 4);
        if (step > shown) {
          shown = step;
          this.push(`上游整包 ${Math.min(step * 25, 100)}%`);
        }
      }, signal, {
        resume: true,
        onStart: (size) => { got = size; },
        onSource: (url) => {
          const host = sourceLabel(url);
          if (host === source) return;
          source = host;
          this.push(`上游整包来源：${host}`);
        },
      });
      rmSync(unpack, { recursive: true, force: true });
      mkdirSync(unpack, { recursive: true });
      await extract(archive, unpack);
      const root = readdirSync(unpack, { withFileTypes: true })
        .find((e) => e.isDirectory() && existsSync(join(unpack, e.name, 'tools', 'asr')));
      if (!root) throw new Error('解出来的整包里没有 tools/asr');
      for (const dir of dirs) {
        const from = join(unpack, root.name, 'tools', dir);
        if (!existsSync(from)) throw new Error(`整包里没有 tools/${dir}`);
        cpSync(from, join(runtimeDir, 'tools', dir), { recursive: true, force: true });
      }
      this.push(`已补齐 ${label}`);
      this.opts.log.info('训练 WebUI 缺的工具目录已从上游补齐', { dirs, zipBytes: got });
    } finally {
      rmSync(unpack, { recursive: true, force: true });
      rmSync(archive, { force: true });
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.running = false;
    this.starting = false;
    this.port = null;
    this.url = null;
    if (!child?.pid || child.exitCode !== null) return;
    this.opts.log.info('停止训练 WebUI', { pid: child.pid });
    this.push('停止训练 WebUI');
    await TrainerManager.kill(child);
  }

  /** 跑 pip 装依赖；按 阿里云 → 清华 → 官方 PyPI 依次尝试，退出码非 0 就把尾部日志当失败原因。 */
  private async runInstall(): Promise<void> {
    this.push(`pip install ${TRAIN_PACKAGES.join(' ')}`);
    const base = ['-I', '-X', 'utf8', '-u', '-m', 'pip', 'install', '--no-warn-script-location', ...PIP_NET_ARGS, ...TRAIN_PACKAGES];
    let code = -1;
    for (const [i, source] of PIP_SOURCES.entries()) {
      const last = i === PIP_SOURCES.length - 1;
      this.push(last ? `装训练依赖走官方 PyPI：${source}` : `装训练依赖走镜像：${source}`);
      code = await this.pip([...base, '-i', source]);
      if (code === 0) break;
      if (!last) {
        this.push(`这个源没装成，换下一个：${PIP_SOURCES[i + 1]}`);
        this.opts.log.warn('训练依赖源失败，换下一个源重试', { source, tail: this.tail.slice(-5) });
      }
    }
    if (code === 0) {
      mkdirSync(this.opts.dataDir, { recursive: true });
      // 标记绑定到具体运行时目录：换档 / 卸载重下后目录变了，旧标记自动失效。
      writeFileSync(join(this.opts.dataDir, DEPS_FILE), JSON.stringify({
        runtime: RUNTIME_VERSION,
        revision: DEPS_REVISION,
        dir: resolve(this.opts.runtimeDir()),
        at: new Date().toISOString(),
      }, null, 2));
      this.depsError = null;
      this.push('训练依赖装好了');
      this.opts.log.info('训练依赖安装完成', { packages: TRAIN_PACKAGES });
    } else {
      this.depsError = this.tail.slice(-LOG_TAIL).join('\n') || `pip 退出码 ${code}`;
      this.push(`装训练依赖失败，退出码 ${code}`);
      this.opts.log.warn('训练依赖安装失败', { code, tail: this.tail.slice(-10) });
    }
  }

  /** 跑一次 pip，输出进日志尾巴；返回退出码。 */
  private pip(args: string[]): Promise<number> {
    return new Promise((done) => {
      const runtimeDir = this.opts.runtimeDir();
      const child = spawn(pythonInRuntime(runtimeDir), args, {
        cwd: runtimeDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: envWithRuntime(runtimeDir),
      });
      const onLine = (chunk: Buffer) => this.pushLines(chunk.toString('utf8'));
      child.stdout!.on('data', onLine);
      child.stderr!.on('data', onLine);
      child.on('error', (err) => {
        this.push(`pip 启动失败：${err.message}`);
        done(-1);
      });
      child.on('exit', (code) => done(code ?? -1));
    });
  }

  /** 逐个下缺的训练资源：下到 `.partial`，校验过了再改名到位。 */
  private async runDownload(): Promise<void> {
    const weightsDir = this.opts.weightsDir();
    const signal = new AbortController().signal;
    try {
      for (const f of TRAIN_ASSETS) {
        if (assetReady(weightsDir, f)) continue;
        const dest = join(weightsDir, f.path);
        const partial = `${dest}.partial`;
        this.push(`下载训练资源 ${f.path}`);
        let source = '';
        await fetchVerified(f.sources, partial, f.bytes, f.sha256, () => {}, signal, {
          onSource: (url) => {
            const host = sourceLabel(url);
            if (host === source) return;
            source = host;
            this.push(`训练资源来源：${host}`);
          },
        });
        renameSync(partial, dest);
        this.push(`训练资源就位 ${f.path}`);
      }
      this.assetsError = null;
      this.opts.log.info('训练资源下载完成', { dir: weightsDir });
    } catch (err) {
      this.assetsError = err instanceof Error ? err.message : String(err);
      this.push(`下载训练资源失败：${this.assetsError}`);
      this.opts.log.warn('训练资源下载失败', { error: this.assetsError, tail: this.tail.slice(-LOG_TAIL) });
    }
  }

  /** 从日志尾部挑出最像根因的一行：优先 `No module named`，否则最后一行。 */
  private failureFromTail(): string | null {
    const tail = this.tail.slice(-LOG_TAIL);
    const missing = [...tail].reverse().find((line) => /No module named|ModuleNotFoundError/i.test(line));
    if (missing) {
      const name = /No module named '?([^'"\s]+)/i.exec(missing)?.[1];
      return `训练依赖缺失${name ? `：${name}` : ''}；点「安装训练依赖」补上再启动。`;
    }
    return tail[tail.length - 1] ?? null;
  }

  private push(line: string): void {
    this.tail.push(line);
    if (this.tail.length > LOG_RING) this.tail.shift();
  }

  private pushLines(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.push(line);
    }
  }

  /** 杀进程树，最多等 5 秒(照 `SovitsServer.stop`)。 */
  private static kill(child: ChildProcess): Promise<void> {
    return new Promise<void>((done) => {
      if (!child.pid || child.exitCode !== null) { done(); return; }
      child.once('exit', () => done());
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else if (process.platform === 'darwin') {
        // macOS：webui.py 在独立进程组里，按组收，别留下占端口的 Python 子进程。
        const pid = child.pid;
        try { process.kill(-pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* 已经退出 */ } }, 4000).unref();
      } else child.kill('SIGTERM');
      setTimeout(done, 5000).unref();
    });
  }
}
