/**
 * GPTSovits 语音 World:`sovits_speak` 把台词排进队列，逐句经 GPT-SoVITS 流式合成，边收边从本机声卡播放;
 * `sovits_hush` 停下当前一句并清空队列。
 *
 * `sovits_speak` 在声音响起前后返回：本地等第一块音频写进声卡（至多 SPEAK_WAIT_MAX_MS）；
 * 云端没有流式，等整句音频回来、写进声卡才返回（超时/失败/打断都会立刻收尾）。主循环按顺序执行同一次回复里的
 * 工具调用，所以提示词要求先 `sovits_speak`、紧跟 `pet_say`：气泡在声音响起时出现，不用任何时序接口。
 *
 * 推理后端三选一，优先级从高到低：配置的已有服务地址、配置的自备运行时目录、托管安装的运行时与权重。
 * 后两种由本 World 起子进程(见 server.ts),就绪后用中英日各一句预热，预热完才算可用。
 *
 * 环境提示词里的状态是前缀重建时的快照;之后变为可用或不可用时推一条 `gpt-sovits.state` 内部事件，
 * 随下一批事件送达(piggyback),不单独唤醒 bot。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type { Logger, ToolDef, ToolOutcome, World, WorldHost, WorldLamp, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { DeepPartial } from 'cortico/world.ts';
import { nowIso } from 'cortico/core/util.ts';
import { normalizeVoiceModel, officialVoice, OUTPUT_GAIN, resolveModelVersion, RUNTIME_ASSETS, RUNTIME_EXTRACT_BYTES, RUNTIME_VERSION, voiceModelNeedsNormalizing, weightPaths, type ModelVersion } from './catalog.ts';
import { synthCloud } from './cloud.ts';
import { cloudProvider, hiddenCloudProviderId, providerIdForStore, resolveCloudProvider } from './cloud-providers.ts';
import { findFolders, inspectFolder, isLocalService, probeService } from './gptsovits-folder.ts';
import { defaultCloudVoices, effectiveCloudVoiceId, effectiveCloudVoices, fetchCloudVoices, isOpenAiBase, OPENAI_VOICES, type CloudVoice } from './cloud-voices.ts';
import { CloudKeyStore } from './secret-store.ts';
import { dirBytes, topLevelBytes } from './disk.ts';
import { detectGpus, fallbackToCpu, pickTier, type AmdProbe, type GpuVendor } from './gpu.ts';
import { AUDIO_BACKEND_OPTIONS, configGroups, DEVICE_OPTIONS, GPT_SOVITS_ID, MODEL_VERSION_OPTIONS, PROMPT_LANGUAGE_OPTIONS, REF_MAX_SECONDS, REF_MIN_SECONDS, RVC_INDEX_MAX, RVC_INDEX_MIN, RVC_PROTECT_MAX, RVC_PROTECT_MIN, RVC_TIMEOUT_MAX, RVC_TIMEOUT_MIN, TEXT_LANGUAGE_OPTIONS, TIER_OPTIONS, VOICE_OPTIONS, audioBackendOptions, modelVersionOptions, promptLanguageOptions, systemDeviceLabel, textLanguageOptions, tierOptions, type GptSovitsConfigSection, type Tier } from './config.ts';
import { effectiveWeights, emptyWeights, NEW_VOICE_PRESET, newCustomVoiceId, selectedCustomVoice, UNNAMED_VOICE, validateCustomVoice, type CustomVoice } from './custom-voice.ts';
import { startHttpTts, SING_MARK, type HttpTtsHandle, type SynthResult, type TtsJob } from './http-tts.ts';
import { channelWords, languageWords, panelText, qqbotWords, shareWords, stateWords } from './i18n.ts';
import { isLinkEntry, isRuntimeDir, removeTreeSafely, RuntimeJob, WeightsJob, type JobState } from './install.ts';
import { Player, applyGain, listOutputDevices, playbackLeadMs } from './player.ts';
import { RvcLink, type RvcProbe } from './rvc-link.ts';
import { SovitsServer, type ServerState } from './server.ts';
import { customVoiceOptions, registerCustomVoiceOptions } from './voice-options.ts';
import { promptLanguageOf, spokenReceipt, speechText, ttsPlain, ttsSafe } from './speech-text.ts';
import { isConnectionDrop, parseWavHeader, synthesize, switchWeights, type SpeechLang, type SynthRequest } from './synth.ts';
import { SOVITS_TOOL_DECLS } from './tools.ts';
import { TrainerManager } from './trainer.ts';
import { translateTo } from './translate.ts';
import { DEFAULT_PRESET, isPreset, presetFileLabel, presetLabel, presetRefId, VOICE_PRESETS, type VoicePreset } from './voices.ts';
import { installedBaseWeights, officialWeights, checkWeights, resolveTrained, sovitsVersion, type TrainedResult, type TrainedWeights } from './weights.ts';
import { readSeconds, staleSavedLine, wavBytes } from './wav.ts';

const ENV_PROMPT_FILES = {
  zh: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
  en: fileURLToPath(new URL('./ENV_PROMPT.en.md', import.meta.url)),
};


/** 包内预设参考音频的路径特征：`assets/voices/<名>.wav`，含分语言的 `dfy.zh.wav` / `dfy.en.wav`。 */
const PRESET_PATH = /[\\/]assets[\\/]voices[\\/][^\\/]+\.wav$/i;

/**
 * 预设音色在这个语音语言下的参考文件；没有对应语言的参考（或文件缺失）时回退到预设的默认语言。
 */
const presetFiles = (id: VoicePreset, textLang: SpeechLang): { audio: string; text: string } => {
  const langs: SpeechLang[] = textLang === 'auto' ? ['auto'] : [textLang, 'auto'];
  let fallback: { audio: string; text: string } | null = null;
  for (const lang of langs) {
    const name = presetRefId(id, lang);
    const files = {
      audio: fileURLToPath(new URL(`../assets/voices/${name}.wav`, import.meta.url)),
      text: fileURLToPath(new URL(`../assets/voices/${name}.txt`, import.meta.url)),
    };
    fallback ??= files;
    if (existsSync(files.audio) && existsSync(files.text)) return files;
  }
  return fallback!;
};

/**
 * 预热一句：只热当前语音语言的文本前端。以前中英日各来一句,但中文那句会把 BERT(约 622 MB)拉进显存,
 * 日语/英语用户白占;现在按需加载,切到中文后的第一句会多等一会儿。
 */
const WARMUP_TEXT: Record<SpeechLang, string> = {
  zh: '你好。', en: 'Hello.', ja: 'こんにちは。', ko: '안녕하세요.', auto: '你好，Hello。',
};

/** `sovits_speak` 等第一块音频的上限;超时照常返回，声音晚到。 */
const SPEAK_WAIT_MAX_MS = 3000;

/** 开着「交给其他插件」时等整句音频的上限；超过就只回执文字，不附音频。 */
const SHARE_WAIT_MAX_MS = 45_000;

/** 本机点歌（`sovits_speak` 带 `【唱】`）等唱歌插件的上限：它要跑五段扩散。 */
const SING_PLAY_TIMEOUT_MS = 180_000;

/** 等 `ms` 毫秒后给出 `null`，给一段等待加个上限。 */
const delayed = (ms: number): Promise<null> => new Promise((resolve) => {
  setTimeout(() => resolve(null), ms).unref();
});

/** 队列里的一句。`finish` 只在开启「交给其他插件」时由 `speak()` 提供。 */
interface QueuedLine {
  /** 去掉标记后的台词，也就是气泡里该出现的那一段。 */
  text: string;
  /** 真正送进合成器的文字：语音语言是 en/ja/ko 时可能是译文。 */
  spoken: string;
  at: number;
  /** true = 只合成不本机外放（这一句是发给别的渠道的）。 */
  silent: boolean;
  /** 这一句开始出声（或失败、被清空、超时）时调用一次。 */
  started: () => void;
  /** 整句 PCM 就绪（或失败、被清空）时调用一次；`null` 表示这次没有音频。 */
  finish?: (wav: Buffer | null) => void;
}

/** 交付这一句的音频；重复调用只生效一次。 */
const settleLine = (item: QueuedLine, wav: Buffer | null): void => {
  const done = item.finish;
  item.finish = undefined;
  done?.(wav);
};

/** 参考音频上传的大小上限：10 秒 48 kHz 立体声 PCM16 不到 2 MB,留足余量。 */
const VOICE_MAX_BYTES = 8 * 1024 * 1024;

/** 换权重要读盘并搬上显存，大文件几十秒;超时按失败处理，声音仍用刚换上的上一组。 */
const WEIGHT_SWITCH_TIMEOUT_MS = 180_000;

/** 自定义参考音频时长不合 api_v2 要求时的说明;量不出时长就交给服务端判断。 */
function referenceIssue(path: string): string | null {
  const seconds = readSeconds(path);
  if (seconds === null || (seconds >= REF_MIN_SECONDS && seconds <= REF_MAX_SECONDS)) return null;
  return `the reference audio is ${seconds.toFixed(1)} s, but GPT-SoVITS needs ${REF_MIN_SECONDS}–${REF_MAX_SECONDS} s`;
}

export const STATE_EVENT = 'gpt-sovits.state';

/** 「用这个目录」时用户点选的附加项；路径都会在服务端重新核对。 */
interface FolderPick {
  weights?: { gpt: string; sovits: string };
  /** 选中的参考音频路径。 */
  ref?: string;
}

/** 语音语言被切换时推给 bot；配置页写入不会通知 World，只能自己盯着。 */
export const LANGUAGE_EVENT = 'gpt-sovits.language';

export interface GptSovitsWorldOptions {
  cfg: GptSovitsConfigSection;
  timezone: string;
  dataDir: string;
  /** 部署目录（含 config.json），用于给 QQ 插件一键写语音配置。 */
  botDir: string;
  runtimesRoot: () => string;
  modelsRoot: () => string;
  persist(patch: DeepPartial<GptSovitsConfigSection>): void;
  /** 部署级密钥读取器（框架 `WorldContext.secret`，读部署 `.env`）；未注入时翻译模型的密钥读不到。 */
  secret?: (name: string) => string;
}

type Backend =
  | { kind: 'remote'; url: string }
  | { kind: 'own'; dir: string }
  | { kind: 'managed'; dir: string };

/**
 * 配置字段的 `x-options` 解析。definition.ts 的 `configOptions` 与自定义配置页共用这一份，
 * 少一个 case 就会退化成手填输入框（模型版本与音频后端就踩过这个坑）。
 */
export function panelOptionsFor(kind: unknown, language: Language): Array<{ value: string; label: string }> | undefined {
  switch (kind) {
    case VOICE_OPTIONS:
      return [
        ...VOICE_PRESETS.map((id) => ({ value: id, label: `${presetLabel(id, language)} · ${presetFileLabel(id)}` })),
        ...customVoiceOptions(),
      ];
    case TEXT_LANGUAGE_OPTIONS:
      return textLanguageOptions(language);
    case PROMPT_LANGUAGE_OPTIONS:
      return promptLanguageOptions();
    case TIER_OPTIONS:
      return tierOptions(language);
    case MODEL_VERSION_OPTIONS:
      return modelVersionOptions(language);
    case AUDIO_BACKEND_OPTIONS:
      return audioBackendOptions(language);
    case DEVICE_OPTIONS:
      try {
        return [{ value: '', label: systemDeviceLabel(language) }, ...listOutputDevices().map((d) => ({ value: d.name, label: d.name }))];
      } catch {
        return [{ value: '', label: systemDeviceLabel(language) }];
      }
    default:
      return undefined;
  }
}

export class GptSovitsWorld implements World {
  readonly id = GPT_SOVITS_ID;
  private log: Logger = console as unknown as Logger;
  private readonly runtime: RuntimeJob;
  private readonly weights: WeightsJob;
  private server: SovitsServer;
  private readonly player: Player;
  private readonly queue: QueuedLine[] = [];
  private pumping = false;
  private current: AbortController | null = null;
  /** 当前这一句的唤醒回调：hush 打断时立刻结束 `sovits_speak` 的等待，不依赖合成端是否响应 abort。 */
  private currentStart: (() => void) | null = null;
  private warming = false;
  private warmed = false;
  private lastError: string | null = null;
  /** 最近一句真正送进合成器的文字：语音语言是 en/ja/ko 时这里是译文，和气泡本来就不同。 */
  private lastSpoken: { text: string; translated: boolean; at: string } | null = null;
  private cuda: boolean | null = null;
  /** AMD 显卡的探测结果：只有在官方 ROCm 支持矩阵里才走 ROCm 档。 */
  private amd: AmdProbe = { kind: 'none' };
  /** 没检测到 NVIDIA 时的显卡厂商，只用来把「为什么走 CPU / ROCm 档」说清楚。 */
  private gpu: GpuVendor | null = null;
  /** 「已安装模型」的体积扫描结果；面板不是每秒都量，1 分钟内的重复请求直接复用。 */
  private usageCache: { at: number; data: UsageState } | null = null;
  private stopped = false;
  private host: WorldHost | null = null;
  /** World 启动后到本机服务第一次就绪或失败之间。 */
  private launching = false;
  /** 上一次用事件报给 bot 的可用性。 */
  private announced: boolean | null = null;
  /** 自定义参考音频时长不合要求时的说明,由 `voice()` 写入。 */
  private voiceIssue: string | null = null;
  /** 已经让服务加载的权重签名;配置变了就地换，不必重启。 */
  private appliedWeights = '';
  /** 服务启动时用的底模版本：版本变了只能重启，热换权重换不了底座。 */
  private appliedVersion: ModelVersion | null = null;
  /** 服务此刻实际加载的权重(内置或自备)；换失败时用它退回去。 */
  private appliedTarget: TrainedWeights | null = null;
  /** 切换失败的签名，同一条配置不重复试。 */
  private weightsFailed = '';
  /** 上一次告诉 bot 的语音语言；配置变了就推事件。 */
  private appliedTextLang: SpeechLang | null = null;
  /** 最近一次渲染 WebUI 的界面语言，配置分类页据此取字段标题。 */
  private uiLanguage: Language = 'zh';
  private langTimer: NodeJS.Timeout | undefined;
  /** 闲置停服的定时器，以及服务是否已因闲置停下（下一句自动唤醒）。 */
  private idleTimer: NodeJS.Timeout | undefined;
  private sleeping = false;
  /** 给其他插件取音频的本地 HTTP 接口；配置关着时为 null。 */
  private httpTts: HttpTtsHandle | null = null;
  /** 接口上一次没起来的原因，面板原样告诉用户（端口被占是最常见的一种）。 */
  private httpApiIssue: { kind: 'port' | 'failed'; port: number; detail: string } | null = null;
  /** 正在启动接口，避免面板连续保存时重复 bind。 */
  private httpApiStarting = false;
  /** 当前监听实际用的令牌；面板改了令牌要重绑才生效。 */
  private httpTokenInUse = '';
  /** 正在进行的启动+预热，避免休眠唤醒与面板按钮同时启动两次。 */
  private startingServer: Promise<void> | null = null;
  /** 训练页管理器，懒建；面板点开才起。 */
  private trainerManager: TrainerManager | null = null;
  /** 出口变声：交给其他插件的音频再过一遍本机 RVC。 */
  private readonly rvc: RvcLink;
  /** 云端密钥（AES-GCM 密文 + `.env` 主密钥）。 */
  private readonly cloudKeys: CloudKeyStore;
  /** 最近几句的实测样本（音频秒/字、实时系数 RTF），用来估预缓冲门槛；`lines = 0` 表示还没样本。 */
  private leadStats = { lines: 0, secondsPerChar: 0, rtf: 0 };

