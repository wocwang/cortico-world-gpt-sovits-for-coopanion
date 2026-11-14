/**
 * 云端音色清单：默认值与可选的「从服务商拉取」。
 *
 * OpenAI 兼容协议里没有标准的「列出音色」端点（官方只有 `/audio/speech`），所以清单主要靠内置：
 * 默认地址是 OpenAI 时直接给出官方音色并选中 `alloy`，用户只需要填密钥就能出声。
 * 用户自己维护的清单永远优先；只有「清单为空且没显式选过音色」时才用默认值，且不写盘。
 *
 * 拉取按所选厂商走：
 * - 自定义 / OpenAI 兼容：`GET {base}/audio/voices`（没有这个端点的会 404）
 * - Breeze Blue：`GET {base}/voices`（`xi-api-key`）
 * - ElevenLabs：`GET {base}/voices`（`xi-api-key`，`{ voices: [{ voice_id, name }] }`）
 * - Azure：`GET https://{region}.tts.speech.microsoft.com/cognitiveservices/voices/list`（`Ocp-Apim-Subscription-Key`）
 * - MiniMax：没有清单端点，界面只让手动填 voice id
 */
import { CloudError, isBreezeBlueBase, redact } from './cloud.ts';
import { resolveCloudProvider, type CloudProviderSpec } from './cloud-providers.ts';

