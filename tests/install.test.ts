import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeTreeSafely, rocmPathProblem } from '../src/install.ts';

describe('removeTreeSafely', () => {
  it('先拆掉目录联接再删运行时，不碰联接目标里的权重', () => {
    const root = mkdtempSync(join(tmpdir(), 'gpt-sovits-'));
    const weights = join(root, 'models', 'pretrained_models');
    const runtime = join(root, 'runtimes', 'cuda');
    mkdirSync(weights, { recursive: true });
    writeFileSync(join(weights, 's1v3.ckpt'), 'weights');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, 'api_v2.py'), 'runtime');
    symlinkSync(weights, join(runtime, 'pretrained_models'), 'junction');

    removeTreeSafely(runtime);

    expect(existsSync(join(weights, 's1v3.ckpt'))).toBe(true);
    expect(existsSync(runtime)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('联接藏在 GPT_SoVITS 里、目标已被删掉时也能删干净', () => {
    const root = mkdtempSync(join(tmpdir(), 'gpt-sovits-'));
    const weights = join(root, 'models', 'pretrained_models');
    const runtime = join(root, 'runtimes', 'cuda');
    mkdirSync(weights, { recursive: true });
    mkdirSync(join(runtime, 'GPT_SoVITS'), { recursive: true });
    writeFileSync(join(runtime, 'GPT_SoVITS', 'TTS.py'), 'x');
    symlinkSync(weights, join(runtime, 'GPT_SoVITS', 'pretrained_models'), 'junction');
    rmSync(weights, { recursive: true, force: true });

    expect(() => removeTreeSafely(runtime)).not.toThrow();
    expect(existsSync(runtime)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('ROCm 档的路径预检', () => {
  const longDir = `D:\\Coopanion\\${'x'.repeat(220)}`;

  it('路径超限且没开长路径时拒绝，并给出开启命令', () => {
    const problem = rocmPathProblem(longDir, false);
    expect(problem).toContain('安装路径太长');
    expect(problem).toContain('LongPathsEnabled');
    expect(problem).toContain('不会自己改注册表');
  });

  it('读不到开关时同样拒绝，不赌系统状态', () => {
    expect(rocmPathProblem(longDir, null)).toContain('读不到长路径开关');
  });

  it('开了长路径或路径够短就放行', () => {
    expect(rocmPathProblem(longDir, true)).toBeNull();
    expect(rocmPathProblem('D:\\rt', false)).toBeNull();
  });

  it('默认安装在 Program Files 下的路径超限，没开长路径时拒绝', () => {
    const defaultDir = 'D:\\Program Files\\Coopanion\\data\\home\\runtimes\\gpt-sovits\\e91506f-1\\rocm';
    expect(rocmPathProblem(defaultDir, false)).toContain('安装路径太长');
    expect(rocmPathProblem(defaultDir, true)).toBeNull();
  });
});
