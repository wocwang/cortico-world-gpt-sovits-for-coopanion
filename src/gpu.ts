/**
 * 显卡探测与推理档决策。只读系统信息：跑一次 `nvidia-smi`、查一次 WMI 的显卡名与驱动版本、
 * 读一次长路径开关；不写注册表、不装驱动、不改系统策略（Cortico `docs/runtimes.md` 的运行时代约定）。
 *
 * ROCm 档只认 AMD 官方 Windows 支持矩阵里的四套架构（gfx1100 / gfx1101 / gfx1200 / gfx1201）：
 * 矩阵外的 A 卡（含 RX 6000 系列与移动端）继续走 CPU 档，并说明原因。
 */
import { execFile } from 'node:child_process';
import type { Tier, TierSetting } from './config.ts';

export type GpuVendor = 'amd' | 'intel' | 'other';

export type AmdGfx = 'gfx1100' | 'gfx1101' | 'gfx1200' | 'gfx1201';

export interface AmdGpu {
  /** 面板上显示的型号。 */
  name: string;
  gfx: AmdGfx;
}

/** AMD 显卡的探测结果：官方支持、有 A 卡但不在列表（再分独显 / 核显）、没有 A 卡。 */
export type AmdProbe =
  | { kind: 'supported'; gpu: AmdGpu; driver: string | null }
  | { kind: 'unsupported'; name: string; driver: string | null; integrated: boolean }
  | { kind: 'none' };

/** 核显的名字：只有核显的机器不该被提示「显卡不在支持名单」，那会让人以为买错了卡。 */
const AMD_IGPU = /radeon\(tm\) graphics|radeon graphics|vega\s*\d|radeon\s+\d{3}m\b|ryzen.*graphics|raphael|renoir|cezanne|rembrandt|phoenix|hawk point|strix|granite ridge|mendocino|barcelo|lucienne|picasso|raven/i;

export interface GpuInfo {
  nvidia: boolean;
  amd: AmdProbe;
  /** 没有 NVIDIA 时的显卡厂商，只用来解释「为什么走 CPU 档」。 */
  vendor: GpuVendor | null;
}

/**
 * 官方 Windows 支持矩阵里的卡。顺序敏感：XT 型号必须先于同系列的普通型号，
 * 否则 `RX 9070 XT` 会被 `RX 9070` 先匹配掉。
 */
const AMD_CARDS: ReadonlyArray<{ re: RegExp; name: string; gfx: AmdGfx }> = [
  { re: /rx\s*9070\s*xt/, name: 'Radeon RX 9070 XT', gfx: 'gfx1201' },
  { re: /rx\s*9070/, name: 'Radeon RX 9070', gfx: 'gfx1201' },
  { re: /(?:radeon\s*)?ai\s*pro\s*r9700/, name: 'Radeon AI PRO R9700', gfx: 'gfx1201' },
  { re: /rx\s*9060\s*xt/, name: 'Radeon RX 9060 XT', gfx: 'gfx1200' },
  { re: /rx\s*7900\s*xtx/, name: 'Radeon RX 7900 XTX', gfx: 'gfx1100' },
  { re: /pro\s*w7900/, name: 'Radeon PRO W7900', gfx: 'gfx1100' },
  { re: /rx\s*7700(?!\s*xt)/, name: 'Radeon RX 7700', gfx: 'gfx1101' },
];

/** 从显卡名与驱动版本里挑出官方支持的那张；两个数组一一对应，缺驱动时传 null。 */
export function amdProbeFrom(names: readonly string[], drivers: readonly (string | null)[] = []): AmdProbe {
  let fallback: { name: string; driver: string | null; integrated: boolean } | null = null;
  for (const [i, raw] of names.entries()) {
    const name = raw.trim();
    if (!/amd|radeon/i.test(name)) continue;
    const driver = drivers[i] ?? null;
    const lower = name.toLowerCase();
    for (const card of AMD_CARDS) {
      if (card.re.test(lower)) return { kind: 'supported', gpu: { name: card.name, gfx: card.gfx }, driver };
    }
    fallback ??= { name, driver, integrated: AMD_IGPU.test(name) };
  }
  return fallback ? { kind: 'unsupported', ...fallback } : { kind: 'none' };
}

/** 服务起不来时要不要把「自动」档写回 CPU：只有自动选出来的 ROCm 才回落，用户显式选的档不动。 */
export function fallbackToCpu(setting: TierSetting, current: Tier): boolean {
  return setting === 'auto' && current === 'rocm';
}

