import type { ConfigGroup } from 'cortico/core/types.ts';
import { pick, type Language } from 'cortico/core/language.ts';
import type { CustomVoice } from './custom-voice.ts';
import { DEFAULT_PRESET } from './voices.ts';

export const GPT_SOVITS_ID = 'gpt-sovits';

/** 推理档：显卡档要 NVIDIA 显卡,`auto` 按 nvidia-smi 能否列出显卡选。 */
export type TierSetting = 'auto' | 'cuda' | 'cpu';
export type Tier = Exclude<TierSetting, 'auto'>;

/** config.json 的 `worlds.gpt-sovits` 段。 */
export interface GptSovitsConfigSection {
  enabled: boolean;
  tier: TierSetting;
  /** 自备的 GPT-SoVITS 根目录(含 `runtime/python.exe` 与 `api_v2.py`);填了就不下载运行时。 */
  runtimeDir: string;
  /** 已在运行的 GPT-SoVITS api_v2 地址;填了就不启动本机运行时，也不下载。 */
  serverUrl: string;
  /** World 启动时一并启动本机推理服务。 */
  autoStart: boolean;
  /**
   * 音色：`preset` 是预设 id / 自定义音色 id / 「＋新建」哨兵；
   * `name`、`audio`、`text` 是当前音色的参数——选自定义音色时镜像显示，改了直接保存回音色。
   */
  voice: { preset: string; name: string; audio: string; text: string };
  /** 用户添加的自定义音色：名称 + 参考音频 + 台本（必填），权重可选（成对）。 */
  voices: CustomVoice[];
  /**
   * 自备训练权重：自己用 GPT-SoVITS 训出来的 s1(`.ckpt`)与 s2(`.pth`)。
   * 两个都填才生效；留空用内置底模。底模仍要装着——v5turbo 的 s2 训练产物是 LoRA 增量，加载时要先读底模。
   */
  weights: { gpt: string; sovits: string };
  /** 语速倍率，对应 api_v2 的 `speed_factor`。 */
  speed: number;
  /**
   * 采样种子，对应 api_v2 的 `seed`。`-1` 每次重新采样（同一句每次都不一样），
   * `0` 及以上固定种子（同一句、同一进程内逐字节可复现）。
   */
  seed: number;
  /** 输出音量，0–1。 */
  volume: number;
  /** 输出设备名;空为系统默认设备。 */
  outputDevice: string;
  /** 发给模型的环境提示词语言。 */
  promptLanguage: 'zh' | 'en';
}

export const SPEED_MIN = .6, SPEED_MAX = 1.6;

/** api_v2 只接受这个长度区间的参考音频,超出会直接回 400。 */
export const REF_MIN_SECONDS = 3, REF_MAX_SECONDS = 10;

/** `seed = -1` 表示每次重新采样(api_v2 的默认值);其余值固定种子。 */
export const SEED_RANDOM = -1;

export const GPT_SOVITS_DEFAULTS: GptSovitsConfigSection = {
  enabled: false,
  tier: 'auto',
  runtimeDir: '',
  serverUrl: '',
  autoStart: true,
  voice: { preset: DEFAULT_PRESET, name: '', audio: '', text: '' },
  voices: [],
  weights: { gpt: '', sovits: '' },
  speed: 1,
  seed: SEED_RANDOM,
  volume: 1,
  outputDevice: '',
  promptLanguage: 'zh',
};

const K = `worlds.${GPT_SOVITS_ID}`;

/** `x-options` 的选项源，由定义的 `configOptions` 给出。 */
export const TIER_OPTIONS = `${GPT_SOVITS_ID}:tier`;
export const DEVICE_OPTIONS = `${GPT_SOVITS_ID}:output-device`;
export const PROMPT_LANGUAGE_OPTIONS = `${GPT_SOVITS_ID}:prompt-language`;
export const VOICE_OPTIONS = `${GPT_SOVITS_ID}:voice`;

