import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_VERSION } from '../src/catalog.ts';
import { DEPS_REVISION, depsReady } from '../src/trainer.ts';

const roots: string[] = [];
const temp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `gsv-${name}-`));
  roots.push(dir);
  return dir;
};
afterAll(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

/** 同时铺 Windows / POSIX 两种 site-packages 布局，测试在哪个平台都成立；每个包都带 dist-info。 */
function runtimeWith(packages: Array<[string, string]>): string {
  const dir = temp('runtime');
  const sites = [
    join(dir, 'runtime', 'Lib', 'site-packages'),
    join(dir, 'runtime', 'lib', 'python3.11', 'site-packages'),
  ];
  for (const site of sites) {
    mkdirSync(site, { recursive: true });
    for (const [name, version] of packages) {
      mkdirSync(join(site, name), { recursive: true });
      mkdirSync(join(site, `${name}-${version}.dist-info`), { recursive: true });
    }
  }
  return dir;
}

/** 合乎 TRAIN_PACKAGES 口径的一套：gradio 4.x + funasr >= 1.3.7。 */
const GOOD: Array<[string, string]> = [['gradio', '4.44.1'], ['funasr', '1.4.9']];

function writeMark(dataDir: string, mark: Record<string, unknown>): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'trainer-deps.json'), JSON.stringify(mark));
}

describe('depsReady', () => {
  it('标记绑定当前目录且 site-packages 里真有 gradio / funasr 才算就绪', () => {
    const dataDir = temp('data');
    const runtimeDir = runtimeWith(GOOD);
    writeMark(dataDir, { runtime: RUNTIME_VERSION, revision: DEPS_REVISION, dir: runtimeDir });
    expect(depsReady(dataDir, runtimeDir)).toBe(true);
  });

  it('运行时被换过、包不在了：同一份标记也不再假报就绪', () => {
    const dataDir = temp('data');
    const oldRuntime = runtimeWith(GOOD);
    writeMark(dataDir, { runtime: RUNTIME_VERSION, revision: DEPS_REVISION, dir: oldRuntime });
    const newRuntime = runtimeWith([['gradio', '4.44.1']]); // 像 cpu 档：少了 funasr
    expect(depsReady(dataDir, newRuntime)).toBe(false);
  });

  it('标记指向别的目录时失效', () => {
    const dataDir = temp('data');
    const runtimeDir = runtimeWith(GOOD);
    writeMark(dataDir, { runtime: RUNTIME_VERSION, revision: DEPS_REVISION, dir: join(runtimeDir, 'other') });
    expect(depsReady(dataDir, runtimeDir)).toBe(false);
  });

  it('旧标记没有 dir 字段，视为过期', () => {
    const dataDir = temp('data');
    const runtimeDir = runtimeWith(GOOD);
    writeMark(dataDir, { runtime: RUNTIME_VERSION, revision: DEPS_REVISION });
    expect(depsReady(dataDir, runtimeDir)).toBe(false);
  });

  it('运行时版本或清单修订号对不上也失效', () => {
    const dataDir = temp('data');
    const runtimeDir = runtimeWith(GOOD);
    writeMark(dataDir, { runtime: 'old', revision: DEPS_REVISION, dir: runtimeDir });
    expect(depsReady(dataDir, runtimeDir)).toBe(false);
    writeMark(dataDir, { runtime: RUNTIME_VERSION, revision: DEPS_REVISION - 1, dir: runtimeDir });
    expect(depsReady(dataDir, runtimeDir)).toBe(false);
  });

  it('gradio 目录缺失（本机 cpu 档的真实情形）判为未就绪', () => {
    const dataDir = temp('data');
    const runtimeDir = runtimeWith([['funasr', '1.4.9']]);
    writeMark(dataDir, { runtime: RUNTIME_VERSION, revision: DEPS_REVISION, dir: runtimeDir });
    expect(depsReady(dataDir, runtimeDir)).toBe(false);
  });

  it('手动装了 gradio 6.x：目录在也不算就绪（对应 issue #14 的漏网分支）', () => {
    const dataDir = temp('data');
    const runtimeDir = runtimeWith([['gradio', '6.31.0'], ['funasr', '1.4.9']]);
    writeMark(dataDir, { runtime: RUNTIME_VERSION, revision: DEPS_REVISION, dir: runtimeDir });
    expect(depsReady(dataDir, runtimeDir)).toBe(false);
  });

  it('funasr 低于 1.3.7 也不算就绪', () => {
    const dataDir = temp('data');
    const runtimeDir = runtimeWith([['gradio', '4.44.1'], ['funasr', '1.2.0']]);
    writeMark(dataDir, { runtime: RUNTIME_VERSION, revision: DEPS_REVISION, dir: runtimeDir });
    expect(depsReady(dataDir, runtimeDir)).toBe(false);
  });

  it('只有包目录、没有 dist-info：版本不可信，按未就绪处理', () => {
    const dataDir = temp('data');
    const runtimeDir = temp('runtime');
    const site = join(runtimeDir, 'runtime', 'Lib', 'site-packages');
    for (const name of ['gradio', 'funasr']) mkdirSync(join(site, name), { recursive: true });
    writeMark(dataDir, { runtime: RUNTIME_VERSION, revision: DEPS_REVISION, dir: runtimeDir });
    expect(depsReady(dataDir, runtimeDir)).toBe(false);
  });

  it('Windows 下目录大小写不同仍认作同一目录', () => {
    const dataDir = temp('data');
    const runtimeDir = runtimeWith(GOOD);
    writeMark(dataDir, { runtime: RUNTIME_VERSION, revision: DEPS_REVISION, dir: runtimeDir.toUpperCase() });
    expect(depsReady(dataDir, runtimeDir)).toBe(process.platform === 'win32');
  });
});
