import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dirBytes, topLevelBytes } from '../src/disk.ts';

describe('已安装文件体积', () => {
  it('累加子目录里的普通文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'gsv-disk-'));
    try {
      mkdirSync(join(root, 'a', 'b'), { recursive: true });
      writeFileSync(join(root, 'a', 'x.bin'), Buffer.alloc(1000));
      writeFileSync(join(root, 'a', 'b', 'y.bin'), Buffer.alloc(2000));
      expect(dirBytes(root)).toBe(3000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('不跟着目录联接把目标算两遍', () => {
    const root = mkdtempSync(join(tmpdir(), 'gsv-disk-'));
    try {
      const target = join(root, 'weights');
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'model.bin'), Buffer.alloc(5000));
      const runtime = join(root, 'runtime', 'GPT_SoVITS');
      mkdirSync(runtime, { recursive: true });
      const link = join(runtime, 'pretrained_models');
      try {
        symlinkSync(target, link, 'junction');
      } catch {
        return; // 这台机器不让建联接时跳过，别让用例失败
      }
      expect(dirBytes(join(root, 'runtime'))).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('目录不存在时返回 0', () => {
    expect(dirBytes(join(tmpdir(), 'gsv-disk-missing-xyz'))).toBe(0);
  });

  it('topLevelBytes 只算第一层文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'gsv-disk-'));
    try {
      writeFileSync(join(root, 'archive.zip'), Buffer.alloc(4000));
      mkdirSync(join(root, 'unpacked'));
      writeFileSync(join(root, 'unpacked', 'x.bin'), Buffer.alloc(9000));
      expect(topLevelBytes(root)).toBe(4000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
