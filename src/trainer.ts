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
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { RUNTIME_VERSION, TRAIN_ASSETS, type ModelVersion, type PinnedFile } from './catalog.ts';
import { extract, fetchVerified } from './install.ts';
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
  logTail: string[];
}

/**
 * 训练 WebUI 要的依赖；上游 `requirements.txt` 里与本面板相关的那几个。
 * fastapi/starlette 必须钉住：gradio 4.44.1 配新版(0.143/1.8)时首页模板渲染报
 * `unhashable type: 'dict'`，launch() 自检失败直接退出——2026-10-27 实机踩过。
 */
const TRAIN_PACKAGES = ['gradio<5', 'tensorboard', 'funasr>=1.3.7', 'modelscope', 'ctranslate2>=4.0,<5', 'fastapi==0.115.2', 'starlette==0.40.0', 'faster-whisper==1.2.1'];

/**
 * 训练依赖先走阿里云镜像（国内直连 PyPI 下几十到几百 MB 的包经常卡住；清华源对 pip 的 UA 返回 403，
 * 不能当主力），镜像失败再回官方 PyPI；网络参数收紧，免得默认重试把面板卡在「安装中」。
 */
const PIP_MIRROR = 'https://mirrors.aliyun.com/pypi/simple/';
const PIP_OFFICIAL = 'https://pypi.org/simple';
const PIP_NET_ARGS = ['--timeout', '30', '--retries', '2'];

/** faster-whisper 的模型托管在 Hugging Face；训练 WebUI 里指向国内镜像，缺模型时才下得动。 */
const HF_ENDPOINT_MIRROR = 'https://hf-mirror.com';

/** 依赖装好的标记文件，放在数据目录。 */
const DEPS_FILE = 'trainer-deps.json';

/**
 * 依赖清单的修订号。`TRAIN_PACKAGES` 增删后 +1:光比运行时版本的话，
 * 老用户标记仍算「已装好」，新加的那几个包永远落不了地(0.5.11 加 faster-whisper 时踩到)。
 */
const DEPS_REVISION = 2;

/** 上游 `webui.py` 写死的默认端口；补丁没生效时才用它兜底。 */
const UPSTREAM_PORT = 9874;

/**
 * 训练 WebUI 要的工具目录。老运行时包只打进了推理要用的东西，这两个目录不在里面，
 * 而 `webui.py` 一启动就 `from tools.asr.config import asr_dict`——缺了就是一句 ModuleNotFoundError 后静默退出。
 */
const TOOL_DIRS = ['asr', 'uvr5'];

/**
 * 补齐用的上游整包：只有六兆多，缺哪个目录就下一份整包、解出目录复制过去。
 * 整包跟着上游 main 变，没有固定大小与 SHA-256，所以下载只做续传重试，成不成看能不能解出目录。
 */
const UPSTREAM_ZIP = 'gpt-sovits-upstream.zip';
const UPSTREAM_SOURCES = [
  'https://ghfast.top/https://github.com/RVC-Boss/GPT-SoVITS/archive/refs/heads/main.zip',
  'https://gh-proxy.com/https://github.com/RVC-Boss/GPT-SoVITS/archive/refs/heads/main.zip',
  'https://github.com/RVC-Boss/GPT-SoVITS/archive/refs/heads/main.zip',
];
/** 实测 6,874,704 字节，只用来算进度百分比。 */
const UPSTREAM_APPROX_BYTES = 6_874_704;

/** 首次加载要读模型进内存，慢的机器上要一两分钟。 */
const READY_TIMEOUT_MS = 300_000;
const POLL_MS = 500;
const LOG_RING = 200;
const LOG_TAIL = 40;

