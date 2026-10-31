import { describe, expect, it } from 'vitest';
import { envWithRuntime, pythonInRuntime, runtimeBinDir, runtimePublished, tarBinary, useSystemPlayer } from '../src/platform.ts';

describe('pythonInRuntime', () => {
  it('Windows 用 runtime/python.exe', () => {
    expect(pythonInRuntime('C:\\rt', 'win32')).toBe('C:\\rt\\runtime\\python.exe');
  });

  it('macOS 用虚拟环境里的 runtime/bin/python3', () => {
    expect(pythonInRuntime('/opt/rt', 'darwin')).toBe('/opt/rt/runtime/bin/python3');
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
});

describe('envWithRuntime', () => {
  it('macOS 把 runtime/bin 放到 PATH 最前', () => {
    expect(envWithRuntime('/opt/rt', { PATH: '/usr/bin:/bin' }, 'darwin').PATH).toBe('/opt/rt/runtime/bin:/usr/bin:/bin');
  });

  it('Windows 把 runtime 放到 PATH 最前，分隔符用分号', () => {
    expect(envWithRuntime('C:\\rt', { PATH: 'C:\\Windows' }, 'win32').PATH).toBe('C:\\rt\\runtime;C:\\Windows');
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
