/**
 * 面板文案(中、英)与发给模型的状态词(按 `promptLanguage`)。浏览器侧的面板也用这张表，
 * 所以这里只 `import type` 框架：简体与繁体中文读中文，其余语言读英文。
 */
import type { Language } from 'cortico/core/language.ts';
import type { SpeechLang } from './synth.ts';

const PANEL = {
  zh: {
    label: 'GPTSovits 语音',
    panel: '语音',
    panelHint: '运行时与权重、推理服务、音色和试听。',
    voicesPanel: '音色',
    voicesPanelHint: '添加、编辑、删除自定义音色，点保存立即生效；这里选中的音色就是配置页「音色」下拉里的那个。',
    lamp: '推理服务',
    tier: '推理档',
    tierCuda: '显卡(V5 turbo)',
    tierCpu: 'CPU(v2ProPlus)',
    tierAuto: (found: boolean): string => (found ? '自动：检测到 NVIDIA 显卡' : '自动：没有检测到 NVIDIA 显卡'),
    runtime: '运行时',
    weights: '权重',
    trained: '权重来源',
    trainedOwn: '自备权重',
    trainedOfficial: '官模',
    trainedBuiltin: '内置底模',
    trainedHint: '想换成自己训的模型：在配置里填「自备 GPT 权重」与「自备 SoVITS 权重」，服务在跑时会就地换。',
    server: '推理服务',
    voice: '音色',
    ownRuntime: '自备目录',
    remote: '已有服务',
    ready: '已就绪',
    absent: '未安装',
    working: '下载中',
    error: '失败',
    unpublished: '这一档还没有发布运行时包，请在配置里填写自备运行时目录或已有服务地址。',
    stopped: '已停止',
    starting: '启动中',
    warming: '预热中',
    running: '运行中',
    asleep: '已休眠',
    install: '安装并启动',
    installSize: (mb: number) => `安装并启动(下载 ${mb} MB)`,
    cancel: '取消',
    start: '启动',
    stop: '停止',
    restart: '重启',
    test: '试听',
    testText: '你好呀，我现在可以说话啦。',
    hush: '停止播放',
    pickVoice: '选择参考音频',
    voiceText: '参考音频的文字',
    saveVoice: '保存音色',
    voiceHint: '预设音色在配置里选择。自定义：3–10 秒的 WAV,内容与下面填写的文字一致。',
    preset: '预设音色',
    usePreset: '改回预设音色',
    noVoice: '还没有参考音频',
    customVoices: '自定义音色',
    customVoicesHint: '名称 + 参考音频 + 台本必填；权重可选（成对，不填用内置底模）。',
    addVoice: '添加音色',
    confirmAdd: '完成添加',
    cancelAdd: '取消',
    voiceName: '音色名称',
    voiceNamePh: '比如：大肥鱼（开心版）',
    voiceAudio: '参考音频（必填，3–10 秒 WAV）',
    voiceTextRequired: '台本（必填，与音频逐字一致）',
    gptWeightOpt: '自备 GPT 权重（可选 .ckpt）',
    sovitsWeightOpt: '自备 SoVITS 权重（可选 .pth）',
    requiredHint: '参考音频和台本必须填写；权重可选，填了就随音色一起切换。',
    incomplete: '还没填完整：参考音频和台本是必填项，权重要么成对填、要么都不填。',
    use: '使用',
    using: '使用中',
    rename: '改名',
    edit: '编辑',
    remove: '删除',
    renamePh: '新名称，回车确认',
    queue: (n: number) => `排队 ${n} 句`,
    lastError: '上次合成失败',
    output: '推理服务输出',
    startMs: (s: number) => `启动用了 ${s} 秒`,
  },
  en: {
    label: 'GPTSovits Voice',
    panel: 'Voice',
    panelHint: 'Runtime and weights, the inference server, the voice and a test line.',
    voicesPanel: 'Voices',
    voicesPanelHint: 'Add, edit and delete custom voices; saving takes effect immediately. The selected voice here is the one in the config "Voice" dropdown.',
    lamp: 'Inference server',
    tier: 'Tier',
    tierCuda: 'GPU (V5 turbo)',
    tierCpu: 'CPU (v2ProPlus)',
    tierAuto: (found: boolean) => (found ? 'Auto: NVIDIA GPU found' : 'Auto: no NVIDIA GPU found'),
    runtime: 'Runtime',
    weights: 'Weights',
    trained: 'Weights in use',
    trainedOwn: 'Own weights',
    trainedOfficial: 'Official',
    trainedBuiltin: 'Bundled base',
    trainedHint: 'To use a model you trained: fill in "Own GPT weights" and "Own SoVITS weights" in the config; the running server switches in place.',
    server: 'Inference server',
    voice: 'Voice',
    ownRuntime: 'Own directory',
    remote: 'Existing server',
    ready: 'Ready',
    absent: 'Not installed',
    working: 'Downloading',
    error: 'Failed',
    unpublished: 'No runtime package is published for this tier yet; set an own runtime directory or an existing server address in the config.',
    stopped: 'Stopped',
    starting: 'Starting',
    warming: 'Warming up',
    running: 'Running',
    asleep: 'Asleep',
    install: 'Install and start',
    installSize: (mb: number) => `Install and start (${mb} MB download)`,
    cancel: 'Cancel',
    start: 'Start',
    stop: 'Stop',
    restart: 'Restart',
    test: 'Test',
    testText: 'Hello! I can talk now.',
    hush: 'Stop playback',
    pickVoice: 'Choose reference audio',
    voiceText: 'Text of the reference audio',
    saveVoice: 'Save voice',
    voiceHint: 'Pick a preset voice in the config. Custom: a 3–10 second WAV whose words match the text below.',
    preset: 'Preset voice',
    usePreset: 'Back to the preset voice',
    noVoice: 'No reference audio yet',
    customVoices: 'Custom voices',
    customVoicesHint: 'Name + reference audio + transcript are required; weights are optional (paired, empty = bundled base).',
    addVoice: 'Add voice',
    confirmAdd: 'Add',
    cancelAdd: 'Cancel',
    voiceName: 'Voice name',
    voiceNamePh: 'e.g. Fatfish (happy)',
    voiceAudio: 'Reference audio (required, 3–10 s WAV)',
    voiceTextRequired: 'Transcript (required, matches the audio word for word)',
    gptWeightOpt: 'Own GPT weights (optional .ckpt)',
    sovitsWeightOpt: 'Own SoVITS weights (optional .pth)',
    requiredHint: 'Reference audio and transcript are required; weights are optional and switch with the voice.',
    incomplete: 'Incomplete: reference audio and transcript are required; weights must be filled as a pair or left empty.',
    use: 'Use',
    using: 'In use',
    rename: 'Rename',
    edit: 'Edit',
    remove: 'Delete',
    renamePh: 'New name, Enter to confirm',
    queue: (n: number) => `${n} queued`,
    lastError: 'Last synthesis failed',
    output: 'Inference server output',
    startMs: (s: number) => `Started in ${s} s`,
  },
};

