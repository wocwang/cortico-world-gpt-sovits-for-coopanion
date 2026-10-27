/**
 * 整链冒烟：文字 → gpt-sovits（本机 api_v2）→ 出口 RVC → WAV。
 *
 * 左侧起 RVC World（本机回环 + 常驻 worker），右侧起 gpt-sovits World 并走「已有服务」模式
 * 连本机 api_v2；同一个 `/tts` 请求各跑一次「不开 RVC / 开 RVC / RVC 停掉」，
 * 三份 WAV 落盘供试听，最后一种用来确认失败时原样返回、链路不断。
 *
 * 本机跑：
 *   pnpm exec tsx scripts/smoke-rvc.mts
 *   GSV_SMOKE_SERVER=http://127.0.0.1:9880 RVC_SMOKE_PYTHON=... pnpm exec tsx scripts/smoke-rvc.mts
 *
 * 需要：本机 api_v2 在跑（默认 9880）、pr-rvc 仓库在旁边、派生 venv 与 RVC 权重已就位
 * （复用 pr-rvc `scripts/smoke.mts` 留在 `<temp>/rvc-smoke` 的布局）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Logger, WorldHost } from 'cortico/core/types.ts';
import { GPT_SOVITS_DEFAULTS } from '../src/config.ts';
import { GptSovitsWorld } from '../src/world.ts';
import { RVC_DEFAULTS } from '../../../pr-rvc/repo/src/config.ts';
import { RvcWorld } from '../../../pr-rvc/repo/src/world.ts';

const temp = tmpdir();
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const rvcRepo = process.env.RVC_SMOKE_REPO || join(dirname(dirname(repo)), 'pr-rvc', 'repo');
const here = join(temp, 'gsv-rvc-smoke');
const outDir = join(here, 'out');
const pythonPath = process.env.RVC_SMOKE_PYTHON || join(temp, 'rvc-probe', 'Scripts', 'python.exe');
const codeDir = process.env.RVC_SMOKE_CODE || join(rvcRepo, 'vendor', 'rvc');
const sourceAssets = process.env.RVC_SMOKE_ASSETS || join(temp, 'rvc-src', 'assets');
const assetsDir = join(temp, 'rvc-smoke', 'assets');
const voicesDir = join(temp, 'rvc-smoke', 'voices');
const server = (process.env.GSV_SMOKE_SERVER || 'http://127.0.0.1:9880').replace(/\/+$/, '');
const said = process.env.GSV_SMOKE_TEXT || '你好，我是大肥鱼，今天也要开开心心的。';

const log: Logger = {
  trace: (m) => console.log(`[trace] ${m}`),
  debug: () => {},
  info: (m, d) => console.log(`[info] ${m}`, d ?? ''),
  warn: (m, d) => console.warn(`[warn] ${m}`, d ?? ''),
  error: (m, d) => console.error(`[error] ${m}`, d ?? ''),
  emit: () => {},
  child: () => log,
};

const host = { log, pushEvent: async () => {} } as unknown as WorldHost;

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? done(addr.port) : fail(new Error('拿不到空闲端口'))));
    });
  });
}

/** 复用 pr-rvc 冒烟留下的数据目录；缺权重时从上游 assets 复制一份。 */
function prepareRvcData(): void {
  const files = ['hubert_base/config.json', 'hubert_base/preprocessor_config.json', 'hubert_base/pytorch_model.bin', 'rmvpe/rmvpe.pt'];
  for (const file of files) {
    const to = join(assetsDir, file);
    if (existsSync(to)) continue;
    const from = join(sourceAssets, file);
    if (!existsSync(from)) throw new Error(`缺权重：${from}；先跑一次 pr-rvc 的 scripts/smoke.mts`);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
  for (const name of ['daifeiyu.pth', 'daifeiyu.index']) {
    const to = join(voicesDir, name);
    if (existsSync(to)) continue;
    const from = join(sourceAssets, name.endsWith('.pth') ? join('weights', name) : join('indices', name));
    if (!existsSync(from)) throw new Error(`缺音色文件：${from}`);
    mkdirSync(voicesDir, { recursive: true });
    cpSync(from, to);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询一个 URL 直到 `ready(obj)` 为真；`what` 只用于报错。 */
async function waitFor<T>(url: string, ready: (v: T) => boolean, what: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        last = (await res.json()) as T;
        if (ready(last)) return last;
      }
    } catch {
      // 还没起来，继续等
    }
    await sleep(500);
  }
  throw new Error(`${what} 没在 ${timeoutMs} ms 内就绪${last ? `：${JSON.stringify(last)}` : ''}`);
}

