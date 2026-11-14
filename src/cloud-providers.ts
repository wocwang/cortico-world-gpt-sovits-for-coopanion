/**
 * 云端语音服务商目录：每家一行的默认值、额外字段、鉴权与 WAV 能力。
 *
 * 选哪家只影响「音色」页的云端卡：默认地址/模型/音色、要显示的附加输入框、
 * 请求体、鉴权头和返回音频的容器都按这家走；本地设置与通用设置不受影响。
 *
 * 范围按 Live2D 一键安装插件（cortico-world-figure）的 provider 目录逐家核对官方文档，
 * 只实现能自己拿到 WAV 的厂商：拿不到 WAV 的宁可标成未支持，也不引 ffmpeg / mp3 解码。
 * 新增一家时先补这里，再到 `cloud.ts` 里补请求构造。
 */

/** 第一家永远是「自定义（OpenAI 兼容）」：认不出的地址都回退到它。 */
export const CUSTOM_PROVIDER_ID = 'custom';

export type CloudProviderId =
  | typeof CUSTOM_PROVIDER_ID
  | 'openai'
  | 'breeze'
  | 'azure'
  | 'minimax'
  | 'elevenlabs'
  | 'volcengine'
  | 'mimo'
  | 'fish'
  | 'gemini'
  | 'dashscope'
  | 'gsv'
  | 'gsvi'
  | 'genie'
  | 'edge';

/** 需要用户额外填的输入框；不同厂商只显示自己用得到的那几个。 */
export type CloudExtraField = 'region' | 'groupId' | 'appId' | 'cluster';

/** 面板里要显示的提示（i18n 键后缀）。 */
export type CloudProviderNote =
  /** 需要本机 Python 包（本插件不内置）。 */
  | 'python'
  /** 只给无头 PCM，不给 WAV。 */
  | 'pcm'
  /** 只给 mp3 / ogg / m4a，不给 WAV。 */
  | 'mp3'
  /** 文档与 figure 的实现冲突或查不到，不敢写死。 */
  | 'unverified'
  /** 文档可查但没实测（或主机名与 figure 不同）。 */
  | 'beta'
  /** 是「本机/局域网 GPT-SoVITS」，请走本地引擎或本机语音接口。 */
  | 'local'
  /** 只回一个下载地址，是否 WAV 无法保证。 */
  | 'url';

export interface CloudProviderSpec {
  id: CloudProviderId;
  /** 厂商专有名词，中英文界面都显示这个，不翻译。 */
  name: string;
  /** 默认基址；Azure 按区域拼主机，留空。 */
  baseUrl: string;
  /** 默认模型；不用 model 的厂商留空。 */
  model: string;
  /** 默认音色 id。 */
  voice: string;
  /** 额外要显示的输入框。 */
  extras: readonly CloudExtraField[];
  /** 有没有「列出音色」端点；false 时面板禁用拉取，并显示「音色 id」手填入口。 */
  voiceList: boolean;
  /** 拉取清单时的服务端语种参数名（Breeze 是 `language_code`）；没有就在本地按返回字段筛。 */
  pullLanguageParam?: string;
  /** 拉取清单时的服务端关键词参数名（Breeze 是 `search`）；没有就在本地只做排序。 */
  pullSearchParam?: string;
  /** 面板是否显示基址输入框（Azure 用区域拼，不显示）。 */
  showBaseUrl: boolean;
  /** 面板是否显示模型输入框（Azure 不用 model）。 */
  showModel: boolean;
  /** `ok` = 按官方文档实现；`beta` = 文档可查但未实测；`unsupported` = 拿不到可校验的 WAV。 */
  status: 'ok' | 'beta' | 'unsupported';
  /** 不支持 / 受限的原因，配 i18n 的 `cloudProviderNotes`。 */
  note?: CloudProviderNote;
  /**
   * 是否出现在面板的厂商下拉里；`false` = 实现与测试保留，但先不暴露给用户
   * （选中旧值会回退到自定义，并在面板上说明）。
   */
  listed?: boolean;
}

