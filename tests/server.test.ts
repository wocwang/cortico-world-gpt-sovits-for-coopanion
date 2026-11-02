import { describe, expect, it } from 'vitest';
import { cachedHipIndex, infererYaml, runtimeEnv, startFailureHint } from '../src/server.ts';

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

  it('缺 NLTK 语料时把补齐目录传给每个档位（英文单词要用 cmudict）', () => {
    const nltkDir = 'D:\\data\\gpt-sovits\\nltk_data';
    expect(runtimeEnv('cuda', { miopenDir, deviceIndex: null, nltkDir })).toEqual({ NLTK_DATA: nltkDir });
    expect(runtimeEnv('cpu', { miopenDir, deviceIndex: null, nltkDir })).toEqual({ NLTK_DATA: nltkDir });
    expect(runtimeEnv('rocm', { miopenDir, deviceIndex: 1, nltkDir }).NLTK_DATA).toBe(nltkDir);
  });
});

describe('启动失败提示', () => {
  it('缺权重时点名缺哪个文件，并说明 CPU 档要 V2 Pro Plus 那套', () => {
    const hint = startFailureHint([
      'Traceback (most recent call last):',
      "FileNotFoundError: [Errno 2] No such file or directory: 'GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth'",
    ]);
    expect(hint).toContain('v2Pro/s2Gv2ProPlus.pth');
    expect(hint).toContain('CPU 档');
  });

  it('别的退出原因不加提示', () => {
    expect(startFailureHint(['Address already in use'])).toBe('');
    expect(startFailureHint(['ModuleNotFoundError: No module named "tools"'])).toBe('');
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
