/**
 * 云端音色清单：默认值与可选的「从服务商拉取」。
 *
 * OpenAI 兼容协议里没有标准的「列出音色」端点（官方只有 `/audio/speech`），所以清单主要靠内置：
 * 默认地址是 OpenAI 时直接给出官方音色并选中 `alloy`，用户只需要填密钥就能出声。
 * 用户自己维护的清单永远优先；只有「清单为空且没显式选过音色」时才用默认值，且不写盘。
 *
 * 另外提供一个尽力而为的拉取：`GET {base}/audio/voices`。部分兼容实现提供这个端点；
 * 没有的（包括 OpenAI 官方）会 404，界面按「可以继续手动添加」处理，不当成错误。
 */
import { CloudError, redact } from './cloud.ts';

export interface CloudVoice {
  /** 请求里的 `voice` 字段。 */
  id: string;
  /** 面板显示名；没有就用 id。 */
  name: string;
  /** true = 这是 OpenAI 官方音色，但当前接口不是 OpenAI（面板会打标并提示）。 */
  official?: boolean;
}

/** OpenAI 官方 `tts-1` / `tts-1-hd` 支持的音色。 */
export const OPENAI_VOICES: ReadonlyArray<CloudVoice> = [
  { id: 'alloy', name: 'alloy' },
  { id: 'echo', name: 'echo' },
  { id: 'fable', name: 'fable' },
  { id: 'onyx', name: 'onyx' },
  { id: 'nova', name: 'nova' },
  { id: 'shimmer', name: 'shimmer' },
];

/** 地址是不是 OpenAI 官方接口；只认主机名，避免误把第三方镜像当成官方音色。 */
export function isOpenAiBase(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    return host === 'api.openai.com';
  } catch {
    return false;
  }
}

/** 已知服务商的默认音色；不认识的服务商返回空（仍走手动添加）。 */
export function defaultCloudVoices(baseUrl: string): CloudVoice[] {
  return isOpenAiBase(baseUrl) ? [...OPENAI_VOICES] : [];
}

/**
 * 面板实际展示 / 合成实际可用的音色清单。
 * 1. 用户清单非空：原样用，并把单独选过却不在清单里的 id 补进去（老配置只存了 voiceId）。
 * 2. 用户清单为空但选过 id：只显示这一个。
 * 3. 两者都空：按已知服务商给默认（OpenAI → 6 个官方音色）。
 */
export function effectiveCloudVoices(
  configured: ReadonlyArray<CloudVoice> | undefined,
  baseUrl: string,
  selectedId: string,
): CloudVoice[] {
  const user = (configured ?? []).map((v) => ({ id: String(v.id ?? '').trim(), name: String(v.name ?? '').trim() })).filter((v) => v.id);
  const selected = selectedId.trim();
  if (user.length) {
    return selected && !user.some((v) => v.id === selected) ? [...user, { id: selected, name: selected }] : user;
  }
  if (selected) {
    // 选过的 id 不覆盖内置默认清单：OpenAI 用户换到 echo 后，其余默认音色仍应可选。
    const defaults = defaultCloudVoices(baseUrl);
    if (!defaults.length) return [{ id: selected, name: selected }];
    return defaults.some((v) => v.id === selected) ? defaults : [...defaults, { id: selected, name: selected }];
  }
  return defaultCloudVoices(baseUrl);
}

/** 生效音色 id：显式选过的优先，否则用清单第一个（含默认清单的 alloy）。 */
export function effectiveCloudVoiceId(selectedId: string, voices: ReadonlyArray<CloudVoice>): string {
  const selected = selectedId.trim();
  return selected || voices[0]?.id || '';
}

/** `https://api.openai.com/v1` → `.../v1/audio/voices`；已经写到 `/audio/speech` 的基址先把这段剥掉。 */
export function voicesUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '').replace(/\/audio\/speech$/i, '');
  if (!base) throw new CloudError('云端地址没填（要填到 /v1 这一层）', 'config');
  return /\/audio\/voices$/i.test(base) ? base : `${base}/audio/voices`;
}

/** 单条音色；兼容 `{id}` / `{voice_id}` / `{name}` / 纯字符串。 */
function voiceOf(item: unknown): CloudVoice | null {
  if (typeof item === 'string') {
    const id = item.trim();
    return id ? { id, name: id } : null;
  }
  if (!item || typeof item !== 'object') return null;
  const row = item as Record<string, unknown>;
  const id = String(row.id ?? row.voice_id ?? row.voiceId ?? row.name ?? row.value ?? '').trim();
  if (!id) return null;
  const name = String(row.display_name ?? row.displayName ?? row.name ?? '').trim();
  return { id, name: name || id };
}

/** 解析服务商返回的清单：裸数组、`{voices}`、`{data}` 都认，id 去重。 */
export function parseVoiceList(raw: unknown): CloudVoice[] {
  const rows: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { voices?: unknown }).voices)
      ? (raw as { voices: unknown[] }).voices
      : raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)
        ? (raw as { data: unknown[] }).data
        : [];
  const out: CloudVoice[] = [];
  for (const row of rows) {
    const voice = voiceOf(row);
    if (voice && !out.some((v) => v.id === voice.id)) out.push(voice);
  }
  return out.slice(0, 50);
}

/**
 * 尽力拉取服务商的音色清单。没有这个端点的服务商（含 OpenAI 官方）会拿到 404，
 * 调用方按「可以继续手动添加」处理；鉴权与网络错误会给出各自的说明，密钥始终脱敏。
 */
export async function fetchCloudVoices(baseUrl: string, key: string, timeoutMs = 60_000): Promise<CloudVoice[]> {
  if (!key) throw new CloudError('云端密钥还没设置', 'config');
  const url = voicesUrl(baseUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), Math.max(5000, timeoutMs));
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${key}` },
      signal: ctrl.signal,
    });
  } catch (err) {
    if (ctrl.signal.aborted) throw new CloudError('拉取音色清单超时', 'timeout');
    const msg = redact(err instanceof Error ? err.message : String(err), key);
    throw new CloudError(`拉取音色清单失败：${msg}`, 'network');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = redact((await res.text().catch(() => '')).slice(0, 200), key).trim();
    if (res.status === 401 || res.status === 403) throw new CloudError(`服务商拒绝鉴权（HTTP ${res.status}）：${detail || '密钥无效'}`, 'auth');
    if (res.status === 404) throw new CloudError(`服务商没有提供音色清单端点（HTTP 404）：${url}`, 'failed');
    throw new CloudError(`拉取音色清单失败（HTTP ${res.status}）：${detail || '稍后再试'}`, 'failed');
  }
  const raw = await res.json().catch(() => null);
  return parseVoiceList(raw);
}
