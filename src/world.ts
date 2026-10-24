/**
 * GPTSovits 语音 World:`sovits_speak` 把台词排进队列，逐句经 GPT-SoVITS 流式合成，边收边从本机声卡播放;
 * `sovits_hush` 停下当前一句并清空队列。
 *
 * `sovits_speak` 等这一句的第一块音频写进声卡才返回(至多 SPEAK_WAIT_MAX_MS)。主循环按顺序执行同一次回复里的
 * 工具调用，紧跟其后的 `pet_say` 因此在声音开始时才出气泡。
 *
 * 推理后端三选一，优先级从高到低：配置的已有服务地址、配置的自备运行时目录、托管安装的运行时与权重。
 * 后两种由本 World 起子进程(见 server.ts),就绪后用中英日各一句预热，预热完才算可用。
 *
 * 环境提示词里的状态是前缀重建时的快照;之后变为可用或不可用时推一条 `gpt-sovits.state` 内部事件，
 * 随下一批事件送达(piggyback),不单独唤醒 bot。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type { Logger, ToolDef, ToolOutcome, World, WorldHost, WorldLamp, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { DeepPartial } from 'cortico/world.ts';
import { nowIso } from 'cortico/core/util.ts';
import { OUTPUT_GAIN, TIER_MODEL, weightPaths, type ModelVersion } from './catalog.ts';
import { configGroups, GPT_SOVITS_ID, REF_MAX_SECONDS, REF_MIN_SECONDS, type GptSovitsConfigSection, type Tier } from './config.ts';
import { effectiveWeights, emptyWeights, NEW_VOICE_PRESET, newCustomVoiceId, selectedCustomVoice, UNNAMED_VOICE, validateCustomVoice, type CustomVoice } from './custom-voice.ts';
import { panelText, stateWords } from './i18n.ts';
import { isRuntimeDir, RuntimeJob, WeightsJob, type JobState } from './install.ts';
import { Player } from './player.ts';
import { SovitsServer, type ServerState } from './server.ts';
import { registerCustomVoiceOptions } from './voice-options.ts';
import { speechText, ttsPlain, ttsSafe } from './speech-text.ts';
import { synthesize, switchWeights, type SynthRequest } from './synth.ts';
import { SOVITS_TOOL_DECLS } from './tools.ts';
import { DEFAULT_PRESET, isPreset, type VoicePreset } from './voices.ts';
import { installedBaseWeights, resolveTrained, type TrainedResult, type TrainedWeights } from './weights.ts';
import { readSeconds } from './wav.ts';

const ENV_PROMPT_FILES = {
  zh: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
  en: fileURLToPath(new URL('./ENV_PROMPT.en.md', import.meta.url)),
};


const presetFiles = (id: VoicePreset): { audio: string; text: string } => ({
  audio: fileURLToPath(new URL(`../assets/voices/${id}.wav`, import.meta.url)),
  text: fileURLToPath(new URL(`../assets/voices/${id}.txt`, import.meta.url)),
});

/** 预热的三句：中、英、日的文本前端各在首次使用时加载。 */
const WARMUP = ['你好。', 'Hello.', 'こんにちは。'];

/** `sovits_speak` 等第一块音频的上限;超时照常返回，声音晚到。 */
const SPEAK_WAIT_MAX_MS = 3000;

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

export interface GptSovitsWorldOptions {
  cfg: GptSovitsConfigSection;
  timezone: string;
  dataDir: string;
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
  private readonly queue: Array<{ text: string; at: number; started: () => void }> = [];
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

