/**
 * 「我已经有 GPT-SoVITS 了」：从用户给的项目目录里认出能直接用的东西。
 *
 * 官方整合包/仓库解压后是一套完整目录：`api_v2.py`、`runtime/`（自带 Python）、
 * `GPT_SoVITS/pretrained_models/`，以及用户自己训练后放在根目录各 `*_weights_*` 里的
 * `.ckpt` / `.pth`。这里只做只读检查与识别，不写用户目录：
 *
 * - 能不能当「自备运行时」：要 `api_v2.py` + `runtime/python.exe`（macOS 是 `runtime/bin/python3`）；
 * - 新版 `api_v2.py` 第 97 行就 `from tools.portable_runtime import …`，缺这个文件起不来，
 *   识别出来并引导走端口接入，而不是让用户对着 ModuleNotFoundError 发愣；
 * - 权重按文件名主干配对（`xxx-e15.ckpt` ↔ `xxx_e8_s208.pth`），版本用 `.pth` 头判断；
 * - 参考音频只收 3–10 秒的 wav（api_v2 的要求），同名 `.txt`/`.lab` 当台本。
 *
 * 另外提供 `probeService()`：只在用户点「测试连接」时探一次，不自动扫端口。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { pythonInRuntime, type Platform } from './platform.ts';
import { readSeconds } from './wav.ts';
import { checkWeights, sovitsVersion } from './weights.ts';
import type { ModelVersion } from './catalog.ts';

/** Windows 的长路径：超过 240 字符时给绝对路径加 `\\?\` 前缀，否则 fs 会 ENOENT。 */
export function fsPath(path: string, platform: Platform = process.platform): string {
  const full = resolve(path);
  if (platform !== 'win32' || full.length <= 240 || full.startsWith('\\\\?\\')) return full;
  return full.startsWith('\\\\') ? `\\\\?\\UNC\\${full.slice(2)}` : `\\\\?\\${full}`;
}

const SKIP_DIRS = new Set(['runtime', 'pretrained_models', 'node_modules', '.git', 'venv', '.venv', '__pycache__', 'logs', 'output', 'TEMP']);

/** 遍历目录但跳过体积大/无关的子树；`depth` 限制层数，避免在整合包里翻几万个文件。 */
function walk(root: string, depth: number, visit: (file: string) => void, platform: Platform): void {
  const dirs: string[] = [root];
  for (let level = 0; level <= depth && dirs.length; level++) {
    const next: string[] = [];
    for (const dir of dirs.splice(0)) {
      let entries;
      try { entries = readdirSync(fsPath(dir, platform), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (level < depth && !SKIP_DIRS.has(entry.name.toLowerCase())) next.push(path);
        } else if (entry.isFile()) {
          visit(path);
        }
      }
    }
    dirs.push(...next);
  }
}

export interface FolderWeights {
  gpt: string;
  sovits: string;
  /** SoVITS 头里的版本；null 表示这套运行时不支持。 */
  version: ModelVersion | null;
  /** 版本的中文名，如 `v5turbo LoRA`。 */
  lang: string;
  /** `checkWeights()` 发现的结构问题；有就不能直接用。 */
  problem: string | null;
}

export interface FolderRef {
  audio: string;
  /** 同名 `.txt` / `.lab` 的内容；没有就空串。 */
  text: string;
  seconds: number | null;
}

export interface FolderReport {
  root: string;
  runtime: {
    /** 可以当 `runtimeDir` 用。 */
    usable: boolean;
    hasApi: boolean;
    python: string | null;
    /** 新版 api_v2.py 需要的 `tools/portable_runtime.py`。 */
    portable: boolean;
    /** 不可用时的一句话原因。 */
    problem: string | null;
  };
  weights: FolderWeights[];
  refs: FolderRef[];
  /** 目录本身的问题（不是某个文件的问题）。 */
  problems: string[];
}

