import type { ConfigGroup } from 'cortico/core/types.ts';
import { pick, type Language } from 'cortico/core/language.ts';
import type { CustomVoice } from './custom-voice.ts';
import type { SpeechLang } from './synth.ts';
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
   * 闲置这么多分钟就停掉本机推理服务，释放显存/内存；下一句自动重新加载。
   * `0` 为不停。只对本机服务生效，连已有服务时没有意义。
   */
  idleMinutes: number;
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
   * 合成语言，对应 api_v2 的 `text_lang`，同时决定 bot 怎么写台词：
   * `zh` 直接照读聊天文字；`en` / `ja` 先把聊天文字翻译成该语言再念；`auto` 跟随原文。
   */
  textLang: SpeechLang;
  /**
   * 翻译模型（OpenAI 兼容 `POST {endpoint}/chat/completions`）：`textLang` 选 en/ja/ko 时，
   * 先把文字整段翻译成该语言再送合成（切句由服务端的 `cut5` 在译文上做）。
   * 三项任一留空就不翻译、按原文合成；密钥写部署 `.env` 里的变量名，运行时经框架读取。
   */
  translateEndpoint: string;
  translateApiKeySecret: string;
  translateModel: string;
  /** 每句合成完另存一个 WAV，供其他程序（如 QQ 机器人）取用。 */
  saveAudio: boolean;
  /** 语音保存目录；空为 `<data>/gpt-sovits/out`。 */
  saveDir: string;
  /** 保存的语音保留多少小时；0 为一直留着。只清理本插件写出的 `line-*.wav`。 */
  saveKeepHours: number;
  /**
   * 把整句语音作为工具回执的附件交出去：其他插件（如 QQ）能用回执里的 `[blob …]` 句柄发送同一段音频。
   * 开启后 `sovits_speak` 要等整句合成完，气泡会比往常晚一点出现。
   */
  shareAudio: boolean;
  /** 本机外放；关掉后语音只合成、不在本机出声（适合语音只发给 QQ 的场景）。 */
  playLocally: boolean;
  /**
   * 对其他插件开放本地 HTTP 语音接口：QQ 插件（cortico-world-qq-final 等）把「语音模型网址」指过来，
   * 就能用本插件的声音合成并发到 QQ。只监听 127.0.0.1。
   */
  httpApi: boolean;
  /** HTTP 语音接口的端口；默认 9880。改端口要重挂扩展（重启 World）才生效。 */
  httpPort: number;
  /** HTTP 语音接口的访问令牌；留空不校验（接口只监听回环地址）。 */
  httpToken: string;
  /** 由对方插件自己合成语音的渠道（如 QQ）：开启后提示词让 bot 不为这些回复调用 sovits_speak。 */
  channelVoice: boolean;
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
  idleMinutes: 0,
  voice: { preset: DEFAULT_PRESET, name: '', audio: '', text: '' },
  voices: [],
  weights: { gpt: '', sovits: '' },
  speed: 1,
  textLang: 'zh',
  translateEndpoint: '',
  translateApiKeySecret: '',
  translateModel: '',
  saveAudio: false,
  saveDir: '',
  saveKeepHours: 0,
  shareAudio: false,
  playLocally: true,
  httpApi: false,
  httpPort: 9880,
  httpToken: '',
  channelVoice: false,
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
export const TEXT_LANGUAGE_OPTIONS = `${GPT_SOVITS_ID}:text-language`;
export const VOICE_OPTIONS = `${GPT_SOVITS_ID}:voice`;