  constructor(private readonly opts: GptSovitsWorldOptions) {
    this.runtime = new RuntimeJob(opts.runtimesRoot, () => this.tier());
    this.weights = new WeightsJob(opts.modelsRoot, () => this.version());
    this.server = new SovitsServer(this.log);
    this.player = new Player({ device: () => opts.cfg.outputDevice, volume: () => opts.cfg.volume, log: { warn: (msg, meta) => this.log.warn(msg, meta) } as Logger });
    registerCustomVoiceOptions(() => (this.cfg.voices ?? []).map((v) => ({ value: v.id, label: v.name })));
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
   *  选中音色自带权重时用音色的，否则用全局配置。 */
  private trained(): TrainedResult {
    const custom = selectedCustomVoice(this.cfg.voices ?? [], this.cfg.voice.preset);
    return resolveTrained(effectiveWeights(custom, this.cfg.weights), this.version());
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

  /**
   * 配置页下拉里选中「＋ 新建音色…」（哨兵值）时建一个未命名音色并切过去;
   * 选中自定义音色时把它的音频与台本镜像进 `voice.audio/text`,让配置页那几个字段直接显示出路径;
   * 从自定义音色切回预设时，把镜像值清掉（用户手填的路径不动）。
   * 在 `voice()` 与 `panelState()` 开头调用，两种入口（配置页下拉 / 语音页）都会收敛到一致状态。
   */
  private settlePreset(): void {
    const p = this.cfg.voice.preset;
    const voices = this.cfg.voices ?? [];
    if (p === NEW_VOICE_PRESET) {
      const voice: CustomVoice = { id: newCustomVoiceId(), name: UNNAMED_VOICE, audio: '', text: '', weights: emptyWeights() };
      this.log.info('从下拉新建了一个未命名音色', { id: voice.id });
      this.opts.persist({ voices: [...voices, voice], voice: { preset: voice.id, audio: '', text: '' } });
      return;
    }
    const custom = selectedCustomVoice(voices, p);
    if (custom) {
      if (this.cfg.voice.audio !== custom.audio || this.cfg.voice.text !== custom.text) {
        this.opts.persist({ voice: { preset: custom.id, audio: custom.audio, text: custom.text } });
      }
      return;
    }
    if (isPreset(p) && this.cfg.voice.audio && voices.some((v) => v.audio === this.cfg.voice.audio)) {
      this.opts.persist({ voice: { preset: p, audio: '', text: '' } });
    }
  }

  /**
   * 自定义参考音频优先，其次是选中的音色（自定义音色或预设）。
   * 音频先量时长：超出 3–10 秒时 api_v2 只回 400、不说原因，这里替它说明。
   */
  private voice(): { audio: string; text: string; preset: string | null } | null {
    this.settlePreset();
    const v = this.cfg.voice;
    if (v.audio && existsSync(v.audio)) {
      this.voiceIssue = referenceIssue(v.audio);
      return this.voiceIssue ? null : { audio: v.audio, text: v.text, preset: selectedCustomVoice(this.cfg.voices ?? [], v.preset)?.id ?? null };
    }
    this.voiceIssue = null;
    const custom = selectedCustomVoice(this.cfg.voices ?? [], v.preset);
    if (custom) {
      // 新建的音色还没配参考音频：明确说原因，不回落到预设（否则用户以为新音色生效了）。
      if (!custom.audio) {
        this.voiceIssue = '这个自定义音色还没有参考音频，在语音页的「自定义音色」里点编辑补上';
        return null;
      }
      if (!existsSync(custom.audio)) {
        this.voiceIssue = `这个自定义音色的参考音频不见了：${custom.audio}`;
        return null;
      }
      this.voiceIssue = referenceIssue(custom.audio);
      return this.voiceIssue ? null : { audio: custom.audio, text: custom.text, preset: custom.id };
    }
    const id = isPreset(v.preset) ? v.preset : DEFAULT_PRESET;
    const f = presetFiles(id);
    return existsSync(f.audio) && existsSync(f.text) ? { audio: f.audio, text: readText(f.text), preset: id } : null;
  }

  /** 当前选中的自定义音色（没选或已删时 null）。 */
  private activeCustomVoice(): CustomVoice | null {
    return selectedCustomVoice(this.cfg.voices ?? [], this.cfg.voice.preset);
  }

  envPromptVars(): Record<string, string> {
    const w = stateWords(this.cfg.promptLanguage);
    return { 'sovits.state': this.stateFor(w) };
  }

  private stateFor(w: ReturnType<typeof stateWords>): string {
    if (!this.voice()) return this.voiceIssue ?? w.noVoice;
    if (this.url()) return w.available;
    const st = this.server.state();
    if (st.phase === 'error') return w.error(st.detail ?? '');
    if (st.phase === 'starting' || this.warming || this.launching) return w.starting;
    return w.notInstalled;
  }

  tools(): ToolDef[] {
    const [speak, hush] = SOVITS_TOOL_DECLS;
    return [
      { ...speak!, handler: (args) => this.speak(String(args.text ?? '')) },
      { ...hush!, handler: async () => { this.hush(); return 'Stopped.'; } },
    ];
  }

  /** 排进队列，等这一句开始出声(或失败、被清空、超时)再返回。 */
  private async speak(script: string): Promise<ToolOutcome> {
    const text = ttsSafe(speechText(script));
    if (!text) return { text: 'Nothing to say: the text has only markup.' };
    if (!this.voice()) return { text: `Voice unavailable: ${this.voiceIssue ?? 'no reference audio is set'}.`, failed: true };
    if (!this.url()) return { text: `Voice unavailable: ${this.stateFor(stateWords('en'))}.`, failed: true };
    const ahead = this.queue.length + (this.current ? 1 : 0);
    let timer: NodeJS.Timeout | undefined;
    const started = new Promise<void>((done) => {
      this.queue.push({ text, at: Date.now(), started: done });
      timer = setTimeout(done, SPEAK_WAIT_MAX_MS);
    });
    void this.pump();
    await started;
    clearTimeout(timer);
    return { text: ahead ? `Queued after ${ahead} line(s).` : 'Speaking.' };
  }

  private hush(): void {
    for (const item of this.queue.splice(0)) item.started();
    this.current?.abort();
    this.player.cut();
  }

  /**
   * 合成一句话并写进播放器；返回首包时间。失败时抛出，由调用方决定要不要降级重试。
   * `onFirst` 在第一次真正写进声卡时调用一次。
   */
  private async playLine(
    url: string, voice: { audio: string; text: string }, text: string,
    signal: AbortSignal, onFirst: () => void,
  ): Promise<number> {
    const gain = OUTPUT_GAIN[this.version()];
    let first = 0;
    for await (const c of synthesize(url, this.request(text, voice), signal)) {
      await this.player.write(c.sampleRate, c.pcm, this.backend().kind === 'remote' ? 1 : gain);
      if (!first) { first = Date.now(); onFirst(); }
    }
    this.player.flush();
    return first;
  }

  /** 逐句合成并写进播放器;一句合成完就开始下一句，播放器按顺序播。 */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.stopped) {
        const { text, at, started } = this.queue.shift()!;
        const url = this.url();
        const voice = this.voice();
        if (!url || !voice) { started(); for (const item of this.queue.splice(0)) item.started(); break; }
        const abort = new AbortController();
        this.current = abort;
        let heard = false;
        const onFirst = (): void => { heard = true; started(); };
        try {
          await this.applyWeights(url);
          const first = await this.playLine(url, voice, text, abort.signal, onFirst);
          this.log.info('GPT-SoVITS 一句合成完', { chars: [...text].length, waitMs: first - at, totalMs: Date.now() - at });
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
                await this.playLine(url, voice, plain, abort.signal, onFirst);
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
          this.current = null;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** 合成一句要用的请求参数。 */
  private request(text: string, voice: { audio: string; text: string }): SynthRequest {
    return { text, refAudio: voice.audio, refText: voice.text, speed: this.cfg.speed, seed: this.cfg.seed };
  }

  async start(host: WorldHost): Promise<void> {
    this.log = host.log;
    this.host = host;
    this.server = new SovitsServer(this.log, (detail) => this.announce(false, detail));
    this.stopped = false;
    this.announced = null;
    this.appliedWeights = '';
    this.appliedTarget = null;
    this.weightsFailed = '';
    this.launching = this.cfg.autoStart && this.backend().kind !== 'remote';
    this.cuda = await detectCuda();
    if (this.launching && this.canStart()) void this.startServer().finally(() => { this.launching = false; });
    else this.launching = false;
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

  async stop(): Promise<void> {
    this.stopped = true;
    this.hush();
    this.player.close();
    this.runtime.cancel();
    this.weights.cancel();
    await this.server.stop();
  }

  /** 本机服务要的东西都在。 */
  private canStart(): boolean {
    const b = this.backend();
    if (b.kind === 'remote') return false;
    if (b.kind === 'own') return isRuntimeDir(b.dir);
    return this.runtime.status().phase === 'ready' && this.weights.status().phase === 'ready';
  }

  private async startServer(): Promise<void> {
    const b = this.backend();
    if (b.kind === 'remote' || this.stopped) return;
    this.warmed = false;
    const trained = this.trained().weights;
    await this.server.start({
      runtimeDir: b.dir,
      weightsDir: b.kind === 'managed' ? this.weights.dir() : null,
      tier: this.tier(),
      version: this.version(),
      trained,
      dataDir: this.opts.dataDir,
    });
    // yaml 里已经是这组权重，启动即加载，不必再调一遍换权重的接口。
    this.appliedWeights = this.weightsSignature();
    this.appliedTarget = trained ?? this.baseTarget();
    this.weightsFailed = '';
    await this.warmUp();
  }

  private async warmUp(): Promise<void> {
    const st = this.server.state();
    const voice = this.voice();
    if (st.phase !== 'ready' || !st.url) return;
    if (!voice) { this.warmed = true; return; }
    this.warming = true;
    try {
      for (const text of WARMUP) {
        for await (const _ of synthesize(st.url, this.request(text, voice))) { /* 只为加载，丢掉音频 */ }
      }
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
    const st = this.server.state();
    const remote = this.backend().kind === 'remote';
    const lamp: WorldLamp = remote
      ? { label: t.lamp, state: 'online', hint: t.remote }
      : {
        label: t.lamp,
        state: st.phase === 'ready' && this.warmed ? 'online' : st.phase === 'starting' || this.warming ? 'loading' : st.phase === 'error' ? 'error' : 'offline',
        hint: st.detail ?? undefined,
      };
    return {
      label: t.label,
      lamps: [lamp],
      panels: [{ id: 'voice', title: t.panel, description: t.panelHint, getMethods: ['state'] }],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
      config: configGroups(language),
      promptDocs: [{
        key: `worlds.${GPT_SOVITS_ID}.envPrompt`,
        title: `${t.label} · ${language === 'zh' || language === 'zh-Hant' ? '环境提示词' : 'environment prompt'}`,
        description: language === 'zh' || language === 'zh-Hant' ? '要求 bot 每次 pet_say 前先调用 sovits_speak 的那一段。' : 'The passage asking the bot to call sovits_speak before each pet_say.',
        path: ENV_PROMPT_FILES[this.cfg.promptLanguage],
        role: 'envPrompt',
        vars: [{ name: 'sovits.state', description: language === 'zh' || language === 'zh-Hant' ? '语音此刻的状态。' : 'The voice state at this moment.' }],
      }],
    };
  }

  /** 面板数据面。 */
  async invoke(panel: string, method: string, args: unknown[]): Promise<unknown> {
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
