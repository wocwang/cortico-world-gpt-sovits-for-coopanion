/**
 * api_v2 `/tts` 的流式客户端。流式回应先是一段 WAV 头(长度字段不可信),之后是单声道 PCM16 裸数据;
 * 这里只读头里的采样率，按到达顺序吐出偶数字节对齐的 PCM 块。
 */

export interface SynthRequest {
  text: string;
  refAudio: string;
  refText: string;
  speed: number;
  /** 采样种子；`-1`(或不填)每次重新采样，`>= 0` 固定。 */
  seed?: number;
}

export interface PcmChunk {
  sampleRate: number;
  pcm: Buffer;
}

/** 头至少要读到 `data` 块的起点;api_v2 的头是标准 44 字节。 */
const WAV_HEADER_MIN = 44;

/** 从 RIFF 头里取采样率与 `data` 块起点;不是 WAV 头返回 null。 */
export function parseWavHeader(buf: Buffer): { sampleRate: number; channels: number; dataStart: number } | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let at = 12;
  let sampleRate = 0, channels = 0;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 16 <= buf.length) {
      channels = buf.readUInt16LE(at + 10);
      sampleRate = buf.readUInt32LE(at + 12);
    }
    if (id === 'data') return sampleRate > 0 ? { sampleRate, channels, dataStart: at + 8 } : null;
    at += 8 + size + (size & 1);
  }
  return null;
}

/**
 * 把字节流拆成 PCM 块。头没收齐前缓存;之后每块留下奇数尾字节给下一块，保证样本不被拆开。
 */
export async function* pcmChunks(body: AsyncIterable<Uint8Array>): AsyncGenerator<PcmChunk> {
  let pending = Buffer.alloc(0);
  let sampleRate = 0;
  for await (const part of body) {
    pending = pending.length ? Buffer.concat([pending, Buffer.from(part)]) : Buffer.from(part);
    if (!sampleRate) {
      if (pending.length < WAV_HEADER_MIN) continue;
      const head = parseWavHeader(pending);
      if (!head) throw new Error('GPT-SoVITS 回应不是 WAV 流');
      if (head.channels !== 1) throw new Error(`GPT-SoVITS 回应是 ${head.channels} 声道，只支持单声道`);
      sampleRate = head.sampleRate;
      pending = pending.subarray(head.dataStart);
    }
    const even = pending.length - (pending.length & 1);
    if (even > 0) {
      yield { sampleRate, pcm: Buffer.from(pending.subarray(0, even)) };
      pending = pending.subarray(even);
    }
  }
}

/** api_v2 的流式档：3 首包最快。 */
export const STREAMING_MODE = 3;

/**
 * 让正在跑的服务换成另一组权重：`/set_gpt_weights` 与 `/set_sovits_weights` 都是 GET 加
 * `weights_path` 查询参数，成功回 `{"message":"success"}`。换权重不必重启进程，也不影响已建立的连接。
 *
 * 两个接口分别加载 s1 与 s2：任一个失败都抛出(失败的那个带服务端 `Exception`)，由调用方决定回滚。
 */
export async function switchWeights(baseUrl: string, target: { gpt: string; sovits: string }, signal?: AbortSignal): Promise<void> {
  for (const [endpoint, path] of [['set_gpt_weights', target.gpt], ['set_sovits_weights', target.sovits]] as const) {
    const url = new URL(`/${endpoint}`, baseUrl);
    url.searchParams.set('weights_path', path);
    const res = await fetch(url, { method: 'GET', signal });
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* 没有回应体就算了 */ }
    if (!res.ok) {
      let said = '';
      try {
        const j = JSON.parse(detail) as { message?: string; Exception?: string };
        said = [j.message, j.Exception].filter(Boolean).join(': ');
      } catch { /* 不是 JSON 就带原文 */ }
      throw new Error(`${endpoint} 失败：${said || detail || `HTTP ${res.status}`}`);
    }
  }
}

/**
 * `/tts` 的请求体。`seed` 只在固定种子(>= 0)时才发，不填时由 api_v2 用它的默认值(-1，每次重新采样)。
 */
export function ttsBody(req: SynthRequest): Record<string, unknown> {
  return {
    text: req.text,
    text_lang: 'auto',
    ref_audio_path: req.refAudio,
    prompt_text: req.refText,
    prompt_lang: 'auto',
    text_split_method: 'cut5',
    batch_size: 1,
    speed_factor: req.speed,
    media_type: 'wav',
    streaming_mode: STREAMING_MODE,
    parallel_infer: false,
    ...(typeof req.seed === 'number' && req.seed >= 0 ? { seed: req.seed } : {}),
  };
}

/** 发一句合成请求，按到达顺序吐出 PCM 块;HTTP 失败时抛出带服务端消息的错误。 */
export async function* synthesize(baseUrl: string, req: SynthRequest, signal?: AbortSignal): AsyncGenerator<PcmChunk> {
  const res = await fetch(new URL('/tts', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify(ttsBody(req)),
  });
  if (!res.ok || !res.body) {
    let message = `HTTP ${res.status}`;
    try {
      const j = await res.json() as { message?: string; Exception?: string };
      message = [j.message, j.Exception].filter(Boolean).join(': ') || message;
    } catch { /* body was not JSON */ }
    throw new Error(message);
  }
  yield* pcmChunks(res.body as unknown as AsyncIterable<Uint8Array>);
}