const TEXT = {
  zh: {
    title: 'GPTSovits 语音',
    groupVoice: { title: '音色与台词', description: '选音色、配参考音频与自备权重，以及这句台词怎么说（语言、语速、种子）。' },
    groupOutput: { title: '输出与保存', description: '声音从哪出、要不要在本机外放、要不要落盘保存。' },
    groupLink: { title: '与其他插件联动', description: '把语音交给 QQ 等插件：新插件（cortico-world-qq-final）用本地语音接口，老插件（cortico-world-qq）用附件句柄。两条路别同时开。' },
    groupService: { title: '推理服务', description: '推理档、随程序自启、闲置停服，以及改用自备运行时目录或已有服务。' },
    preset: { title: '音色', description: '预设或已保存的音色（音色名后 ✓ 表示已配置完整）。添加、改名、换音频/权重都在「音色」页里做。' },
    audio: { title: '参考音频', description: '3–10 秒的 WAV。这里是当前音色的参考音频，与「音色」页同步。' },
    text: { title: '参考音频的台本', description: '参考音频里说的话，要逐字一致。' },
    gptWeights: { title: '自备 GPT 权重', description: '自己训的 s1 权重(.ckpt)。与下面的 SoVITS 权重一起填才生效；都留空就用内置底模。选自定义音色时，这里改的是该音色自带的权重。' },
    sovitsWeights: { title: '自备 SoVITS 权重', description: '自己训的 s2 权重(.pth)，版本要和推理档一致(显卡档 v5turbo / CPU 档 v2ProPlus)。服务在跑时改这两项会就地换权重，不用重启。' },
    tier: { title: '推理档', auto: '自动', cuda: '显卡(NVIDIA)', cpu: 'CPU', description: '自动：检测到 NVIDIA 显卡用显卡档，否则用 CPU 档。修改后重启推理服务生效。' },
    speed: { title: '语速', description: '1 为原速。' },
    textLang: {
      title: '语音语言',
      description: '与界面语言无关。中文：直接照读聊天框里的这句文字；English / 日本語：先把聊天文字翻译成该语言再念（气泡文字不变）。',
      auto: '跟随原文（不翻译）', zh: '中文（直接照读）', en: 'English（先翻译）', ja: '日本語（先翻译）',
    },
    translateEndpoint: { title: '翻译模型地址', description: 'OpenAI 兼容接口的基址（如 https://api.deepseek.com/v1）。语音语言选「先翻译」时，聊天文字会先译成目标语言再念；留空则按原文念。' },
    translateApiKeySecret: { title: '翻译模型密钥变量名', description: '部署 .env 里的变量名（如 DEEPSEEK_API_KEY），不是密钥本身；留空表示接口不需要鉴权。' },
    translateModel: { title: '翻译模型名称', description: '如 deepseek-chat。地址、变量名、模型名凑齐才启用翻译。' },
    saveAudio: { title: '把语音保存成文件', description: '每句合成完另存一个 WAV，方便交给其他程序（如 QQ 机器人）发送。' },
    saveDir: { title: '语音保存目录', description: '留空为插件数据目录下的 gpt-sovits\\out。' },
    saveKeepHours: { title: '语音文件保留时长（小时）', description: '只清理本插件写出的 line-*.wav，别的文件不动；保存新语音时顺手清理过期的。0 为一直留着。' },
    shareAudio: { title: '把整句语音交给其他插件', description: '合成完把这一句的音频作为回执附件交出去：QQ 等插件可以用回执里的 [blob …] 句柄发送同一段音频，不必再读文件。代价是这句台词要等整句合成完才回执，气泡比往常晚一点出现。' },
    playLocally: { title: '本机外放', description: '关掉后语音不在本机出声，只合成——语音只发给 QQ 等渠道时用它。桌宠气泡不受影响；某一句想临时不播，让 bot 调 sovits_speak 时带 silent 参数即可。' },
    httpApi: { title: '开放本地语音接口', description: '给其他插件取音频用：QQ 插件（cortico-world-qq-final 等）把「语音模型网址」填成本机地址，就能用这个声音合成并发到 QQ。只监听 127.0.0.1，开关与端口改动需重挂扩展（重启 World）生效。' },
    httpPort: { title: '语音接口端口', description: '默认 9880。与别的程序冲突时换一个。' },
    httpToken: { title: '语音接口令牌', description: '留空不校验（接口只监听本机回环地址）。填了以后对方请求要带 Authorization: Bearer 或 ?token=。' },
    channelVoice: { title: '其他渠道的语音交给对方插件', description: '开启后提示词会告诉 bot：在由对方插件自己合成语音的渠道（如 QQ）回复时不要调用 sovits_speak，要发语音就在对方工具里打开语音开关（qq-final 的 qq_send 传 voice=true），由对方用本插件的声音合成；本机对话页照常出声。配合「开放本地语音接口」+ QQ 插件自带语音时用。' },
    seed: { title: '采样种子', description: '-1 每次重新采样（同一句每次听起来都不同）；填 0 或正整数可固定，同一句每次逐字节一致。' },
    volume: { title: '音量' },
    outputDevice: { title: '输出设备', description: '留空使用系统默认设备。', system: '系统默认' },
    autoStart: { title: '随 Cortico 启动推理服务' },
    idle: { title: '闲置停服', description: '多久不说话就停掉本机推理服务，把显存和内存让出来；下一句会自动重新加载（显卡档通常十几秒）。0 为不停。只对本机服务生效。' },
    serverUrl: { title: '已有的 GPT-SoVITS 地址', description: '填写后连接这个 api_v2 服务，不在本机启动，也不下载运行时。' },
    runtimeDir: { title: '自备运行时目录', description: '含 runtime/python.exe 与 api_v2.py 的 GPT-SoVITS 目录；填写后不下载运行时。' },
    promptLanguage: { title: '提示词语言' },
  },
  en: {
    title: 'GPTSovits Voice',
    groupVoice: { title: 'Voice and lines', description: 'Pick the voice, its reference audio and own weights, and how a line is spoken (language, speed, seed).' },
    groupOutput: { title: 'Output and saving', description: 'Where the sound comes out, whether it plays on this computer, and whether lines are written to files.' },
    groupLink: { title: 'Other plugins (QQ voice)', description: 'Hand the voice to QQ: the new plugin (cortico-world-qq-final) calls the local voice API; the old one (cortico-world-qq) takes an attachment handle. Do not enable both.' },
    groupService: { title: 'Inference service', description: 'Tier, start with the app, stop-when-idle, and switching to your own runtime directory or an existing server.' },
    preset: { title: 'Voice', description: 'A preset or a saved voice (a ✓ after the name means fully configured). Add, rename and edit voices on the "Voices" page.' },
    audio: { title: 'Reference audio', description: 'A 3–10 second WAV. The reference audio of the current voice, kept in sync with the "Voices" page.' },
    text: { title: 'Reference transcript', description: 'The exact words spoken in the reference audio.' },
    gptWeights: { title: 'Own GPT weights', description: 'Your own trained s1 weights (.ckpt). Takes effect together with the SoVITS weights below; leave both empty to use the bundled base model. For a custom voice these are the voice’s own weights.' },
    sovitsWeights: { title: 'Own SoVITS weights', description: 'Your own trained s2 weights (.pth). Its version must match the tier (v5turbo on GPU, v2ProPlus on CPU). Editing either field switches the running server in place, no restart.' },
    tier: { title: 'Inference tier', auto: 'Auto', cuda: 'GPU (NVIDIA)', cpu: 'CPU', description: 'Auto uses the GPU tier when an NVIDIA GPU is found, the CPU tier otherwise. Takes effect when the inference server restarts.' },
    speed: { title: 'Speech rate', description: '1 is the original rate.' },
    textLang: {
      title: 'Speech language',
      description: 'Independent of the UI language. Chinese: reads the chat line as-is; English / Japanese: translates the chat line into that language first (the bubble text stays unchanged).',
      auto: 'Follow the text (no translation)', zh: 'Chinese (read as-is)', en: 'English (translate first)', ja: '日本語 (translate first)',
    },
    translateEndpoint: { title: 'Translation API URL', description: 'Base URL of an OpenAI-compatible API (e.g. https://api.deepseek.com/v1). Used to translate the chat line before speaking when the speech language asks for translation; empty reads the text as-is.' },
    translateApiKeySecret: { title: 'Translation key variable', description: 'Name of the variable in the deployment .env (e.g. DEEPSEEK_API_KEY), not the key itself; empty sends no auth header.' },
    translateModel: { title: 'Translation model', description: 'e.g. deepseek-chat. Translation turns on when the URL, variable and model are all set.' },
    saveAudio: { title: 'Save the speech to files', description: 'Also writes every synthesized line to a WAV file, so other programs (a QQ bot, for example) can send it.' },
    saveDir: { title: 'Speech folder', description: 'Empty uses gpt-sovits\\out under the plugin data folder.' },
    saveKeepHours: { title: 'Keep speech files (hours)', description: 'Only removes line-*.wav files written by this plugin, nothing else; expired ones are swept whenever a new line is saved. 0 keeps everything.' },
    shareAudio: { title: 'Hand each line to other plugins', description: 'Returns the finished line as a result attachment, so plugins like QQ can send the same audio with the [blob …] handle instead of reading a file. The line must finish synthesizing first, so the bubble appears a little later than before.' },
    playLocally: { title: 'Play on this computer', description: 'When off, lines are synthesized but not played here — handy when the voice only goes to QQ. Bubbles are unaffected; for a single line, have the bot pass silent to sovits_speak.' },
    httpApi: { title: 'Serve a local voice API', description: 'For other plugins to fetch audio: point a QQ plugin\'s (cortico-world-qq-final, for example) voice model URL at this computer and it can synthesize with this voice and send it to QQ. Loopback only; toggling it or the port needs the extension remounted (World restarted).' },
    httpPort: { title: 'Voice API port', description: 'Defaults to 9880; change it if something else uses that port.' },
    httpToken: { title: 'Voice API token', description: 'Empty means no check (the server listens on loopback only). When set, callers must send Authorization: Bearer or ?token=.' },
    channelVoice: { title: 'Channel voice comes from the other plugin', description: 'When on, the prompt tells the bot not to call sovits_speak for replies on channels whose plugin synthesizes voice itself (QQ, for example), so the same line is not spoken here too; the chat page keeps its voice. Use it with the local voice API and a voice-capable QQ plugin.' },
    seed: { title: 'Sampling seed', description: '-1 resamples every time (the same line sounds different each run); 0 or a positive integer fixes it, making the same line byte-identical.' },
    volume: { title: 'Volume' },
    outputDevice: { title: 'Output device', description: 'Empty for the system default.', system: 'System default' },
    autoStart: { title: 'Start the inference server with Cortico' },
    idle: { title: 'Stop when idle', description: 'Stops the local inference server after this many minutes without speech, freeing VRAM and RAM; the next line reloads it (usually ten-odd seconds on GPU). 0 keeps it running. Local server only.' },
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

export function textLanguageOptions(language: Language): Array<{ value: string; label: string }> {
  const t = pick(language, TEXT).textLang;
  return [{ value: 'auto', label: t.auto }, { value: 'zh', label: t.zh }, { value: 'en', label: t.en }, { value: 'ja', label: t.ja }];
}

export const systemDeviceLabel = (language: Language): string => pick(language, TEXT).outputDevice.system;

/**
 * 配置按用途拆成多组：设置页会把每组渲染成一张可折叠卡片，避免一长条。
 * 组 id 唯一即可，值仍写在 `worlds.gpt-sovits.*` 下。
 */
export function configGroups(language: Language): ConfigGroup[] {
  const t = pick(language, TEXT);
  const owner = `world:${GPT_SOVITS_ID}`;
  return [
    {
      id: owner,
      owner,
      schema: {
        type: 'object',
        title: t.groupVoice.title,
        description: t.groupVoice.description,
        properties: {
          [`${K}.voice.preset`]: { type: 'string', title: t.preset.title, description: t.preset.description, 'x-options': VOICE_OPTIONS, 'x-hot': true },
          [`${K}.voice.audio`]: { type: 'string', title: t.audio.title, description: t.audio.description, 'x-path': { kind: 'file', extensions: ['.wav'] }, 'x-hot': true },
          [`${K}.voice.text`]: { type: 'string', title: t.text.title, description: t.text.description, 'x-hot': true },
          [`${K}.weights.gpt`]: { type: 'string', title: t.gptWeights.title, description: t.gptWeights.description, 'x-path': { kind: 'file', extensions: ['.ckpt'] }, 'x-hot': true },
          [`${K}.weights.sovits`]: { type: 'string', title: t.sovitsWeights.title, description: t.sovitsWeights.description, 'x-path': { kind: 'file', extensions: ['.pth'] }, 'x-hot': true },
          [`${K}.textLang`]: { type: 'string', title: t.textLang.title, description: t.textLang.description, 'x-options': TEXT_LANGUAGE_OPTIONS, 'x-hot': true },
          [`${K}.translateEndpoint`]: { type: 'string', title: t.translateEndpoint.title, description: t.translateEndpoint.description, 'x-hot': true },
          [`${K}.translateApiKeySecret`]: { type: 'string', title: t.translateApiKeySecret.title, description: t.translateApiKeySecret.description, 'x-hot': true },
          [`${K}.translateModel`]: { type: 'string', title: t.translateModel.title, description: t.translateModel.description, 'x-hot': true },
          [`${K}.speed`]: { type: 'number', title: t.speed.title, description: t.speed.description, minimum: SPEED_MIN, maximum: SPEED_MAX, multipleOf: .05, 'x-hot': true },
          [`${K}.seed`]: { type: 'number', title: t.seed.title, description: t.seed.description, minimum: SEED_RANDOM, multipleOf: 1, 'x-hot': true },
          [`${K}.promptLanguage`]: { type: 'string', title: t.promptLanguage.title, 'x-options': PROMPT_LANGUAGE_OPTIONS, 'x-hot': true },
        },
      },
    },
    {
      id: `${owner}:output`,
      owner,
      schema: {
        type: 'object',
        title: t.groupOutput.title,
        description: t.groupOutput.description,
        properties: {
          [`${K}.playLocally`]: { type: 'boolean', title: t.playLocally.title, description: t.playLocally.description, 'x-hot': true },
          [`${K}.volume`]: { type: 'number', title: t.volume.title, minimum: 0, maximum: 1, multipleOf: .05, 'x-hot': true },
          [`${K}.outputDevice`]: { type: 'string', title: t.outputDevice.title, description: t.outputDevice.description, 'x-options': DEVICE_OPTIONS, 'x-hot': true },
          [`${K}.saveAudio`]: { type: 'boolean', title: t.saveAudio.title, description: t.saveAudio.description, 'x-hot': true },
          [`${K}.saveDir`]: { type: 'string', title: t.saveDir.title, description: t.saveDir.description, 'x-path': { kind: 'directory' }, 'x-hot': true },
          [`${K}.saveKeepHours`]: { type: 'number', title: t.saveKeepHours.title, description: t.saveKeepHours.description, minimum: 0, multipleOf: 1, 'x-hot': true },
        },
      },
    },
    {
      id: `${owner}:link`,
      owner,
      schema: {
        type: 'object',
        title: t.groupLink.title,
        description: t.groupLink.description,
        properties: {
          [`${K}.httpApi`]: { type: 'boolean', title: t.httpApi.title, description: t.httpApi.description, 'x-hot': true },
          [`${K}.httpPort`]: { type: 'number', title: t.httpPort.title, description: t.httpPort.description, minimum: 1, maximum: 65535, multipleOf: 1, 'x-hot': true },
          [`${K}.httpToken`]: { type: 'string', title: t.httpToken.title, description: t.httpToken.description, 'x-hot': true },
          [`${K}.channelVoice`]: { type: 'boolean', title: t.channelVoice.title, description: t.channelVoice.description, 'x-hot': true },
          [`${K}.shareAudio`]: { type: 'boolean', title: t.shareAudio.title, description: t.shareAudio.description, 'x-hot': true },
        },
      },
    },
    {
      id: `${owner}:service`,
      owner,
      schema: {
        type: 'object',
        title: t.groupService.title,
        description: t.groupService.description,
        properties: {
          [`${K}.tier`]: { type: 'string', title: t.tier.title, description: t.tier.description, 'x-options': TIER_OPTIONS, 'x-hot': true },
          [`${K}.autoStart`]: { type: 'boolean', title: t.autoStart.title, 'x-hot': true },
          [`${K}.idleMinutes`]: { type: 'number', title: t.idle.title, description: t.idle.description, minimum: 0, multipleOf: 1, 'x-hot': true },
          [`${K}.serverUrl`]: { type: 'string', title: t.serverUrl.title, description: t.serverUrl.description, 'x-hot': true },
          [`${K}.runtimeDir`]: { type: 'string', title: t.runtimeDir.title, description: t.runtimeDir.description, 'x-hot': true },
        },
      },
    },
  ];
}