/** 文件名主干：去掉 `-e15` / `_e8_s208` 这类训练后缀，用来把 ckpt 和 pth 配成一对。 */
const stemOf = (file: string): string => basename(file, extname(file))
  .replace(/[-_\s]*[eE]\d+([-_]s\d+)?.*$/, '')
  .replace(/[-_\s]+$/, '')
  .toLowerCase();

/** 最长公共前缀的长度，用来给配对打分。 */
function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** 把 ckpt 与 pth 按文件名主干配对；配不上的 pth 丢掉，配不上的 ckpt 也丢掉。 */
export function pairWeights(ckpts: string[], sovitsFiles: string[]): Array<{ gpt: string; sovits: string }> {
  const pairs: Array<{ gpt: string; sovits: string; score: number }> = [];
  const used = new Set<string>();
  for (const gpt of ckpts) {
    const gs = stemOf(gpt);
    let best: { sovits: string; score: number } | null = null;
    if (!gs) continue;
    for (const sovits of sovitsFiles) {
      if (used.has(sovits)) continue;
      const ss = stemOf(sovits);
      if (!ss) continue;
      // 主干完全相同就配（`foo-e1` ↔ `foo_e8` 这种短名字也认）；否则要求至少 4 个字符的公共前缀。
      const score = gs === ss ? gs.length : commonPrefix(gs, ss);
      if ((gs === ss || score >= 4) && (!best || score > best.score)) best = { sovits, score };
    }
    if (best) {
      used.add(best.sovits);
      pairs.push({ gpt, sovits: best.sovits, score: best.score });
    }
  }
  return pairs.map(({ gpt, sovits }) => ({ gpt, sovits }));
}

const GPT_MIN_BYTES = 1024 * 1024;

/** 检查一个目录能不能直接用；只读，不改任何东西。 */
export function inspectFolder(root: string, platform: Platform = process.platform): FolderReport {
  const dir = resolve(root.trim());
  const problems: string[] = [];
  const report: FolderReport = {
    root: dir,
    runtime: { usable: false, hasApi: false, python: null, portable: false, problem: null },
    weights: [],
    refs: [],
    problems,
  };
  if (!existsSync(fsPath(dir, platform))) {
    problems.push('这个目录不存在');
    return report;
  }
  try {
    if (!statSync(fsPath(dir, platform)).isDirectory()) problems.push('这个路径不是目录');
  } catch {
    problems.push('读不了这个目录（权限或路径太长）');
  }

  const hasApi = existsSync(fsPath(join(dir, 'api_v2.py'), platform));
  const python = pythonInRuntime(dir, platform);
  const hasPython = existsSync(fsPath(python, platform));
  const portable = existsSync(fsPath(join(dir, 'tools', 'portable_runtime.py'), platform));
  report.runtime = {
    usable: hasApi && hasPython && portable,
    hasApi,
    python: hasPython ? python : null,
    portable,
    problem: !hasApi ? '没找到 api_v2.py，这不像 GPT-SoVITS 的根目录'
      : !hasPython ? '没找到 runtime 里的 Python（整合包才有；仓库克隆需要自己的虚拟环境）'
        : !portable ? '这个版本的 api_v2.py 需要 tools/portable_runtime.py，目录里没有；请改用「已有服务」'
          : null,
  };

  const ckpts: string[] = [];
  const pths: string[] = [];
  walk(dir, 3, (file) => {
    const ext = extname(file).toLowerCase();
    if (ext === '.ckpt') {
      try { if (statSync(fsPath(file, platform)).size >= GPT_MIN_BYTES) ckpts.push(file); } catch { /* 读不到就算了 */ }
    } else if (ext === '.pth') {
      pths.push(file);
    } else if (ext === '.wav') {
      const seconds = readSeconds(fsPath(file, platform));
      if (seconds !== null && seconds >= 3 && seconds <= 10) {
        report.refs.push({ audio: file, text: sidecarText(file, platform), seconds });
      }
    }
  }, platform);
  if (!hasApi) report.problems.push('顶层没有 api_v2.py');

  for (const pair of pairWeights(ckpts, pths)) {
    const checked = checkWeights(pair);
    const v = sovitsVersion(fsPath(pair.sovits, platform));
    report.weights.push({
      gpt: pair.gpt,
      sovits: pair.sovits,
      version: checked.version ?? v?.version ?? null,
      lang: v?.lang ?? '未知',
      problem: checked.problem,
    });
  }
  report.refs.sort((a, b) => (a.seconds ?? 0) - (b.seconds ?? 0)).splice(8);
  report.weights.sort((a, b) => Number(!!a.problem) - Number(!!b.problem));
  return report;
}

