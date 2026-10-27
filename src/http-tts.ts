/**
 * 给其他插件取音频用的本地 HTTP 接口。cortico-world-qq-final 这类插件自己合成语音，
 * 把它的「语音模型网址」指到这里即可用本插件当前的声音：我们合成（不本机播放）后把 WAV 交回去。
 * 兼容两种形状：OpenAI 的 `POST /audio/speech`（local / custom 供应商，base 可带 `/v1`）
 * 与 VoxCPM 的 `GET /health` + `POST /tts`（voxcpm 供应商）。
 * 只监听回环地址；配了 token 时要求 `Authorization: Bearer` 或 `?token=`。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from 'cortico/core/types.ts';

/** 一次合成请求；`voice` 是调用方点名的音色（预设 id 或自定义音色名），空为插件当前音色。 */
export interface TtsJob {
  text: string;
  voice?: string;
  /** VoxCPM 形状里的 `voice_desc`：只在能匹配已知音色时采用，认不出不算调用方点名。 */
  voiceHint?: string;
  speed?: number;
  seed?: number;
}

export interface HttpTtsDeps {
  /** 合成一句，不播放；失败抛错（回 502）。 */
  synthesize: (job: TtsJob, signal: AbortSignal) => Promise<Buffer>;
  /**
   * 出口后处理（如 RVC 变声）。契约：失败必须原样返回入参，不许抛——
   * 这里再兜一层，抛了也按原音频发出去。
   */
  post?: (wav: Buffer) => Promise<Buffer>;
  /** 此刻能不能接活（服务就绪，或休眠但能自己拉起来）。 */
  ready: () => boolean;
  /** 不能接活时的状态说明，用作 503 文案。 */
  stateText: () => string;
  log: Logger;
}

export interface HttpTtsHandle {
  /** 实际监听的端口（配 0 时由系统分配）。 */
  port: number;
  close: () => Promise<void>;
}

/** 单次合成上限；本地推理慢，给足时间。 */
const SYNTH_TIMEOUT_MS = 120_000;
/** 请求体上限：就一句台词，64 KB 足够。 */
const BODY_MAX = 64 * 1024;

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (b: Buffer) => {
      size += b.length;
      if (size > BODY_MAX) { reject(new Error('body too large')); req.destroy(); return; }
      parts.push(b);
    });
    req.on('end', () => {
      try {
        resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown> : {});
      } catch {
        reject(new Error('body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** 起接口；`port` 为 0 时由系统分配。 */
export function startHttpTts(opts: { port: number; token?: string; deps: HttpTtsDeps }): Promise<HttpTtsHandle> {
  const { deps } = opts;
  const token = opts.token?.trim() ?? '';
  // 串行：一次合成一句，别把 GPU 打满。
  let tail: Promise<unknown> = Promise.resolve();
  const run = <T>(job: () => Promise<T>): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };
  const send = (res: ServerResponse, code: number, body: Buffer | string, type: string): void => {
    res.writeHead(code, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  const json = (res: ServerResponse, code: number, obj: unknown): void =>
    send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    if (!token) return true;
    if ((req.headers.authorization ?? '') === `Bearer ${token}`) return true;
    return url.searchParams.get('token') === token;
  };

  const synthesize = async (res: ServerResponse, path: string, body: Record<string, unknown>): Promise<void> => {
    const said = text(body.input) ?? text(body.text); // OpenAI 用 input，VoxCPM 用 text
    if (!said) { json(res, 400, { error: 'missing text' }); return; }
    if (!deps.ready()) { json(res, 503, { error: `voice not ready: ${deps.stateText()}` }); return; }
    const hint = text(body.voice_desc);
    const job: TtsJob = {
      text: said,
      voice: text(body.voice),
      ...(hint ? { voiceHint: hint } : {}),
      speed: num(body.speed) ?? num(body.speed_factor),
      seed: num(body.seed),
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SYNTH_TIMEOUT_MS);
    const at = Date.now();
    try {
      const wav = await run(() => deps.synthesize(job, ctrl.signal));
      let out = wav;
      if (deps.post) {
        try {
          out = await deps.post(wav);
        } catch {
          out = wav;
        }
      }
      deps.log.info('HTTP 语音接口合成完', { path, chars: [...said].length, voice: job.voice ?? '', ms: Date.now() - at });
      send(res, 200, out, 'audio/wav');
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      deps.log.warn('HTTP 语音接口合成失败', { path, err: why });
      json(res, 502, { error: why });
    } finally {
      clearTimeout(timer);
    }
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!authorized(req, url)) { json(res, 401, { error: 'bad token' }); return; }
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      json(res, 200, { ready: deps.ready(), state: deps.stateText() });
      return;
    }
    // OpenAI 兼容客户端（qq-final / QQ-ProMAX 的 local 供应商等）会先探 /models 判断服务活着。
    if (req.method === 'GET' && /\/models\/?$/.test(url.pathname)) {
      json(res, 200, { object: 'list', data: [{ id: 'gpt-sovits', object: 'model', created: 0, owned_by: 'coopanion' }] });
      return;
    }
    // VoxCPM 的 /tts 与 OpenAI 的 /audio/speech（调用方的 base 可能带 /v1）。
    const synthesizing = url.pathname === '/tts' || /\/audio\/speech\/?$/.test(url.pathname);
    if (req.method === 'POST' && synthesizing) {
      void readJson(req)
        .then((body) => synthesize(res, url.pathname, body))
        .catch((err: unknown) => { json(res, 400, { error: err instanceof Error ? err.message : String(err) }); });
      return;
    }
    json(res, 404, { error: `no such route: ${req.method} ${url.pathname}` });
  };

  return new Promise((resolve, reject) => {
    const server: Server = createServer(handler);
    server.on('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : opts.port;
      deps.log.info('HTTP 语音接口已就绪', { port, auth: !!token });
      resolve({
        port,
        close: () => new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
      });
    });
  });
}
