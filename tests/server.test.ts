import { describe, expect, it } from 'vitest';
import { cachedHipIndex, infererYaml, runtimeEnv } from '../src/server.ts';

describe('api_v2 配置', () => {
  it('ROCm 档和显卡档一样写 cuda + fp16', () => {
    const rocm = infererYaml('rocm', 'v5turbo');
    expect(rocm).toContain('  device: cuda');
    expect(rocm).toContain('  is_half: true');
    expect(rocm).toContain('  version: v5turbo');
    expect(infererYaml('cuda', 'v5turbo')).toBe(rocm);
  });

  it('CPU 档写 cpu + fp32', () => {
    const cpu = infererYaml('cpu', 'v2ProPlus');
    expect(cpu).toContain('  device: cpu');
    expect(cpu).toContain('  is_half: false');
  });
});

describe('ROCm 子进程环境', () => {
  const miopenDir = 'D:\\data\\gpt-sovits\\miopen';

  it('只给 ROCm 档加 MIOpen 变量，其它档不加', () => {
    expect(runtimeEnv('cuda', { miopenDir, deviceIndex: 1 })).toEqual({});
    expect(runtimeEnv('cpu', { miopenDir, deviceIndex: null })).toEqual({});
  });

  it('ROCm 档压到快速启发式，并使用可写缓存目录', () => {
    expect(runtimeEnv('rocm', { miopenDir, deviceIndex: null })).toEqual({
      MIOPEN_FIND_MODE: 'FAST',
      MIOPEN_USER_DB_PATH: miopenDir,
      MIOPEN_CUSTOM_CACHE_DIR: miopenDir,
    });
  });

  it('按架构探到独显时只暴露那一块，没探到就不设可见列表', () => {
    expect(runtimeEnv('rocm', { miopenDir, deviceIndex: 1 }).HIP_VISIBLE_DEVICES).toBe('1');
    expect(runtimeEnv('rocm', { miopenDir, deviceIndex: null })).not.toHaveProperty('HIP_VISIBLE_DEVICES');
  });
});

describe('设备探针缓存', () => {
  const now = 1_700_000_000_000;
  const raw = JSON.stringify({ gfx: 'gfx1201', index: 1, at: now - 1000 });

  it('同架构且在有效期里就用缓存', () => {
    expect(cachedHipIndex(raw, 'gfx1201', now)).toBe(1);
  });

  it('换架构、过期、坏文件都不用', () => {
    expect(cachedHipIndex(raw, 'gfx1100', now)).toBeNull();
    expect(cachedHipIndex(raw, 'gfx1201', now + 8 * 24 * 3600_000)).toBeNull();
    expect(cachedHipIndex('not json', 'gfx1201', now)).toBeNull();
  });
});
