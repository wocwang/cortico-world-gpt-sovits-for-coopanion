/**
 * 云端语音：按所选厂商拼请求，统一归一成 WAV 字节。
 * - 自定义 / OpenAI：`POST {base}/audio/speech`（`Bearer`）
 * - Breeze Blue：`POST {base}/text-to-speech/{voice}`（`xi-api-key`）
 * - Azure：`POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1`（SSML）
 * - MiniMax：`POST {base}/t2a_v2`（`Bearer`，返回 hex，声明的格式是 wav）
 * - ElevenLabs：`POST {base}/text-to-speech/{voice}?output_format=wav_24000`（`xi-api-key`）
 *
 * 只做「文本 → WAV 字节」这一件事：不播放、不写盘、不发 QQ。返回的 PCM 交给现有播放器，
 * WAV 交给 9880 / 附件句柄，所以 RVC、`[blob …]`、QQ 都不需要知道声音是不是云端来的。
 *
 * 只接受 WAV：请求里一律先向厂商索取 WAV（response_format / format / output_format）。
 * Node 没有解码器，也不引 ffmpeg：回 mp3 / ogg 就明确报错，不静默降级。
 */
import { randomUUID } from 'node:crypto';
import { resolveCloudProvider, type CloudProviderSpec } from './cloud-providers.ts';
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
  /** 合成语言（`zh` / `en` / …）；只给需要它的服务商（Breeze Blue）用，其余忽略。 */
  language?: string;
  /** 服务商 id；留空时按地址推断（Breeze / OpenAI / 自定义），与旧配置一致。 */
  provider?: string;
  /** Azure 区域（如 `eastus`）；只有 Azure 用。 */
  region?: string;
  /** MiniMax 的 GroupId（可选）。 */
  groupId?: string;
  /** 火山引擎的应用 ID（app.appid）。 */
  appId?: string;
  /** 火山引擎的集群（默认 volcano_tts）。 */
  cluster?: string;
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

/**
 * Breeze Blue 的开发者 API（`https://api.breeze.blue/v1`）不是 OpenAI 兼容协议：
 * 鉴权是 `xi-api-key`，合成是 `POST /text-to-speech/{voice_id}`，音色清单是 `GET /voices`。
 * 只认官方主机名，避免把第三方镜像当成它。
 */
export function isBreezeBlueBase(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    return host === 'api.breeze.blue' || host.endsWith('.breeze.blue');
  } catch {
    return false;
  }
}

/** `https://api.breeze.blue/v1` → `.../v1/text-to-speech/<voice>`；已经写到端点的原样用。 */
export function breezeSpeechUrl(baseUrl: string, voice: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new CloudError('云端地址没填（要填到 /v1 这一层）', 'config');
  if (/\/text-to-speech\/[^/]+$/i.test(base)) return base;
  return `${base}/text-to-speech/${encodeURIComponent(voice.trim())}`;
}

/** Azure 只按区域拼主机：`eastus` → `https://eastus.tts.speech.microsoft.com/cognitiveservices/v1`。 */
export function azureSpeechUrl(region: string): string {
  const clean = region.trim().toLowerCase();
  if (!clean) throw new CloudError('Azure 区域没填（如 eastus、eastasia）', 'config');
  if (!/^[a-z0-9]+$/.test(clean)) throw new CloudError(`Azure 区域格式不对：${clean}（只允许小写字母和数字）`, 'config');
  return `https://${clean}.tts.speech.microsoft.com/cognitiveservices/v1`;
}

/** `https://api.minimax.cn/v1` → `.../v1/t2a_v2`；已经写到 `/t2a_v2` 的原样用。 */
export function minimaxSpeechUrl(baseUrl: string, groupId = ''): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new CloudError('云端地址没填（MiniMax 默认 https://api.minimax.cn/v1/t2a_v2）', 'config');
  const url = /\/t2a_v2$/i.test(base) ? base : `${base}/t2a_v2`;
  const group = groupId.trim();
  return group ? `${url}?GroupId=${encodeURIComponent(group)}` : url;
}

/** `https://api.elevenlabs.io/v1` → `.../v1/text-to-speech/<voice>`；已写到端点的原样用。 */
export function elevenLabsSpeechUrl(baseUrl: string, voice: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new CloudError('云端地址没填（要填到 /v1 这一层）', 'config');
  if (/\/text-to-speech\/[^/]+$/i.test(base)) return base;
  return `${base}/text-to-speech/${encodeURIComponent(voice.trim())}`;
}

/** `https://api.xiaomimimo.com/v1` → `.../v1/chat/completions`；已经写到端点的原样用。 */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new CloudError('云端地址没填（MiMo 默认 https://api.xiaomimimo.com/v1）', 'config');
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

