import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CloudKeyStore, MASTER_ENV, decodeMaster, maskKey, type KeyStoreOptions } from '../src/secret-store.ts';

const KEY = 'sk-live-abcdefghijklmnop';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gsv-secret-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const envPath = (): string => join(dir, '.env');
const dataDir = (): string => join(dir, 'data');
const master = (seed: number): string => Buffer.from(Array.from({ length: 32 }, (_, i) => (i + seed) & 0xff)).toString('base64');
const store = (patch: Partial<KeyStoreOptions> = {}): CloudKeyStore => new CloudKeyStore({
  dataDir: dataDir(),
  envFiles: [envPath()],
  ...patch,
});
/** 预先写一条合法主密钥进 `.env`，让测试不受自动生成分支影响。 */
const withEnvMaster = (seed = 0): CloudKeyStore => {
  writeFileSync(envPath(), `${MASTER_ENV}=${master(seed)}\n`);
  return store();
};

describe('密钥掩码与主密钥解析', () => {
  it('长密钥只露前后四位，短密钥全遮', () => {
    expect(maskKey('sk-1234567890abcdef')).toBe('sk-1…cdef');
    expect(maskKey('short')).toBe('********');
    expect(maskKey('  short  ')).toBe('********');
  });

  it('主密钥接受 64 位 hex 与 32 字节 base64，别的一律不认', () => {
    expect(decodeMaster('a'.repeat(64))?.length).toBe(32);
    expect(decodeMaster(master(0))?.length).toBe(32);
    expect(decodeMaster(`"${master(0)}"`)?.length).toBe(32);
    expect(decodeMaster('not-a-key')).toBeNull();
    expect(decodeMaster(master(0).slice(0, 20))).toBeNull();
    expect(decodeMaster('')).toBeNull();
  });
});

describe('云端密钥落盘', () => {
  it('保存后能解回原文，文件里没有明文', () => {
    const s = withEnvMaster();
    const mask = s.save(KEY);
    expect(mask).toBe(maskKey(KEY));
    expect(s.has()).toBe(true);
    expect(s.read()).toBe(KEY);
    expect(s.mask()).toBe(mask);
    const raw = readFileSync(s.file());
    expect(raw.subarray(0, 4).toString('ascii')).toBe('CTT1');
    expect(raw.toString('utf8')).not.toContain(KEY);
  });

  it('没有密钥文件时 read 返回 null、mask 为空', () => {
    const s = withEnvMaster();
    expect(s.has()).toBe(false);
    expect(s.read()).toBeNull();
    expect(s.mask()).toBe('');
  });

  it('文件损坏时明确报错（面板要提示重新填写）', () => {
    const s = withEnvMaster();
    s.save(KEY);
    writeFileSync(s.file(), Buffer.alloc(40));
    expect(() => s.read()).toThrow(/损坏/);
  });

  it('换过主密钥就解不开，错误提示重新填写', () => {
    const first = store({ secret: () => master(1) });
    first.save(KEY);
    const second = store({ secret: () => master(2) });
    expect(() => second.read()).toThrow(/无法解密/);
  });

  it('clear 之后文件消失，状态回到未设置', () => {
    const s = withEnvMaster();
    s.save(KEY);
    expect(s.has()).toBe(true);
    s.clear();
    expect(s.has()).toBe(false);
    expect(s.read()).toBeNull();
  });

  it('部署 .env 缺主密钥时自动生成并追加，写前留备份', () => {
    writeFileSync(envPath(), 'FOO=bar\n');
    const s = store();
    s.save(KEY);
    const text = readFileSync(envPath(), 'utf8');
    expect(text).toContain('FOO=bar');
    expect(text).toMatch(new RegExp(`^${MASTER_ENV}=`, 'm'));
    expect(readdirSync(dir).filter((name) => name.startsWith('.env.bak-')).length).toBe(1);
    // 新进程（新实例）重新从 .env 读主密钥，仍能解开同一份密文。
    expect(store().read()).toBe(KEY);
  });

  it('没有可写的 .env 时退回数据目录的 master.key（跨实例可解）', () => {
    const s = store({ envFiles: [join(dir, 'missing', '.env')] });
    s.save(KEY);
    const fallback = join(dataDir(), 'secrets', 'master.key');
    expect(existsSync(fallback)).toBe(true);
    expect(decodeMaster(readFileSync(fallback, 'utf8'))?.length).toBe(32);
    expect(store({ envFiles: [join(dir, 'missing', '.env')] }).read()).toBe(KEY);
  });

  it('宿主注入的 secret 优先于 .env 文件', () => {
    // .env 不存在，但框架已经把部署密钥交进来了：不应生成 master.key。
    const s = store({ secret: () => master(3) });
    s.save(KEY);
    expect(s.read()).toBe(KEY);
    expect(existsSync(join(dataDir(), 'secrets', 'master.key'))).toBe(false);
  });

  it('空密钥拒绝保存，也不建文件', () => {
    const s = withEnvMaster();
    expect(() => s.save('   ')).toThrow(/空/);
    expect(s.has()).toBe(false);
    expect(dirname(s.file())).toBe(join(dataDir(), 'secrets'));
  });
});