/** 同名 `.txt` / `.lab` 的台本；读不到就当没有。 */
function sidecarText(wav: string, platform: Platform): string {
  const stem = wav.slice(0, -extname(wav).length);
  for (const ext of ['.txt', '.lab']) {
    const path = `${stem}${ext}`;
    try {
      if (existsSync(fsPath(path, platform))) {
        return readFileSync(fsPath(path, platform), 'utf8').trim().slice(0, 500);
      }
    } catch { /* 忽略 */ }
  }
  return '';
}

/** 给单个根目录的扫描限时：失效/断开的盘符 `existsSync` 会卡几十秒，不能拖住整个面板。 */
function withTimeout<T>(task: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((done) => {
    const timer = setTimeout(() => done(fallback), ms);
    task.then(
      (value) => { clearTimeout(timer); done(value); },
      () => { clearTimeout(timer); done(fallback); },
    );
  });
}

/**
 * 常见位置找候选目录：桌面、下载、文档，以及各盘根目录下一层。只用来给用户点选，不自动接入。
 * 异步 + 单根限时，避免某个失效盘符（本机实测 `G:\` 的 `existsSync` 要 21 秒）把面板冻住。
 */
export async function findFolders(platform: Platform = process.platform): Promise<string[]> {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const roots = [
    join(home, 'Desktop'), join(home, 'Downloads'), join(home, 'Documents'),
    ...(platform === 'win32' ? 'CDEFGH'.split('').map((d) => `${d}:\\`) : [home]),
  ].filter(Boolean);

  const scan = async (root: string): Promise<string[]> => {
    try {
      const entries = await readdir(fsPath(root, platform), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && /gpt[-_ ]?sovits/i.test(entry.name))
        .map((entry) => join(root, entry.name));
    } catch {
      return [];
    }
  };

  const found = await Promise.all(roots.map((root) => withTimeout(scan(root), 1500, [])));
  return [...new Set(found.flat())].slice(0, 8);
}

export interface ProbeResult {
  ok: boolean;
  /** 给用户看的一句话结论。 */
  detail: string;
}

/** 地址是不是指本机（决定「换权重」是否真的生效）。 */
export function isLocalService(url: string): boolean {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/**
 * 试连一次已有服务：`GET {url}/docs`（api_v2 是 FastAPI，这与本机托管时的就绪判定一致）。
 * 只在用户点「测试连接」时调用，不自动扫端口。
 */
export async function probeService(url: string, timeoutMs = 4000): Promise<ProbeResult> {
  const base = url.trim().replace(/\/+$/, '');
  if (!base) return { ok: false, detail: '地址还没填（例如 http://127.0.0.1:9880）' };
  if (!/^https?:\/\//i.test(base)) return { ok: false, detail: '地址要以 http:// 或 https:// 开头' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs));
  let res: Response;
  try {
    res = await fetch(`${base}/docs`, { method: 'GET', signal: ctrl.signal });
  } catch {
    return { ok: false, detail: `连不上 ${base}：服务没启动、端口不对，或被防火墙挡了` };
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) return { ok: false, detail: `连上了 ${base}，但 /docs 不存在，可能不是 GPT-SoVITS 的 api_v2` };
  if (!res.ok) return { ok: false, detail: `连上了 ${base}，但 /docs 返回 HTTP ${res.status}` };
  return { ok: true, detail: `已连接 ${base}` };
}
