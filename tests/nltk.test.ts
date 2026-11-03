import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hasNltkData, mirrorNltkData, missingNltkResources } from '../src/install.ts';

const made: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'gsv-nltk-'));
  made.push(dir);
  return dir;
};
const touch = (root: string, kind: string, name: string, body = 'x'): void => {
  mkdirSync(join(root, kind, name), { recursive: true });
  writeFileSync(join(root, kind, name, 'content'), body);
};

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('NLTK 语料预检', () => {
  it('缺两样都报；只缺 tagger 也要报（g2p_en 两者都要）', () => {
    const root = temp();
    expect(missingNltkResources(root)).toEqual(['corpora/cmudict', 'taggers/averaged_perceptron_tagger_eng']);
    mkdirSync(join(root, 'corpora'), { recursive: true });
    writeFileSync(join(root, 'corpora', 'cmudict'), 'x');
    expect(missingNltkResources(root)).toEqual(['taggers/averaged_perceptron_tagger_eng']);
    mkdirSync(join(root, 'taggers', 'averaged_perceptron_tagger_eng'), { recursive: true });
    expect(missingNltkResources(root)).toEqual([]);
  });

  it('hasNltkData 看的是运行时里的 runtime/nltk_data', () => {
    const runtime = temp();
    expect(hasNltkData(runtime)).toBe(false);
    touch(join(runtime, 'runtime', 'nltk_data'), 'corpora', 'cmudict');
    touch(join(runtime, 'runtime', 'nltk_data'), 'taggers', 'averaged_perceptron_tagger_eng');
    expect(hasNltkData(runtime)).toBe(true);
  });
});

describe('把语料同步进运行时', () => {
  it('复制缺失的文件，不动运行时已存在的文件', () => {
    const from = temp();
    const to = temp();
    touch(from, 'corpora', 'cmudict', 'from-zip');
    touch(from, 'taggers', 'averaged_perceptron_tagger_eng', 'from-zip');
    // 运行时自带的同名文件优先：内容不同且必须保留
    touch(to, 'corpora', 'cmudict', 'bundled');

    const copied = mirrorNltkData(from, to);
    expect(copied).toBeGreaterThan(0);
    expect(readFileSync(join(to, 'corpora', 'cmudict', 'content'), 'utf8')).toBe('bundled');
    expect(readFileSync(join(to, 'taggers', 'averaged_perceptron_tagger_eng', 'content'), 'utf8')).toBe('from-zip');
    expect(missingNltkResources(to)).toEqual([]);
  });

  it('再跑一次不复制（幂等）', () => {
    const from = temp();
    const to = temp();
    touch(from, 'corpora', 'cmudict');
    mirrorNltkData(from, to);
    expect(mirrorNltkData(from, to)).toBe(0);
  });
});
