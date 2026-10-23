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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type { Logger, ToolDef, ToolOutcome, World, WorldHost, WorldLamp, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { DeepPartial } from 'cortico/world.ts';
import { nowIso } from 'cortico/core/util.ts';
import { OUTPUT_GAIN, TIER_MODEL, type ModelVersion } from './catalog.ts';
import { configGroups, GPT_SOVITS_ID, REF_MAX_SECONDS, REF_MIN_SECONDS, type GptSovitsConfigSection, type Tier } from './config.ts';
import { panelText, stateWords } from './i18n.ts';
import { isRuntimeDir, RuntimeJob, WeightsJob, type JobState } from './install.ts';
import { Player } from './player.ts';
import { SovitsServer, type ServerState } from './server.ts';
import { speechText, ttsPlain, ttsSafe } from './speech-text.ts';
import { synthesize, type SynthRequest } from './synth.ts';
import { SOVITS_TOOL_DECLS } from './tools.ts';
import { DEFAULT_PRESET, isPreset, type VoicePreset } from './voices.ts';
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
  /** 辅助参考在当前权重下无效的日志只报一次。 */
  private auxWarned = false;

  constructor(private readonly opts: GptSovitsWorldOptions) {
    this.runtime = new RuntimeJob(opts.runtimesRoot, () => this.tier());
    this.weights = new WeightsJob(opts.modelsRoot, () => this.version());
    this.server = new SovitsServer(this.log);
    this.player = new Player({ device: () => opts.cfg.outputDevice, volume: () => opts.cfg.volume, log: { warn: (msg, meta) => this.log.warn(msg, meta) } as Logger });
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
   * 自定义参考音频优先，其次是选中的预设音色。
   * 自定义音频先量时长：超出 3–10 秒时 api_v2 只回 400、不说原因，这里替它说明。
   */
  private voice(): { audio: string; text: string; preset: string | null } | null {
    const v = this.cfg.voice;
    if (v.audio && existsSync(v.audio)) {
      this.voiceIssue = referenceIssue(v.audio);
      return this.voiceIssue ? null : { audio: v.audio, text: v.text, preset: null };
    }
    this.voiceIssue = null;
    const id = isPreset(v.preset) ? v.preset : DEFAULT_PRESET;
    const f = presetFiles(id);
    return existsSync(f.audio) && existsSync(f.text) ? { audio: f.audio, text: readText(f.text), preset: id } : null;
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

  /** 主参考之外再挂一条辅助参考(音色融合);与主参考是同一个文件时不重复传。 */
  private request(text: string, voice: { audio: string; text: string }): SynthRequest {
    const aux = this.cfg.voice.auxAudio.trim();
    const useAux = aux && existsSync(aux) && resolve(aux) !== resolve(voice.audio);
    if (useAux && this.version() === 'v5turbo' && !this.auxWarned) {
      // 多参考融合只在 V1/V2 的 decode() 里做；v5turbo 走 vocoder 路径，只取第一条参考。
      // 填了不报错、也不生效，用户会以为坏了，这里至少留一条日志。
      this.auxWarned = true;
      this.log.warn('辅助参考音频在 v5turbo 权重下不生效，已按单参考合成', { aux });
    }
    return {
      text, refAudio: voice.audio, refText: voice.text, speed: this.cfg.speed, seed: this.cfg.seed,
      ...(useAux ? { auxRefs: [aux] } : {}),
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.log = host.log;
    this.host = host;
    this.server = new SovitsServer(this.log, (detail) => this.announce(false, detail));
    this.stopped = false;
    this.announced = null;
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
    await this.server.start({
      runtimeDir: b.dir,
      weightsDir: b.kind === 'managed' ? this.weights.dir() : null,
      tier: this.tier(),
      version: this.version(),
      dataDir: this.opts.dataDir,
    });
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
      case 'resetVoice': this.opts.persist({ voice: { audio: '', text: '' } }); return this.panelState();
      default: throw new Error(`未知方法 ${method}`);
    }
  }

  panelState(): PanelState {
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
      server: { ...this.server.state(), warming: this.warming, warmed: this.warmed },
      voice: voice ? { audio: voice.audio, text: voice.text, preset: voice.preset } : null,
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
  server: ServerState & { warming: boolean; warmed: boolean };
  voice: { audio: string; text: string; preset: string | null } | null;
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
