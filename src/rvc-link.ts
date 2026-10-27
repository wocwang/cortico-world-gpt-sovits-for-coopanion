/**
 * 出口变声：把交给其他插件的 WAV 再送本机 RVC 插件（cortico-world-rvc-for-coopanion）过一遍。
 *
 * 契约只有一条：**永不断链路**。`convert` 不抛、不返回空——没开、连不上、超时、
 * 非 2xx、回的不是 WAV，一律原样交回原音频；失败日志按同一句话每分钟最多一条。
 * 探测（`probe`）只给面板看状态，不参与合成决策。
 */
import type { Logger } from 'cortico/core/types.ts';

/** `worlds.gpt-sovits.rvc` 段；config.ts 的默认值与这里对应。 */
export interface RvcLinkConfig {
  enabled: boolean;
  /** 例：`http://127.0.0.1:9881`。 */
  endpoint: string;
  token: string;
  timeoutMs: number;
  pitch: number;
  indexRate: number;
  protect: number;
}

/** 面板上的四态：没开 / 连不上 / 没就绪 / 就绪；`error` 是对方回了非 2xx。 */
export type RvcProbeState = 'off' | 'absent' | 'not-ready' | 'ready' | 'error';

export interface RvcProbe {
  state: RvcProbeState;
  /** 原始说明（HTTP 状态、异常消息），面板按语言拼句子。 */
  detail: string;
  device: string | null;
  model: string | null;
}

/** 同一句错误最多每分钟记一条，别让一句失败把日志刷满。 */
const ERROR_LOG_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 3000;
/** 失败日志里最多留几种不同的错误。 */
const ERROR_KINDS_MAX = 20;

const trimSlash = (url: string): string => url.trim().replace(/\/+$/, '');

const headersFor = (token: string): Record<string, string> => {
  const t = token.trim();
  return t ? { authorization: `Bearer ${t}` } : {};
};

export class RvcLink {
  private readonly loggedAt = new Map<string, number>();

  constructor(
    private readonly cfg: () => RvcLinkConfig | undefined,
    private readonly log: () => Logger,
  ) {}

  /** 当前配置（缺省值兜底），面板与测试用。 */
  config(): RvcLinkConfig {
    const c = this.cfg();
    return {
      enabled: c?.enabled === true,
      endpoint: c?.endpoint ?? 'http://127.0.0.1:9881',
      token: c?.token ?? '',
      timeoutMs: c?.timeoutMs ?? 8000,
      pitch: c?.pitch ?? 0,
      indexRate: c?.indexRate ?? 0.3,
      protect: c?.protect ?? 0.33,
    };
  }

  /** 变声；任何失败都原样返回 `wav`。 */
  async convert(wav: Buffer): Promise<Buffer> {
    const c = this.config();
    const endpoint = trimSlash(c.endpoint);
    if (!c.enabled || !endpoint || !wav.length) return wav;
    const at = Date.now();
    try {
      const out = await this.post(endpoint, c, wav);
      this.log().info('RVC 出口变声完', { ms: Date.now() - at, bytes: out.length });
      return out;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.warnOnce(`convert:${why}`);
      return wav;
    }
  }

  /** 面板「检测」：只看对方此刻的健康状态，不要求 `enabled`。 */
  async probe(): Promise<RvcProbe> {
    const c = this.config();
    const endpoint = trimSlash(c.endpoint);
    if (!endpoint) return { state: 'off', detail: 'endpoint is empty', device: null, model: null };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`${endpoint}/health`, { signal: ctrl.signal, headers: headersFor(c.token) });
      if (!res.ok) return { state: 'error', detail: `HTTP ${res.status}`, device: null, model: null };
      const body = (await res.json().catch(() => ({}))) as { ready?: unknown; device?: unknown; model?: unknown };
      const device = typeof body.device === 'string' ? body.device : null;
      const model = typeof body.model === 'string' ? body.model : null;
      return body.ready === true
        ? { state: 'ready', detail: '', device, model }
        : { state: 'not-ready', detail: '', device, model };
    } catch (err) {
      const why = ctrl.signal.aborted ? `no answer in ${PROBE_TIMEOUT_MS} ms` : err instanceof Error ? err.message : String(err);
      return { state: 'absent', detail: why, device: null, model: null };
    } finally {
      clearTimeout(timer);
    }
  }

  private async post(endpoint: string, c: RvcLinkConfig, wav: Buffer): Promise<Buffer> {
    const timeoutMs = Math.max(500, c.timeoutMs);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'line.wav');
      form.set('pitch', String(Math.round(c.pitch)));
      form.set('indexRate', String(c.indexRate));
      form.set('protect', String(c.protect));
      form.set('format', 'wav');
      const res = await fetch(`${endpoint}/convert`, {
        method: 'POST',
        body: form,
        signal: ctrl.signal,
        headers: headersFor(c.token),
      });
      if (!res.ok) throw new Error(`RVC 回 ${res.status}`);
      const out = Buffer.from(await res.arrayBuffer());
      if (!out.length) throw new Error('RVC 回了空音频');
      if (out.subarray(0, 4).toString() !== 'RIFF') throw new Error('RVC 回的不是 WAV');
      return out;
    } catch (err) {
      if (ctrl.signal.aborted) throw new Error(`RVC 超过 ${timeoutMs} ms 没回`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 同一句错误每分钟最多一条；错误种类太多时清空重来，别让 map 长。 */
  private warnOnce(key: string): void {
    const now = Date.now();
    const last = this.loggedAt.get(key) ?? 0;
    if (now - last < ERROR_LOG_INTERVAL_MS) return;
    if (this.loggedAt.size > ERROR_KINDS_MAX) this.loggedAt.clear();
    this.loggedAt.set(key, now);
    this.log().warn('RVC 出口变声失败，这次原样返回', { err: key.slice(7, 200) });
  }
}