/** Fish Audio 的合成端点是 `{base}/tts`（MessagePack 请求体）。 */
export function fishTtsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new CloudError('云端地址没填（Fish 默认 https://api.fish.audio/v1）', 'config');
  return /\/tts$/i.test(base) ? base : `${base}/tts`;
}

/** MessagePack 字符串（fixstr / str8 / str16），Fish 的请求体只放字符串字段。 */
function msgpackString(value: string): Buffer {
  const data = Buffer.from(value, 'utf8');
  if (data.length < 32) return Buffer.concat([Buffer.from([0xa0 + data.length]), data]);
  if (data.length < 256) return Buffer.concat([Buffer.from([0xd9, data.length]), data]);
  if (data.length < 65536) {
    const head = Buffer.alloc(3);
    head[0] = 0xda;
    head.writeUInt16BE(data.length, 1);
    return Buffer.concat([head, data]);
  }
  throw new CloudError('Fish 的单句文本太长（超过 64 KB），先拆句再合成', 'config');
}

/** 只编码一层 string→string 的 map（fixmap），够 Fish 的 text / reference_id / format 用。 */
export function msgpackMap(fields: Record<string, string>): Buffer {
  const rows = Object.entries(fields);
  if (rows.length > 15) throw new CloudError('Fish 请求字段过多', 'config');
  return Buffer.concat([Buffer.from([0x80 + rows.length]), ...rows.flatMap(([k, v]) => [msgpackString(k), msgpackString(v)])]);
}

/** 解 base64 音频（MiMo / 火山引擎），校验字符集避免把错误页当音频。 */
function base64Audio(value: unknown, label: string): Buffer {
  if (typeof value !== 'string' || !value) throw new CloudError(`${label} 没返回音频数据`, 'bad-audio');
  const clean = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) throw new CloudError(`${label} 返回的音频不是合法的 base64`, 'bad-audio');
  return Buffer.from(clean, 'base64');
}
function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
}

/** 从音色名推 SSML 的 `xml:lang`（`zh-CN-YunxiaNeural` → `zh-CN`），推不出按中文。 */
function azureLocale(voice: string): string {
  return /^([a-z]{2,3}-[A-Z]{2})/.exec(voice)?.[1] ?? 'zh-CN';
}