  constructor(private readonly opts: GptSovitsWorldOptions) {
    this.runtime = new RuntimeJob(opts.runtimesRoot, () => this.tier());
    this.weights = new WeightsJob(opts.modelsRoot, () => this.version(), () => officialVoice(this.cfg.voice.preset)?.files ?? [], () => opts.dataDir);
    this.server = new SovitsServer(this.log);
    this.player = new Player({
      device: () => opts.cfg.outputDevice,
      backend: () => opts.cfg.audioBackend ?? 'auto',
      volume: () => opts.cfg.volume,
      log: { warn: (msg, meta) => this.log.warn(msg, meta), info: (msg, meta) => this.log.info(msg, meta) } as Logger,
    });
    this.rvc = new RvcLink(() => opts.cfg.rvc, () => this.log);

    this.cloudKeys = new CloudKeyStore({
      dataDir: opts.dataDir,
      envFiles: [join(opts.dataDir, '..', '..', '.env'), join(opts.dataDir, '..', '.env'), join(opts.dataDir, '.env')],
      secret: (name) => opts.secret?.(name) ?? '',
      log: (msg, meta) => this.log.info(msg, meta),
    });
    registerCustomVoiceOptions(() => (this.cfg.voices ?? []).map((v) => {
      // 选项名自带状态、音频文件名与台本片段：下拉每次点开都重新拉取，不看下面字段也能确认配了什么。
      const missing = [!v.audio ? '缺音频' : '', !v.text ? '缺台本' : ''].filter(Boolean);
      const mark = missing.length ? `（${missing.join('、')}）` : ' ✓';
      const file = v.audio ? ` · ${v.audio.split(/[\\/]/).pop()}` : '';
      const chars = [...v.text.trim()];
      const snippet = chars.length ? ` · ${chars.slice(0, 12).join('')}${chars.length > 12 ? '…' : ''}` : '';
      return { value: v.id, label: `${v.name || UNNAMED_VOICE}${mark}${file}${snippet}` };
    }));
  }

  private get cfg(): GptSovitsConfigSection {
    return this.opts.cfg;
  }

  /** 生效的推理档；显式选择照用，`auto` 的优先级见 `pickTier`。 */
  tier(): Tier {
    const picked = pickTier(this.cfg.tier, this.cuda === true, this.amd);
    // ROCm 运行时还没上传时，自动档不能把 A 卡用户留在装不了的档上（显式选了就照用户的意思）。
    return picked === 'rocm' && this.cfg.tier === 'auto' && RUNTIME_ASSETS.rocm.bytes === 0 ? 'cpu' : picked;
  }

  /** 生效的底模版本：配置显式选了就照它，`auto` 跟档位；CPU 档一律 v2ProPlus。 */
  version(): ModelVersion {
    return resolveModelVersion(this.cfg.voiceModel ?? 'auto', this.tier());
  }

  /** 面板里的原始选择：`null` = 还没选（新装默认）；老配置的 local/cloud 都算已选。 */
  private engineSelected(): 'local' | 'cloud' | null {
    return this.cfg.ttsEngine === 'cloud' ? 'cloud' : this.cfg.ttsEngine === 'local' ? 'local' : null;
  }

  /** 合成用引擎：没选时按本地走，与 0.6.x 的默认一致，免得还没选就发不出声。 */
  private engine(): 'local' | 'cloud' {
    return this.engineSelected() ?? 'local';
  }

  /** 生效的云端服务商：显式选的优先；空串按地址推断（老配置升级后行为不变）。 */
  private cloudSpec() {
    return resolveCloudProvider(this.cfg.cloudProvider ?? '', this.cfg.cloudBaseUrl);
  }

  /**
   * 面板展示的云端音色：用户清单优先，空时按已知服务商给默认（OpenAI → 官方 6 个）。
   * 接口不是 OpenAI 时，把「OpenAI 官方音色」标出来；这类 id 厂商很可能不认，需要在合成前就看得见。
   */
  private cloudVoiceOptions(): CloudVoice[] {
    const list = effectiveCloudVoices(this.cfg.cloudVoices, this.cfg.cloudBaseUrl, this.cfg.cloudVoiceId);
    if (isOpenAiBase(this.cfg.cloudBaseUrl)) return list;
    return list.map((v) => (OPENAI_VOICES.some((o) => o.id === v.id) ? { ...v, official: true } : v));
  }

  /** 实际请求用的音色 id：显式选过的优先，否则用清单第一个（默认清单里是 alloy）。 */
  private cloudVoiceId(): string {
    return effectiveCloudVoiceId(this.cfg.cloudVoiceId, this.cloudVoiceOptions());
  }

  /** 当前是不是在用内置默认清单（用户没维护清单、也没单独选过音色）。 */
  private usingDefaultCloudVoices(): boolean {
    return !(this.cfg.cloudVoices ?? []).length && !this.cfg.cloudVoiceId.trim() && defaultCloudVoices(this.cfg.cloudBaseUrl).length > 0;
  }

  /** 云端能不能接活：填了地址（Azure 是区域）、有可用音色（含默认）、密钥可解密。 */
  private cloudReady(): boolean {
    if (this.engine() !== 'cloud') return false;
    const spec = this.cloudSpec();
    if (spec.status === 'unsupported') return false;
    if (spec.id === 'azure') {
      if (!this.cfg.cloudRegion.trim()) return false;
    } else if (!this.cfg.cloudBaseUrl.trim()) return false;
    if (spec.id === 'volcengine' && !this.cfg.cloudAppId.trim()) return false;
    if (!this.cloudVoiceId()) return false;
    try {
      return !!this.cloudKeys.read();
    } catch {
      return false;
    }
  }

