/**
 * GPTSovits 语音 World:`sovits_speak` 把台词排进队列，逐句经 GPT-SoVITS 流式合成，边收边从本机声卡播放;
 * `sovits_hush` 停下当前一句并清空队列。
 *
 * `sovits_speak` 等这一句的第一块音频写进声卡才返回(至多 SPEAK_WAIT_MAX_MS)。主循环按顺序执行同一次回复里的
 * 工具调用，所以提示词要求先 `pet_say` 再 `sovits_speak`：气泡先出现，声音随后响起。
 *
 * 推理后端三选一，优先级从高到低：配置的已有服务地址、配置的自备运行时目录、托管安装的运行时与权重。
 * 后两种由本 World 起子进程(见 server.ts),就绪后用中英日各一句预热，预热完才算可用。
 *
 * 环境提示词里的状态是前缀重建时的快照;之后变为可用或不可用时推一条 `gpt-sovits.state` 内部事件，
 * 随下一批事件送达(piggyback),不单独唤醒 bot。
 */
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type { Logger, ToolDef, ToolOutcome, World, WorldHost, WorldLamp, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { DeepPartial } from 'cortico/world.ts';
import { nowIso } from 'cortico/core/util.ts';
import { officialVoice, OUTPUT_GAIN, TIER_MODEL, weightPaths, type ModelVersion } from './catalog.ts';
import { configGroups, DEVICE_OPTIONS, GPT_SOVITS_ID, PROMPT_LANGUAGE_OPTIONS, REF_MAX_SECONDS, REF_MIN_SECONDS, TEXT_LANGUAGE_OPTIONS, TIER_OPTIONS, VOICE_OPTIONS, promptLanguageOptions, systemDeviceLabel, textLanguageOptions, tierOptions, type GptSovitsConfigSection, type Tier } from './config.ts';
import { effectiveWeights, emptyWeights, NEW_VOICE_PRESET, newCustomVoiceId, selectedCustomVoice, UNNAMED_VOICE, validateCustomVoice, type CustomVoice } from './custom-voice.ts';
import { startHttpTts, type HttpTtsHandle, type TtsJob } from './http-tts.ts';
import { channelWords, languageWords, panelText, shareWords, stateWords } from './i18n.ts';
import { isRuntimeDir, RuntimeJob, WeightsJob, type JobState } from './install.ts';
import { Player, applyGain, listOutputDevices } from './player.ts';
import { SovitsServer, type ServerState } from './server.ts';
import { customVoiceOptions, registerCustomVoiceOptions } from './voice-options.ts';
import { promptLanguageOf, speechText, ttsPlain, ttsSafe } from './speech-text.ts';
import { synthesize, switchWeights, type SpeechLang, type SynthRequest } from './synth.ts';
import { SOVITS_TOOL_DECLS } from './tools.ts';
import { DEFAULT_PRESET, isPreset, presetFileLabel, presetLabel, presetRefId, VOICE_PRESETS, type VoicePreset } from './voices.ts';
import { installedBaseWeights, officialWeights, resolveTrained, type TrainedResult, type TrainedWeights } from './weights.ts';
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

/** 等 `ms` 毫秒后给出 `null`，给一段等待加个上限。 */
const delayed = (ms: number): Promise<null> => new Promise((resolve) => {
  setTimeout(() => resolve(null), ms).unref();
});

/** 队列里的一句。`finish` 只在开启「交给其他插件」时由 `speak()` 提供。 */
interface QueuedLine {
  text: string;
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
}

type Backend =
  | { kind: 'remote'; url: string }
  | { kind: 'own'; dir: string }
  | { kind: 'managed'; dir: string };

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
  private warming = false;
  private warmed = false;
  private lastError: string | null = null;
  private cuda: boolean | null = null;
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
  /** 正在进行的启动+预热，避免休眠唤醒与面板按钮同时启动两次。 */
  private startingServer: Promise<void> | null = null;

  constructor(private readonly opts: GptSovitsWorldOptions) {
    this.runtime = new RuntimeJob(opts.runtimesRoot, () => this.tier());
    this.weights = new WeightsJob(opts.modelsRoot, () => this.version(), () => officialVoice(this.cfg.voice.preset)?.files ?? []);
    this.server = new SovitsServer(this.log);
    this.player = new Player({ device: () => opts.cfg.outputDevice, volume: () => opts.cfg.volume, log: { warn: (msg, meta) => this.log.warn(msg, meta) } as Logger });
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

  /** 生效的推理档;`auto` 按 nvidia-smi 能否列出显卡。 */
  tier(): Tier {
    if (this.cfg.tier !== 'auto') return this.cfg.tier;
    return this.cuda ? 'cuda' : 'cpu';
  }

  version(): ModelVersion {
    return TIER_MODEL[this.tier()];
  }

  /** 配置里的自备权重，校验过版本与文件；用不上时 `problem` 里是原因。
   *  选中音色自带权重时用音色的，否则用全局配置；都没填时，选中官模音色就用随包官模权重。 */
  private trained(): TrainedResult {
    const custom = selectedCustomVoice(this.cfg.voices ?? [], this.cfg.voice.preset);
    const own = resolveTrained(effectiveWeights(custom, this.cfg.weights), this.version());
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

  /** 权重签名：变了说明配置里换了模型。 */
  private weightsSignature(): string {
    const t = this.trained().weights;
    return t ? `${t.gpt}|${t.sovits}` : '';
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

  private backend(): Backend {
    if (this.cfg.serverUrl.trim()) return { kind: 'remote', url: this.cfg.serverUrl.trim().replace(/\/+$/, '') };
    if (this.cfg.runtimeDir.trim()) return { kind: 'own', dir: this.cfg.runtimeDir.trim() };
    return { kind: 'managed', dir: this.runtime.dir() };
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
    // 开着「交给其他插件」时补一句附件用法，模型才知道把回执里的 [blob …] 句柄填给别的发送工具。
    const share = this.cfg.shareAudio
      ? " The result also carries the whole line as an audio attachment: pass that [blob …] handle to another plugin's send tool (the QQ voice parameter, for example) to deliver the same audio. Pass silent: true for a line meant for such a channel, so it is not played on this computer."
      : '';
    return [
      { ...speak!, description: `${speak!.description} Speech language: ${lang.name} — ${lang.rule}${share}`, handler: (args) => this.speak(String(args.text ?? ''), args.silent === true) },
      { ...hush!, handler: async () => { this.hush(); return 'Stopped.'; } },
    ];
  }

  /** 排进队列，等这一句开始出声(或失败、被清空、超时)再返回。 */
  private async speak(script: string, silent = false): Promise<ToolOutcome> {
    this.syncLanguage();
    const text = ttsSafe(speechText(script));
    if (!text) return { text: 'Nothing to say: the text has only markup.' };
    if (!this.voice()) return { text: `Voice unavailable: ${this.voiceIssue ?? 'no reference audio is set'}.`, failed: true };
    const ready = this.url();
    if (!ready) {
      if (!this.sleeping || !this.canStart()) return { text: `Voice unavailable: ${this.stateFor(stateWords('en'))}.`, failed: true };
      // 闲置停服后第一句：先叫醒服务，这一句排在队列里等它加载完。
      this.sleeping = false;
      this.log.info('推理服务在休眠，这句话会叫醒它');
      void this.startServer().finally(() => { this.armIdle(); void this.pump(); });
    }
    const ahead = this.queue.length + (this.current ? 1 : 0);
    // 开启「交给其他插件」时收下整句 PCM：合成完（或失败、被清空）后在 finished 上拿到音频。
    const sharing = this.cfg.shareAudio;
    let finish: ((wav: Buffer | null) => void) | undefined;
    const finished = sharing ? new Promise<Buffer | null>((resolve) => { finish = resolve; }) : null;
    let timer: NodeJS.Timeout | undefined;
    const started = new Promise<void>((done) => {
      this.queue.push({ text, at: Date.now(), silent, started: done, ...(finish ? { finish } : {}) });
      timer = setTimeout(done, SPEAK_WAIT_MAX_MS);
    });
    if (ready) void this.pump();
    await started;
    clearTimeout(timer);
    const said = ahead ? `Queued after ${ahead} line(s).` : 'Speaking.';
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
    this.player.cut();
  }

  /**
   * 合成一句话并写进播放器；返回首包时间和整句 PCM（只有开启保存或「交给其他插件」时才收）。
   * `silent` 为 true 时只合成不写播放器：这一句是给别的渠道（QQ 等）的，本机不该出声。
   * 失败时抛出，由调用方决定要不要降级重试。`onFirst` 在第一次真正写进声卡时调用一次。
   */
  private async playLine(
    url: string, voice: { audio: string; text: string }, text: string,
    signal: AbortSignal, onFirst: () => void, silent: boolean,
  ): Promise<{ first: number; wav: Buffer | null }> {
    const gain = this.backend().kind === 'remote' ? 1 : OUTPUT_GAIN[this.version()];
    // 落盘或交出去的内容与听到的一致（同一增益）；两者都关时不占内存。
    const archive = this.cfg.saveAudio || this.cfg.shareAudio ? { rate: 0, chunks: [] as Buffer[] } : null;
    let first = 0;
    for await (const c of synthesize(url, this.request(text, voice), signal)) {
      if (archive) { archive.rate = c.sampleRate; archive.chunks.push(applyGain(c.pcm, gain)); }
      if (!silent) await this.player.write(c.sampleRate, c.pcm, gain);
      if (!first) { first = Date.now(); onFirst(); }
    }
    if (!silent) this.player.flush();
    if (!archive?.chunks.length) return { first, wav: null };
    const bytes = Buffer.concat(archive.chunks);
    if (this.cfg.saveAudio) this.saveLine(bytes, archive.rate);
    // 交出去的一律是带 RIFF 头的完整 WAV：别的插件拿这段字节去转码，裸 PCM 会被 ffmpeg 判成
    // 「Invalid data found when processing input」（QQ 语音就是这么失败的）。
    return { first, wav: this.cfg.shareAudio ? wavBytes(bytes, archive.rate) : null };
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
        const { text, at, started } = item;
        // 本机不外放开关关着时整句静音；句子级 silent 参数也一样。
        const silent = item.silent || !this.cfg.playLocally;
        const url = this.url();
        const voice = this.voice();
        if (!url || !voice) {
          started();
          settleLine(item, null);
          for (const rest of this.queue.splice(0)) { rest.started(); settleLine(rest, null); }
          break;
        }
        const abort = new AbortController();
        this.current = abort;
        let heard = false;
        let wav: Buffer | null = null;
        const onFirst = (): void => { heard = true; started(); };
        try {
          await this.applyWeights(url);
          const spoken = await this.playLine(url, voice, text, abort.signal, onFirst, silent);
          wav = spoken.wav;
          this.log.info('GPT-SoVITS 一句合成完', { chars: [...text].length, silent, waitMs: spoken.first - at, totalMs: Date.now() - at });
          this.lastError = null;
        } catch (err) {
          if (abort.signal.aborted) {
            // 被 hush() 打断，不算失败。
          } else {
            // 服务端遇到「某一段只剩符号」的文本会在音素前端崩(空音素段 -> torch.cat 报错)。
            // 已经出过声就不再重试(会把半句重复播一次)，没出声时去掉标点再试一次。
            const plain = ttsPlain(text);
            let ok = false;
            if (!heard && plain && plain !== text) {
              try {
                wav = (await this.playLine(url, voice, plain, abort.signal, onFirst, silent)).wav;
                ok = true;
              } catch {
                ok = false;
              }
            }
            if (ok) {
              this.lastError = null;
              this.log.info('GPT-SoVITS 去掉标点后合成成功', { chars: [...plain].length });
            } else if (!abort.signal.aborted) {
              this.lastError = err instanceof Error ? err.message : String(err);
              this.log.warn('GPT-SoVITS 合成失败', { err: this.lastError });
            }
          }
        } finally {
          started();
          // 交付这一句的音频：成功给 WAV，失败、被打断、没合成出来都给 null（重复调用只生效一次）。
          settleLine(item, wav);
          this.current = null;
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
    return {
      text, refAudio: voice.audio, refText: voice.text, speed: this.cfg.speed, seed: this.cfg.seed,
      textLang, promptLang: promptLanguageOf(voice.text),
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.log = host.log;
    this.host = host;
    this.server = new SovitsServer(this.log, (detail) => this.announce(false, detail));
    this.stopped = false;
    this.announced = null;
    this.sleeping = false;
    this.appliedWeights = '';
    this.appliedTarget = null;
    this.weightsFailed = '';
    this.launching = this.cfg.autoStart && this.backend().kind !== 'remote';
    this.cuda = await detectCuda();
    // 启动即把当前音色的音频/台本镜像进配置字段：配置页一打开就能看到实际用的文件。
    this.settlePreset();
    this.appliedTextLang = null;
    this.syncLanguage(true);
    this.langTimer = setInterval(() => this.syncLanguage(), 1000);
    if (this.launching && this.canStart()) void this.startServer().finally(() => { this.launching = false; });
    else this.launching = false;
    void this.startHttpApi();
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
    if (api) await api.close();
    await this.server.stop();
  }

  /** 起「给其他插件取音频」的本地接口；没开或已经在跑就不做。 */
  private async startHttpApi(): Promise<void> {
    if (!this.cfg.httpApi || this.httpTts) return;
    try {
      this.httpTts = await startHttpTts({
        port: this.cfg.httpPort || 9880,
        token: this.cfg.httpToken,
        deps: {
          synthesize: (job, signal) => this.synthesizeForApi(job, signal),
          ready: () => this.apiReady(),
          stateText: () => this.stateFor(stateWords('en')),
          log: this.log,
        },
      });
    } catch (err) {
      this.log.warn('HTTP 语音接口没起来，其他插件取不到音频', { err: String(err), port: this.cfg.httpPort });
    }
  }

  /** 接口此刻能不能接活：服务就绪，或休眠中但能自己拉起来。 */
  private apiReady(): boolean {
    return !!this.url() || (this.sleeping && this.canStart());
  }

  /**
   * HTTP 接口要的一句音频：用点名或当前的音色合成，只回 WAV —— 不播放、不进播放队列。
   * 服务在休眠就先叫醒；失败抛错，由接口回 502。
   */
  private async synthesizeForApi(job: TtsJob, signal: AbortSignal): Promise<Buffer> {
    const voice = this.voiceByName(job.voice) ?? this.voice();
    if (!voice) throw new Error(this.voiceIssue ?? 'no reference audio is set');
    if (!this.url() && this.sleeping && this.canStart()) {
      this.sleeping = false;
      this.log.info('推理服务在休眠，这次取音频会叫醒它');
      await this.startServer();
    }
    const url = this.url();
    if (!url) throw new Error(`voice not ready: ${this.stateFor(stateWords('en'))}`);
    const gain = this.backend().kind === 'remote' ? 1 : OUTPUT_GAIN[this.version()];
    const req = this.request(job.text, voice);
    const chunks: Buffer[] = [];
    let rate = 0;
    const asked: SynthRequest = {
      ...req,
      ...(typeof job.speed === 'number' && job.speed > 0 ? { speed: job.speed } : {}),
      ...(typeof job.seed === 'number' && job.seed >= 0 ? { seed: job.seed } : {}),
    };
    for await (const c of synthesize(url, asked, signal)) {
      rate = c.sampleRate;
      chunks.push(applyGain(c.pcm, gain));
    }
    if (!chunks.length) throw new Error('synthesized nothing');
    return wavBytes(Buffer.concat(chunks), rate);
  }

  /** 接口点名的音色：自定义音色的 id 或名字、预设 id（xll/dfy/female/male）；认不出返回 null。 */
  private voiceByName(name?: string): { audio: string; text: string } | null {
    const want = (name ?? '').trim().toLowerCase();
    if (!want) return null;
    const custom = (this.cfg.voices ?? []).find((v) => v.id === name || v.name.toLowerCase() === want);
    if (custom?.audio) {
      if (!existsSync(custom.audio)) this.log.warn('HTTP 语音接口点名的自定义音色缺参考音频，用当前音色', { voice: name });
      else if (!referenceIssue(custom.audio)) return { audio: custom.audio, text: custom.text };
    }
    const preset = VOICE_PRESETS.find((p) => p === want);
    if (preset) {
      const f = presetFiles(preset, this.cfg.textLang);
      if (existsSync(f.audio) && existsSync(f.text)) return { audio: f.audio, text: readText(f.text) };
    }
    this.log.warn('HTTP 语音接口点名的音色认不出，用当前音色', { voice: name });
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
    });
    // yaml 里已经是这组权重，启动即加载，不必再调一遍换权重的接口。
    this.appliedWeights = this.weightsSignature();
    this.appliedTarget = trained ?? this.baseTarget();
    this.weightsFailed = '';
    await this.warmUp();
    this.armIdle();
  }

  private async warmUp(): Promise<void> {
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
        // 权重填了就当场校验版本与文件，不让坏配置进列表。
        const result = resolveTrained(weights, this.version());
        if (result.problem || !result.weights) throw new Error(`权重用不上：${result.problem}`);
      }
      const id = newCustomVoiceId();
      const file = join(this.opts.dataDir, 'voices', `${id}.wav`);
      writeFileSync(file, bytes);
      const voice: CustomVoice = { id, name: name.trim(), audio: file, text: text.trim(), weights: weights.gpt ? weights : emptyWeights() };
      this.opts.persist({ voices: [...(this.cfg.voices ?? []), voice], voice: { preset: id, audio: file, text: voice.text } });
      this.log.info('已添加自定义音色', { id, name: voice.name, withWeights: !!weights.gpt });
      return this.panelState();
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
      if (weights.gpt) {
        const result = resolveTrained(weights, this.version());
        if (result.problem || !result.weights) throw new Error(`权重用不上：${result.problem}`);
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
      return this.panelState();
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
    const lamp: WorldLamp = remote
      ? { label: t.lamp, state: 'online', hint: t.remote }
      : {
        label: t.lamp,
        state: st.phase === 'ready' && this.warmed ? 'online' : st.phase === 'starting' || this.warming ? 'loading' : st.phase === 'error' ? 'error' : 'offline',
        hint: this.sleeping ? t.asleep : st.detail ?? undefined,
      };
    return {
      label: t.label,
      lamps: [lamp],
      panels: [
        { id: 'voice', title: t.panel, description: t.panelHint, getMethods: ['state'] },
        cfgPanel('cfg-voice', `world:${GPT_SOVITS_ID}`),
        cfgPanel('cfg-output', `world:${GPT_SOVITS_ID}:output`),
        cfgPanel('cfg-link', `world:${GPT_SOVITS_ID}:link`, ['config', 'qqGuide', 'writeQqVoice']),
        cfgPanel('cfg-service', `world:${GPT_SOVITS_ID}:service`),
        { id: 'voices', title: t.voicesPanel, description: t.voicesPanelHint, getMethods: ['state'] },
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
    const optionsFor = (kind: unknown): Array<{ value: string; label: string }> | undefined => {
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
        case DEVICE_OPTIONS:
          try {
            return [{ value: '', label: systemDeviceLabel(language) }, ...listOutputDevices().map((d) => ({ value: d.name, label: d.name }))];
          } catch {
            return [{ value: '', label: systemDeviceLabel(language) }];
          }
        default:
          return undefined;
      }
    };
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
      values[key] = resolve(key);
    }
    return { groupId, title: (group.schema as any).title, description: (group.schema as any).description, properties: out, values };
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
      { label: zh ? '语义判定是否说语音' : 'Judge when to speak', value: String(qq?.voice?.semanticJudge ?? true) },
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
    return { ok: true, key, value };
  }

  /** 面板数据面。 */
  async invoke(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (method === 'setConfigValue') return this.setConfigValue(String(args[0] ?? ''), args[1]);
    if (method === 'qqGuide') return this.qqGuide();
    if (method === 'writeQqVoice') return this.writeQqVoice();
    if (method === 'config') {
      return this.configSchema(String(args[0] ?? ''), String(args[1] ?? ''), args[2] === true);
    }
    if (panel === 'voices') {
      switch (method) {
        case 'state': return this.panelState();
        case 'add': return this.addCustomVoice(args);
        case 'update': return this.updateCustomVoice(args);
        case 'remove': this.removeCustomVoice(String(args[0] ?? '')); return this.panelState();
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
          if (id && !cv) throw new Error('找不到这个自定义音色。');
          this.opts.persist({ voice: { preset: id || DEFAULT_PRESET, name: cv?.name ?? '', audio: cv?.audio ?? '', text: cv?.text ?? '' } });
          return this.panelState();
        }
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
      case 'setVoice': this.saveVoice(String(args[0] ?? ''), String(args[1] ?? ''), String(args[2] ?? '')); return this.panelState();
      case 'resetVoice': this.opts.persist({ voice: { preset: DEFAULT_PRESET, audio: '', text: '' } }); return this.panelState();
      case 'addVoice': return this.addCustomVoice(args);
      case 'updateVoice': return this.updateCustomVoice(args);
      case 'renameVoice': {
        const [id, name] = [String(args[0] ?? ''), String(args[1] ?? '')];
        if (!name.trim()) throw new Error('音色名称不能为空。');
        const voices = this.cfg.voices ?? [];
        const target = voices.find((v) => v.id === id);
        if (!target) throw new Error('找不到这个自定义音色。');
        this.opts.persist({ voices: voices.map((v) => (v.id === id ? { ...v, name: name.trim() } : v)) });
        return this.panelState();
      }
      case 'removeVoice': this.removeCustomVoice(String(args[0] ?? '')); return this.panelState();
      case 'useVoice': {
        const id = String(args[0] ?? '');
        if (id && !selectedCustomVoice(this.cfg.voices ?? [], id)) throw new Error('找不到这个自定义音色。');
        const cv = id ? selectedCustomVoice(this.cfg.voices ?? [], id) : null;
        this.opts.persist({ voice: { preset: id || DEFAULT_PRESET, audio: cv?.audio ?? '', text: cv?.text ?? '' } });
        return this.panelState();
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
      tierSetting: this.cfg.tier,
      tier: this.tier(),
      cudaFound: this.cuda === true,
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
      output: this.server.output().slice(-12),
    };
  }
}

export interface PanelState {
  backend: Backend['kind'];
  tierSetting: GptSovitsConfigSection['tier'];
  tier: Tier;
  cudaFound: boolean;
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
  output: string[];
}

const readText = (file: string): string => readFileSync(file, 'utf8').trim();

/** nvidia-smi 能列出至少一块显卡就算有 NVIDIA 显卡。 */
function detectCuda(): Promise<boolean> {
  return new Promise((done) => {
    execFile('nvidia-smi', ['-L'], { windowsHide: true, timeout: 5000 }, (err, stdout) => done(!err && /GPU \d+:/.test(stdout)));
  });
}