/** 响应头里没有格式信息时，按前几个字节判断厂商实际回了什么（只用于报错文案）。 */
export function audioKind(buf: Buffer): string {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'WAV';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') return 'MP3';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) return 'MP3';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return 'OGG';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'fLaC') return 'FLAC';
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return 'M4A';
  return '未知格式';
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

/** 不支持的原因（服务端报错也用它，保证界面与日志口径一致）。 */
const UNSUPPORTED_REASON: Record<string, string> = {
  python: '需要本机安装 Python 语音包，本插件不内置',
  pcm: '只返回无头 PCM，拿不到可校验的 WAV',
  mp3: '只返回 mp3 / ogg 等压缩格式，本插件不做解码',
  unverified: '接口文档无法核实，暂不接入',
  local: '这是本机/局域网的 GPT-SoVITS，请改用本地引擎或本机语音接口',
  url: '只返回下载地址，无法保证是 WAV',
};

/** 按厂商拼一次请求；文本字段、鉴权头、请求体形状全在这里分流。 */
function buildRequest(spec: CloudProviderSpec, text: string, opts: CloudOptions): { url: string; headers: Record<string, string>; body: string | Buffer } {
  const headers: Record<string, string> = { accept: 'audio/wav', 'x-request-id': randomUUID() };
  const body: Record<string, unknown> = {};
  switch (spec.id) {
    case 'breeze': {
      // Breeze Blue：`xi-api-key` 鉴权，文本字段是 `text`，模型留空由服务商自动选。
      headers['content-type'] = 'application/json';
      headers['xi-api-key'] = opts.key;
      body.text = text;
      const model = opts.model.trim();
      if (model && model !== 'tts-1') body.model_id = model;
      const lang = (opts.language ?? '').trim().toLowerCase();
      if (/^[a-z]{2}$/.test(lang)) body.language_code = lang;
      return { url: `${breezeSpeechUrl(opts.baseUrl, opts.voice)}?output_format=wav`, headers, body: JSON.stringify(body) };
    }
    case 'azure': {
      const locale = azureLocale(opts.voice.trim());
      const rate = Number.isFinite(opts.speed) && opts.speed > 0 ? Math.min(2, Math.max(0.5, opts.speed)) : 1;
      const prosody = `<prosody rate="${rate}">${xmlEscape(text)}</prosody>`;
      const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">`
        + `<voice name="${xmlEscape(opts.voice.trim())}">${prosody}</voice></speak>`;
      headers['content-type'] = 'application/ssml+xml';
      headers['Ocp-Apim-Subscription-Key'] = opts.key;
      // riff = WAV；不用 mp3 输出格式，省得回来还要转码。
      headers['X-Microsoft-OutputFormat'] = 'riff-24khz-16bit-mono-pcm';
      return { url: azureSpeechUrl(opts.region ?? ''), headers, body: ssml };
    }
    case 'minimax': {
      headers['content-type'] = 'application/json';
      headers.authorization = `Bearer ${opts.key}`;
      const speed = Number.isFinite(opts.speed) && opts.speed > 0 ? Math.min(2, Math.max(0.5, opts.speed)) : 1;
      body.model = opts.model.trim() || 'speech-2.8-turbo';
      body.text = text;
      body.stream = false;
      // hex 是 t2a_v2 的非流式默认输出；wav 由 audio_setting.format 指定。
      body.output_format = 'hex';
      body.language_boost = 'auto';
      body.voice_setting = { voice_id: opts.voice.trim(), ...(speed !== 1 ? { speed } : {}) };
      body.audio_setting = { format: 'wav', sample_rate: 32000, bitrate: 128000, channel: 1 };
      return { url: minimaxSpeechUrl(opts.baseUrl, opts.groupId ?? ''), headers, body: JSON.stringify(body) };
    }
    case 'elevenlabs': {
      headers['content-type'] = 'application/json';
      headers['xi-api-key'] = opts.key;
      body.text = text;
      body.model_id = opts.model.trim() || 'eleven_multilingual_v2';
      // wav_24000 是标准档就能用的 WAV 输出（44.1 kHz 的 WAV 要 Pro）。
      return { url: `${elevenLabsSpeechUrl(opts.baseUrl, opts.voice)}?output_format=wav_24000`, headers, body: JSON.stringify(body) };
    }
    case 'volcengine': {
      const appId = (opts.appId ?? '').trim();
      if (!appId) throw new CloudError('火山引擎的应用 ID（appId）没填', 'config');
      headers['content-type'] = 'application/json';
      // 豆包语音的鉴权头格式是 `Bearer; <token>`（分号和空格都保留）。
      headers.authorization = `Bearer; ${opts.key}`;
      body.app = { appid: appId, token: opts.key, cluster: (opts.cluster ?? '').trim() || 'volcano_tts' };
      body.user = { uid: 'gp-sovits' };
      const speed = Number.isFinite(opts.speed) && opts.speed > 0 ? Math.min(3, Math.max(0.2, opts.speed)) : 1;
      body.audio = { voice_type: opts.voice.trim(), encoding: 'wav', speed_ratio: speed };
      body.request = { reqid: randomUUID(), text, text_type: 'plain', operation: 'query' };
      return { url: opts.baseUrl.trim() || 'https://openspeech.bytedance.com/api/v1/tts', headers, body: JSON.stringify(body) };
    }
    case 'mimo': {
      headers['content-type'] = 'application/json';
      // 官方文档的两种鉴权任选其一：这里用 `api-key`（第一方案）。
      headers['api-key'] = opts.key;
      body.model = opts.model.trim() || 'mimo-v2.5-tts';
      body.messages = [{ role: 'assistant', content: text }];
      body.audio = { format: 'wav', ...(opts.voice.trim() ? { voice: opts.voice.trim() } : {}) };
      return { url: chatCompletionsUrl(opts.baseUrl), headers, body: JSON.stringify(body) };
    }
    case 'fish': {
      headers['content-type'] = 'application/msgpack';
      headers.authorization = `Bearer ${opts.key}`;
      const model = opts.model.trim();
      if (model) headers.model = model;
      return {
        url: fishTtsUrl(opts.baseUrl),
        headers,
        body: msgpackMap({ text, reference_id: opts.voice.trim(), format: 'wav' }),
      };
    }
    default: {
      headers['content-type'] = 'application/json';
      headers.authorization = `Bearer ${opts.key}`;
      body.model = opts.model.trim() || 'tts-1';
      body.voice = opts.voice.trim();
      body.input = text;
      body.response_format = 'wav';
      if (Number.isFinite(opts.speed) && opts.speed > 0) body.speed = Math.min(4, Math.max(0.25, opts.speed));
      return { url: speechUrl(opts.baseUrl), headers, body: JSON.stringify(body) };
    }
  }
}

/** MiniMax 的音频在 JSON 的 `data.audio` 里，是 hex；只做 hex → 字节，不做解码。 */
function minimaxAudio(raw: Buffer, key: string): Buffer {
  let parsed: { data?: { audio?: unknown }; base_resp?: { status_code?: unknown; status_msg?: unknown } };
  try {
    parsed = JSON.parse(raw.toString('utf8')) as typeof parsed;
  } catch {
    throw new CloudError('MiniMax 回的不是 JSON（检查地址是否指向 /t2a_v2）', 'failed');
  }
  const code = parsed?.base_resp?.status_code;
  if (code !== 0) {
    const msg = redact(String(parsed?.base_resp?.status_msg ?? ''), key).trim();
    throw new CloudError(`MiniMax 合成失败（${String(code ?? '未知')}）：${msg || '没有返回音频'}`, code === 1004 ? 'auth' : 'failed');
  }
  const hex = parsed?.data?.audio;
  if (typeof hex !== 'string' || !hex || hex.length % 2 || /[^0-9a-f]/i.test(hex)) {
    throw new CloudError('MiniMax 没返回有效音频（data.audio 为空或不是 hex）', 'bad-audio');
  }
  return Buffer.from(hex, 'hex');
}

/** MiMo 走 chat/completions，音频是 base64 在 `choices[0].message.audio.data`。 */
function mimoAudio(raw: Buffer): Buffer {
  let parsed: { choices?: Array<{ message?: { audio?: { data?: unknown } } }> };
  try {
    parsed = JSON.parse(raw.toString('utf8')) as typeof parsed;
  } catch {
    throw new CloudError('MiMo 回的不是 JSON（检查地址是否指向 /chat/completions）', 'failed');
  }
  return base64Audio(parsed?.choices?.[0]?.message?.audio?.data, 'MiMo');
}

/** 火山引擎的音频是 base64，成功码是 0 或 3000（不同版本文档两种都出现过）。 */
function volcengineAudio(raw: Buffer, key: string): Buffer {
  let parsed: { code?: unknown; message?: unknown; data?: unknown };
  try {
    parsed = JSON.parse(raw.toString('utf8')) as typeof parsed;
  } catch {
    throw new CloudError('火山引擎回的不是 JSON（检查地址是否指向 /api/v1/tts）', 'failed');
  }
  const code = parsed?.code;
  if (code !== undefined && code !== 0 && code !== 3000) {
    const msg = redact(String(parsed?.message ?? ''), key).trim();
    throw new CloudError(`火山引擎合成失败（${String(code)}）：${msg || '没有返回音频'}`, 'failed');
  }
  const data = parsed?.data;
  const payload = typeof data === 'string' ? data : (data && typeof data === 'object' ? (data as { data?: unknown }).data : undefined);
  return base64Audio(payload, '火山引擎');
}

/** 合成一句；失败抛 `CloudError`，消息已脱敏。 */
export async function synthCloud(text: string, opts: CloudOptions, signal?: AbortSignal): Promise<CloudAudio> {
  if (!opts.key) throw new CloudError('云端密钥还没设置（面板里填一次即可）', 'config');
  if (!opts.voice.trim()) throw new CloudError('云端音色没选（先添加一个 voice id）', 'config');
  const spec = resolveCloudProvider(opts.provider ?? '', opts.baseUrl);
  if (spec.status === 'unsupported') {
    const why = UNSUPPORTED_REASON[spec.note ?? 'unverified'] ?? UNSUPPORTED_REASON.unverified;
    throw new CloudError(`「${spec.name}」暂不支持：${why}`, 'config');
  }
  const req = buildRequest(spec, text, opts);
  const url = req.url;
  const headers = req.headers;
  const body = req.body;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), Math.max(5000, opts.timeoutMs));
  const onAbort = (): void => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : new Uint8Array(body),
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

  let bytes: Buffer = Buffer.from(await res.arrayBuffer());
  if (spec.id === 'minimax') bytes = minimaxAudio(bytes, opts.key);
  else if (spec.id === 'mimo') bytes = mimoAudio(bytes);
  else if (spec.id === 'volcengine') bytes = volcengineAudio(bytes, opts.key);
  const wav = bytes;
  const head = parseWavHeader(wav);
  if (!head) {
    const kind = audioKind(wav);
    throw new CloudError(
      kind === 'WAV'
        ? '云端回的 WAV 不完整（缺 fmt 或 data 块），请稍后再试。'
        : `厂商没有按请求返回 WAV（收到 ${kind}）。云端只接受 WAV；这类厂商暂不支持，本插件不做转码。`,
      'bad-audio',
    );
  }
  const rawPcm = wav.subarray(head.dataStart);
  const pcm = downmix(rawPcm, head.channels);
  if (!pcm.length) throw new CloudError('云端回了空音频', 'bad-audio');
  return { wav, pcm, sampleRate: head.sampleRate, ms: Date.now() - started };
}