export interface CloudVoice {
  /** 请求里的 `voice` 字段。 */
  id: string;
  /** 面板显示名；没有就用 id。 */
  name: string;
  /** true = 这是 OpenAI 官方音色，但当前接口不是 OpenAI（面板会打标并提示）。 */
  official?: boolean;
  /** 服务商返回的语种（`zh` / `zh-CN` / `en`…）；用于厂商不支持服务端语种参数时本地筛选。 */
  language?: string;
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

/**
 * `https://api.openai.com/v1` → `.../v1/audio/voices`；已经写到 `/audio/speech` 的基址先把这段剥掉。
 * Breeze Blue / ElevenLabs 的清单在 `GET {base}/voices`；Azure 按区域拼 `voices/list`。
 * `provider` 留空时按地址推断，老配置行为不变。
 */
export function voicesUrl(baseUrl: string, provider = '', region = ''): string {
  const spec = resolveCloudProvider(provider, baseUrl);
  if (spec.id === 'azure') return azureVoicesUrl(region);
  if (!spec.voiceList) throw new CloudError(`「${spec.name}」没有音色清单端点，请手动填写 voice id`, 'config');
  const base = baseUrl.trim().replace(/\/+$/, '').replace(/\/audio\/speech$/i, '');
  if (!base) throw new CloudError('云端地址没填（要填到 /v1 这一层）', 'config');
  if (spec.id === 'breeze' || spec.id === 'elevenlabs' || isBreezeBlueBase(base)) {
    const stem = base.replace(/\/text-to-speech\/[^/]+$/i, '');
    return /\/voices$/i.test(stem) ? stem : `${stem}/voices`;
  }
  return /\/audio\/voices$/i.test(base) ? base : `${base}/audio/voices`;
}

/** Azure 的清单地址跟合成一样按区域拼；区域没填就明确报错，不猜。 */
function azureVoicesUrl(region: string): string {
  const clean = region.trim().toLowerCase();
  if (!clean) throw new CloudError('Azure 区域没填（如 eastus、eastasia）', 'config');
  if (!/^[a-z0-9]+$/.test(clean)) throw new CloudError(`Azure 区域格式不对：${clean}（只允许小写字母和数字）`, 'config');
  return `https://${clean}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
}

/** 单条音色；兼容 `{id}` / `{voice_id}` / `{name}` / Azure 的 `{ShortName, LocalName}` / 纯字符串。 */
function voiceOf(item: unknown): CloudVoice | null {
  if (typeof item === 'string') {
    const id = item.trim();
    return id ? { id, name: id } : null;
  }
  if (!item || typeof item !== 'object') return null;
  const row = item as Record<string, unknown>;
  const id = String(row.id ?? row.voice_id ?? row.voiceId ?? row.ShortName ?? row.shortName ?? row.name ?? row.value ?? '').trim();
  if (!id) return null;
  const name = String(row.display_name ?? row.displayName ?? row.LocalName ?? row.localName ?? row.name ?? '').trim();
  // 语种用来在「厂商不支持服务端语种参数」时本地过滤；各家字段名不同，取不到就不带。
  const labels = row.labels && typeof row.labels === 'object' ? row.labels as Record<string, unknown> : {};
  const language = String(row.language_code ?? row.languageCode ?? row.language ?? row.Locale ?? row.locale ?? labels.language ?? '').trim();
  return { id, name: name || id, ...(language ? { language } : {}) };
}

/** 解析服务商返回的清单：裸数组、`{voices}`、`{data}` 都认，id 去重；`limit` 只是兜底上限。 */
export function parseVoiceList(raw: unknown, limit = 50): CloudVoice[] {
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
  return out.slice(0, Math.max(1, limit));
}

/** `zh-CN` / `zh_CN` / `zh` → `zh`，用来比较语种。 */
function langRoot(value: string): string {
  return value.trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

/** 关键词只影响排序：命中的排前面，其余保持原顺序。 */
function rankByKeyword(voices: CloudVoice[], keyword: string): CloudVoice[] {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return voices;
  const hit = (v: CloudVoice): boolean => v.name.toLowerCase().includes(kw) || v.id.toLowerCase().includes(kw);
  return [...voices.filter(hit), ...voices.filter((v) => !hit(v))];
}

/**
 * 尽力拉取服务商的音色清单，鉴权按厂商走：Azure 用订阅密钥头，Breeze / ElevenLabs 用 `xi-api-key`，
 * 其余用 `Bearer`。没有清单端点的服务商直接给可读错误；密钥始终脱敏。
 *
 * `query.language` / `query.keyword` 按厂商能力处理：
 * - 厂商声明了服务端参数（Breeze：`language_code` / `search`）就交给服务端；
 * - 没声明就在本地处理：语种按返回的 `language` 字段过滤（缺字段的保留），
 *   关键词只做排序（命中的排前面，其余保持原顺序）。
 */
export async function fetchCloudVoices(
  baseUrl: string,
  key: string,
  timeoutMs = 60_000,
  provider = '',
  region = '',
  query: { language?: string; keyword?: string } = {},
): Promise<CloudVoice[]> {
  if (!key) throw new CloudError('云端密钥还没设置', 'config');
  const spec: CloudProviderSpec = resolveCloudProvider(provider, baseUrl);
  const language = (query.language ?? '').trim().toLowerCase();
  const keyword = (query.keyword ?? '').trim();
  const params = new URLSearchParams();
  if (language && spec.pullLanguageParam) params.set(spec.pullLanguageParam, langRoot(language));
  if (keyword && spec.pullSearchParam) params.set(spec.pullSearchParam, keyword);
  const base = voicesUrl(baseUrl, spec.id, region);
  const url = params.size ? `${base}${base.includes('?') ? '&' : '?'}${params.toString()}` : base;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (spec.id === 'azure') headers['Ocp-Apim-Subscription-Key'] = key;
  else if (spec.id === 'breeze' || spec.id === 'elevenlabs' || isBreezeBlueBase(baseUrl)) headers['xi-api-key'] = key;
  else headers.authorization = `Bearer ${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), Math.max(5000, timeoutMs));
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal });
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
  let voices = parseVoiceList(raw, 200);
  // 厂商不支持服务端语种参数：本地按返回的 language 过滤，字段缺失的保留（不误杀）。
  if (language && !spec.pullLanguageParam) {
    const want = langRoot(language);
    voices = voices.filter((v) => !v.language || langRoot(v.language) === want);
  }
  // 服务端 search 已经是过滤/相关度排序；本地路径只负责把命中项提到前面。
  if (keyword) voices = rankByKeyword(voices, keyword);
  return voices.slice(0, 50);
}
