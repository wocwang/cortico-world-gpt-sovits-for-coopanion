/**
 * 本机 GPT-SoVITS 推理服务：在运行时目录里以 `<运行时>/runtime/python.exe`（macOS 是 `runtime/bin/python3`）
 * 加 `-I -X utf8 -u api_v2.py` 起子进程(`-I` 下环境变量不生效，编码与无缓冲只能走参数)，监听 127.0.0.1 的空闲端口。
 * 启动方式与上游整合包的 go-webui.bat 一致(工作目录为运行时根,`runtime/` 在 PATH 最前)。
 * 托管运行时的 `GPT_SoVITS/pretrained_models` 在启动前接成指向权重目录的目录联接;自备目录原样使用。
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'cortico/core/types.ts';
import { weightPaths, type ModelVersion } from './catalog.ts';
import type { Tier } from './config.ts';
import { parseHipProbe, pickHipDevice, type AmdGfx } from './gpu.ts';
import { isLinkEntry, removeLink } from './install.ts';
import { envWithRuntime, pythonInRuntime } from './platform.ts';
import { patchRuntime } from './runtime-patch.ts';
import type { TrainedWeights } from './weights.ts';

export interface ServerState {
  phase: 'stopped' | 'starting' | 'ready' | 'error';
  url: string | null;
  pid: number | null;
  /** 失败原因，或启动中最后一行输出。 */
  detail: string | null;
  /** 从启动到能接请求用了多少毫秒。 */
  startMs: number | null;
}

export interface LaunchSpec {
  runtimeDir: string;
  /** 托管运行时给出权重目录;自备目录为 null。 */
  weightsDir: string | null;
  tier: Tier;
  version: ModelVersion;
  /** 自备的训练权重；填了就写进 yaml，替掉内置底模的两行路径。 */
  trained: TrainedWeights | null;
  /** 生成的 api_v2 配置文件放在这里。 */
  dataDir: string;
  /** 托管运行时才打「BERT 按需加载、CNHuBERT 用完即卸」的补丁；自备目录是用户的，不动。 */
  patchRuntime?: boolean;
  /** ROCm 档要用的架构；用来把核显排除在 HIP 可见列表外。 */
  gfx?: AmdGfx | null;
}

/** 首次加载要把几个模型读进内存,CPU 档慢的机器上要一两分钟。 */
const READY_TIMEOUT_MS = 300_000;
const POLL_MS = 500;
const TAIL_LINES = 40;

export async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? done(addr.port) : fail(new Error('拿不到空闲端口'))));
    });
  });
}

