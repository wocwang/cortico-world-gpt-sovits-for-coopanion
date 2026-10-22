import type { ConfigGroup } from 'cortico/core/types.ts';
import { pick, type Language } from 'cortico/core/language.ts';

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
   * 预设音色(见 voices.ts);`audio` 填了参考音频的绝对路径时用它与 `text`,语言按 `auto` 识别。
   * `auxAudio` 是可选的辅助参考音频,与主参考一起融合音色,语调起伏更丰富。
   */
  voice: { preset: string; audio: string; text: string; auxAudio: string };
  /** 语速倍率，对应 api_v2 的 `speed_factor`。 */
  speed: number;
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

export const GPT_SOVITS_DEFAULTS: GptSovitsConfigSection = {
  enabled: false,
  tier: 'auto',
  runtimeDir: '',
  serverUrl: '',
  autoStart: true,
  voice: { preset: 'female', audio: '', text: '', auxAudio: '' },
  speed: 1,
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
    preset: { title: '音色', description: '填了自定义参考音频时用自定义的。' },
    audio: { title: '自定义参考音频', description: '3–10 秒的 WAV。填了就不用上面的预设音色，清空后改回预设。' },
    text: { title: '参考音频的台本', description: '参考音频里说的话，要逐字一致。' },
    auxAudio: { title: '辅助参考音频', description: '可选。与上面的参考音频一起融合音色，语调起伏更丰富；仅 V1/V2 权重生效，V3/V4/V5（含默认底模）会被忽略。留空只用主参考。' },
    tier: { title: '推理档', auto: '自动', cuda: '显卡(NVIDIA)', cpu: 'CPU', description: '自动：检测到 NVIDIA 显卡用显卡档，否则用 CPU 档。修改后重启推理服务生效。' },
    speed: { title: '语速', description: '1 为原速。' },
    volume: { title: '音量' },
    outputDevice: { title: '输出设备', description: '留空使用系统默认设备。', system: '系统默认' },
    autoStart: { title: '随 Cortico 启动推理服务' },
    serverUrl: { title: '已有的 GPT-SoVITS 地址', description: '填写后连接这个 api_v2 服务，不在本机启动，也不下载运行时。' },
    runtimeDir: { title: '自备运行时目录', description: '含 runtime/python.exe 与 api_v2.py 的 GPT-SoVITS 目录；填写后不下载运行时。' },
    promptLanguage: { title: '提示词语言' },
  },
  en: {
    title: 'GPTSovits Voice',
    preset: { title: 'Voice', description: 'A custom reference audio takes precedence.' },
    audio: { title: 'Custom reference audio', description: 'A 3–10 second WAV. When set, the preset voice above is not used; clear it to go back to the preset.' },
    text: { title: 'Reference transcript', description: 'The exact words spoken in the reference audio.' },
    auxAudio: { title: 'Auxiliary reference audio', description: 'Optional. Blended with the reference above for livelier intonation; only takes effect with V1/V2 weights and is ignored by V3/V4/V5 (including the default base model). Leave empty to use the main reference alone.' },
    tier: { title: 'Inference tier', auto: 'Auto', cuda: 'GPU (NVIDIA)', cpu: 'CPU', description: 'Auto uses the GPU tier when an NVIDIA GPU is found, the CPU tier otherwise. Takes effect when the inference server restarts.' },
    speed: { title: 'Speech rate', description: '1 is the original rate.' },
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
        [`${K}.voice.audio`]: { type: 'string', title: t.audio.title, description: t.audio.description, 'x-path': { kind: 'file', extensions: ['.wav'] }, 'x-hot': true },
        [`${K}.voice.text`]: { type: 'string', title: t.text.title, description: t.text.description, 'x-hot': true },
        [`${K}.voice.auxAudio`]: { type: 'string', title: t.auxAudio.title, description: t.auxAudio.description, 'x-path': { kind: 'file', extensions: ['.wav'] }, 'x-hot': true },
        [`${K}.tier`]: { type: 'string', title: t.tier.title, description: t.tier.description, 'x-options': TIER_OPTIONS, 'x-hot': true },
        [`${K}.speed`]: { type: 'number', title: t.speed.title, description: t.speed.description, minimum: SPEED_MIN, maximum: SPEED_MAX, multipleOf: .05, 'x-hot': true },
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
