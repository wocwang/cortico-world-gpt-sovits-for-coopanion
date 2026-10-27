/**
 * 本机 GPT-SoVITS 推理服务：在运行时目录里以 `runtime/python.exe -I -X utf8 -u api_v2.py` 起子进程(`-I` 下环境变量不生效，编码与无缓冲只能走参数)，监听 127.0.0.1 的空闲端口。
 * 启动方式与上游整合包的 go-webui.bat 一致(工作目录为运行时根,`runtime/` 在 PATH 最前)。
 * 托管运行时的 `GPT_SoVITS/pretrained_models` 在启动前接成指向权重目录的目录联接;自备目录原样使用。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { weightPaths, type ModelVersion } from './catalog.ts';
import type { Tier } from './config.ts';
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

/** 让 `link` 成为指向 `target` 的目录联接;已是同一目标时不动。 */
export function linkWeights(link: string, target: string): void {
  mkdirSync(target, { recursive: true });
  if (existsSync(link) || isLink(link)) {
    if (isLink(link) && resolve(readlinkSync(link)) === resolve(target)) return;
    rmSync(link, { recursive: !isLink(link), force: true });
  }
  symlinkSync(target, link, 'junction');
}

function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
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
  return [
    'custom:',
    `  device: ${tier === 'cuda' ? 'cuda' : 'cpu'}`,
    `  is_half: ${tier === 'cuda'}`,
    `  version: ${version}`,
    `  t2s_weights_path: ${yamlScalar(w.gpt)}`,
    `  vits_weights_path: ${yamlScalar(w.sovits)}`,
    '  bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large',
    '  cnhuhbert_base_path: GPT_SoVITS/pretrained_models/chinese-hubert-base',
    '',
  ].join('\n');
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
      else child.kill('SIGTERM');
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
    if (spec.weightsDir) linkWeights(join(spec.runtimeDir, 'GPT_SoVITS', 'pretrained_models'), spec.weightsDir);
    mkdirSync(spec.dataDir, { recursive: true });
    const yaml = join(spec.dataDir, `tts_infer.${spec.tier}.yaml`);
    writeFileSync(yaml, infererYaml(spec.tier, spec.version, spec.trained));
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const runtimeBin = join(spec.runtimeDir, 'runtime');
    const child = spawn(join(runtimeBin, 'python.exe'), ['-I', '-X', 'utf8', '-u', 'api_v2.py', '-a', '127.0.0.1', '-p', String(port), '-c', yaml], {
      cwd: spec.runtimeDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${runtimeBin};${process.env.PATH ?? ''}` },
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