export type PanelText = (typeof PANEL)['zh'];
export const panelText = (language: Language): PanelText => (language === 'zh' || language === 'zh-Hant' ? PANEL.zh : PANEL.en);

/** `{{sovits.state}}` 的取值。 */
const STATE = {
  zh: {
    available: '可用', notInstalled: '未安装', starting: '启动中', asleep: '已休眠（下一句自动唤醒）', noVoice: '没有设置参考音频', error: (d: string): string => `出错(${d})`,
    nowAvailable: '语音可用了。', nowUnavailable: (d: string): string => `语音不可用了:${d}`,
  },
  en: {
    available: 'available', notInstalled: 'not installed', starting: 'starting', asleep: 'asleep (wakes on the next line)', noVoice: 'no reference audio set', error: (d: string): string => `failed (${d})`,
    nowAvailable: 'The voice is available now.', nowUnavailable: (d: string): string => `The voice is unavailable now: ${d}`,
  },
};

export type StateWords = (typeof STATE)['zh'];
export const stateWords = (language: 'zh' | 'en'): StateWords => STATE[language];

/**
 * `{{sovits.share}}` 的取值：开着「交给其他插件」时告诉 bot 怎么把同一句发给别的插件（QQ 等），
 * 没开就留空——那一行提示词会变成空行，不影响其余内容。
 */
