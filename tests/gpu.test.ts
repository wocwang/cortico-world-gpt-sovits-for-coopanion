import { describe, expect, it } from 'vitest';
import { amdProbeFrom, buildFromRelease, detectGpus, detectNvidia, fallbackToCpu, parseHipProbe, pathTooLong, pickHipDevice, pickTier } from '../src/gpu.ts';

const supported = (name: string) => amdProbeFrom([name]);

describe('AMD 显卡识别', () => {
  it('官方列表里的型号落到对应架构', () => {
    expect(supported('AMD Radeon RX 9070 XT')).toMatchObject({ kind: 'supported', gpu: { gfx: 'gfx1201' } });
    expect(supported('AMD Radeon RX 9070')).toMatchObject({ kind: 'supported', gpu: { gfx: 'gfx1201' } });
    expect(supported('AMD Radeon AI PRO R9700')).toMatchObject({ kind: 'supported', gpu: { gfx: 'gfx1201' } });
    expect(supported('AMD Radeon RX 9060 XT')).toMatchObject({ kind: 'supported', gpu: { gfx: 'gfx1200' } });
    expect(supported('AMD Radeon RX 7900 XTX')).toMatchObject({ kind: 'supported', gpu: { gfx: 'gfx1100' } });
    expect(supported('AMD Radeon PRO W7900 Dual Slot')).toMatchObject({ kind: 'supported', gpu: { gfx: 'gfx1100' } });
    expect(supported('AMD Radeon RX 7700')).toMatchObject({ kind: 'supported', gpu: { gfx: 'gfx1101' } });
  });

  it('XT 型号优先于同系列，不被普通型号吃掉', () => {
    expect(supported('AMD Radeon RX 9070 XT')).toMatchObject({ gpu: { name: 'Radeon RX 9070 XT' } });
    expect(supported('AMD Radeon RX 9070')).toMatchObject({ gpu: { name: 'Radeon RX 9070' } });
  });

  it('列表外的 A 卡（含 RX 6000 与 7700 XT）判为不支持', () => {
    expect(supported('AMD Radeon RX 6800 XT')).toMatchObject({ kind: 'unsupported', name: 'AMD Radeon RX 6800 XT' });
    expect(supported('AMD Radeon RX 7700 XT')).toMatchObject({ kind: 'unsupported' });
    expect(supported('AMD Radeon(TM) Graphics')).toMatchObject({ kind: 'unsupported' });
  });

  it('没有 A 卡时返回 none，Intel / NVIDIA 不算', () => {
    expect(supported('Intel(R) UHD Graphics 770')).toEqual({ kind: 'none' });
    expect(supported('NVIDIA GeForce RTX 4070')).toEqual({ kind: 'none' });
    expect(amdProbeFrom([])).toEqual({ kind: 'none' });
  });

  it('驱动版本按同名下标带上，缺的给 null', () => {
    const probe = amdProbeFrom(['Intel(R) UHD Graphics', 'AMD Radeon RX 9070'], [null, '32.0.32015.7029']);
    expect(probe).toEqual({ kind: 'supported', gpu: { name: 'Radeon RX 9070', gfx: 'gfx1201' }, driver: '32.0.32015.7029' });
  });
});

describe('核显与回落', () => {
  it('只有核显时标成 integrated，面板不该说「显卡不在支持名单」', () => {
    expect(supported('AMD Radeon(TM) Graphics')).toMatchObject({ kind: 'unsupported', integrated: true });
    expect(supported('AMD Radeon 780M Graphics')).toMatchObject({ kind: 'unsupported', integrated: true });
    expect(supported('AMD Radeon RX 6600')).toMatchObject({ kind: 'unsupported', integrated: false });
  });

  it('只有「自动」选出来的 ROCm 会回落 CPU，显式选择不动', () => {
    expect(fallbackToCpu('auto', 'rocm')).toBe(true);
    expect(fallbackToCpu('rocm', 'rocm')).toBe(false);
    expect(fallbackToCpu('auto', 'cuda')).toBe(false);
    expect(fallbackToCpu('auto', 'cpu')).toBe(false);
  });
});

