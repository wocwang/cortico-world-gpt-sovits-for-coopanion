import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RUNTIME_ASSETS } from '../src/catalog.ts';
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

describe('ROCm 运行时资产', () => {
  it('整包字节与分片对得上，哈希是 64 位十六进制', () => {
    const rocm = RUNTIME_ASSETS.rocm;
    expect(rocm.bytes).toBeGreaterThan(0);
    expect(rocm.sha256).toMatch(/^[0-9a-f]{64}$/);
    const sum = (rocm.parts ?? []).reduce((n, part) => n + part.bytes, 0);
    expect(sum).toBe(rocm.bytes);
  });

  it('整包先走魔搭，GitHub 只做分片兜底', () => {
    const rocm = RUNTIME_ASSETS.rocm;
    expect(rocm.sources.some((source) => source.includes('modelscope.cn'))).toBe(true);
    expect(rocm.parts?.length).toBeGreaterThan(0);
    for (const part of rocm.parts ?? []) {
      expect(part.sources.every((source) => source.includes('github.com'))).toBe(true);
    }
  });

  it('共享的 cuda / cpu 资产没有被 ROCm 改动', () => {
    expect(RUNTIME_ASSETS.cuda.bytes).toBe(4140732064);
    expect(RUNTIME_ASSETS.cpu.bytes).toBe(1036310624);
    expect(RUNTIME_ASSETS.cuda.sha256).toBe('87c775a93f9b13195b83bc2901a6176f771e31076bc051acf07a5ccca1db7a78');
  });
});
