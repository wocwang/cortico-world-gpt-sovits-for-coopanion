import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureRuntimeAr } from '../src/server.ts';

const log = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {}, trace: () => {}, emit: () => {}, child: () => log } as never;
const root = mkdtempSync(join(tmpdir(), 'gsv-ar-'));

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('运行时 AR 补齐', () => {
  it('缺 GPT_SoVITS/AR 时从包内副本补上', () => {
    const runtime = join(root, 'missing');
    mkdirSync(join(runtime, 'GPT_SoVITS'), { recursive: true });
    expect(ensureRuntimeAr(runtime, log)).toBe(true);
    const marker = join(runtime, 'GPT_SoVITS', 'AR', 'models', 't2s_lightning_module.py');
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toContain('Text2SemanticLightningModule');
  });

  it('已经有 AR 时不动用户文件', () => {
    const runtime = join(root, 'present');
    const models = join(runtime, 'GPT_SoVITS', 'AR', 'models');
    mkdirSync(models, { recursive: true });
    writeFileSync(join(models, 't2s_lightning_module.py'), '# 用户自己的副本');
    expect(ensureRuntimeAr(runtime, log)).toBe(false);
    expect(readFileSync(join(models, 't2s_lightning_module.py'), 'utf8')).toBe('# 用户自己的副本');
  });
});
