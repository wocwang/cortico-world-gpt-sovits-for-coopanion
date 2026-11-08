/**
 * 云端密钥的落盘：AES-256-GCM 密文文件，主密钥来自部署 `.env` 的 `CORTICO_SECRET_KEY`。
 *
 * 目标（按主人的要求）：
 *   - `config.json` 里**永远不出现明文**，只存掩码（展示用）；
 *   - 明文只在「保存」与「发请求前解密」这两次停留在内存，不写日志；
 *   - 主密钥不在代码里：优先读 `.env`，没有就生成一条**追加进 .env**（写前备份），
 *     实在找不到/写不进去才退回数据目录的 `master.key`（强度弱一档，日志会说明）。
 *
 * 边界：能读进程内存或环境变量的人仍能拿到明文——这层保护的是静态文件、日志与误传，
 * 不是本机管理员。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** `.env` 里的变量名。 */
export const MASTER_ENV = 'CORTICO_SECRET_KEY';

const MAGIC = Buffer.from('CTT1');
const AAD = Buffer.from('cortico-cloud-tts-v1');
const FILE = 'cloud-tts.bin';

/** 只显示前后几位；短到看不出内容就全遮。 */
export function maskKey(key: string): string {
  const s = key.trim();
  if (s.length < 12) return '********';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** 主密钥接受 32 字节的 base64（44 字符）或 64 位 hex。 */
export function decodeMaster(raw: string): Buffer | null {
  const s = raw.trim().replace(/^["']|["']$/g, '');
  if (!s) return null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  try {
    const b = Buffer.from(s, 'base64');
    if (b.length === 32) return b;
  } catch { /* 不是 base64 */ }
  return null;
}

export interface KeyStoreOptions {
  /** 插件数据目录（`.../data/gpt-sovits`）。 */
  dataDir: string;
  /** 部署 `.env` 的候选路径，按优先级。 */
  envFiles: string[];
  /** 宿主注入的部署级密钥读取器（读 `.env`）。 */
  secret?: (name: string) => string;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export class CloudKeyStore {
  /** 本次进程里生成/读到的明文主密钥（重启后从 .env 重新读，不落盘到别处）。 */
  private master: Buffer | null = null;

  constructor(private readonly opts: KeyStoreOptions) {}

  /** 密文文件路径。 */
  file(): string {
    return join(this.opts.dataDir, 'secrets', FILE);
  }

  has(): boolean {
    return existsSync(this.file());
  }

  mask(): string {
    try {
      const key = this.read();
      return key ? maskKey(key) : '';
    } catch {
      return '';
    }
  }

  /** 解密出明文；没有密钥返回 null，主密钥换了/文件坏了抛错（面板要提示重新填）。 */
  read(): string | null {
    const file = this.file();
    if (!existsSync(file)) return null;
    const buf = readFileSync(file);
    if (buf.length < MAGIC.length + 12 + 16 + 1 || !buf.subarray(0, 4).equals(MAGIC)) {
      throw new Error('云端密钥文件已损坏，请在面板重新填写');
    }
    const nonce = buf.subarray(4, 16);
    const tag = buf.subarray(16, 32);
    const ct = buf.subarray(32);
    try {
      const d = createDecipheriv('aes-256-gcm', this.masterKey(), nonce);
      d.setAAD(AAD);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch (err) {
      throw new Error(`云端密钥无法解密（主密钥可能变了，或文件损坏）：${err instanceof Error ? err.message : String(err)}。请在面板重新填写一次。`);
    }
  }

  /** 保存明文，返回掩码；失败抛错。 */
  save(key: string): string {
    const plain = key.trim();
    if (!plain) throw new Error('密钥是空的');
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.masterKey(), nonce);
    c.setAAD(AAD);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    const tag = c.getAuthTag();
    const file = this.file();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, Buffer.concat([MAGIC, nonce, tag, ct]), { mode: 0o600 });
    renameSync(tmp, file);
    return maskKey(plain);
  }

  clear(): void {
    const file = this.file();
    if (existsSync(file)) unlinkSync(file);
  }

  /** 主密钥：缓存 → `.env`（必要时生成并追加）→ 数据目录 master.key（降级）。 */
  private masterKey(): Buffer {
    if (this.master) return this.master;
    const fromEnv = decodeMaster(this.opts.secret?.(MASTER_ENV) ?? '');
    if (fromEnv) {
      this.master = fromEnv;
      return fromEnv;
    }
    const envFile = this.opts.envFiles.find((p) => existsSync(p));
    if (envFile) {
      const found = readEnvValue(envFile, MASTER_ENV);
      const parsed = decodeMaster(found ?? '');
      if (parsed) {
        this.master = parsed;
        return parsed;
      }
      // 生成一条追加进去：写前备份，失败也不阻断（退回 master.key）。
      try {
        const key = randomBytes(32);
        const line = `${MASTER_ENV}=${key.toString('base64')}\n`;
        copyFileSync(envFile, `${envFile}.bak-${Date.now()}`);
        appendFileSync(envFile, (readFileSync(envFile, 'utf8').endsWith('\n') ? '' : '\n') + line, 'utf8');
        this.opts.log?.('已在部署 .env 里生成 CORTICO_SECRET_KEY（写前已备份）', { file: envFile });
        this.master = key;
        return key;
      } catch (err) {
        this.opts.log?.('写不进部署 .env，主密钥改放数据目录', { err: String(err) });
      }
    }
    return this.fallbackMaster();
  }

  /** 最后的退路：与密文同目录的 master.key（权限 0600）。 */
  private fallbackMaster(): Buffer {
    const file = join(this.opts.dataDir, 'secrets', 'master.key');
    if (existsSync(file)) {
      const parsed = decodeMaster(readFileSync(file, 'utf8'));
      if (parsed) return (this.master = parsed);
    }
    const key = randomBytes(32);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o600 });
    this.opts.log?.('没有可写的部署 .env，主密钥已生成到数据目录（强度较弱）', { file });
    return (this.master = key);
  }
}

/** 读 `.env` 里的某个变量（只认第一处，允许 `export ` 前缀与引号）。 */
function readEnvValue(file: string, name: string): string | null {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = new RegExp(`^(?:export\\s+)?${name}\\s*=\\s*(.*)$`).exec(line);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}