/** 依赖是否装好：标记文件在，运行时版本与清单修订号都对得上(升级运行时或改了包列表就要重装)。 */
function depsReady(dataDir: string): boolean {
  const file = join(dataDir, DEPS_FILE);
  if (!existsSync(file)) return false;
  try {
    const mark = JSON.parse(readFileSync(file, 'utf8')) as { runtime?: unknown; revision?: unknown };
    return mark.runtime === RUNTIME_VERSION && mark.revision === DEPS_REVISION;
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
      deps: this.depsInstalling ? 'installing' : depsReady(this.opts.dataDir) ? 'ready' : 'missing',
      depsError: this.depsError,
      assets,
      assetsReady: assets.every((a) => a.ready),
      assetsWorking: this.assetsWorking,
      assetsError: this.assetsError,
      running: this.running,
      starting: this.starting,
      port: this.port,
      url: this.url,
      logTail: this.tail.slice(-LOG_TAIL),
    };
  }

  /** 装训练依赖；已在装时返回同一份 promise。 */
  installDeps(): Promise<void> {
    if (this.depsPromise) return this.depsPromise;
    this.depsInstalling = true;
    this.depsError = null;
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
      const runtimeBin = join(runtimeDir, 'runtime');
      this.push(`启动训练 WebUI，期望端口 ${port}`);
      child = spawn(join(runtimeBin, 'python.exe'), ['-I', '-X', 'utf8', '-u', 'webui.py'], {
        cwd: runtimeDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `${runtimeBin};${process.env.PATH ?? ''}`,
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
        this.opts.log.warn('训练 WebUI 启动失败', { error: err.message });
      });
      const started = Date.now();
      while (this.child === child && Date.now() - started < READY_TIMEOUT_MS) {
        const hit = await trainerAnswers(port, patched);
        if (this.child !== child) break;
        if (hit) {
          this.running = true;
          this.starting = false;
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
    this.push(`缺少 ${label}，正在从上游整包补齐（约 ${Math.round(UPSTREAM_APPROX_BYTES / 1024 ** 2)} MB）`);
    let got = 0;
    let shown = 0;
    const signal = new AbortController().signal;
    try {
      await fetchVerified(UPSTREAM_SOURCES, archive, 0, '', (n) => {
        got += n;
        // 每过 25% 报一次，别把日志尾巴刷满。
        const step = Math.floor((got / UPSTREAM_APPROX_BYTES) * 4);
        if (step > shown) {
          shown = step;
          this.push(`上游整包 ${Math.min(step * 25, 100)}%`);
        }
      }, signal, { resume: true, onStart: (size) => { got = size; } });
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

  /** 跑 pip 装依赖；镜像失败回官方，退出码非 0 就把尾部日志当失败原因。 */
  private async runInstall(): Promise<void> {
    this.push(`pip install ${TRAIN_PACKAGES.join(' ')}`);
    const base = ['-I', '-X', 'utf8', '-u', '-m', 'pip', 'install', '--no-warn-script-location', ...PIP_NET_ARGS, ...TRAIN_PACKAGES];
    this.push(`装训练依赖走镜像：${PIP_MIRROR}`);
    let code = await this.pip([...base, '-i', PIP_MIRROR]);
    if (code !== 0) {
      this.push('镜像源没装成，改用官方 PyPI 重试');
      this.opts.log.warn('训练依赖镜像源失败，改走官方 PyPI', { tail: this.tail.slice(-5) });
      code = await this.pip([...base, '-i', PIP_OFFICIAL]);
    }
    if (code === 0) {
      mkdirSync(this.opts.dataDir, { recursive: true });
      writeFileSync(join(this.opts.dataDir, DEPS_FILE), JSON.stringify({ runtime: RUNTIME_VERSION, revision: DEPS_REVISION, at: new Date().toISOString() }, null, 2));
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
      const runtimeBin = join(runtimeDir, 'runtime');
      const child = spawn(join(runtimeBin, 'python.exe'), args, {
        cwd: runtimeDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${runtimeBin};${process.env.PATH ?? ''}` },
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
        await fetchVerified(f.sources, partial, f.bytes, f.sha256, () => {}, signal);
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
      else child.kill('SIGTERM');
      setTimeout(done, 5000).unref();
    });
  }
}