/**
 * 内置厂商。第 1 批只放能直接拿到 WAV 的几家；其余在后续批次补，未核实的标 unsupported。
 */
export const CLOUD_PROVIDERS: readonly CloudProviderSpec[] = [
  {
    id: CUSTOM_PROVIDER_ID,
    name: '自定义（OpenAI 兼容）',
    baseUrl: 'https://api.openai.com/v1',
    model: 'tts-1',
    voice: 'alloy',
    extras: [],
    voiceList: true,
    showBaseUrl: true,
    showModel: true,
    status: 'ok',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'tts-1',
    voice: 'alloy',
    extras: [],
    voiceList: false,
    showBaseUrl: true,
    showModel: true,
    status: 'ok',
  },
  {
    id: 'breeze',
    name: 'Breeze Blue',
    baseUrl: 'https://api.breeze.blue/v1',
    model: '',
    voice: '',
    extras: [],
    voiceList: true,
    pullLanguageParam: 'language_code',
    pullSearchParam: 'search',
    showBaseUrl: true,
    showModel: true,
    status: 'ok',
  },
  {
    id: 'azure',
    name: 'Azure 语音',
    baseUrl: '',
    model: '',
    voice: 'zh-CN-YunxiaNeural',
    extras: ['region'],
    voiceList: true,
    showBaseUrl: false,
    showModel: false,
    status: 'ok',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.cn/v1/t2a_v2',
    model: 'speech-2.8-turbo',
    voice: 'female-shaonv',
    extras: ['groupId'],
    voiceList: false,
    showBaseUrl: true,
    showModel: true,
    status: 'ok',
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    baseUrl: 'https://api.elevenlabs.io/v1',
    model: 'eleven_multilingual_v2',
    voice: '',
    extras: [],
    voiceList: true,
    showBaseUrl: true,
    showModel: true,
    status: 'ok',
  },
  {
    id: 'volcengine',
    name: '火山引擎（豆包语音）',
    baseUrl: 'https://openspeech.bytedance.com/api/v1/tts',
    model: '',
    voice: '',
    extras: ['appId', 'cluster'],
    voiceList: false,
    showBaseUrl: true,
    showModel: false,
    status: 'ok',
  },
  {
    id: 'mimo',
    name: '小米 MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-tts',
    voice: 'mimo_default',
    extras: [],
    voiceList: false,
    showBaseUrl: true,
    showModel: true,
    status: 'ok',
  },
  {
    id: 'fish',
    name: 'Fish Audio',
    baseUrl: 'https://api.fish.audio/v1',
    model: 's2-pro',
    voice: '',
    extras: [],
    voiceList: false,
    showBaseUrl: true,
    showModel: true,
    status: 'beta',
    note: 'beta',
  },
  {
    id: 'gemini',
    name: 'Gemini TTS',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.1-flash-tts-preview',
    voice: 'Leda',
    extras: [],
    voiceList: false,
    showBaseUrl: true,
    showModel: true,
    status: 'unsupported',
    note: 'pcm',
    listed: false,
  },
  {
    id: 'dashscope',
    name: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'qwen-tts',
    voice: '',
    extras: [],
    voiceList: false,
    showBaseUrl: true,
    showModel: true,
    status: 'unsupported',
    note: 'unverified',
    listed: false,
  },
  {
    id: 'gsv',
    name: 'GPT-SoVITS 自部署',
    baseUrl: 'http://127.0.0.1:9880',
    model: '',
    voice: '',
    extras: [],
    voiceList: false,
    showBaseUrl: true,
    showModel: false,
    status: 'unsupported',
    note: 'local',
    listed: false,
  },
  {
    id: 'gsvi',
    name: 'GPT-SoVITS 兼容接口（GSVI）',
    baseUrl: 'http://127.0.0.1:8000',
    model: '',
    voice: '',
    extras: [],
    voiceList: false,
    showBaseUrl: true,
    showModel: false,
    status: 'unsupported',
    note: 'unverified',
    listed: false,
  },
  {
    id: 'genie',
    name: 'Genie TTS',
    baseUrl: '',
    model: '',
    voice: 'mika',
    extras: [],
    voiceList: false,
    showBaseUrl: false,
    showModel: false,
    status: 'unsupported',
    note: 'python',
    listed: false,
  },
  {
    id: 'edge',
    name: 'Edge TTS',
    baseUrl: '',
    model: '',
    voice: 'zh-CN-XiaoxiaoNeural',
    extras: [],
    voiceList: false,
    showBaseUrl: false,
    showModel: false,
    status: 'unsupported',
    note: 'python',
    listed: false,
  },
];