describe('档位决策', () => {
  const amdSupported = supported('AMD Radeon RX 9070');
  const amdOther = supported('AMD Radeon RX 6600');

  it('显式选择一律尊重，不看硬件', () => {
    expect(pickTier('cpu', true, amdSupported)).toBe('cpu');
    expect(pickTier('cuda', false, amdOther)).toBe('cuda');
    expect(pickTier('rocm', false, amdOther)).toBe('rocm');
  });

  it('自动：NVIDIA 优先，其次官方支持的 A 卡，最后 CPU', () => {
    expect(pickTier('auto', true, amdSupported)).toBe('cuda');
    expect(pickTier('auto', false, amdSupported)).toBe('rocm');
    expect(pickTier('auto', false, amdOther)).toBe('cpu');
    expect(pickTier('auto', false, { kind: 'none' })).toBe('cpu');
  });
});

describe('长路径预检', () => {
  it('按最长相对路径 220 字符算，超过 259 就算超限', () => {
    expect(pathTooLong('D:\\' + 'a'.repeat(37))).toBe(true);
    expect(pathTooLong('D:\\rt')).toBe(false);
  });

  it('默认安装在 Program Files 下的路径本身就超限，必须开长路径', () => {
    expect(pathTooLong('D:\\Program Files\\Coopanion\\data\\home\\runtimes\\gpt-sovits\\e91506f-1\\rocm')).toBe(true);
  });
});

describe('Windows 版本解析', () => {
  it('取 release 的最后一段', () => {
    expect(buildFromRelease('10.0.26200')).toBe(26200);
    expect(buildFromRelease('10.0.19045')).toBe(19045);
    expect(buildFromRelease('')).toBe(0);
  });
});

describe('ROCm 设备探针', () => {
  it('只读 HIPDEVICES 那一行，坏的条目丢掉', () => {
    const out = [
      'some torch warning',
      'HIPDEVICES:[{"index":0,"arch":"gfx1036","name":"iGPU"},{"index":1,"arch":"gfx1201","name":"RX 9070"},{"index":"x"}]',
    ].join('\n');
    expect(parseHipProbe(out)).toEqual([
      { index: 0, arch: 'gfx1036', name: 'iGPU' },
      { index: 1, arch: 'gfx1201', name: 'RX 9070' },
    ]);
  });

  it('没有那一行或不是 JSON 时返回空表', () => {
    expect(parseHipProbe('Traceback (most recent call last): boom')).toEqual([]);
    expect(parseHipProbe('HIPDEVICES:not json')).toEqual([]);
  });

  it('按架构挑索引，带 sramecc 后缀的也算命中', () => {
    const devices = [
      { index: 0, arch: 'gfx1036', name: 'iGPU' },
      { index: 1, arch: 'gfx1201:sramecc+:xnack-', name: 'RX 9070' },
    ];
    expect(pickHipDevice(devices, 'gfx1201')).toBe(1);
    expect(pickHipDevice(devices, 'gfx1100')).toBeNull();
  });
});

describe('非 Windows 的显卡探测', () => {
  it('macOS 不去 spawn powershell / nvidia-smi，直接给「没有独显」', async () => {
    await expect(detectGpus('darwin')).resolves.toEqual({ nvidia: false, amd: { kind: 'none' }, vendor: null });
    await expect(detectNvidia('darwin')).resolves.toBe(false);
  });

  it('Linux 同理（运行时包只有 win-x64）', async () => {
    await expect(detectGpus('linux')).resolves.toMatchObject({ nvidia: false, amd: { kind: 'none' } });
    await expect(detectNvidia('linux')).resolves.toBe(false);
  });
});