const TEXT = {
  zh: {
    title: 'GPTSovits 语音',
    preset: { title: '音色', description: '选预设，或选已保存的自定义音色。选「＋ 新建音色…」后填好下面的名称、参考音频与台本，就会自动保存成新音色。' },
    name: { title: '音色名称', description: '自定义音色的名字，改了即保存；留空用「未命名音色」。' },
    audio: { title: '参考音频', description: '3–10 秒的 WAV。选自定义音色时这里显示它的音频，换一个即替换该音色。' },
    text: { title: '参考音频的台本', description: '参考音频里说的话，要逐字一致；改了对当前音色生效。' },
    gptWeights: { title: '自备 GPT 权重', description: '自己训的 s1 权重(.ckpt)。与下面的 SoVITS 权重一起填才生效；都留空就用内置底模。选自定义音色时，这里改的是该音色自带的权重。' },
    sovitsWeights: { title: '自备 SoVITS 权重', description: '自己训的 s2 权重(.pth)，版本要和推理档一致(显卡档 v5turbo / CPU 档 v2ProPlus)。服务在跑时改这两项会就地换权重，不用重启。' },
    tier: { title: '推理档', auto: '自动', cuda: '显卡(NVIDIA)', cpu: 'CPU', description: '自动：检测到 NVIDIA 显卡用显卡档，否则用 CPU 档。修改后重启推理服务生效。' },
    speed: { title: '语速', description: '1 为原速。' },
    seed: { title: '采样种子', description: '-1 每次重新采样（同一句每次听起来都不同）；填 0 或正整数可固定，同一句每次逐字节一致。' },
    volume: { title: '音量' },
    outputDevice: { title: '输出设备', description: '留空使用系统默认设备。', system: '系统默认' },
    autoStart: { title: '随 Cortico 启动推理服务' },
    serverUrl: { title: '已有的 GPT-SoVITS 地址', description: '填写后连接这个 api_v2 服务，不在本机启动，也不下载运行时。' },
    runtimeDir: { title: '自备运行时目录', description: '含 runtime/python.exe 与 api_v2.py 的 GPT-SoVITS 目录；填写后不下载运行时。' },
    promptLanguage: { title: '提示词语言' },
  },
  en: {
    title: 'GPTSovits Voice',
    preset: { title: 'Voice', description: 'A preset, or a saved custom voice. Pick "+ New voice…", fill in the name, reference audio and transcript below, and it is saved automatically.' },
    name: { title: 'Voice name', description: 'Name of the custom voice; saved as you type. Empty means "Untitled voice".' },
    audio: { title: 'Reference audio', description: 'A 3–10 second WAV. For a custom voice this shows its audio; choose another file to replace it.' },
    text: { title: 'Reference transcript', description: 'The exact words spoken in the reference audio; edits apply to the current custom voice.' },
    gptWeights: { title: 'Own GPT weights', description: 'Your own trained s1 weights (.ckpt). Takes effect together with the SoVITS weights below; leave both empty to use the bundled base model. For a custom voice these are the voice’s own weights.' },
    sovitsWeights: { title: 'Own SoVITS weights', description: 'Your own trained s2 weights (.pth). Its version must match the tier (v5turbo on GPU, v2ProPlus on CPU). Editing either field switches the running server in place, no restart.' },
    tier: { title: 'Inference tier', auto: 'Auto', cuda: 'GPU (NVIDIA)', cpu: 'CPU', description: 'Auto uses the GPU tier when an NVIDIA GPU is found, the CPU tier otherwise. Takes effect when the inference server restarts.' },
    speed: { title: 'Speech rate', description: '1 is the original rate.' },
    seed: { title: 'Sampling seed', description: '-1 resamples every time (the same line sounds different each run); 0 or a positive integer fixes it, making the same line byte-identical.' },
    volume: { title: 'Volume' },
    outputDevice: { title: 'Output device', description: 'Empty for the system default.', system: 'System default' },
    autoStart: { title: 'Start the inference server with Cortico' },
    serverUrl: { title: 'Existing GPT-SoVITS address', description: 'Connects to this api_v2 server instead of starting one here; nothing is downloaded.' },
    runtimeDir: { title: 'Own runtime directory', description: 'A GPT-SoVITS directory with runtime/python.exe and api_v2.py; the runtime is not downloaded.' },
    promptLanguage: { title: 'Prompt language' },
  },
};

export function tierOptions(language: Language): Array<{ value: string; label: string }> {
  const t = pick(language, TEXT).tier;
  return [{ value: 'auto', label: t.auto }, { value: 'cuda', label: t.cuda }, { value: 'cpu', label: t.cpu }];
}

export const promptLanguageOptions = (): Array<{ value: string; label: string }> =>
  [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }];

export const systemDeviceLabel = (language: Language): string => pick(language, TEXT).outputDevice.system;

export function configGroups(language: Language): ConfigGroup[] {
  const t = pick(language, TEXT);
  return [{
    id: `world:${GPT_SOVITS_ID}`,
    owner: `world:${GPT_SOVITS_ID}`,
    schema: {
      type: 'object',
      title: t.title,
      properties: {
        [`${K}.voice.preset`]: { type: 'string', title: t.preset.title, description: t.preset.description, 'x-options': VOICE_OPTIONS, 'x-hot': true },
        [`${K}.voice.name`]: { type: 'string', title: t.name.title, description: t.name.description, 'x-hot': true },
        [`${K}.voice.audio`]: { type: 'string', title: t.audio.title, description: t.audio.description, 'x-path': { kind: 'file', extensions: ['.wav'] }, 'x-hot': true },
        [`${K}.voice.text`]: { type: 'string', title: t.text.title, description: t.text.description, 'x-hot': true },
        [`${K}.weights.gpt`]: { type: 'string', title: t.gptWeights.title, description: t.gptWeights.description, 'x-path': { kind: 'file', extensions: ['.ckpt'] }, 'x-hot': true },
        [`${K}.weights.sovits`]: { type: 'string', title: t.sovitsWeights.title, description: t.sovitsWeights.description, 'x-path': { kind: 'file', extensions: ['.pth'] }, 'x-hot': true },
        [`${K}.tier`]: { type: 'string', title: t.tier.title, description: t.tier.description, 'x-options': TIER_OPTIONS, 'x-hot': true },
        [`${K}.speed`]: { type: 'number', title: t.speed.title, description: t.speed.description, minimum: SPEED_MIN, maximum: SPEED_MAX, multipleOf: .05, 'x-hot': true },
        [`${K}.seed`]: { type: 'number', title: t.seed.title, description: t.seed.description, minimum: SEED_RANDOM, multipleOf: 1, 'x-hot': true },
        [`${K}.volume`]: { type: 'number', title: t.volume.title, minimum: 0, maximum: 1, multipleOf: .05, 'x-hot': true },
        [`${K}.outputDevice`]: { type: 'string', title: t.outputDevice.title, description: t.outputDevice.description, 'x-options': DEVICE_OPTIONS, 'x-hot': true },
        [`${K}.autoStart`]: { type: 'boolean', title: t.autoStart.title, 'x-hot': true },
        [`${K}.serverUrl`]: { type: 'string', title: t.serverUrl.title, description: t.serverUrl.description, 'x-hot': true },
        [`${K}.runtimeDir`]: { type: 'string', title: t.runtimeDir.title, description: t.runtimeDir.description, 'x-hot': true },
        [`${K}.promptLanguage`]: { type: 'string', title: t.promptLanguage.title, 'x-options': PROMPT_LANGUAGE_OPTIONS, 'x-hot': true },
      },
    },
  }];
}