const BY_ID = new Map<string, CloudProviderSpec>(CLOUD_PROVIDERS.map((p) => [p.id, p]));

/** 按 id 取厂商；不认识的一律回退「自定义」，老配置不会因为多了个陌生 id 失效。 */
export function cloudProvider(id: string): CloudProviderSpec {
  return BY_ID.get(String(id ?? '').trim()) ?? BY_ID.get(CUSTOM_PROVIDER_ID)!;
}

/** 旧配置没有 `cloudProvider` 字段：按地址认已知主机，其余按自定义（与升级前行为一致）。 */
export function detectCloudProvider(baseUrl: string): CloudProviderId {
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    if (host === 'api.breeze.blue' || host.endsWith('.breeze.blue')) return 'breeze';
    if (host === 'api.openai.com') return 'openai';
    if (host.endsWith('.tts.speech.microsoft.com')) return 'azure';
    if (host === 'api.minimax.cn' || host.endsWith('.minimaxi.com')) return 'minimax';
    if (host === 'api.elevenlabs.io') return 'elevenlabs';
    if (host === 'openspeech.bytedance.com') return 'volcengine';
    if (host === 'api.xiaomimimo.com') return 'mimo';
    if (host === 'api.fish.audio' || host === 'api.fish-audio.cn') return 'fish';
    if (host === 'generativelanguage.googleapis.com') return 'gemini';
    if (host === 'dashscope.aliyuncs.com' || host.endsWith('.dashscope.aliyuncs.com')) return 'dashscope';
  } catch {
    // 空地址或不是 URL：交给自定义去报「地址没填」。
  }
  return CUSTOM_PROVIDER_ID;
}

/** 配置里的 provider + 地址 → 实际生效的厂商（空 id 时按地址推断；未开放的厂商回退自定义）。 */
export function resolveCloudProvider(id: string, baseUrl: string): CloudProviderSpec {
  const stored = String(id ?? '').trim();
  const spec = stored ? cloudProvider(stored) : cloudProvider(detectCloudProvider(baseUrl));
  return spec.listed === false ? cloudProvider(CUSTOM_PROVIDER_ID) : spec;
}

/** 面板下拉里真正展示的厂商；实现保留但不暴露的先不出现在这里。 */
export function listedCloudProviders(): CloudProviderSpec[] {
  return CLOUD_PROVIDERS.filter((p) => p.listed !== false);
}

/** 旧配置里存了「暂不开放」的厂商 id 时返回它，用于面板上说明已回退；否则返回空串。 */
export function hiddenCloudProviderId(id: string): string {
  const stored = String(id ?? '').trim();
  if (!stored) return '';
  const spec = cloudProvider(stored);
  return spec.listed === false ? spec.id : '';
}

/** 存盘时「自定义」写空串：下次仍按地址推断，老配置语义不变。 */
export function providerIdForStore(spec: CloudProviderSpec): string {
  return spec.id === CUSTOM_PROVIDER_ID ? '' : spec.id;
}
