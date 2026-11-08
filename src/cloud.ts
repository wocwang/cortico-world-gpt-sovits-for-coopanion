/**
 * 云端语音：OpenAI 兼容的 `POST {base}/audio/speech`。
 *
 * 只做「文本 → WAV 字节」这一件事：不播放、不写盘、不发 QQ。返回的 PCM 交给现有播放器，
 * WAV 交给 9880 / 附件句柄，所以 RVC、`[blob …]`、QQ 都不需要知道声音是不是云端来的。
 *
 * 只接受 WAV（请求里带 `response_format: "wav"`）：多数厂商默认回 mp3，Node 没有解码器，
 * 与其引 ffmpeg 不如明确报错。响应不是 RIFF 头就按「厂商没听话」处理。
 */
import { randomUUID } from 'node:crypto';
import { parseWavHeader } from './synth.ts';

export type CloudErrorKind = 'config' | 'auth' | 'quota' | 'rate' | 'network' | 'timeout' | 'bad-audio' | 'failed';

export class CloudError extends Error {
  constructor(message: string, readonly kind: CloudErrorKind) {
    super(message);
    this.name = 'CloudError';
  }
}

export interface CloudOptions {
  baseUrl: string;
  model: string;
  voice: string;
  speed: number;
  timeoutMs: number;
  key: string;
}

export interface CloudAudio {
  /** 完整 WAV（RIFF 头 + data），可直接交出去。 */
  wav: Buffer;
  /** 去掉头之后的单声道 PCM16。 */
  pcm: Buffer;
  sampleRate: number;
  ms: number;
}

/** 把密钥从任何错误文本里抹掉：厂商回显、URL 参数、异常 message 都可能带。 */
export function redact(text: string, key: string): string {
  if (!key) return text;
  return text.split(key).join('[redacted]');
}

/** `https://api.openai.com/v1` → `.../v1/audio/speech`；已经写到端点的就原样用。 */
export function speechUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new CloudError('云端地址没填（要填到 /v1 这一层）', 'config');
  return /\/audio\/speech$/.test(base) ? base : `${base}/audio/speech`;
}

/** 把 32 位立体声降成单声道（厂商偶尔回立体声；播放器只吃单声道）。 */
function downmix(pcm: Buffer, channels: number): Buffer {
  if (channels <= 1) return pcm;
  const frames = Math.floor(pcm.length / (2 * channels));
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += pcm.readInt16LE((i * channels + c) * 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / channels))), i * 2);
  }
  return out;
}

/** 合成一句；失败抛 `CloudError`，消息已脱敏。 */
export async function synthCloud(text: string, opts: CloudOptions, signal?: AbortSignal): Promise<CloudAudio> {
  if (!opts.key) throw new CloudError('云端密钥还没设置（面板里填一次即可）', 'config');
  if (!opts.voice.trim()) throw new CloudError('云端音色没选（先添加一个 voice id）', 'config');
  const url = speechUrl(opts.baseUrl);
  const body: Record<string, unknown> = {
    model: opts.model.trim() || 'tts-1',
    voice: opts.voice.trim(),
    input: text,
    response_format: 'wav',
  };
  if (Number.isFinite(opts.speed) && opts.speed > 0) body.speed = Math.min(4, Math.max(0.25, opts.speed));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), Math.max(5000, opts.timeoutMs));
  const onAbort = (): void => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'audio/wav',
        authorization: `Bearer ${opts.key}`,
        'x-request-id': randomUUID(),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new CloudError('这一句被取消了', 'failed');
    if (ctrl.signal.aborted) throw new CloudError(`云端超时（${Math.round(Math.max(5000, opts.timeoutMs) / 1000)} s 没回完）`, 'timeout');
    const msg = redact(err instanceof Error ? err.message : String(err), opts.key);
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) throw new CloudError('云端地址解析失败（DNS）', 'network');
    if (/ECONNREFUSED|ECONNRESET|socket hang up|terminated/i.test(msg)) throw new CloudError('连不上云端（连接被拒或中断）', 'network');
    if (/certificate|TLS|SSL/i.test(msg)) throw new CloudError('云端 TLS 握手失败（证书问题）', 'network');
    throw new CloudError(`云端请求失败：${msg}`, 'network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let detail = raw.slice(0, 300);
    try {
      const j = JSON.parse(raw) as { error?: { message?: string } | string; message?: string; detail?: string };
      const e = j.error;
      detail = (typeof e === 'string' ? e : e?.message) ?? j.message ?? j.detail ?? detail;
    } catch { /* 非 JSON 用原文 */ }
    detail = redact(String(detail), opts.key).trim();
    if (res.status === 401 || res.status === 403) throw new CloudError(`云端拒绝鉴权（HTTP ${res.status}）：${detail || '密钥无效'}`, 'auth');
    if (res.status === 402) throw new CloudError(`云端额度不足（HTTP 402）：${detail}`, 'quota');
    if (res.status === 429) throw new CloudError(`云端限流（HTTP 429）：${detail || '稍后再试'}`, 'rate');
    throw new CloudError(`云端合成失败（HTTP ${res.status}）：${detail}`, 'failed');
  }

  const wav = Buffer.from(await res.arrayBuffer());
  const head = parseWavHeader(wav);
  if (!head) {
    throw new CloudError(
      '云端回的不是 WAV（可能厂商忽略 response_format）。请换支持 WAV 的模型/音色，或把响应格式改成 wav。',
      'bad-audio',
    );
  }
  const rawPcm = wav.subarray(head.dataStart);
  const pcm = downmix(rawPcm, head.channels);
  if (!pcm.length) throw new CloudError('云端回了空音频', 'bad-audio');
  return { wav, pcm, sampleRate: head.sampleRate, ms: Date.now() - started };
}