/** 让 `link` 成为指向 `target` 的目录联接;已是同一目标时不动。macOS / Linux 建普通目录符号链接（Node 在 POSIX 上不认 junction）。 */
export function linkWeights(link: string, target: string): void {
  mkdirSync(target, { recursive: true });
  if (existsSync(link) || isLinkEntry(link)) {
    if (isLinkEntry(link) && resolve(readlinkSync(link)) === resolve(target)) return;
    if (isLinkEntry(link)) removeLink(link);
    else rmSync(link, { recursive: true, force: true });
  }
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * 运行时解压不完整时会缺 `GPT_SoVITS/AR`：`TTS_infer_pack/TTS.py` 的 `from AR...` 依赖它，
 * 缺了 `api_v2.py` 一启动就 `ModuleNotFoundError: No module named 'AR'`。
 * 这里在拉起服务前检查，缺了就从包内 `vendor/ar` 补一份（上游同 commit 的 49 个文件，约 390 KB）。
 */
export function ensureRuntimeAr(runtimeDir: string, log: Logger): boolean {
  const target = join(runtimeDir, 'GPT_SoVITS', 'AR');
  const marker = join(target, 'models', 't2s_lightning_module.py');
  if (existsSync(marker)) return false;
  const source = fileURLToPath(new URL('../vendor/ar', import.meta.url));
  if (!existsSync(join(source, 'models', 't2s_lightning_module.py'))) {
    log.warn('运行时缺 GPT_SoVITS/AR，包内也没有可补的副本', { runtimeDir });
    return false;
  }
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  log.warn('运行时缺 GPT_SoVITS/AR，已用包内副本补齐', { runtimeDir });
  return true;
}

/**
 * YAML 标量：`api_v2` 用 PyYAML 解析，含反斜杠或空格的 Windows 路径必须加引号；
 * 单引号里反斜杠不转义，正好放 `D:\weights\x.ckpt`。
 */
export function yamlScalar(value: string): string {
  return /[\\'":#\s]/.test(value) ? `'${value.replace(/'/g, "''")}'` : value;
}

/** api_v2 读的配置：只用 `custom` 一节，路径相对运行时根。 */
export function infererYaml(tier: Tier, version: ModelVersion, trained: TrainedWeights | null = null): string {
  const base = weightPaths(version);
  const w = trained ?? { gpt: base.t2s, sovits: base.vits };
  const gpu = tier !== 'cpu';
  return [
    'custom:',
    // ROCm 版 PyTorch 暴露同一套 `torch.cuda` API，所以 ROCm 档写的也是 cuda。
    `  device: ${gpu ? 'cuda' : 'cpu'}`,
    `  is_half: ${gpu}`,
    `  version: ${version}`,
    `  t2s_weights_path: ${yamlScalar(w.gpt)}`,
    `  vits_weights_path: ${yamlScalar(w.sovits)}`,
    '  bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large',
    '  cnhuhbert_base_path: GPT_SoVITS/pretrained_models/chinese-hubert-base',
    '',
  ].join('\n');
}

/**
 * 子进程环境：ROCm 档要把 MIOpen 的 solver 搜索压到快速启发式，并指定一个确定可写的缓存目录。
 * 原生库直接读进程环境，`python -I` 只隔离 `PYTHON*`，不影响这些变量。
 */
export function runtimeEnv(tier: Tier, opts: { miopenDir: string; deviceIndex: number | null }): NodeJS.ProcessEnv {
  if (tier !== 'rocm') return {};
  const env: NodeJS.ProcessEnv = {
    MIOPEN_FIND_MODE: 'FAST',
    MIOPEN_USER_DB_PATH: opts.miopenDir,
    MIOPEN_CUSTOM_CACHE_DIR: opts.miopenDir,
  };
  if (opts.deviceIndex !== null) env.HIP_VISIBLE_DEVICES = String(opts.deviceIndex);
  return env;
}

/** 只打印设备表，不加载模型；`gcnArchName` 只有 ROCm 版 torch 才有。 */
const HIP_PROBE = [
  'import json',
  'import torch',
  'out = []',
  'for i in range(torch.cuda.device_count()):',
  '    p = torch.cuda.get_device_properties(i)',
  '    out.append({"index": i, "arch": getattr(p, "gcnArchName", ""), "name": str(p.name)})',
  'print("HIPDEVICES:" + json.dumps(out))',
].join('\n');

interface HipCache {
  gfx: AmdGfx;
  index: number;
  at: number;
}

/** 探针一次 3–5 秒，缓存 7 天；换卡或换运行时会因为架构不同而失效。 */
const HIP_CACHE_FILE = 'hip-device.json';
const HIP_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

/** 纯函数：缓存文件内容是否还能用。 */
export function cachedHipIndex(raw: string, gfx: AmdGfx, now = Date.now()): number | null {
  try {
    const parsed = JSON.parse(raw) as Partial<HipCache>;
    if (parsed.gfx !== gfx || typeof parsed.index !== 'number' || typeof parsed.at !== 'number') return null;
    return now - parsed.at < HIP_CACHE_MS ? parsed.index : null;
  } catch {
    return null;
  }
}

/**
 * 按架构挑出独显的 HIP 索引：双显卡机器上核显常被枚举成 device 0，而运行时只带了独显的内核包
 * （社区实测：device 0 是 gfx1036 核显时，第一个卷积就 `hipErrorInvalidKernelFile`）。
 * 探针失败或没命中就返回 null，不设可见列表、照原样启动。
 */
async function probeHipDevice(runtimeDir: string, gfx: AmdGfx, dataDir: string, log: Logger): Promise<number | null> {
  const file = join(dataDir, HIP_CACHE_FILE);
  try {
    const cached = cachedHipIndex(readFileSync(file, 'utf8'), gfx);
    if (cached !== null) return cached;
  } catch { /* 还没有缓存 */ }
  const out = await new Promise<string | null>((done) => {
    execFile(
      pythonInRuntime(runtimeDir),
      ['-I', '-X', 'utf8', '-c', HIP_PROBE],
      { cwd: runtimeDir, windowsHide: true, timeout: 20_000 },
      (err, stdout) => done(err ? null : stdout),
    );
  });
  if (out === null) {
    log.warn('ROCm 设备探针没跑起来，按默认设备顺序启动', { runtimeDir });
    return null;
  }
  const devices = parseHipProbe(out);
  if (!devices.length) {
    log.warn('ROCm 设备探针没有返回设备表', { gfx });
    return null;
  }
  const index = pickHipDevice(devices, gfx);
  log.info('ROCm 设备探针', { gfx, picked: index, devices: devices.map((device) => `${device.index}:${device.arch}`) });
  if (index === null) return null;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ gfx, index, at: Date.now() }));
  } catch { /* 缓存写不了不影响启动 */ }
  return index;
}

export class SovitsServer {
  private child: ChildProcess | null = null;
  private st: ServerState = { phase: 'stopped', url: null, pid: null, detail: null, startMs: null };
  private tail: string[] = [];
  private starting: Promise<void> | null = null;
  /** 正在收尾的旧进程；闲置停服后马上来一句时，新进程要等它退干净。 */
  private stopping: Promise<void> | null = null;

  /** `onExit` 在子进程意外退出时调用，参数是失败原因。 */
  constructor(private readonly log: Logger, private readonly onExit: (detail: string) => void = () => {}) {}

  state(): ServerState {
    return { ...this.st };
  }

  /** 最近的输出行，失败时给操作者看。 */
  output(): string[] {
    return [...this.tail];
  }

  start(spec: LaunchSpec): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child) return Promise.resolve();
    this.starting = (async () => {
      if (this.stopping) await this.stopping;
      await this.launch(spec);
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.st = { phase: 'stopped', url: null, pid: null, detail: null, startMs: null };
    if (!child?.pid || child.exitCode !== null) return;
    const done = new Promise<void>((finish) => {
      child.once('exit', () => finish());
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else if (process.platform === 'darwin') {
        // macOS：子进程在独立进程组里（见 launch 的 detached），按组收，别留下 python 子进程占端口。
        const pid = child.pid!;
        try { process.kill(-pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* 已经退出 */ } }, 4000).unref();
      } else child.kill('SIGTERM');
      setTimeout(finish, 5000).unref();
    });
    this.stopping = done;
    try {
      await done;
    } finally {
      if (this.stopping === done) this.stopping = null;
    }
  }

  private async launch(spec: LaunchSpec): Promise<void> {
    const started = Date.now();
    this.tail = [];
    if (spec.patchRuntime) {
      const result = patchRuntime(spec.runtimeDir);
      if (result === 'patched') this.log.info('已给托管运行时打上按需加载补丁', { dir: spec.runtimeDir });
      else if (result !== 'already') this.log.warn('托管运行时没能打上按需加载补丁，按原样启动', { result, dir: spec.runtimeDir });
    }
    ensureRuntimeAr(spec.runtimeDir, this.log);
    if (spec.weightsDir) {
      // 联接失败（被占用、权限、残留目录）只影响这一档，不能再让异常冒到宿主把整个 App 带走。
      try {
        linkWeights(join(spec.runtimeDir, 'GPT_SoVITS', 'pretrained_models'), spec.weightsDir);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        throw new Error(`接不上权重目录${code ? `（${code}）` : ''}：${err instanceof Error ? err.message : String(err)}。请确认运行时目录没有被其他程序占用。`);
      }
    }
    mkdirSync(spec.dataDir, { recursive: true });
    const yaml = join(spec.dataDir, `tts_infer.${spec.tier}.yaml`);
    writeFileSync(yaml, infererYaml(spec.tier, spec.version, spec.trained));
    const miopenDir = join(spec.dataDir, 'miopen');
    let deviceIndex: number | null = null;
    if (spec.tier === 'rocm') {
      mkdirSync(miopenDir, { recursive: true });
      if (spec.gfx) deviceIndex = await probeHipDevice(spec.runtimeDir, spec.gfx, spec.dataDir, this.log);
    }
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(pythonInRuntime(spec.runtimeDir), ['-I', '-X', 'utf8', '-u', 'api_v2.py', '-a', '127.0.0.1', '-p', String(port), '-c', yaml], {
      cwd: spec.runtimeDir,
      windowsHide: true,
      // macOS：放进独立进程组，停服务时按组收（api_v2 自己也会起子进程）。
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      // PATH 由 envWithRuntime 给（运行时目录在最前）；runtimeEnv 只给档位相关的变量，别让它把 PATH 覆盖掉。
      env: { ...envWithRuntime(spec.runtimeDir), ...runtimeEnv(spec.tier, { miopenDir, deviceIndex }) },
    });
    this.child = child;
    this.st = { phase: 'starting', url, pid: child.pid ?? null, detail: null, startMs: null };
    const onLine = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.tail.push(line);
        if (this.tail.length > TAIL_LINES) this.tail.shift();
        if (this.st.phase === 'starting') this.st.detail = line.slice(0, 200);
      }
    };
    child.stdout!.on('data', onLine);
    child.stderr!.on('data', onLine);
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      const last = this.tail.slice(-3).join(' | ');
      this.st = { phase: 'error', url: null, pid: null, detail: `推理服务退出(${code}):${last}`, startMs: null };
      this.log.warn('GPT-SoVITS 推理服务退出', { code, tail: this.tail.slice(-10) });
      this.onExit(this.st.detail ?? '');
    });
    child.on('error', (err) => {
      if (this.child !== child) return;
      this.child = null;
      this.st = { phase: 'error', url: null, pid: null, detail: err.message, startMs: null };
    });
    while (this.child === child && Date.now() - started < READY_TIMEOUT_MS) {
      if (await answers(url)) {
        this.st = { phase: 'ready', url, pid: child.pid ?? null, detail: null, startMs: Date.now() - started };
        this.log.info('GPT-SoVITS 推理服务就绪', { url, tier: spec.tier, version: spec.version, ms: this.st.startMs });
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (this.child === child) {
      await this.stop();
      this.st = { phase: 'error', url: null, pid: null, detail: `推理服务 ${READY_TIMEOUT_MS / 1000} 秒内没有就绪`, startMs: null };
    }
  }
}

/** api_v2 起来之前连接被拒;FastAPI 的 /docs 页起来就有。 */
async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/docs`, { signal: AbortSignal.timeout(2000) });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}
