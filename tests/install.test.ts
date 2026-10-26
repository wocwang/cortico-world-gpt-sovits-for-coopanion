import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeTreeSafely } from '../src/install.ts';

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
});