/** 采样率与声道数，用于确认 RVC 真的换过一遍（输出 40 kHz 单声道）。 */
function wavInfo(buf: Buffer): { rate: number; channels: number; bytes: number } {
  return { rate: buf.readUInt32LE(24), channels: buf.readUInt16LE(22), bytes: buf.length };
}

/** 向 gpt-sovits 的 `/tts` 要一句，返回字节与耗时。 */
async function ask(base: string, label: string): Promise<Buffer> {
  const began = Date.now();
  const res = await fetch(`${base}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: said }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const info = buf.subarray(0, 4).toString() === 'RIFF' ? wavInfo(buf) : null;
  console.log(`${label}: HTTP ${res.status} ${Date.now() - began} ms`, info ?? buf.subarray(0, 120).toString('utf8'));
  if (res.status !== 200 || !info) throw new Error(`${label} 没拿到 WAV`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${label}.wav`), buf);
  return buf;
}

prepareRvcData();
const rvcPort = await freePort();
const rvc = new RvcWorld({
  cfg: {
    ...RVC_DEFAULTS,
    enabled: true,
    codeDir,
    pythonPath,
    assetsDir,
    voicesDir,
    voice: 'daifeiyu',
    httpApi: true,
    httpPort: rvcPort,
  },
  dataDir: join(here, 'rvc-data'),
  packageDir: rvcRepo,
  runtimesRoot: () => '',
});
await rvc.start(host);
const rvcBase = `http://127.0.0.1:${rvcPort}`;
const rvcHealth = await waitFor<{ ready: boolean }>(`${rvcBase}/health`, (v) => v.ready, 'RVC', 180_000);
console.log('rvc health:', rvcHealth);
const rvcPanel = rvc.webUi('zh').invoke!;
const firstState = (await rvcPanel('service', 'state', [])) as Record<string, unknown>;
const convertAt = (): number => ((firstState.lastConvert as { at?: number } | null)?.at ?? 0);
const before = convertAt();

const gsvPort = await freePort();
const cfg = {
  ...GPT_SOVITS_DEFAULTS,
  serverUrl: server,
  autoStart: false,
  playLocally: false,
  httpApi: true,
  httpPort: gsvPort,
  rvc: { ...GPT_SOVITS_DEFAULTS.rvc, enabled: false, endpoint: rvcBase, timeoutMs: 60_000 },
};
const gsv = new GptSovitsWorld({
  cfg,
  timezone: 'Asia/Shanghai',
  dataDir: join(here, 'gsv-data'),
  botDir: join(here, 'bot'),
  runtimesRoot: () => join(here, 'runtimes'),
  modelsRoot: () => join(here, 'models'),
  persist: () => {},
});
await gsv.start(host);
const gsvBase = `http://127.0.0.1:${gsvPort}`;
console.log('gsv health:', await waitFor<{ ready: boolean }>(`${gsvBase}/health`, (v) => v.ready, 'gpt-sovits', 60_000));

try {
  const plain = await ask(gsvBase, 'chain-plain');

  // 热改配置：RvcLink 每次转换都重新读，不必重启 World。
  cfg.rvc.enabled = true;
  const converted = await ask(gsvBase, 'chain-rvc');
  const afterState = (await rvcPanel('service', 'state', [])) as Record<string, unknown>;
  const last = afterState.lastConvert as { at: number; ms: number; bytes: number; savedPath: string | null } | null;
  console.log('rvc lastConvert:', last);
  if (!last || last.at <= before) throw new Error('RVC 没被调用：lastConvert 没更新');
  const a = wavInfo(plain);
  const b = wavInfo(converted);
  if (a.rate === b.rate && a.bytes === b.bytes) throw new Error(`RVC 没换过音频：${JSON.stringify({ a, b })}`);

  // RVC 停掉后同一入口：必须仍是 200 + 原音频，链路不断。
  await rvc.stop();
  const fallback = await ask(gsvBase, 'chain-fallback');
  console.log('fallback:', wavInfo(fallback));
  if (fallback.subarray(0, 4).toString() !== 'RIFF') throw new Error('RVC 停掉后没返回 WAV');
  console.log('ok →', outDir);
} finally {
  await gsv.stop();
  await rvc.stop();
}