  /** 云端为什么没就绪（只用于回执，不抛错）。 */
  private cloudIssue(): string {
    const spec = this.cloudSpec();
    if (spec.status === 'unsupported') return `the provider (${spec.name}) cannot return a verifiable WAV`;
    if (spec.id === 'azure' && !this.cfg.cloudRegion.trim()) return 'the Azure region is empty';
    if (spec.id !== 'azure' && !this.cfg.cloudBaseUrl.trim()) return 'the cloud base URL is empty';
    if (spec.id === 'volcengine' && !this.cfg.cloudAppId.trim()) return 'the Volcengine app ID is empty';
    if (!this.cloudVoiceId()) return 'no cloud voice is selected';
    try {
      this.cloudKeys.read();
      return 'the cloud key is missing';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * 面板「从服务商拉取清单」：成功就合并进清单并选中第一个；没有这个端点的服务商按失败说明，
   * 但保留现有清单，用户仍可手动添加。密钥只在这次请求里解密，错误文本已脱敏。
   */
  /** 拉取清单用的语种：显式 textLang 优先；`auto` 时按当前参考文本推断，推不出按中文。 */
  private cloudPullLanguage(): string {
    const lang = this.cfg.textLang;
    if (lang !== 'auto') return lang;
    const text = (this.cfg.voice?.text ?? '').trim();
    return text ? promptLanguageOf(text) : 'zh';
  }

  private async refreshCloudVoices(keyword = ''): Promise<PanelState | { text: string; failed: true }> {
    const t = panelText(this.uiLanguage);
    const spec = this.cloudSpec();
    if (!spec.voiceList) return { text: t.cloudProviderNoList, failed: true };
    let key = '';
    try { key = this.cloudKeys.read() ?? ''; } catch { /* 解不开按未设置处理 */ }
    if (!key) return { text: t.cloudVoicesNeedKey, failed: true };
    const language = this.cloudPullLanguage();
    const search = keyword.trim();
    try {
      const fetched = await fetchCloudVoices(this.cfg.cloudBaseUrl, key, this.cfg.cloudTimeoutMs || 60_000, spec.id, this.cfg.cloudRegion, {
        language,
        keyword: search,
      });
      if (!fetched.length) return { text: t.cloudVoicesPullEmpty, failed: true };
      const merged = [...(this.cfg.cloudVoices ?? [])];
      for (const v of fetched) if (!merged.some((x) => x.id === v.id)) merged.push(v);
      const keep = merged.some((v) => v.id === this.cfg.cloudVoiceId);
      const kept = merged.slice(0, 50);
      this.opts.persist({ cloudVoices: kept, ...(keep ? {} : { cloudVoiceId: kept[0]?.id ?? '' }) });
      return {
        ...this.panelState(),
        notice: {
          code: 'cloudVoicesPulled',
          count: fetched.length,
          kept: kept.length,
          total: merged.length,
          keywordMode: search ? (spec.pullSearchParam ? 'server' : 'local') : '',
        },
      };
    } catch (err) {
      return { text: t.cloudVoicesPullFailed(err instanceof Error ? err.message : String(err)), failed: true };
    }
  }

  /**
   * 用「我已经有 GPT-SoVITS 了」选中的目录：只改 `runtimeDir`（以及用户点选的那套权重/参考音频）。
   * 服务端重新检查一遍目录，不直接相信面板传回来的路径。
   */
  private applyFolder(root: unknown, pick: FolderPick): { text: string; failed?: true } {
    const t = panelText(this.uiLanguage);
    const report = inspectFolder(String(root ?? ''));
    if (!report.runtime.usable) {
      return { text: report.runtime.problem ?? report.problems[0] ?? t.folderUnusable, failed: true };
    }
    const patch: DeepPartial<GptSovitsConfigSection> = { runtimeDir: report.root, serverUrl: '' };
    const weights = pick.weights
      ? report.weights.find((w) => w.gpt === pick.weights?.gpt && w.sovits === pick.weights?.sovits)
      : undefined;
    const chosen = weights && !weights.problem ? { gpt: weights.gpt, sovits: weights.sovits } : null;
    if (chosen) patch.weights = chosen;
    const ref = pick.ref ? report.refs.find((r) => r.audio === pick.ref) : undefined;
    if (chosen && ref) {
      // 官方预设不吃全局自备权重；把「权重 + 这段参考音频」落成一个自定义音色并切过去，
      // 否则面板说「用上权重」，合成时却被官方音色挡掉。
      const voices = this.cfg.voices ?? [];
      const existing = voices.find((v) =>
        v.audio === ref.audio && v.weights.gpt === chosen.gpt && v.weights.sovits === chosen.sovits);
      const voice: CustomVoice = existing ?? {
        id: newCustomVoiceId(),
        name: basename(report.root) || UNNAMED_VOICE,
        audio: ref.audio,
        text: ref.text,
        weights: chosen,
      };
      if (!existing) patch.voices = [...voices, voice];
      patch.voice = { preset: voice.id, name: voice.name, audio: voice.audio, text: voice.text };
    } else if (ref) {
      patch.voice = { audio: ref.audio, text: ref.text };
    }
    this.opts.persist(patch);
    if (chosen) {
      // 与「换音色」同一条路：先按 SoVITS 版本头对齐推理模型，再就地换权重。
      this.alignModel(chosen);
      this.syncWeightsAfterVoiceChange();
    }
    if (chosen && !ref) return { text: t.folderWeightsNeedRef };
    return { text: t.folderApplied(report.root, !!chosen && !!ref, !!ref) };
  }

  /** 连用户已经跑起来的 api_v2：先试连，通了才写进配置。 */
  private async useService(url: string): Promise<{ text: string; failed?: true }> {
    const t = panelText(this.uiLanguage);
    const result = await probeService(url);
    if (!result.ok) return { text: result.detail, failed: true };
    this.opts.persist({ serverUrl: url.trim(), runtimeDir: '' });
    return { text: t.serviceConnected(result.detail) };
  }

  /** 回到「下载托管运行时」这条默认路。 */
  private useManagedRuntime(): { text: string } {
    this.opts.persist({ serverUrl: '', runtimeDir: '' });
    return { text: panelText(this.uiLanguage).managedChosen };
  }

  /** 云端合成一句；密钥只在这次调用里解密，失败消息已脱敏。 */
  private async synthCloudLine(text: string, signal?: AbortSignal): Promise<{ sampleRate: number; pcm: Buffer; wav: Buffer }> {
    const key = this.cloudKeys.read();
    if (!key) throw new Error('云端密钥还没设置：到「音色」页的云端分组里填一次');
    const audio = await synthCloud(text, {
      baseUrl: this.cfg.cloudBaseUrl,
      model: this.cfg.cloudModel,
      voice: this.cloudVoiceId(),
      speed: this.cfg.speed,
      timeoutMs: this.cfg.cloudTimeoutMs || 60_000,
      key,
      language: this.cfg.textLang === 'auto' ? '' : this.cfg.textLang,
      provider: this.cloudSpec().id,
      region: this.cfg.cloudRegion,
      groupId: this.cfg.cloudGroupId,
      appId: this.cfg.cloudAppId,
      cluster: this.cfg.cloudCluster,
    }, signal);
    return { sampleRate: audio.sampleRate, pcm: audio.pcm, wav: audio.wav };
  }

  /** 配置里的自备权重，校验过版本与文件；用不上时 `problem` 里是原因。
   *  选中音色自带权重时用音色的；官方音色不吃全局权重（用自己的官模 LoRA 或底模）；
   *  其余音色没有自带权重时才回落到全局配置。 */
  private trained(): TrainedResult {
    const custom = selectedCustomVoice(this.cfg.voices ?? [], this.cfg.voice.preset);
    const officialPreset = !custom && isPreset(this.cfg.voice.preset);
    const own = resolveTrained(effectiveWeights(custom, this.cfg.weights, officialPreset), this.version());
    if (own.weights || own.problem) return own;
    const off = this.official();
    return off ? { weights: off, problem: null, official: true } : own;
  }

  /** 官模只在「显卡档 + 托管安装 + 选中带官模的预设」时生效；权重没装完就先用底模。 */
  private official(): TrainedWeights | null {
    if (this.version() !== 'v5turbo') return null;
    if (this.backend().kind !== 'managed') return null;
    return officialWeights(this.weights.dir(), this.cfg.voice.preset);
  }

  /** 权重签名：变了说明配置里换了模型。底模也进签名，切换「自备 ↔ 底模」才不会被当成没变。 */
  private weightsSignature(): string {
    const t = this.trained().weights;
    return `${this.version()}|${t ? `${t.gpt}|${t.sovits}` : 'base'}`;
  }

  /** 内置底模的绝对路径；连已有服务时无从得知它在哪，返回 null。 */
  private baseTarget(): TrainedWeights | null {
    const b = this.backend();
    if (b.kind === 'remote') return null;
    if (b.kind === 'managed') return installedBaseWeights(this.weights.dir(), this.version());
    // 自备目录按运行时根拼：那里的 pretrained_models 就是真实目录，不是联接。
    const w = weightPaths(this.version());
    return { gpt: join(b.dir, w.t2s), sovits: join(b.dir, w.vits) };
  }

  /** 配置希望服务加载的权重；连已有服务又没填自备权重时为 null(不知道底模路径，只能不动)。 */
  private wantedTarget(): TrainedWeights | null {
    return this.trained().weights ?? this.baseTarget();
  }

  /**
   * 让服务加载当前配置指向的权重。启动时这份路径已经写进 yaml,这里管的是「服务在跑时改了配置」:
   * 走 `/set_gpt_weights` 与 `/set_sovits_weights` 就地换，不重启进程，也不打断正在播的句子。
   * 换失败只警告，并尽量退回上一组权重;同一条配置不重复试。
   */
  private async applyWeights(url: string): Promise<void> {
    // 已有服务在另一台机器上时，权重/参考音频路径在对面不存在；按约定只提示、不切。
    const backend = this.backend();
    if (backend.kind === 'remote' && !isLocalService(backend.url)) {
      this.log.warn('已有服务不在本机，跳过换权重（路径只在本机有效）', { url: backend.url });
      return;
    }
    const sig = this.weightsSignature();
    if (sig === this.appliedWeights || sig === this.weightsFailed) return;
    const target = this.wantedTarget();
    const previous = this.appliedTarget;
    if (!target) { this.appliedWeights = sig; return; }
    try {
      await switchWeights(url, target, AbortSignal.timeout(WEIGHT_SWITCH_TIMEOUT_MS));
      this.appliedWeights = sig;
      this.appliedTarget = target;
      this.log.info('推理服务已换用这组权重', { gpt: target.gpt, sovits: target.sovits });
    } catch (err) {
      this.weightsFailed = sig;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log.warn('换权重失败，继续用原来的权重', { err: this.lastError, target });
      if (previous) {
        try {
          await switchWeights(url, previous, AbortSignal.timeout(WEIGHT_SWITCH_TIMEOUT_MS));
        } catch (back) {
          this.log.warn('退回上一组权重也失败', { err: String(back) });
        }
      }
    }
  }

  /**
   * 换音色后立刻把权重切过去，不等下一句：服务在跑就直接走 `/set_*_weights`，
   * 上一次失败也清掉（换过音色就该重试，不能因为一次失败一直沿用旧权重）。
   */
  private syncWeightsAfterVoiceChange(): void {
    this.weightsFailed = '';
    const url = this.url();
    if (!url || this.server.state().phase !== 'ready') return;
    // 推理档刚被换音色自动对齐过：当前服务还是旧底座，下一句会走重启，先别切权重。
    if (this.appliedVersion !== null && this.appliedVersion !== this.version()) return;
    void this.applyWeights(url);
  }

  /** 一组权重需要哪个推理模型；没填或读不出返回 null。 */
  private weightsModel(weights: TrainedWeights | null | undefined): ModelVersion | null {
    if (!weights?.sovits) return null;
    return sovitsVersion(weights.sovits)?.version ?? null;
  }

  /** 换音色时把推理模型对齐到该权重需要的版本；返回想要的版本与实际生效的版本。 */
  private alignModel(weights: TrainedWeights | null | undefined): { want: ModelVersion; applied: ModelVersion | null } | null {
    const want = this.weightsModel(weights);
    if (!want || want === this.version()) return null;
    this.opts.persist({ voiceModel: want });
    const applied = this.version() === want ? want : null;
    if (!applied) this.log.warn('推理档受硬件限制，切不到权重需要的版本', { want, current: this.version() });
    return { want, applied };
  }

  /** 自动对齐 / 编辑保存后的回执：对齐成功报「已切换」，切不动或有版本差就报冲突。 */
  private alignNotice(align: { want: ModelVersion; applied: ModelVersion | null } | null, mismatch: ModelVersion | null): PanelNotice | undefined {
    if (align) {
      return align.applied
        ? { code: 'modelSwitched', model: align.applied }
        : { code: 'weightsMismatch', want: align.want, current: this.version() };
    }
    return mismatch && mismatch !== this.version() ? { code: 'weightsMismatch', want: mismatch, current: this.version() } : undefined;
  }

  /** 当前该用的权重与推理模型的版本冲突；启动兜底与面板提示共用这一份判断。 */
  private modelMismatch(): { want: ModelVersion; current: ModelVersion } | null {
    const custom = selectedCustomVoice(this.cfg.voices ?? [], this.cfg.voice.preset);
    const officialPreset = !custom && isPreset(this.cfg.voice.preset);
    const want = this.weightsModel(effectiveWeights(custom, this.cfg.weights, officialPreset));
    return want && want !== this.version() ? { want, current: this.version() } : null;
  }

  private backend(): Backend {
    if (this.cfg.serverUrl.trim()) return { kind: 'remote', url: this.cfg.serverUrl.trim().replace(/\/+$/, '') };
    if (this.cfg.runtimeDir.trim()) return { kind: 'own', dir: this.cfg.runtimeDir.trim() };
    return { kind: 'managed', dir: this.runtime.dir() };
  }

  /** 训练页管理器，懒建：面板第一次用时才构造。 */
  private trainer(): TrainerManager {
    if (!this.trainerManager) {
      this.trainerManager = new TrainerManager({
        runtimeDir: () => this.runtime.dir(),
        weightsDir: () => this.weights.dir(),
        dataDir: this.opts.dataDir,
        log: this.log,
        stopInference: async () => { this.hush(); await this.server.stop(); },
        modelVersion: () => this.version(),
      });
    }
    return this.trainerManager;
  }

  /** 训练页的门槛：只有托管安装且运行时就绪才放行，否则把原因直接抛给面板。 */
  private trainerGate(): TrainerManager {
    const b = this.backend();
    if (b.kind === 'remote') throw new Error('当前是「已有服务」模式：训练需要本机运行时。');
    if (b.kind === 'own') throw new Error('自备运行时目录不支持训练面板，请直接用该目录里的 webui.py。');
    if (this.runtime.status().phase !== 'ready') throw new Error('运行时还没装好，先到「语音」页安装。');
    return this.trainer();
  }

  /** 能接合成请求的地址;本机服务要预热完。 */
  private url(): string | null {
    const b = this.backend();
    if (b.kind === 'remote') return b.url;
    const st = this.server.state();
    return st.phase === 'ready' && this.warmed ? st.url : null;
  }

  /** 上次见到的音色选择;变化时把该音色的参数镜像到配置字段（含权重），避免上个音色的值残留。 */
  private seenPreset = '';

  /**
   * 配置页就是自定义音色的管理界面：`voice.name/audio/text` 是「当前音色」的参数。
   * - 选中某个音色：把它的参数镜像到字段（含权重），用户随后改字段就等于改这个音色；
   * - 选「＋ 新建音色…」：名称、音频、台本都填齐就自动存成新音色并切过去（权重可选，成对）；
   * - 切回预设：清掉镜像过来的音频/台本（手填的路径不动），权重留作用户全局设置。
   * 在 `voice()` 与 `panelState()` 开头调用，配置页与面板两种入口都会收敛到一致状态。
   */
  private settlePreset(): void {
    const p = this.cfg.voice.preset;
    const v = this.cfg.voice;
    const voices = this.cfg.voices ?? [];
    const switched = p !== this.seenPreset;
    this.seenPreset = p;
    const custom = selectedCustomVoice(voices, p);
    if (custom && switched) {
      // 刚切到这个音色：镜像它的全部参数，之后字段的改动即为对该音色的编辑。
      // 音色没自己的权重时不动全局权重——「音色管音色，权重是底座」，否则用户配好的自备权重会被清掉。
      const own = !!custom.weights.gpt && !!custom.weights.sovits;
      this.opts.persist({
        voice: { preset: custom.id, name: custom.name, audio: custom.audio, text: custom.text },
        ...(own ? { weights: custom.weights } : {}),
      });
      return;
    }
    if (p === NEW_VOICE_PRESET) {
      if (switched) {
        // 刚选「＋ 新建音色…」：清空名称/音频/台本，进入空白新建态（权重保留，作为新音色的默认）。
        this.opts.persist({ voice: { preset: NEW_VOICE_PRESET, name: '', audio: '', text: '' } });
        return;
      }
      const audio = v.audio?.trim() ?? '';
      const text = v.text?.trim() ?? '';
      if (!audio || !text) return; // 还没填齐，等用户填
      const seconds = existsSync(audio) ? readSeconds(audio) : null;
      const gpt = this.cfg.weights.gpt.trim(), sovits = this.cfg.weights.sovits.trim();
      const problems = validateCustomVoice({ name: v.name ?? '', text, gpt, sovits, seconds });
      if (!existsSync(audio)) problems.unshift(`参考音频不存在：${audio}`);
      if (problems.length) { this.voiceIssue = problems.join(' '); return; }
      const weights = gpt && sovits ? { gpt, sovits } : emptyWeights();
      const voice: CustomVoice = {
        id: newCustomVoiceId(),
        name: (v.name ?? '').trim() || UNNAMED_VOICE,
        audio, text, weights,
      };
      this.log.info('从配置页新建了音色', { id: voice.id, name: voice.name, withWeights: !!weights.gpt });
      this.opts.persist({ voices: [...voices, voice], voice: { preset: voice.id, name: voice.name, audio: voice.audio, text: voice.text } });
      this.seenPreset = voice.id;
      return;
    }
    if (!custom) {
      if (!isPreset(p)) return;
      // 预设音色：把包内的参考音频与台本镜像进字段，用户看得见当前用的是什么文件（按语音语言选）。
      const f = presetFiles(p, this.cfg.textLang);
      if (!existsSync(f.audio) || !existsSync(f.text)) return;
      const text = readText(f.text);
      const mirrored = !v.audio || PRESET_PATH.test(v.audio) || voices.some((x) => x.audio === v.audio);
      if ((switched || mirrored) && (v.audio !== f.audio || v.text !== text)) {
        this.opts.persist({ voice: { preset: p, name: '', audio: f.audio, text } });
      }
      return;
    }
    // 选着自定义音色且字段被改过：写回该音色（名称只在「音色」面板里改，这里忽略 voice.name）。
    const gpt = this.cfg.weights.gpt.trim(), sovits = this.cfg.weights.sovits.trim();
    const weights = gpt && sovits ? { gpt, sovits } : emptyWeights();
    const name = custom.name;
    const audio = v.audio?.trim() ?? custom.audio;
    const text = v.text?.trim() ?? custom.text;
    const changed = name !== custom.name || audio !== custom.audio || text !== custom.text
      || weights.gpt !== custom.weights.gpt || weights.sovits !== custom.weights.sovits;
    if (!changed) return;
    if (audio !== custom.audio) {
      const seconds = existsSync(audio) ? readSeconds(audio) : null;
      const problems = validateCustomVoice({ name, text, gpt, sovits, seconds });
      if (!existsSync(audio)) problems.unshift(`参考音频不存在：${audio}`);
      if (problems.length) { this.voiceIssue = problems.join(' '); return; }
    }
    const updated: CustomVoice = { id: custom.id, name, audio, text, weights };
    this.log.info('配置页更新了音色', { id: custom.id, name });
    this.opts.persist({
      voices: voices.map((x) => (x.id === custom.id ? updated : x)),
      voice: { preset: custom.id, name: updated.name, audio: updated.audio, text: updated.text },
    });
  }

  /**
   * 自定义参考音频优先，其次是选中的音色（自定义音色或预设）。
   * 音频先量时长：超出 3–10 秒时 api_v2 只回 400、不说原因，这里替它说明。
   */
  private voice(): { audio: string; text: string; preset: string | null } | null {
    this.settlePreset();
    this.voiceIssue = null;
    const v = this.cfg.voice;
    const custom = selectedCustomVoice(this.cfg.voices ?? [], v.preset);
    if (custom) {
      if (!custom.audio) {
        this.voiceIssue = '这个音色还没有参考音频：在配置里选一段 3–10 秒的 WAV。';
        return null;
      }
      if (!existsSync(custom.audio)) {
        this.voiceIssue = `这个音色的参考音频不见了：${custom.audio}`;
        return null;
      }
      this.voiceIssue = referenceIssue(custom.audio);
      return this.voiceIssue ? null : { audio: custom.audio, text: custom.text, preset: custom.id };
    }
    if (v.preset === NEW_VOICE_PRESET) {
      this.voiceIssue = '新建音色还差参数：在配置里选参考音频、填台本（名称可留空），填齐就自动保存。';
      return null;
    }
    if (v.audio && existsSync(v.audio) && !PRESET_PATH.test(v.audio)) {
      // 手填的参考音频（不属于任何音色、也不是预设镜像）也照旧生效，兼容老配置。
      this.voiceIssue = referenceIssue(v.audio);
      return this.voiceIssue ? null : { audio: v.audio, text: v.text, preset: null };
    }
    const id = isPreset(v.preset) ? v.preset : DEFAULT_PRESET;
    const f = presetFiles(id, this.cfg.textLang);
    return existsSync(f.audio) && existsSync(f.text) ? { audio: f.audio, text: readText(f.text), preset: id } : null;
  }

  /** 当前选中的自定义音色（没选或已删时 null）。 */
  private activeCustomVoice(): CustomVoice | null {
    return selectedCustomVoice(this.cfg.voices ?? [], this.cfg.voice.preset);
  }

  envPromptVars(): Record<string, string> {
    const w = stateWords(this.cfg.promptLanguage);
    const lang = languageWords(this.cfg.promptLanguage, this.cfg.textLang);
    return {
      'sovits.state': this.stateFor(w),
      'sovits.language': `${lang.name}——${lang.rule}`,
      'sovits.share': shareWords(this.cfg.promptLanguage, this.cfg.shareAudio),
      'sovits.channel': channelWords(this.cfg.promptLanguage, this.cfg.channelVoice),
      'sovits.qqbot': qqbotWords(this.cfg.promptLanguage, this.cfg.qqbotVoice),
    };
  }

  private stateFor(w: ReturnType<typeof stateWords>): string {
    if (!this.voice()) return this.voiceIssue ?? w.noVoice;
    if (this.url()) return w.available;
    if (this.sleeping) return w.asleep;
    const st = this.server.state();
    if (st.phase === 'error') return w.error(st.detail ?? '');
    if (st.phase === 'starting' || this.warming || this.launching) return w.starting;
    return w.notInstalled;
  }

  tools(): ToolDef[] {
    const [speak, hush] = SOVITS_TOOL_DECLS;
    // 工具描述每次请求都会带上：把当前语音语言规则附在这里，前缀过期或被旧记忆带偏时也能纠正。
    const lang = languageWords('en', this.cfg.textLang);
    // 补一句附件用法：模型才知道把回执里的 [blob …] 句柄填给别的发送工具。
    // 开了「交给其他插件」时整句都回附件；没开时 silent: true 也回，够旧 QQ 插件取语音条。
    const share = this.cfg.shareAudio
      ? " The result also carries the whole line as an audio attachment: pass that [blob …] handle to another plugin's send tool (the QQ Bot plugin's qqbot_send_message voice parameter, or the old plugin's qq_draft voice) to deliver the same audio. Pass silent: true for a line meant for such a channel, so it is not played on this computer."
      : this.cfg.channelVoice
        ? ''
        : " A line spoken with silent: true also comes back as an audio attachment: hand its [blob …] handle to a plugin's voice parameter (qqbot_send_message or qq_draft, for example).";
    // 旧 QQ 插件（qq-final / NapCat）自己合成语音：走 qq_send 时别调本工具，改传 voice=true。
    const channel = this.cfg.channelVoice
      ? " When you reply through the old QQ plugin's qq_send, do not call this tool: pass voice=true in that same qq_send call instead, and it speaks with this same voice through the local voice API. This rule does not apply to qqbot_send_message — follow the QQ Bot instruction instead. That still holds when the person asks for voice or asks you to try again — do not skip it because you once said that channel was broken."
      : '';
    return [
      { ...speak!, description: `${speak!.description} Speech language: ${lang.name} — ${lang.rule}${share}${channel}`, handler: (args) => this.speak(String(args.text ?? ''), args.silent === true) },
      { ...hush!, handler: async () => { this.hush(); return 'Stopped.'; } },
    ];
  }

  /** 排进队列，等这一句开始出声(或失败、被清空、超时)再返回；不外放的句子没有声音要对齐，直接返回。 */
  private async speak(script: string, silent = false): Promise<ToolOutcome> {
    this.syncLanguage();
    // 以 `【唱】` 开头：这句不当台词念，交给唱歌插件唱出来并直接写进本机播放器（桌宠/对话页）。
    // 唱不出来（插件没装、引擎没就绪）就退回去念歌词，不影响正常出声。
    // `silent: true` 只合成不本机外放（给 QQ 等渠道用），但仍把 WAV 作为附件交出去——
    // 那些渠道只认 `[blob …]` / `log:` 句柄，读不到本机路径。
    const song = SING_MARK.exec(script);
    if (song) {
      const lyrics = script.slice(song[0].length).trim();
      if (lyrics) {
        try {
          const wav = await this.singViaSinger(lyrics, AbortSignal.timeout(SING_PLAY_TIMEOUT_MS));
          const head = parseWavHeader(wav);
          if (!head) throw new Error('sing returned no WAV header');
          const pcm = wav.subarray(head.dataStart);
          if (!pcm.length) throw new Error('sing returned empty audio');
          const seconds = pcm.length / 2 / head.sampleRate;
          const played = !silent && this.cfg.playLocally;
          if (played) {
            await this.player.write(head.sampleRate, pcm, 1);
            this.player.flush();
          }
          if (this.cfg.saveAudio) this.saveLine(pcm, head.sampleRate);
          this.log.info('唱了一句', { chars: [...lyrics].length, seconds: Number(seconds.toFixed(2)), played });
          const outcome: ToolOutcome = { text: `Sang one line (${seconds.toFixed(1)} s)${played ? ' on this computer' : ''}.` };
          if (this.cfg.shareAudio || silent) {
            outcome.blobs = [{
              bytes: wav,
              mime: 'audio/wav',
              name: 'song.wav',
              fallbackText: 'This song as an audio file; hand this handle to another plugin (the QQ voice parameter, for example) to send it.',
            }];
          }
          return outcome;
        } catch (err) {
          this.log.warn('点歌没唱成，这句改用普通语音念', { err: err instanceof Error ? err.message : String(err), lyrics });
          script = lyrics;
        }
      }
    }
    const text = ttsSafe(speechText(script));
    if (!text) return { text: 'Nothing to say: the text has only markup.' };
    const cloud = this.engine() === 'cloud';
    if (cloud) {
      if (!this.cloudReady()) {
        return { text: `Voice unavailable: cloud mode is on but ${this.cloudIssue()}.`, failed: true };
      }
    } else if (!this.voice()) {
      return { text: `Voice unavailable: ${this.voiceIssue ?? 'no reference audio is set'}.`, failed: true };
    }
    const ready = cloud || !!this.url();
    if (!ready) {
      if (!this.sleeping || !this.canStart()) return { text: `Voice unavailable: ${this.stateFor(stateWords('en'))}.`, failed: true };
      // 闲置停服后第一句：先叫醒服务，这一句排在队列里等它加载完。
      this.sleeping = false;
      this.log.info('推理服务在休眠，这句话会叫醒它');
      void this.startServer().finally(() => { this.armIdle(); void this.pump(); });
    }
    // 翻译放在排队之前：回执要写清真正念出去的是哪句；放进 pump 里做的话，模型永远看不到译文。
    const spoken = await this.prepareSpeechText(text, this.cfg.textLang);
    this.lastSpoken = { text: spoken, translated: spoken !== text, at: nowIso(this.opts.timezone) };
    const ahead = this.queue.length + (this.current ? 1 : 0);
    // 开启「交给其他插件」或这一句本来就不外放（silent）时收下整句 PCM：
    // 后者让旧 QQ 插件（qq_draft 的 voice 只认 log:/mem: 句柄）拿到可发送的附件。
    const sharing = this.cfg.shareAudio || silent;
    let finish: ((wav: Buffer | null) => void) | undefined;
    const finished = sharing ? new Promise<Buffer | null>((resolve) => { finish = resolve; }) : null;
    let timer: NodeJS.Timeout | undefined;
    const started = new Promise<void>((done) => {
      this.queue.push({ text, spoken, at: Date.now(), silent, started: done, ...(finish ? { finish } : {}) });
      // 云端没有流式：等整句音频回来（成功写声卡、或失败/打断收尾）再回执，由请求自身的超时兜底，
      // 不套本地的 3 秒上限，免得气泡比声音早。本地仍是「第一块音频进声卡」的上限。
      if (!cloud) timer = setTimeout(done, SPEAK_WAIT_MAX_MS);
    });
    if (ready) void this.pump();
    // 提示词现在是先 `sovits_speak` 再 `pet_say`，回执早晚决定气泡出现的时间：本地等第一块音频写进声卡
    // （至多 SPEAK_WAIT_MAX_MS）；云端等整句音频到手。不外放的句子没有声音要对齐，直接回执，免得气泡白等。
    if (!silent && this.cfg.playLocally) await started;
    clearTimeout(timer);
    const said = spokenReceipt(spoken, { ahead, lang: this.cfg.textLang, translated: spoken !== text });
    if (!finished) return { text: said };
    const wav = await Promise.race([finished, delayed(SHARE_WAIT_MAX_MS)]);
    if (!wav) return { text: `${said} No audio attachment this time: the line did not finish within ${SHARE_WAIT_MAX_MS / 1000} s.` };
    return {
      text: said,
      // 字节由宿主存成 log: 附件，句柄随回执交给模型；别的插件（QQ 等）用同一个句柄取回这段音频。
      blobs: [{
        bytes: wav,
        mime: 'audio/wav',
        name: 'line.wav',
        fallbackText: 'This line as an audio file; hand this handle to another plugin (the QQ voice parameter, for example) to send the same audio.',
      }],
    };
  }

  private hush(): void {
    for (const item of this.queue.splice(0)) { item.started(); settleLine(item, null); }
    this.current?.abort();
    // 被打断的当前句也要立刻结束 `sovits_speak` 的等待（合成端可能还没来得及响应 abort）。
    this.currentStart?.();
    this.player.cut();
  }

  /**
   * 合成一句话并写进播放器；返回首包时间和整句 PCM（只有开启保存或需要交付时才收）。
   * `silent` 为 true 时只合成不写播放器：这一句是给别的渠道（QQ 等）的，本机不该出声。
   * `deliver` 为 true 时收下整句并在返回值里给出 WAV。
   * 失败时抛出，由调用方决定要不要降级重试。`onFirst` 在第一次真正写进声卡时调用一次。
   */
  private async playLine(
    url: string, voice: { audio: string; text: string }, spoken: string,
    signal: AbortSignal, onFirst: () => void, silent: boolean, deliver: boolean, text = spoken,
  ): Promise<{ first: number; wav: Buffer | null }> {
    const gain = this.backend().kind === 'remote' ? 1 : OUTPUT_GAIN[this.version()];
    // 落盘或这一句要交出去时收整句；都没有时不占内存。
    const archive = this.cfg.saveAudio || deliver ? { rate: 0, chunks: [] as Buffer[] } : null;
    let first = 0;
    let audioMs = 0;
    const began = Date.now();
    // 预缓冲只在「实测生成慢于播放」时生效；门槛 0（默认）时与旧行为完全一致：第一块就写声卡。
    const leadMs = this.leadTargetMs(spoken, silent);
    let held: Array<{ rate: number; pcm: Buffer }> = [];
    let heldMs = 0;
    let released = leadMs <= 0;
    const release = async (): Promise<void> => {
      const hadAudio = held.length > 0;
      for (const part of held) await this.player.write(part.rate, part.pcm, gain);
      held = [];
      released = true;
      if (hadAudio && !first) { first = Date.now(); onFirst(); }
    };
    for await (const c of synthesize(url, this.request(spoken, voice), signal)) {
      const ms = (c.pcm.length / 2 / c.sampleRate) * 1000;
      audioMs += ms;
      if (archive) { archive.rate = c.sampleRate; archive.chunks.push(applyGain(c.pcm, gain)); }
      if (!silent) {
        if (released) {
          await this.player.write(c.sampleRate, c.pcm, gain);
        } else {
          held.push({ rate: c.sampleRate, pcm: c.pcm });
          heldMs += ms;
          if (heldMs >= leadMs) await release();
        }
      }
      if (!first && (released || silent)) { first = Date.now(); onFirst(); }
    }
    // 句子比门槛短时，别把最后几块压在手里白等：直接全部写出去。
    if (!silent && !released) await release();
    if (!silent) this.player.flush();
    // 只拿本机外放的整句做样本：silent / 交付句的墙钟含 QQ 等下游开销，算进来会把 RTF 带偏。
    if (!silent && !signal.aborted) this.recordLeadSample(spoken.length, audioMs, Date.now() - began);
    if (!archive?.chunks.length) return { first, wav: null };
    const bytes = Buffer.concat(archive.chunks);
    if (this.cfg.saveAudio) this.saveLine(bytes, archive.rate);
    // 交出去的一律是带 RIFF 头的完整 WAV：别的插件拿这段字节去转码，裸 PCM 会被 ffmpeg 判成
    // 「Invalid data found when processing input」（QQ 语音就是这么失败的）。
    return { first, wav: deliver ? wavBytes(bytes, archive.rate) : null };
  }

  /** 本句的预缓冲门槛；没有样本、生成快于播放、系统播放器或本句不落声卡时都给 0。 */
  private leadTargetMs(spoken: string, silent: boolean): number {
    if (silent || this.player.usesSystemPlayer) return 0;
    const s = this.leadStats;
    if (!s.lines) return 0;
    return playbackLeadMs({
      ratio: this.cfg.playbackLead ?? 0,
      chars: spoken.length,
      secondsPerChar: s.secondsPerChar,
      rtf: s.rtf,
    });
  }

  /** 记一句本机外放的实测：音频秒/字与实时系数（合成墙钟 / 音频时长），EMA 衰减旧样本。 */
  private recordLeadSample(chars: number, audioMs: number, synthMs: number): void {
    if (!(chars > 0) || !(audioMs > 0) || !(synthMs > 0)) return;
    const secondsPerChar = audioMs / 1000 / chars;
    const rtf = synthMs / audioMs;
    const s = this.leadStats;
    if (!s.lines) {
      s.secondsPerChar = secondsPerChar;
      s.rtf = rtf;
    } else {
      s.secondsPerChar = s.secondsPerChar * .75 + secondsPerChar * .25;
      s.rtf = s.rtf * .75 + rtf * .25;
    }
    s.lines += 1;
  }

  /**
   * 云端的一句：整段 WAV 一次回来，没有首块流式。写进播放器、落盘、交付附件都与本地同语义。
   * 音量由云端请求里的 `speed` 之外不再二次调节（交付的 WAV 保持厂商原样）。
   */
  private async playCloudLine(
    spoken: string, signal: AbortSignal, onFirst: () => void, silent: boolean, deliver: boolean, text = spoken,
  ): Promise<{ first: number; wav: Buffer | null }> {
    const audio = await this.synthCloudLine(spoken, signal);
    if (!silent) {
      await this.player.write(audio.sampleRate, audio.pcm, 1);
      this.player.flush();
    }
    const first = Date.now();
    onFirst();
    if (this.cfg.saveAudio) this.saveLine(audio.pcm, audio.sampleRate);
    return { first, wav: deliver ? audio.wav : null };
  }

  /** 把这一句的 PCM 另存为 WAV；保存失败只记日志，不影响播放。 */
  private saveLine(pcm: Buffer, sampleRate: number): void {
    try {
      const dir = this.cfg.saveDir.trim() || join(this.opts.dataDir, 'out');
      mkdirSync(dir, { recursive: true });
      const d = new Date();
      const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
      const file = join(dir, `line-${stamp}.wav`);
      writeFileSync(file, wavBytes(pcm, sampleRate));
      this.log.info('GPT-SoVITS 语音已保存', { file });
      this.sweepSaved(dir);
    } catch (err) {
      this.log.warn('GPT-SoVITS 语音保存失败', { err: String(err) });
    }
  }

  /** 按「保留时长」清掉过期的语音文件；只认本插件写出的 `line-*.wav`，目录里别的文件不动。 */
  private sweepSaved(dir: string): void {
    const hours = this.cfg.saveKeepHours;
    if (!(hours > 0)) return;
    const cutoff = Date.now() - hours * 3_600_000;
    try {
      let removed = 0;
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        let mtime = 0;
        try { mtime = statSync(file).mtimeMs; } catch { continue; }
        if (!staleSavedLine(name, mtime, cutoff)) continue;
        rmSync(file, { force: true });
        removed += 1;
      }
      if (removed) this.log.info('已清理过期的语音文件', { dir, removed, hours });
    } catch (err) {
      this.log.warn('清理语音文件失败', { err: String(err) });
    }
  }

  /** 逐句合成并写进播放器;一句合成完就开始下一句，播放器按顺序播。 */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.stopped) {
        const item = this.queue.shift()!;
        const { spoken, at, started } = item;
        // 本机不外放开关关着时整句静音；句子级 silent 参数也一样。
        const silent = item.silent || !this.cfg.playLocally;
        const cloud = this.engine() === 'cloud';
        // 换底模版本只能重启：api_v2 的 `version` 只在启动时读 yaml，热换权重换不了底座。云端不碰这些。
        if (!cloud && this.backend().kind !== 'remote' && this.appliedVersion !== null && this.appliedVersion !== this.version()) {
          this.log.info('模型版本变了，重启推理服务', { from: this.appliedVersion, to: this.version() });
          await this.server.stop();
          this.appliedWeights = '';
          this.weightsFailed = '';
          await this.startServer();
        }
        const url = this.url();
        const voice = cloud ? null : this.voice();
        if (cloud ? !this.cloudReady() : (!url || !voice)) {
          started();
          settleLine(item, null);
          for (const rest of this.queue.splice(0)) { rest.started(); settleLine(rest, null); }
          break;
        }
        const abort = new AbortController();
        this.current = abort;
        this.currentStart = started;
        let heard = false;
        let wav: Buffer | null = null;
        const onFirst = (): void => { heard = true; started(); };
        try {
          const played = cloud
            ? await this.playCloudLine(spoken, abort.signal, onFirst, silent, !!item.finish, item.text)
            : await (async () => { await this.applyWeights(url!); return this.playLine(url!, voice!, spoken, abort.signal, onFirst, silent, !!item.finish, item.text); })();
          wav = played.wav;
          this.log.info(cloud ? '云端一句合成完' : 'GPT-SoVITS 一句合成完', { chars: [...spoken].length, silent, waitMs: played.first - at, totalMs: Date.now() - at });
          this.lastError = null;
        } catch (err) {
          if (abort.signal.aborted) {
            // 被 hush() 打断，不算失败。
          } else {
            const message = err instanceof Error ? err.message : String(err);
            let ok = false;
            let recovered = '';
            // 连接被服务端断开（undici 的 `terminated` 之类）时重发一次通常就好，这不是文本问题，
            // 不该拿「去掉标点」去试（社区实测 0.6.1 在 ROCm 上就是这种错）。
            if (!cloud && !heard && isConnectionDrop(message)) {
              try {
                wav = (await this.playLine(url!, voice!, spoken, abort.signal, onFirst, silent, !!item.finish, item.text)).wav;
                ok = true;
                recovered = '连接断开后重试';
              } catch { ok = false; }
            }
            // 服务端遇到「某一段只剩符号」的文本会在音素前端崩(空音素段 -> torch.cat 报错)。
            // 已经出过声就不再重试(会把半句重复播一次)，没出声时去掉标点再试一次。
            const plain = ttsPlain(spoken);
            if (!cloud && !ok && !heard && plain && plain !== spoken) {
              try {
                wav = (await this.playLine(url!, voice!, plain, abort.signal, onFirst, silent, !!item.finish, item.text)).wav;
                ok = true;
                recovered = '去掉标点后';
              } catch {
                ok = false;
              }
            }
            if (ok) {
              this.lastError = null;
              this.log.info(`GPT-SoVITS ${recovered}合成成功`, { chars: [...spoken].length });
            } else if (!abort.signal.aborted) {
              this.lastError = message;
              if (cloud) this.log.warn('云端合成失败', { err: this.lastError, base: this.cfg.cloudBaseUrl, model: this.cfg.cloudModel });
              else this.log.warn('GPT-SoVITS 合成失败', { err: this.lastError, tier: this.tier(), streaming: this.tier() === 'rocm' ? 0 : 3 });
            }
          }
        } finally {
          started();
          // 交付这一句的音频：成功给 WAV，失败、被打断、没合成出来都给 null（重复调用只生效一次）。
          settleLine(item, wav);
          this.current = null;
          this.currentStart = null;
        }
      }
    } finally {
      this.pumping = false;
      this.armIdle();
    }
  }

  /** 队列空了就开始计时：闲置到 `idleMinutes` 分钟就停服务释放显存；0 为不停。 */
  private armIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const minutes = this.cfg.idleMinutes;
    if (!minutes || minutes <= 0 || this.sleeping || this.stopped) return;
    if (this.backend().kind === 'remote' || this.server.state().phase !== 'ready') return;
    if (this.queue.length || this.current || this.pumping) return;
    this.idleTimer = setTimeout(() => { void this.sleep(); }, minutes * 60_000);
    this.idleTimer.unref();
  }

  /** 闲置到点：停掉本机服务并把状态记为休眠，下一句 `sovits_speak` 会重新拉起。 */
  private async sleep(): Promise<void> {
    this.idleTimer = undefined;
    if (this.stopped || this.sleeping) return;
    if (this.queue.length || this.current || this.pumping) return this.armIdle();
    if (this.backend().kind === 'remote' || this.server.state().phase !== 'ready') return;
    this.sleeping = true;
    this.warmed = false;
    this.log.info('推理服务闲置，停掉以释放显存', { minutes: this.cfg.idleMinutes });
    await this.server.stop();
  }

  /** 合成一句要用的请求参数；预热时可指定语言。 */
  private request(text: string, voice: { audio: string; text: string }, textLang: SpeechLang = this.cfg.textLang): SynthRequest {
    const rocm = this.tier() === 'rocm';
    return {
      text, refAudio: voice.audio, refText: voice.text, speed: this.cfg.speed, seed: this.cfg.seed,
      textLang, promptLang: promptLanguageOf(voice.text),
      // ROCm 上「多段 + 流式」会在第二段起被服务端断开（社区 0.6.1 实测 `terminated`，同一句试听却正常）。
      // 这一档改成整句一次算、非流式返回：短句本来就能过，长句也不再分段，代价是首音晚一点。
      ...(rocm ? { splitMethod: 'cut0', streamingMode: 0 } : {}),
    };
  }

  /**
   * 合成前的文本准备：`textLang` 选 en/ja/ko 且文字还不是该语言时，先用配置的翻译模型把整段文字
   * 翻成目标语言再送合成（切句由服务端的 `cut5` 在译文上做）。没配翻译模型或翻译失败时按原文合成。
   */
  private async prepareSpeechText(text: string, textLang: SpeechLang): Promise<string> {
    if (textLang !== 'en' && textLang !== 'ja' && textLang !== 'ko') return text;
    const src = text.trim();
    if (!src || promptLanguageOf(src) === textLang) return text;
    const endpoint = (this.cfg.translateEndpoint ?? '').trim();
    const model = (this.cfg.translateModel ?? '').trim();
    if (!endpoint || !model) return text;
    const keyName = (this.cfg.translateApiKeySecret ?? '').trim();
    const apiKey = keyName ? this.opts.secret?.(keyName) ?? '' : '';
    const out = await translateTo(src, textLang, { endpoint, apiKey, model }, this.log);
    if (!out) return text;
    this.log.info('GPT-SoVITS 语音先翻译再合成', { to: textLang, inChars: [...src].length, outChars: [...out].length });
    return out;
  }

  async start(host: WorldHost): Promise<void> {
    this.log = host.log;
    this.host = host;
    this.server = new SovitsServer(this.log, (detail) => this.onServerExit(detail));
    this.stopped = false;
    this.announced = null;
    this.sleeping = false;
    this.appliedWeights = '';
    this.appliedVersion = null;
    this.appliedTarget = null;
    this.weightsFailed = '';
    this.launching = this.cfg.autoStart && this.backend().kind !== 'remote' && this.engineSelected() === 'local';
    const gpus = await detectGpus();
    this.cuda = gpus.nvidia;
    this.amd = gpus.amd;
    this.gpu = gpus.vendor;
    if (this.cfg.tier === 'cuda' && !gpus.nvidia) this.log.warn('配置的是显卡档，但没检测到 NVIDIA 显卡', { gpu: this.gpu });
    if (this.cfg.tier === 'rocm' && gpus.amd.kind !== 'supported') this.log.warn('配置的是 ROCm 档，但没检测到官方支持的 AMD 显卡', { gpu: this.gpu, amd: gpus.amd });
    if (voiceModelNeedsNormalizing(this.cfg.voiceModel)) this.log.warn('配置里的模型版本不是有效值，已按 auto 处理', { voiceModel: this.cfg.voiceModel });
    if (normalizeVoiceModel(this.cfg.voiceModel) === 'v5turbo' && this.tier() === 'cpu') this.log.warn('CPU 档跑不动 V5 turbo，已按 V2 Pro Plus 运行', { voiceModel: this.cfg.voiceModel });
    // 旧 QQ 插件（qq-final / NapCat）是来拉 9880 的：接口没开就发不出语音，启动时说一声。
    if (this.cfg.channelVoice && !this.cfg.httpApi) this.log.warn('「其他渠道的语音交给对方插件」开着，但「开放本地语音接口」没开，旧 QQ 插件取不到音频', { httpPort: this.cfg.httpPort });
    // 启动即把当前音色的音频/台本镜像进配置字段：配置页一打开就能看到实际用的文件。
    this.settlePreset();
    // 启动兜底：推理模型与音色权重的版本对不上（手改配置 / 旧配置遗留）时说一声。
    const bad = this.modelMismatch();
    if (bad) this.log.warn('推理模型与音色权重的版本不一致，换音色时会自动对齐', { want: bad.want, current: bad.current });
    this.appliedTextLang = null;
    this.syncLanguage(true);
    this.langTimer = setInterval(() => this.syncLanguage(), 1000);
    if (this.launching && this.canStart()) void this.startServer().finally(() => { this.launching = false; });
    else this.launching = false;
    void this.startHttpApi();
  }

  /**
   * 推理服务意外退出。ROCm 档如果是「自动」选出来的，就把它写回 CPU：
   * A 卡第一次真机跑不能卡在一个起不来的档上。显式选了 ROCm 的不动，由面板如实报错。
   */
  private onServerExit(detail: string): void {
    this.announce(false, detail);
    if (!fallbackToCpu(this.cfg.tier, this.tier())) return;
    this.log.warn('ROCm 推理服务起不来，「自动」档回落到 CPU', { detail });
    this.lastError = detail;
    this.weightsFailed = '';
    this.opts.persist({ tier: 'cpu' });
  }

  /** 可用性变了才推事件;World 刚启动时第一次变为可用也报，因为前缀里写的是「启动中」。 */
  private announce(available: boolean, detail = ''): void {
    if (this.announced === available || !this.host || this.stopped) return;
    this.announced = available;
    const w = stateWords(this.cfg.promptLanguage);
    void this.host.pushEvent({
      type: STATE_EVENT,
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: available ? w.nowAvailable : w.nowUnavailable(detail),
    }, { trigger: 'piggyback' });
  }

  /**
   * 语音语言变了就推一条事件。配置页写入不会回调 World（框架没有配置变更钩子），
   * system 前缀又只在会话开始时组装，所以这里每秒对一次配置；启动时也推一次当前规则。
   */
  private syncLanguage(initial = false): void {
    const applied = this.appliedTextLang;
    this.appliedTextLang = this.cfg.textLang;
    if (applied === this.cfg.textLang || !this.host || this.stopped) return;
    const lang = languageWords(this.cfg.promptLanguage, this.cfg.textLang);
    const text = this.cfg.promptLanguage === 'zh'
      ? `${initial ? '当前语音语言' : '语音语言已切换为'}${lang.name}：${lang.rule}`
      : `${initial ? 'Current speech language' : 'The speech language is now'} ${lang.name}: ${lang.rule}`;
    void this.host.pushEvent({
      type: LANGUAGE_EVENT,
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text,
    }, { trigger: 'piggyback' });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.langTimer) clearInterval(this.langTimer);
    this.langTimer = undefined;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.sleeping = false;
    this.hush();
    this.player.close();
    this.runtime.cancel();
    this.weights.cancel();
    const api = this.httpTts;
    this.httpTts = null;
    this.httpApiIssue = null;
    if (api) await api.close();
    await this.server.stop();
  }

  /** 起「给其他插件取音频」的本地接口；没开或已经在跑就不做。 */
  private async startHttpApi(): Promise<void> {
    if (this.stopped || !this.cfg.httpApi || this.httpTts || this.httpApiStarting) return;
    this.httpApiStarting = true;
    const port = this.cfg.httpPort || 9880;
    try {
      this.httpTts = await startHttpTts({
        port,
        token: this.cfg.httpToken,
        deps: {
          synthesize: (job, signal) => this.synthesizeForApi(job, signal),
          sing: (lyrics, signal) => this.singViaSinger(lyrics, signal),
          post: (wav) => this.rvc.convert(wav),
          ready: () => this.apiReady(),
          stateText: () => this.stateFor(stateWords('en')),
          log: this.log,
        },
      });
      this.httpApiIssue = null;
      this.httpTokenInUse = (this.cfg.httpToken ?? '').trim();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException | null)?.code;
      this.httpApiIssue = { kind: code === 'EADDRINUSE' ? 'port' : 'failed', port, detail };
      this.log.warn('HTTP 语音接口没起来，其他插件取不到音频', { err: detail, port });
    } finally {
      this.httpApiStarting = false;
    }
  }

  /**
   * 开关、端口或令牌在面板上改了就立即照做：关掉就真的停，改端口/令牌就重绑。
   * 不轮询配置，避免端口被占时每秒重试刷日志。
   */
  private async reconcileHttpApi(): Promise<void> {
    if (this.stopped) return;
    const port = this.cfg.httpPort || 9880;
    const running = this.httpTts;
    if (!this.cfg.httpApi) {
      this.httpTts = null;
      this.httpApiIssue = null;
      this.httpTokenInUse = '';
      if (running) await running.close();
      return;
    }
    // 令牌只在绑定时读取，改了也要重绑才能生效。
    if (running && (running.port !== port || this.httpTokenInUse !== this.cfg.httpToken.trim())) {
      this.httpTts = null;
      await running.close();
    }
    if (!this.httpTts) await this.startHttpApi();
  }

  /** 面板读的真实状态：开关、配置端口、实际监听端口，以及没起来的原因。 */
  private httpApiState(): unknown {
    const port = this.cfg.httpPort || 9880;
    const issue = this.httpApiIssue;
    return {
      enabled: !!this.cfg.httpApi,
      port,
      listening: !!this.httpTts,
      listeningPort: this.httpTts?.port ?? null,
      issue,
      // 撞的是本插件自己填的推理地址（api_v2 默认也在 9880）时，提示要说得更具体。
      selfConflict: issue?.kind === 'port' && this.inferenceOnPort(port),
    };
  }

  /** 本机推理服务是否就在这个端口上（远端填了别的机器不算）。 */
  private inferenceOnPort(port: number): boolean {
    const backend = this.backend();
    const target = backend.kind === 'remote' ? backend.url : this.server.state().url;
    if (!target) return false;
    try {
      const u = new URL(target);
      const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '0.0.0.0' || u.hostname === '::1';
      return loopback && Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === port;
    } catch {
      return false;
    }
  }

  /** 接口此刻能不能接活：云端看密钥/音色；本地看服务或冷启动能力。 */
  private apiReady(): boolean {
    if (this.engine() === 'cloud') return this.cloudReady();
    return !!this.url() || this.canStart();
  }

  /**
   * HTTP 接口要的一句音频：用点名或当前的音色合成，只回 WAV —— 不播放、不进播放队列。
   * 服务没起（冷启动）或睡着了都先拉起来；失败抛错，由接口回 502。
   */
  private async synthesizeForApi(job: TtsJob, signal: AbortSignal): Promise<SynthResult> {
    // 云端：音色由 cloudVoiceId 决定，调用方点名的本地音色/参考音频不参与。
    if (this.engine() === 'cloud') {
      if (!this.cloudReady()) throw new Error(`cloud not ready: ${this.cloudIssue()}`);
      const t0 = Date.now();
      const spoken = await this.prepareSpeechText(job.text, this.cfg.textLang);
      const audio = await this.synthCloudLine(spoken, signal);
      return { wav: audio.wav, firstMs: Date.now() - t0, totalMs: Date.now() - t0 };
    }
    // `voice` 是调用方明确点名；`voice_desc`（VoxCPM 形状）只是描述，能对上已知音色才采用。
    const voice = this.voiceByName(job.voice)
      ?? (job.voiceHint ? this.voiceByName(job.voiceHint, false) : null)
      ?? this.voice();
    if (!voice) throw new Error(this.voiceIssue ?? 'no reference audio is set');
    // 「其他插件来取音频」不该挑时间：没起就起，睡着就叫醒。以前只在休眠时唤醒，
    // 进程刚起来、引擎还没起过的冷启动场景（autoStart 关着）会一直回 503。
    if (!this.url() && this.canStart()) {
      this.sleeping = false;
      this.log.info('语音接口来人取音频，这就把推理服务拉起来');
      await this.startServer();
    }
    const url = this.url();
    if (!url) throw new Error(`voice not ready: ${this.stateFor(stateWords('en'))}`);
    const gain = this.backend().kind === 'remote' ? 1 : OUTPUT_GAIN[this.version()];
    const spoken = await this.prepareSpeechText(job.text, this.cfg.textLang);
    const req = this.request(spoken, voice);
    const chunks: Buffer[] = [];
    let rate = 0;
    // 从收到请求算起：冷启动拉服务也算进去，调用方要的就是「等多久才有声音」。
    const started = Date.now();
    let firstMs: number | undefined;
    const asked: SynthRequest = {
      ...req,
      ...(typeof job.speed === 'number' && job.speed > 0 ? { speed: job.speed } : {}),
      ...(typeof job.seed === 'number' && job.seed >= 0 ? { seed: job.seed } : {}),
    };
    for await (const c of synthesize(url, asked, signal)) {
      if (firstMs === undefined) firstMs = Date.now() - started;
      rate = c.sampleRate;
      chunks.push(applyGain(c.pcm, gain));
    }
    if (!chunks.length) throw new Error('synthesized nothing');
    return { wav: wavBytes(Buffer.concat(chunks), rate), firstMs, totalMs: Date.now() - started };
  }

  /**
   * 把一句歌词交给 DiffSinger 唱歌插件（默认 127.0.0.1:9882），只回 WAV。
   * 没配地址、插件没装、引擎没就绪都直接抛错，由 HTTP 接口退回普通语音。
   */
  private async singViaSinger(lyrics: string, signal: AbortSignal): Promise<Buffer> {
    const base = (this.cfg.singUrl ?? '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('sing endpoint is not configured');
    const res = await fetch(`${base}/sing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lyrics }),
      signal,
    });
    if (!res.ok) {
      const why = await res.text().catch(() => '');
      throw new Error(`sing HTTP ${res.status}${why ? `: ${why.slice(0, 160)}` : ''}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    if (!audio.length) throw new Error('sing returned empty audio');
    return audio;
  }

  /** 接口点名的音色：自定义音色的 id 或名字、预设 id（xll/dfy/female/male）；认不出返回 null。
   *  `warn` 为 false 用于 `voice_desc` 这种描述性文字：对不上就安静地用当前音色。 */
  private voiceByName(name?: string, warn = true): { audio: string; text: string } | null {
    const want = (name ?? '').trim().toLowerCase();
    if (!want) return null;
    const custom = (this.cfg.voices ?? []).find((v) => v.id === name || v.name.toLowerCase() === want);
    if (custom?.audio) {
      if (!existsSync(custom.audio)) {
        if (warn) this.log.warn('HTTP 语音接口点名的自定义音色缺参考音频，用当前音色', { voice: name });
      } else if (!referenceIssue(custom.audio)) return { audio: custom.audio, text: custom.text };
    }
    const preset = VOICE_PRESETS.find((p) => p === want);
    if (preset) {
      const f = presetFiles(preset, this.cfg.textLang);
      if (existsSync(f.audio) && existsSync(f.text)) return { audio: f.audio, text: readText(f.text) };
    }
    if (warn) this.log.warn('HTTP 语音接口点名的音色认不出，用当前音色', { voice: name });
    return null;
  }

  /** 本机服务要的东西都在。 */
  private canStart(): boolean {
    const b = this.backend();
    if (b.kind === 'remote') return false;
    if (b.kind === 'own') return isRuntimeDir(b.dir);
    return this.runtime.status().phase === 'ready' && this.weights.baseReady();
  }

  /** 启动本机服务并预热；同一时间只跑一次（休眠唤醒、面板按钮、World 启动都可能触发）。 */
  private startServer(): Promise<void> {
    if (this.startingServer) return this.startingServer;
    this.startingServer = this.launchServer().finally(() => { this.startingServer = null; });
    return this.startingServer;
  }

  private async launchServer(): Promise<void> {
    const b = this.backend();
    if (b.kind === 'remote' || this.stopped) return;
    this.sleeping = false;
    this.warmed = false;
    const trained = this.trained().weights;
    await this.server.start({
      runtimeDir: b.dir,
      weightsDir: b.kind === 'managed' ? this.weights.dir() : null,
      tier: this.tier(),
      version: this.version(),
      trained,
      dataDir: this.opts.dataDir,
      patchRuntime: b.kind === 'managed',
      gfx: this.amd.kind === 'supported' ? this.amd.gpu.gfx : null,
    });
    // yaml 里已经是这组权重，启动即加载，不必再调一遍换权重的接口。
    this.appliedVersion = this.version();
    this.appliedWeights = this.weightsSignature();
    this.appliedTarget = trained ?? this.baseTarget();
    this.weightsFailed = '';
    await this.warmUp();
    this.armIdle();
  }

  private async warmUp(): Promise<void> {
    // 云端没有本机服务要预热。
    if (this.engine() === 'cloud') { this.warmed = true; return; }
    const st = this.server.state();
    const voice = this.voice();
    if (st.phase !== 'ready' || !st.url) return;
    if (!voice) { this.warmed = true; return; }
    this.warming = true;
    try {
      const lang = this.cfg.textLang;
      for await (const _ of synthesize(st.url, this.request(WARMUP_TEXT[lang], voice, lang))) { /* 只为加载，丢掉音频 */ }
    } catch (err) {
      this.log.warn('GPT-SoVITS 预热失败', { err: String(err) });
    } finally {
      this.warming = false;
      this.warmed = true;
    }
    if (this.url()) this.announce(true);
  }

  private async restartServer(): Promise<void> {
    this.hush();
    this.sleeping = false;
    await this.server.stop();
    if (this.canStart()) await this.startServer();
  }

  /** 先装运行时，再装权重，都好了就启动服务。 */
  private async install(): Promise<void> {
    if (this.backend().kind !== 'managed') return;
    await this.runtime.install();
    if (this.runtime.status().phase !== 'ready') return;
    await this.weights.install();
    if (this.weights.status().phase !== 'ready') return;
    await this.restartServer();
  }

  private saveVoice(name: string, base64: string, text: string): void {
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > VOICE_MAX_BYTES) throw new Error(`参考音频超过 ${VOICE_MAX_BYTES / 1048576} MB`);
    if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('参考音频要是 WAV 文件');
    const dir = join(this.opts.dataDir, 'voices');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${basename(name, extname(name)).replace(/[^\w一-鿿-]+/g, '_') || 'voice'}.wav`);
    writeFileSync(file, bytes);
    this.opts.persist({ voice: { audio: file, text: text.trim() } });
  }

  /**
   * 添加自定义音色：名称、参考音频、台本必填；权重可选但必须成对。
   * 校验不过直接抛错（面板把原因显示出来），通过才写文件与配置，并立刻选用它。
   */
  private addCustomVoice(args: unknown[]): PanelState {
    const [name, audioName, audioB64, text, gpt, sovits] = args.map((a) => String(a ?? ''));
    const bytes = Buffer.from(audioB64, 'base64');
    if (bytes.length > VOICE_MAX_BYTES) throw new Error(`参考音频超过 ${VOICE_MAX_BYTES / 1048576} MB`);
    if (bytes.length && (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')) {
      throw new Error('参考音频要是 WAV 文件。');
    }
    const tmp = join(this.opts.dataDir, 'voices', `~probe-${process.pid}.wav`);
    mkdirSync(join(this.opts.dataDir, 'voices'), { recursive: true });
    if (bytes.length) writeFileSync(tmp, bytes);
    try {
      const seconds = bytes.length ? readSeconds(tmp) : null;
      const problems = validateCustomVoice({ name, text, gpt, sovits, seconds });
      if (!bytes.length) problems.unshift('请选择参考音频文件（3–10 秒的 WAV）。');
      if (problems.length) throw new Error(problems.join(' '));
      const weights = { gpt: gpt.trim(), sovits: sovits.trim() };
      if (weights.gpt) {
        // 填了就校验文件与版本头；和当前推理档不一致也允许保存，换这个音色时会自动对齐。
        const result = checkWeights(weights);
        if (result.problem || !result.weights) throw new Error(`权重用不上：${result.problem}`);
      }
      const id = newCustomVoiceId();
      const file = join(this.opts.dataDir, 'voices', `${id}.wav`);
      writeFileSync(file, bytes);
      const voice: CustomVoice = { id, name: name.trim(), audio: file, text: text.trim(), weights: weights.gpt ? weights : emptyWeights() };
      this.opts.persist({ voices: [...(this.cfg.voices ?? []), voice], voice: { preset: id, audio: file, text: voice.text } });
      this.log.info('已添加自定义音色', { id, name: voice.name, withWeights: !!weights.gpt });
      const align = this.alignModel(voice.weights);
      return { ...this.panelState(), notice: this.alignNotice(align, null) };
    } finally {
      if (bytes.length) rmSync(tmp, { force: true });
    }
  }

  /**
   * 编辑已有音色：名称、台本、权重可以直接改，参考音频不选就保留原来的;
   * 原本没有参考音频（从下拉新建的未命名音色）时必须补上。
   */
  private updateCustomVoice(args: unknown[]): PanelState {
    const [id, name, audioB64, text, gpt, sovits] = args.map((a) => String(a ?? ''));
    const voices = this.cfg.voices ?? [];
    const target = voices.find((v) => v.id === id);
    if (!target) throw new Error('找不到这个自定义音色。');
    const bytes = Buffer.from(audioB64, 'base64');
    if (bytes.length > VOICE_MAX_BYTES) throw new Error(`参考音频超过 ${VOICE_MAX_BYTES / 1048576} MB`);
    if (bytes.length && (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')) {
      throw new Error('参考音频要是 WAV 文件。');
    }
    const probe = join(this.opts.dataDir, 'voices', `~probe-${process.pid}.wav`);
    mkdirSync(join(this.opts.dataDir, 'voices'), { recursive: true });
    if (bytes.length) writeFileSync(probe, bytes);
    try {
      const seconds = bytes.length ? readSeconds(probe) : target.audio ? readSeconds(target.audio) : null;
      const problems = validateCustomVoice({ name: name || target.name, text, gpt, sovits, seconds });
      if (!bytes.length && !target.audio) problems.unshift('请选择参考音频文件（3–10 秒的 WAV）。');
      if (problems.length) throw new Error(problems.join(' '));
      const weights = { gpt: gpt.trim(), sovits: sovits.trim() };
      let weightVersion: ModelVersion | null = null;
      if (weights.gpt) {
        // 只校验文件与版本头；版本和当前推理档不一致也不再拦保存。
        const result = checkWeights(weights);
        if (result.problem || !result.weights) throw new Error(`权重用不上：${result.problem}`);
        weightVersion = result.version ?? null;
      }
      const audio = bytes.length ? (writeFileSync(join(this.opts.dataDir, 'voices', `${id}.wav`), bytes), join(this.opts.dataDir, 'voices', `${id}.wav`)) : target.audio;
      const updated: CustomVoice = { id, name: (name || target.name).trim(), audio, text: text.trim(), weights: weights.gpt ? weights : emptyWeights() };
      const next = voices.map((v) => (v.id === id ? updated : v));
      const selected = this.cfg.voice.preset === id;
      this.opts.persist({
        voices: next,
        ...(selected ? { voice: { preset: id, audio: updated.audio, text: updated.text } } : {}),
      });
      this.log.info('已更新自定义音色', { id, name: updated.name, newAudio: !!bytes.length, withWeights: !!weights.gpt });
      // 正在用的音色：保存即按新权重的版本对齐推理模型；否则只提示版本差距，不动全局设置。
      const align = selected ? this.alignModel(updated.weights) : null;
      return { ...this.panelState(), notice: this.alignNotice(align, selected ? null : weightVersion) };
    } finally {
      if (bytes.length) rmSync(probe, { force: true });
    }
  }

  private removeCustomVoice(id: string): void {
    const voices = this.cfg.voices ?? [];
    const target = voices.find((v) => v.id === id);
    if (!target) return;
    this.opts.persist({ voices: voices.filter((v) => v.id !== id), ...(this.cfg.voice.preset === id ? { voice: { preset: DEFAULT_PRESET, audio: '', text: '' } } : {}) });
    if (target.audio) rmSync(target.audio, { force: true });
  }
  // ---------------------------------------------------------------- WebUI

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = panelText(language);
    this.uiLanguage = language;
    const groups = configGroups(language);
    /** 配置分类页：标题/说明直接取配置组的 schema，字段读写走框架配置面。 */
    const cfgPanel = (id: string, group: string, methods: string[] = ['config']) => {
      const schema = (groups.find((g) => g.id === group)?.schema ?? {}) as { title?: string; description?: string };
      return { id, title: schema.title ?? id, description: schema.description ?? '', getMethods: methods };
    };
    const st = this.server.state();
    const remote = this.backend().kind === 'remote';
    // 启动兜底：本地模式下推理模型与音色权重版本不一致时，灯泡提示直接说出来。
    const bad = this.engineSelected() === 'cloud' ? null : this.modelMismatch();
    const lamp: WorldLamp = remote
      ? { label: t.lamp, state: 'online', hint: t.remote }
      : {
        label: t.lamp,
        state: st.phase === 'ready' && this.warmed ? 'online' : st.phase === 'starting' || this.warming ? 'loading' : st.phase === 'error' ? 'error' : 'offline',
        hint: bad ? t.modelMismatchHint : this.sleeping ? t.asleep : st.detail ?? undefined,
      };
    return {
      label: t.label,
      lamps: [lamp],
      panels: [
        { id: 'voice', title: t.panel, description: t.panelHint, getMethods: ['state'] },
        cfgPanel('cfg-output', `world:${GPT_SOVITS_ID}:output`),
        cfgPanel('cfg-link', `world:${GPT_SOVITS_ID}:link`, ['config', 'qqGuide', 'writeQqVoice', 'httpApiState']),
        cfgPanel('cfg-service', `world:${GPT_SOVITS_ID}:service`),
        { id: 'voices', title: t.voicesPanel, description: t.voicesPanelHint, getMethods: ['state'] },
        { id: 'train', title: t.trainPanel, description: t.trainPanelHint, getMethods: ['trainerState'] },
      ],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
      promptDocs: [{
        key: `worlds.${GPT_SOVITS_ID}.envPrompt`,
        title: `${t.label} · ${language === 'zh' || language === 'zh-Hant' ? '环境提示词' : 'environment prompt'}`,
        description: language === 'zh' || language === 'zh-Hant' ? '要求 bot 每次 pet_say 前先调用 sovits_speak 的那一段。' : 'The passage asking the bot to call sovits_speak before each pet_say.',
        path: ENV_PROMPT_FILES[this.cfg.promptLanguage],
        role: 'envPrompt',
        vars: [
          { name: 'sovits.state', description: language === 'zh' || language === 'zh-Hant' ? '语音此刻的状态。' : 'The voice state at this moment.' },
          { name: 'sovits.share', description: language === 'zh' || language === 'zh-Hant' ? '开着「交给其他插件」时告诉 bot 怎么把同一句发出去；没开时为空。' : 'How to hand the same line to another plugin while the attachment mode is on; empty when it is off.' },
          { name: 'sovits.channel', description: language === 'zh' || language === 'zh-Hant' ? '开着「其他渠道的语音交给对方插件」时提醒 bot 那些渠道不要自己念；没开时为空。' : 'Reminds the bot not to speak for channels whose plugin handles voice itself; empty when that option is off.' },
        ],
      }],
    };
  }

  /** 配置分类页的数据面：返回某组字段与当前值；写回由框架 `ctx.setConfig` 处理。 */
  private configSchema(groupId: string, keyPrefix: string, topOnly: boolean): unknown {
    const language = this.uiLanguage;
    const group = configGroups(language).find((g) => g.id === groupId);
    if (!group?.schema) return { error: `unknown group ${groupId}` };
    const props = (group.schema as { properties?: Record<string, any> }).properties ?? {};
    const valuePrefix = `worlds.${GPT_SOVITS_ID}.`;
    const optionsFor = (kind: unknown): Array<{ value: string; label: string }> | undefined => panelOptionsFor(kind, language);
    const resolve = (key: string): unknown => {
      if (!key.startsWith(valuePrefix)) return undefined;
      let cur: any = this.cfg;
      for (const part of key.slice(valuePrefix.length).split('.')) {
        if (cur == null) return undefined;
        cur = cur[part];
      }
      return cur;
    };
    const out: Array<Record<string, unknown>> = [];
    const values: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(props) as Array<[string, any]>) {
      if (keyPrefix && !key.startsWith(keyPrefix)) continue;
      if (topOnly && key.slice(valuePrefix.length).split('.').length !== 1) continue;
      out.push({
        key,
        type: def.type || 'string',
        title: def.title || key.split('.').pop(),
        description: def.description,
        options: optionsFor(def['x-options']),
        path: def['x-path'],
        minimum: def.minimum,
        maximum: def.maximum,
        multipleOf: def.multipleOf,
        xHot: def['x-hot'] === true,
      });
      // 手填时代存过 `V2 Pro Plus` 这类显示名：面板按归一后的 key 显示，下拉才能选中。
      const current = resolve(key);
      values[key] = key.endsWith('.voiceModel') ? normalizeVoiceModel(current) : current;
    }
    return { groupId, title: (group.schema as any).title, description: (group.schema as any).description, properties: out, values };
  }

  /** 联动页「检测」：看本机 RVC 插件此刻的健康状态。 */
  private rvcProbe(): Promise<RvcProbe> {
    return this.rvc.probe();
  }

  /** 联动页「试听」：用当前音色合成一句，再过一遍 RVC，回 WAV 给浏览器播放。 */
  private async rvcTest(said: string): Promise<unknown> {
    const zh = this.uiLanguage === 'zh' || this.uiLanguage === 'zh-Hant';
    const text = said.trim() || (zh ? '你好，这是变声试听。' : 'Hello, this is the converted voice.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    timer.unref();
    try {
      const { wav } = await this.synthesizeForApi({ text }, ctrl.signal);
      const out = await this.rvc.convert(wav);
      return { $binary: { mime: 'audio/wav', base64: out.toString('base64') } };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 联动页「一键写入」：把端点 / 超时 / 变调 / 索引率写进配置并启用。 */
  private rvcWrite(asked: unknown): unknown {
    const o = (asked && typeof asked === 'object' ? asked : {}) as Record<string, unknown>;
    const num = (v: unknown, fallback: number, min: number, max: number): number => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    const cur = this.rvc.config();
    const endpoint = typeof o.endpoint === 'string' && o.endpoint.trim() ? o.endpoint.trim().replace(/\/+$/, '') : cur.endpoint;
    const rvc = {
      enabled: o.enabled === undefined ? true : o.enabled === true,
      endpoint,
      token: typeof o.token === 'string' ? o.token.trim() : cur.token,
      timeoutMs: Math.round(num(o.timeoutMs, cur.timeoutMs, RVC_TIMEOUT_MIN, RVC_TIMEOUT_MAX)),
      pitch: Math.round(num(o.pitch, cur.pitch, -24, 24)),
      indexRate: num(o.indexRate, cur.indexRate, RVC_INDEX_MIN, RVC_INDEX_MAX),
      protect: num(o.protect, cur.protect, RVC_PROTECT_MIN, RVC_PROTECT_MAX),
    };
    this.opts.persist({ rvc });
    return { ok: true, rvc };
  }

  /** QQ 语音对接：给面板生成要填的值，并读出 QQ 插件当前配置做对照。 */
  private qqGuide(): unknown {
    const zh = this.uiLanguage === 'zh' || this.uiLanguage === 'zh-Hant';
    const port = this.cfg.httpPort || 9880;
    const voice = this.cfg.voice.preset || DEFAULT_PRESET;
    const path = join(this.opts.botDir, 'config.json');
    let qq: any = null;
    try { qq = JSON.parse(readFileSync(path, 'utf8'))?.worlds?.qqbot ?? null; } catch { /* 没装或读不到就按未安装处理 */ }
    const values = [
      { label: zh ? '实现方式' : 'Provider', value: 'local' },
      { label: zh ? '发语音' : 'Send voice', value: 'true' },
      { label: zh ? '语音模型网址' : 'Voice base URL', value: `http://127.0.0.1:${port}` },
      { label: zh ? '音色' : 'Voice', value: voice },
      { label: zh ? 'TTS 模型名' : 'TTS model', value: 'tts-1' },
      { label: zh ? 'TTS 请求超时(秒)' : 'TTS timeout (s)', value: '120' },
    ];
    return {
      installed: !!qq,
      httpApi: !!this.cfg.httpApi,
      port,
      voice,
      tokenSet: !!this.cfg.httpToken,
      path,
      values,
      current: qq?.voice
        ? { enabled: !!qq.voice.enabled, provider: qq.voice.provider ?? '', tts: !!qq.voice.tts, voiceBaseUrl: qq.voice.voiceBaseUrl ?? '', voiceVoice: qq.voice.voiceVoice ?? '' }
        : null,
    };
  }

  /** 一键把本地语音接口的参数写进 QQ 插件配置（改完需重启 Coopanion 生效）。 */
  private writeQqVoice(): unknown {
    const port = this.cfg.httpPort || 9880;
    // 先把自己的接口开关写进配置（HTTP 服务本身要重启 World 才挂载，这里只改值）。
    if (!this.cfg.httpApi) this.opts.persist({ httpApi: true });
    if (!this.cfg.httpPort) this.opts.persist({ httpPort: port });
    const path = join(this.opts.botDir, 'config.json');
    let raw: any;
    try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`读不到部署配置：${path}`); }
    const qq = raw?.worlds?.qqbot;
    if (!qq) throw new Error('没有找到 QQ 插件配置（worlds.qqbot），请先安装并启用 cortico-world-qq-final。');
    qq.voice = { ...(qq.voice ?? {}) };
    qq.voice.enabled = true;
    qq.voice.provider = 'local';
    qq.voice.tts = true;
    qq.voice.voiceBaseUrl = `http://127.0.0.1:${port}`;
    qq.voice.voiceVoice = this.cfg.voice.preset || DEFAULT_PRESET;
    qq.voice.voiceTtsModel = 'tts-1';
    qq.voice.voiceTimeout = 120;
    const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(path, backup);
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
    return { ok: true, path, backup, port, voice: qq.voice.voiceVoice, tokenSet: !!this.cfg.httpToken };
  }

  /** 面板写配置：只接受已声明配置组里的键，按 schema 类型校验后写回。 */
  private setConfigValue(key: string, raw: unknown): unknown {
    const group = configGroups(this.uiLanguage).find((g) => key in ((g.schema as { properties?: Record<string, any> }).properties ?? {}));
    if (!group) throw new Error(`未知配置项：${key}`);
    const def = (group.schema as any).properties[key] as { type?: string; minimum?: number; maximum?: number };
    let value: string | number | boolean;
    if (def.type === 'boolean') {
      if (typeof raw !== 'boolean') throw new Error(`${key} 需要布尔值`);
      value = raw;
    } else if (def.type === 'number' || def.type === 'integer') {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${key} 需要数字`);
      if (def.type === 'integer' && !Number.isInteger(n)) throw new Error(`${key} 需要整数`);
      if (def.minimum !== undefined && n < def.minimum) throw new Error(`${key} 最小 ${def.minimum}`);
      if (def.maximum !== undefined && n > def.maximum) throw new Error(`${key} 最大 ${def.maximum}`);
      value = n;
    } else {
      value = String(raw ?? '');
    }
    const prefix = `worlds.${GPT_SOVITS_ID}.`;
    if (!key.startsWith(prefix)) throw new Error(`未知配置项：${key}`);
    const parts = key.slice(prefix.length).split('.');
    const patch: Record<string, any> = {};
    let cur = patch;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    this.opts.persist(patch as DeepPartial<GptSovitsConfigSection>);
    // 接口开关、端口与令牌即时生效：关掉就停、改端口/令牌就重绑（端口被占时由面板说原因）。
    if (key === `${prefix}httpApi` || key === `${prefix}httpPort` || key === `${prefix}httpToken`) void this.reconcileHttpApi();
    return { ok: true, key, value };
  }

  /** 面板数据面。 */
  async invoke(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (method === 'setConfigValue') return this.setConfigValue(String(args[0] ?? ''), args[1]);
    if (method === 'qqGuide') return this.qqGuide();
    if (method === 'writeQqVoice') return this.writeQqVoice();
    if (method === 'rvcProbe') return this.rvcProbe();
    if (method === 'rvcWrite') return this.rvcWrite(args[0]);
    if (method === 'rvcTest') return this.rvcTest(String(args[0] ?? ''));
    if (method === 'httpApiState') return this.httpApiState();
    if (method === 'config') {
      return this.configSchema(String(args[0] ?? ''), String(args[1] ?? ''), args[2] === true);
    }
    // 「我已经有 GPT-SoVITS 了」：只读检查目录，挑一个用；也有「填地址连已有服务」的试连。
    if (method === 'findFolders') return findFolders();
    if (method === 'inspectFolder') return inspectFolder(String(args[0] ?? ''));
    if (method === 'applyFolder') return this.applyFolder(args[0], (args[1] ?? {}) as FolderPick);
    if (method === 'probeService') return this.useService(String(args[0] ?? ''));
    if (method === 'useManaged') return this.useManagedRuntime();
    if (method === 'trainerState') return this.trainerGate().state();
    if (method === 'installTrainer') { const m = this.trainerGate(); void m.installDeps(); return m.state(); }
    if (method === 'downloadTrainerAssets') { const m = this.trainerGate(); void m.downloadAssets(); return m.state(); }
    if (method === 'startTrainer') { const m = this.trainerGate(); void m.start({ stopInference: args[0] === true }); return m.state(); }
    if (method === 'stopTrainer') { const m = this.trainerGate(); await m.stop(); return m.state(); }
    if (panel === 'voices') {
      switch (method) {
        case 'state': return this.panelState();
        case 'add': { const s = this.addCustomVoice(args); this.syncWeightsAfterVoiceChange(); return s; }
        case 'update': { const s = this.updateCustomVoice(args); this.syncWeightsAfterVoiceChange(); return s; }
        case 'remove': this.removeCustomVoice(String(args[0] ?? '')); this.syncWeightsAfterVoiceChange(); return this.panelState();
        case 'rename': {
          const [id, name] = [String(args[0] ?? ''), String(args[1] ?? '')];
          if (!name.trim()) throw new Error('音色名称不能为空。');
          const voices = this.cfg.voices ?? [];
          if (!voices.some((v) => v.id === id)) throw new Error('找不到这个自定义音色。');
          this.opts.persist({ voices: voices.map((v) => (v.id === id ? { ...v, name: name.trim() } : v)) });
          return this.panelState();
        }
        case 'use': {
          const id = String(args[0] ?? '');
          const cv = selectedCustomVoice(this.cfg.voices ?? [], id);
          // 预设音色（xll / dfy / female / male）也能从这里直接选中，不必只走配置页。
          if (id && !cv && !isPreset(id)) throw new Error('找不到这个自定义音色。');
          this.opts.persist({ voice: { preset: id || DEFAULT_PRESET, name: cv?.name ?? '', audio: cv?.audio ?? '', text: cv?.text ?? '' } });
          // 换成自带权重的音色时，推理模型跟着对齐，并在回执里明确告诉用户。
          const align = this.alignModel(cv?.weights);
          this.syncWeightsAfterVoiceChange();
          return { ...this.panelState(), notice: this.alignNotice(align, null) };
        }
        // 云端设置的入口在「音色」页，实现与「语音」页同一套（转发过去，免得两份逻辑）。
        case 'setEngine':
        case 'saveCloudKey':
        case 'clearCloudKey':
        case 'setCloudField':
        case 'setCloudVoices':
        case 'refreshCloudVoices':
        case 'useCloudVoice':
          return this.invoke('voice', method, args);
        default: throw new Error(`未知方法 ${method}`);
      }
    }
    if (panel !== 'voice') throw new Error(`未知面板 ${panel}`);
    switch (method) {
      case 'state': return this.panelState();
      case 'install': void this.install(); return this.panelState();
      case 'cancel': this.runtime.cancel(); this.weights.cancel(); return this.panelState();
      case 'start': void this.startServer(); return this.panelState();
      case 'stop': this.hush(); await this.server.stop(); return this.panelState();
      case 'restart': void this.restartServer(); return this.panelState();
      case 'test': return this.speak(String(args[0] ?? ''));
      case 'hush': this.hush(); return this.panelState();
      case 'usage': return this.usage(args[0] === 'refresh');
      case 'setEngine': {
        const engine = args[0] === 'cloud' ? 'cloud' : 'local';
        // 换引擎后，上一档的失败原因不该当成这一档的；清掉，等下一次合成再写。
        if (this.engine() !== engine) this.lastError = null;
        this.opts.persist({ ttsEngine: engine });
        // 切回本地且服务没起时，按 autoStart 拉起（云端模式从不启动本机服务）。
        if (engine === 'local' && this.cfg.autoStart && !this.url() && this.canStart() && !this.launching) {
          void this.startServer().finally(() => { this.launching = false; });
        }
        return this.panelState();
      }
      case 'saveCloudKey': {
        const mask = this.cloudKeys.save(String(args[0] ?? ''));
        this.opts.persist({ cloudKeyMask: mask });
        this.log.info('云端密钥已保存（加密存储，明文不回显）', { mask });
        return this.panelState();
      }
      case 'clearCloudKey':
        this.cloudKeys.clear();
        this.opts.persist({ cloudKeyMask: '' });
        return this.panelState();
      case 'setCloudField': {
        const key = String(args[0] ?? '');
        const allowed = ['cloudProvider', 'cloudBaseUrl', 'cloudModel', 'cloudVoiceId', 'cloudTimeoutMs', 'cloudRegion', 'cloudGroupId', 'cloudAppId', 'cloudCluster'] as const;
        if (!(allowed as readonly string[]).includes(key)) throw new Error(`不允许写这个字段：${key}`);
        // 换厂商：填好该家的默认地址/模型/音色，附加项（区域）保留用户已填的值。
        if (key === 'cloudProvider') {
          const spec = cloudProvider(String(args[1] ?? ''));
          this.lastError = null;
          this.opts.persist({
            cloudProvider: providerIdForStore(spec),
            cloudBaseUrl: spec.baseUrl,
            cloudModel: spec.model,
            cloudVoiceId: spec.voice,
            // 各家的音色 id 不通用：换厂商时清空面板清单，免得把上一家的 id 发给这一家。
            cloudVoices: [],
          });
          return this.panelState();
        }
        const value = key === 'cloudTimeoutMs'
          ? Math.max(5000, Math.min(300000, Number(args[1]) || 60_000))
          : String(args[1] ?? '').trim();
        this.opts.persist({ [key]: value } as Partial<GptSovitsConfigSection>);
        // 改了地址/模型/音色/区域之后，上一次的失败信息多半已经过期，别让红字一直挂着吓人。
        if (key !== 'cloudGroupId') this.lastError = null;
        return this.panelState();
      }
      case 'setCloudVoices': {
        const raw = Array.isArray(args[0]) ? args[0] as Array<Record<string, unknown>> : [];
        const voices = raw
          .map((v) => ({ id: String(v.id ?? '').trim(), name: String(v.name ?? '').trim() }))
          .filter((v) => v.id)
          .slice(0, 50);
        const keep = voices.some((v) => v.id === this.cfg.cloudVoiceId);
        this.opts.persist({ cloudVoices: voices, ...(keep ? {} : { cloudVoiceId: voices[0]?.id ?? '' }) });
        return this.panelState();
      }
      case 'refreshCloudVoices': return this.refreshCloudVoices(String(args[0] ?? ''));
      case 'useCloudVoice': {
        const id = String(args[0] ?? '').trim();
        if (!id) throw new Error('音色 id 不能为空。');
        const name = String(args[1] ?? '').trim() || id;
        // 点「使用」就写入并选中：清单里没有的 id（例如拉取后手工补的）也一并收进清单，
        // 这样「音色」下拉立刻能显示它，用户不用再手填一遍。
        const voices = [...(this.cfg.cloudVoices ?? [])];
        if (!voices.some((v) => v.id === id)) voices.push({ id, name });
        this.lastError = null;
        this.opts.persist({ cloudVoices: voices.slice(0, 50), cloudVoiceId: id });
        return { ...this.panelState(), notice: { code: 'cloudVoiceSelected', name } };
      }
      case 'setVoice': this.saveVoice(String(args[0] ?? ''), String(args[1] ?? ''), String(args[2] ?? '')); this.syncWeightsAfterVoiceChange(); return this.panelState();
      case 'resetVoice': this.opts.persist({ voice: { preset: DEFAULT_PRESET, audio: '', text: '' } }); this.syncWeightsAfterVoiceChange(); return this.panelState();
      case 'addVoice': { const s = this.addCustomVoice(args); this.syncWeightsAfterVoiceChange(); return s; }
      case 'updateVoice': { const s = this.updateCustomVoice(args); this.syncWeightsAfterVoiceChange(); return s; }
      case 'renameVoice': {
        const [id, name] = [String(args[0] ?? ''), String(args[1] ?? '')];
        if (!name.trim()) throw new Error('音色名称不能为空。');
        const voices = this.cfg.voices ?? [];
        const target = voices.find((v) => v.id === id);
        if (!target) throw new Error('找不到这个自定义音色。');
        this.opts.persist({ voices: voices.map((v) => (v.id === id ? { ...v, name: name.trim() } : v)) });
        return this.panelState();
      }
      case 'removeVoice': this.removeCustomVoice(String(args[0] ?? '')); this.syncWeightsAfterVoiceChange(); return this.panelState();
      case 'uninstall': return this.uninstall(String(args[0] ?? ''));
      case 'useVoice': {
        const id = String(args[0] ?? '');
        if (id && !selectedCustomVoice(this.cfg.voices ?? [], id)) throw new Error('找不到这个自定义音色。');
        const cv = id ? selectedCustomVoice(this.cfg.voices ?? [], id) : null;
        this.opts.persist({ voice: { preset: id || DEFAULT_PRESET, audio: cv?.audio ?? '', text: cv?.text ?? '' } });
        const align = this.alignModel(cv?.weights);
        this.syncWeightsAfterVoiceChange();
        return { ...this.panelState(), notice: this.alignNotice(align, null) };
      }
      default: throw new Error(`未知方法 ${method}`);
    }
  }

  panelState(): PanelState {
    this.syncLanguage();
    this.settlePreset();
    const b = this.backend();
    const voice = this.voice();
    return {
      backend: b.kind,
      engine: this.engineSelected(),
      setup: {
        mode: b.kind,
        runtimeDir: this.cfg.runtimeDir,
        serverUrl: this.cfg.serverUrl,
        localService: !this.cfg.serverUrl.trim() || isLocalService(this.cfg.serverUrl),
        ready: b.kind === 'remote' ? !!this.cfg.serverUrl.trim()
          : b.kind === 'own' ? isRuntimeDir(b.dir) && existsSync(join(b.dir, 'tools', 'portable_runtime.py'))
            : this.runtime.status().phase === 'ready',
      },
      mismatch: this.modelMismatch() ?? undefined,
      cloud: {
        baseUrl: this.cfg.cloudBaseUrl,
        model: this.cfg.cloudModel,
        voiceId: this.cloudVoiceId(),
        voices: this.cloudVoiceOptions(),
        autoVoices: this.usingDefaultCloudVoices(),
        presetMismatch: !isOpenAiBase(this.cfg.cloudBaseUrl) && OPENAI_VOICES.some((v) => v.id === this.cloudVoiceId()),
        keyMask: this.cfg.cloudKeyMask || '',
        keySet: this.cloudKeys.has(),
        timeoutMs: this.cfg.cloudTimeoutMs,
        ready: this.cloudReady(),
        provider: this.cloudSpec().id,
        providerFallback: hiddenCloudProviderId(this.cfg.cloudProvider ?? ''),
        region: this.cfg.cloudRegion ?? '',
        groupId: this.cfg.cloudGroupId ?? '',
        appId: this.cfg.cloudAppId ?? '',
        cluster: this.cfg.cloudCluster ?? '',
        canListVoices: this.cloudSpec().voiceList,
        /** 拉取清单实际使用的语种（auto 时是推断结果），只用于展示。 */
        language: this.cloudPullLanguage(),
        languageAuto: this.cfg.textLang === 'auto',
      },
      platform: process.platform,
      tierSetting: this.cfg.tier,
      tier: this.tier(),
      cudaFound: this.cuda === true,
      amd: this.amd,
      gpu: this.gpu,
      version: this.version(),
      runtime: { ...this.runtime.status(), dir: b.kind === 'remote' ? b.url : b.dir, published: this.runtime.published(), bytes: this.runtime.bytes(), own: b.kind === 'own' && isRuntimeDir(b.dir) },
      weights: { ...this.weights.status(), dir: this.weights.dir(), bytes: this.weights.bytes() },
      trained: this.trained(),
      server: { ...this.server.state(), warming: this.warming, warmed: this.warmed },
      voice: voice ? { audio: voice.audio, text: voice.text, preset: voice.preset } : null,
      voices: (this.cfg.voices ?? []).map((v) => ({ id: v.id, name: v.name, audio: v.audio, text: v.text, weights: v.weights, selected: v.id === this.cfg.voice.preset })),
      queue: this.queue.length + (this.current ? 1 : 0),
      playing: this.player.playing,
      lastError: this.lastError,
      lastSpoken: this.lastSpoken,
      output: this.server.output().slice(-12),
    };
  }

  /** 扫描已安装的运行时与权重，给出体积；`refresh` 跳过 10 分钟缓存。 */
  async usage(refresh = false): Promise<UsageState> {
    const now = Date.now();
    if (!refresh && this.usageCache && now - this.usageCache.at < 600_000) return this.usageCache.data;
    const items: UsageItem[] = [];
    const root = join(this.opts.runtimesRoot(), 'gpt-sovits', RUNTIME_VERSION);
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { /* 还没装过 */ }
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (!entry.isDirectory() || isLinkEntry(path)) continue;
      const kind: UsageKind | null = entry.name.endsWith('.partial') ? 'partial'
        : /\.old-\d+$/.test(entry.name) ? 'stale'
          : (entry.name === 'cuda' || entry.name === 'rocm' || entry.name === 'cpu') ? 'runtime'
            : null;
      if (!kind) continue;
      // 运行时是几万个文件，递归量要几十秒；面板用解压后的实测估算，标 ≈。
      const tier: Tier | null = entry.name.startsWith('cuda') ? 'cuda'
        : entry.name.startsWith('rocm') ? 'rocm'
          : entry.name.startsWith('cpu') ? 'cpu' : null;
      const bytes = kind === 'partial' ? topLevelBytes(path) : tier ? RUNTIME_EXTRACT_BYTES[tier] : 0;
      items.push({ id: entry.name, kind, dir: path, bytes, estimated: true });
    }
    const weightsDir = this.weights.dir();
    // 权重只有几十个文件，递归量很快，给准确值。
    if (existsSync(weightsDir)) items.push({ id: 'weights', kind: 'weights', dir: weightsDir, bytes: dirBytes(weightsDir) });
    items.sort((a, b) => b.bytes - a.bytes);
    const data: UsageState = { items, total: items.reduce((n, item) => n + item.bytes, 0), scannedAt: nowIso(this.opts.timezone) };
    this.usageCache = { at: now, data };
    return data;
  }

  /** 删掉一项：先停服务（Windows 上服务开着时删文件会被占用），再按联接安全的方式整目录删除。 */
  private async uninstall(id: string): Promise<{ usage: UsageState; removed: { id: string; bytes: number } }> {
    const current = await this.usage(true);
    const item = current.items.find((i) => i.id === id);
    if (!item) throw new Error(`没有可卸载的「${id}」`);
    this.hush();
    await this.server.stop();
    try {
      removeTreeSafely(item.dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EBUSY') throw new Error('文件仍被占用：请先停止推理服务再试一次。');
      throw err;
    }
    this.usageCache = null;
    this.log.info('已卸载模型文件', { id, dir: item.dir, bytes: item.bytes });
    return { usage: await this.usage(true), removed: { id: item.id, bytes: item.bytes } };
  }
}

/** 没检测到 NVIDIA 时的显卡厂商；定义在 `gpu.ts`，这里转出给现有引用。 */
export type { GpuVendor } from './gpu.ts';

/** 「已安装模型」里的一项：运行时档、没下完的运行时、旧运行时残留，或 GPT-SoVITS 权重。 */
export type UsageKind = 'runtime' | 'partial' | 'stale' | 'weights';

export interface UsageItem {
  /** 目录名：`cuda` / `rocm` / `cpu` / `cuda.partial` / `cuda.old-…` / `weights`。 */
  id: string;
  kind: UsageKind;
  dir: string;
  bytes: number;
  /** 运行时目录太大没法每次递归量，`bytes` 是解压后的实测估算值。 */
  estimated?: boolean;
}

export interface UsageState {
  items: UsageItem[];
  /** 全部卸载后可释放的字节数。 */
  total: number;
  scannedAt: string;
}

/** 面板操作的一次性回执：换音色自动对齐推理模型，或权重与推理模型版本不一致。 */
export type PanelNotice =
  | { code: 'modelSwitched'; model: ModelVersion }
  | { code: 'weightsMismatch'; want: ModelVersion; current: ModelVersion }
  | { code: 'cloudVoicesPulled'; count: number; kept: number; total: number; keywordMode: 'server' | 'local' | '' }
  /** 点「使用」选中了某个云端音色（id 已写入配置）。 */
  | { code: 'cloudVoiceSelected'; name: string };

export interface PanelState {
  backend: Backend['kind'];
  /** 当前合成引擎：本地 / 云端（手动切换）；`null` = 还没选，面板只显示选择提示。 */
  engine: 'local' | 'cloud' | null;
  /** 本地这一侧是怎么接上的：托管下载 / 自备目录 / 已有服务。 */
  setup: { mode: Backend['kind']; runtimeDir: string; serverUrl: string; localService: boolean; ready: boolean };
  /** 当前推理模型与所选音色权重需要的版本不一致；启动兜底与面板提示共用。 */
  mismatch?: { want: ModelVersion; current: ModelVersion };
  /** 一次操作回执（换音色自动对齐、保存了版本不一致的权重等）。 */
  notice?: PanelNotice;
  /** 云端配置与状态；密钥只给掩码，明文永远不出现在这里。 */
  cloud: {
    baseUrl: string;
    model: string;
    voiceId: string;
    voices: Array<{ id: string; name: string; official?: boolean }>;
    /** true = 用户没维护清单，正在用内置默认（OpenAI 官方地址）。 */
    autoVoices: boolean;
    /** true = 生效音色是 OpenAI 官方音色，但接口不是 OpenAI（厂商很可能不认）。 */
    presetMismatch: boolean;
    keyMask: string;
    keySet: boolean;
    timeoutMs: number;
    ready: boolean;
    /** 生效的服务商 id（空配置按地址推断后的结果）。 */
    provider: string;
    /** 旧配置里存过「暂不开放」的厂商 id；非空时界面说明已回退到自定义。 */
    providerFallback: string;
    /** Azure 区域；其它厂商为空。 */
    region: string;
    /** MiniMax GroupId；其它厂商为空。 */
    groupId: string;
    /** 火山引擎应用 ID；其它厂商为空。 */
    appId: string;
    /** 火山引擎集群；其它厂商为空。 */
    cluster: string;
    /** 该厂商有没有「列出音色」端点。 */
    canListVoices: boolean;
    /** 拉取清单实际使用的语种；`auto` 时是推断结果。 */
    language: string;
    /** true = 台词语种是「自动识别」，上面是推断值。 */
    languageAuto: boolean;
  };
  /** 面板在哪个平台上；macOS 的档位说明与 Windows 不同（没有可下载的运行时包）。 */
  platform: NodeJS.Platform;
  tierSetting: GptSovitsConfigSection['tier'];
  tier: Tier;
  cudaFound: boolean;
  /** AMD 显卡的探测结果；`supported` 时 `auto` 会走 ROCm 档。 */
  amd: AmdProbe;
  /** 没有 NVIDIA 时的显卡厂商；用来解释为什么用 CPU 档。 */
  gpu: GpuVendor | null;
  version: ModelVersion;
  runtime: JobState & { dir: string; published: boolean; bytes: number; own: boolean };
  weights: JobState & { dir: string; bytes: number };
  /** 自备训练权重；`problem` 非空表示填了但用不上。 */
  trained: TrainedResult;
  server: ServerState & { warming: boolean; warmed: boolean };
  voice: { audio: string; text: string; preset: string | null } | null;
  /** 用户添加的自定义音色。 */
  voices: Array<{ id: string; name: string; audio: string; text: string; weights: CustomVoice['weights']; selected: boolean }>;
  queue: number;
  playing: boolean;
  lastError: string | null;
  /** 最近念出去的一句；`translated` 为真表示这是译文，与气泡不同。 */
  lastSpoken: { text: string; translated: boolean; at: string } | null;
  output: string[];
}

const readText = (file: string): string => readFileSync(file, 'utf8').trim();
