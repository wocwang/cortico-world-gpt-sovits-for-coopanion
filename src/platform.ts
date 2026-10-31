/**
 * 平台差异集中在这里。
 *
 * - Windows：随包带 win-x64 的托管运行时（zip 里是 `runtime/python.exe`），播放走 audify(RtAudio/WASAPI)。
 * - macOS：内置运行时包没有 darwin 版本，用「自备运行时目录」——目录里同样要有 `runtime/` 与 `api_v2.py`，
 *   Python 落在 `runtime/bin/python3`（`python3 -m venv runtime` 生成的布局正好是它）；播放交给系统自带的 `afplay`。
 *
 * 路径与分隔符都按「传入的平台」拼，不按跑测试的机器，这样两边都能用同一份断言。
 */
export type Platform = NodeJS.Platform;

/** 该平台有没有可下载的托管运行时包：内置包都是 win-x64。 */
export function runtimePublished(bytes: number, platform: Platform = process.platform): boolean {
  return platform === 'win32' && bytes > 0;
}

/** 去掉结尾的分隔符，拼路径时不会出现 `//` 或 `\\`。 */
const trimEnd = (dir: string): string => dir.replace(/[\\/]+$/, '');

/** 运行时里的 Python 可执行文件：Windows 是 `runtime/python.exe`，其它平台是 `runtime/bin/python3`。 */
export function pythonInRuntime(runtimeDir: string, platform: Platform = process.platform): string {
  const root = trimEnd(runtimeDir);
  return platform === 'win32' ? `${root}\\runtime\\python.exe` : `${root}/runtime/bin/python3`;
}

/** 要把 `<运行时>/runtime` 下哪个目录放进子进程的 PATH：Windows 直接是 `runtime`，其它平台是 `runtime/bin`（虚拟环境）。 */
export function runtimeBinDir(runtimeDir: string, platform: Platform = process.platform): string {
  const root = trimEnd(runtimeDir);
  return platform === 'win32' ? `${root}\\runtime` : `${root}/runtime/bin`;
}

/** 解压用的 tar：Windows 用 System32 里的 bsdtar（PATH 上靠前的 Git tar 不认 zip），macOS 用系统自带的，其它平台走 PATH。 */
export function tarBinary(platform: Platform = process.platform): string {
  if (platform === 'darwin') return '/usr/bin/tar';
  if (platform !== 'win32') return 'tar';
  return `${trimEnd(process.env.SystemRoot ?? 'C:\\Windows')}\\System32\\tar.exe`;
}

/** 子进程的 PATH：运行时目录放最前，分隔符按平台（Windows 是分号）。 */
export function envWithRuntime(runtimeDir: string, env: NodeJS.ProcessEnv = process.env, platform: Platform = process.platform): NodeJS.ProcessEnv {
  const bin = runtimeBinDir(runtimeDir, platform);
  return { ...env, PATH: [bin, env.PATH ?? ''].join(platform === 'win32' ? ';' : ':') };
}

/** 是不是用系统自带播放器（macOS 的 afplay）而不是 audify。 */
export const useSystemPlayer = (platform: Platform = process.platform): boolean => platform === 'darwin';