/** `auto` 的优先级：NVIDIA 显卡档 → 官方矩阵内的 AMD 卡走 ROCm 档 → CPU 档。显式选择一律尊重。 */
export function pickTier(setting: TierSetting, nvidia: boolean, amd: AmdProbe): Tier {
  if (setting !== 'auto') return setting;
  if (nvidia) return 'cuda';
  return amd.kind === 'supported' ? 'rocm' : 'cpu';
}

/** nvidia-smi 能列出至少一块显卡就算有 NVIDIA 显卡。 */
export function detectNvidia(): Promise<boolean> {
  return new Promise((done) => {
    execFile('nvidia-smi', ['-L'], { windowsHide: true, timeout: 5000 }, (err, stdout) => done(!err && /GPU \d+:/.test(stdout)));
  });
}

/** 一次 PowerShell 取回显卡名与驱动版本，再判 NVIDIA / AMD。失败按「没检测到」处理，不抛。 */
export function detectGpus(): Promise<GpuInfo> {
  return new Promise((done) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + '|' + $_.DriverVersion }"],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        const lines = err ? [] : stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const names = lines.map((line) => line.split('|')[0] ?? '');
        const drivers = lines.map((line) => (line.split('|')[1] ?? '').trim() || null);
        const joined = names.join(';').toLowerCase();
        const vendor: GpuVendor | null = /amd|radeon/.test(joined) ? 'amd' : /intel/.test(joined) ? 'intel' : names.length ? 'other' : null;
        void detectNvidia().then((nvidia) => done({ nvidia, amd: amdProbeFrom(names, drivers), vendor }));
      },
    );
  });
}

/**
 * ROCm 运行时里最长的一条相对路径（`runtime\Lib\site-packages\_rocm_sdk_libraries\bin\hipblaslt\
 * library\gfx1201\TensileLibrary_…_gfx1201.dat.zlib`）。实测整条绝对路径 272 字符：
 * hipBLASLt 打不开这种文件时进程直接 0xC0000005，所以安装前要按这个上限预检。
 */
export const ROCM_LONGEST_RELATIVE = 220;

/** Windows 的 MAX_PATH 上限（含结尾的 NUL 是 260，可用的路径长度是 259）。 */
export const MAX_PATH = 259;

export function pathTooLong(installDir: string, longestRelative = ROCM_LONGEST_RELATIVE): boolean {
  return installDir.length + 1 + longestRelative > MAX_PATH;
}

/** 只读 `LongPathsEnabled`：开着返回 true，明确是 0 返回 false，读不到返回 null。 */
export function longPathsEnabled(): Promise<boolean | null> {
  return new Promise((done) => {
    execFile(
      'reg',
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled'],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) return done(null);
        const match = /LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout);
        done(match ? Number.parseInt(match[1], 16) === 1 : null);
      },
    );
  });
}

/** `os.release()` 的最后一段就是内部版本号：`10.0.26200` → 26200；Win11 从 22000 起。 */
export function buildFromRelease(release: string): number {
  const parts = release.split('.');
  const build = Number.parseInt(parts[parts.length - 1] ?? '', 10);
  return Number.isFinite(build) ? build : 0;
}

export interface HipDevice {
  index: number;
  arch: string;
  name: string;
}

/** 设备探针的输出里找 `HIPDEVICES:` 那一行；解析失败按「没探到」处理。 */
export function parseHipProbe(output: string): HipDevice[] {
  for (const line of output.split(/\r?\n/)) {
    const at = line.indexOf('HIPDEVICES:');
    if (at < 0) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice(at + 'HIPDEVICES:'.length));
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const raw = item as { index?: unknown; arch?: unknown; name?: unknown };
        if (typeof raw.index !== 'number' || typeof raw.arch !== 'string') return [];
        return [{ index: raw.index, arch: raw.arch, name: typeof raw.name === 'string' ? raw.name : '' }];
      });
    } catch {
      return [];
    }
  }
  return [];
}

/** 按架构挑设备索引；`gfx1201:sramecc+` 这种带后缀的也算命中。没命中返回 null（不设可见列表）。 */
export function pickHipDevice(devices: readonly HipDevice[], gfx: AmdGfx): number | null {
  for (const device of devices) {
    if (device.arch.split(':')[0]?.trim() === gfx) return device.index;
  }
  return null;
}
