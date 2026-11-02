import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envWithRuntime, missingRuntimePart, pythonInRuntime, runtimeBinDir, runtimePublished, tarBinary, useSystemPlayer } from '../src/platform.ts';

describe('pythonInRuntime', () => {
  it('Windows 用 runtime/python.exe', () => {
    expect(pythonInRuntime('C:\\rt', 'win32')).toBe('C:\\rt\\runtime\\python.exe');
  });

  it('macOS 用虚拟环境里的 runtime/bin/python3', () => {
    expect(pythonInRuntime('/opt/rt', 'darwin')).toBe('/opt/rt/runtime/bin/python3');
  });

  it('结尾带分隔符时不会拼出双层斜杠', () => {
    expect(pythonInRuntime('/opt/rt/', 'darwin')).toBe('/opt/rt/runtime/bin/python3');
    expect(pythonInRuntime('C:\\rt\\', 'win32')).toBe('C:\\rt\\runtime\\python.exe');
  });
});

describe('runtimePublished', () => {
  it('内置运行时包都是 win-x64：只在 Windows 上算已发布', () => {
    expect(runtimePublished(1_036_310_624, 'win32')).toBe(true);
    expect(runtimePublished(1_036_310_624, 'darwin')).toBe(false);
  });

  it('这一档没有包（字节为 0）时哪儿都不算已发布', () => {
    expect(runtimePublished(0, 'win32')).toBe(false);
    expect(runtimePublished(0, 'darwin')).toBe(false);
  });
});

describe('tarBinary', () => {
  it('macOS 走系统自带的 /usr/bin/tar', () => {
    expect(tarBinary('darwin')).toBe('/usr/bin/tar');
  });

  it('其它非 Windows 平台交给 PATH', () => {
    expect(tarBinary('linux')).toBe('tar');
  });

  it('Windows 走 System32 里的 bsdtar', () => {
    expect(tarBinary('win32', 'C:\\Windows')).toBe('C:\\Windows\\System32\\tar.exe');
    expect(tarBinary('win32', 'D:\\Win\\')).toBe('D:\\Win\\System32\\tar.exe');
  });
});

describe('envWithRuntime', () => {
  it('macOS 把 runtime/bin 放到 PATH 最前', () => {
    expect(envWithRuntime('/opt/rt', { PATH: '/usr/bin:/bin' }, 'darwin').PATH).toBe('/opt/rt/runtime/bin:/usr/bin:/bin');
  });

  it('Windows 把 runtime 放到 PATH 最前，分隔符用分号', () => {
    expect(envWithRuntime('C:\\rt', { PATH: 'C:\\Windows' }, 'win32').PATH).toBe('C:\\rt\\runtime;C:\\Windows');
  });

  it('原来没有 PATH 时也不留空档', () => {
    expect(envWithRuntime('/opt/rt', {}, 'darwin').PATH).toBe('/opt/rt/runtime/bin:');
  });

  it('其余环境变量原样带过去', () => {
    const env = envWithRuntime('/opt/rt', { PATH: '/bin', HF_ENDPOINT: 'https://hf-mirror.com' }, 'darwin');
    expect(env.HF_ENDPOINT).toBe('https://hf-mirror.com');
  });

  it('runtimeBinDir 与 pythonInRuntime 指向同一个 runtime', () => {
    expect(runtimeBinDir('/opt/rt', 'darwin')).toBe('/opt/rt/runtime/bin');
    expect(runtimeBinDir('C:\\rt', 'win32')).toBe('C:\\rt\\runtime');
  });
});

describe('useSystemPlayer', () => {
  it('只有 macOS 用系统播放器（afplay）', () => {
    expect(useSystemPlayer('darwin')).toBe(true);
    expect(useSystemPlayer('win32')).toBe(false);
    expect(useSystemPlayer('linux')).toBe(false);
  });
});

describe('自备运行时预检', () => {
  it('缺解释器时给出带路径的提示（macOS 在 runtime/bin/python3）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsv-rt-'));
    mkdirSync(join(dir, 'runtime', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'api_v2.py'), '');
    const problem = missingRuntimePart(dir, 'darwin');
    expect(problem).toContain('runtime/bin/python3');
    expect(problem).toContain('找不到解释器');
    rmSync(dir, { recursive: true, force: true });
  });

  it('解释器在但缺 api_v2.py 时同样拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsv-rt-'));
    mkdirSync(join(dir, 'runtime', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'runtime', 'bin', 'python3'), '');
    expect(missingRuntimePart(dir, 'darwin')).toContain('api_v2.py');
    rmSync(dir, { recursive: true, force: true });
  });

  it('两样都齐就放行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsv-rt-'));
    mkdirSync(join(dir, 'runtime', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'runtime', 'bin', 'python3'), '');
    writeFileSync(join(dir, 'api_v2.py'), '');
    expect(missingRuntimePart(dir, 'darwin')).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