const SHARE = {
  zh: '想把同一句话发到 QQ 等消息渠道时，用这次 `sovits_speak` 回执里的 `[blob …]` 音频句柄作为发送工具的音频来源（例如 `qq_draft` 的 voice 参数），不要再合成一遍；这一句是发给那种渠道、不想在对方电脑外放时，给这次 `sovits_speak` 带上 `silent: true`。',
  en: 'To send the same line to a chat channel such as QQ, use the audio `[blob …]` handle from this `sovits_speak` result as the audio for that send tool (the `qq_draft` voice parameter, for example) instead of synthesizing it again; when the line is meant for such a channel and should not be played on this computer, pass `silent: true` to that `sovits_speak`.',
};

export const shareWords = (language: 'zh' | 'en', on: boolean): string => (on ? SHARE[language] : '');

/**
 * `{{sovits.language}}` 与语言切换事件的取值：告诉 bot 这句台词该怎么写。
 * 中文＝直接照读聊天文字；日语/英语＝先把中文台词翻译过去（气泡仍是聊天语言）。
 */
const LANGUAGE = {
  zh: {
    auto: { name: '自动识别', rule: '`sovits_speak` 的 text 与这次 `pet_say` 的 script 逐字相同。' },
    zh: { name: '中文', rule: '`sovits_speak` 的 text 与这次 `pet_say` 的 script 逐字相同；直接用中文想这句台词，不要先用日语或英语组织再翻译。' },
    en: { name: '英语', rule: '`pet_say` 的 script 保持聊天语言（通常是中文）；`sovits_speak` 的 text 是这句台词自然、口语化的英语翻译（标记照抄），不要夹中文，也不要把翻译过程念出来。' },
    ja: { name: '日语', rule: '`pet_say` 的 script 保持聊天语言（通常是中文）；`sovits_speak` 的 text 是这句台词自然、口语化的日语翻译（标记照抄），不要夹中文，也不要把翻译过程念出来。' },
    ko: { name: '韩语', rule: '`pet_say` 的 script 保持聊天语言（通常是中文）；`sovits_speak` 的 text 是这句台词自然、口语化的韩语翻译（标记照抄），不要夹中文，也不要把翻译过程念出来。' },
  },
  en: {
    auto: { name: 'auto', rule: 'the `sovits_speak` text is identical to this `pet_say` script.' },
    zh: { name: 'Chinese', rule: 'the `sovits_speak` text is identical to this `pet_say` script; write the line directly in Chinese instead of composing it in Japanese or English first.' },
    en: { name: 'English', rule: '`pet_say` stays in the chat language (usually Chinese); the `sovits_speak` text is a natural, spoken English translation of that line (copy the markup), with no Chinese left in it and no translation notes read aloud.' },
    ja: { name: 'Japanese', rule: '`pet_say` stays in the chat language (usually Chinese); the `sovits_speak` text is a natural, spoken Japanese translation of that line (copy the markup), with no Chinese left in it and no translation notes read aloud.' },
    ko: { name: 'Korean', rule: '`pet_say` stays in the chat language (usually Chinese); the `sovits_speak` text is a natural, spoken Korean translation of that line (copy the markup), with no Chinese left in it and no translation notes read aloud.' },
  },
};

export interface LanguageWords { name: string; rule: string }

export const languageWords = (promptLanguage: 'zh' | 'en', textLang: SpeechLang): LanguageWords =>
  LANGUAGE[promptLanguage][textLang] ?? LANGUAGE[promptLanguage].auto;
