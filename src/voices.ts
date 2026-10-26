/**
 * 随包的预设音色，放在 `assets/voices/<id>.wav`,参考文字在同名 `.txt`。
 * - `xll`：官方微调音色「大肥鱼_星落落版本」，蒸自肥鱼 CosyVoice3，中文/英文两套参考；
 * - `dfy`：本仓旧默认音色（日语，5.16 秒），另有中文/英文参考；
 * - `female` / `male`：原作者的 MOSS-VoiceGenerator 生成音色，描述与种子见 `prompts.json`。
 * 面板也用这张表，所以这里不引用 Node 模块;文件路径在 world.ts 里拼。
 */
import type { Language } from 'cortico/core/language.ts';
import type { SpeechLang } from './synth.ts';

export const VOICE_PRESETS = ['xll', 'dfy', 'female', 'male'] as const;
export type VoicePreset = (typeof VOICE_PRESETS)[number];
export const DEFAULT_PRESET: VoicePreset = 'xll';

const LABEL = {
  zh: { xll: '大肥鱼_星落落版本(中英)', dfy: '大肥鱼(日中英)', female: '女声', male: '男声' },
  en: { xll: 'Fatfish Xll (ZH/EN)', dfy: 'Fatfish (JA/ZH/EN)', female: 'Female', male: 'Male' },
};

export function presetLabel(id: VoicePreset, language: Language): string {
  return (language === 'zh' || language === 'zh-Hant' ? LABEL.zh : LABEL.en)[id];
}

/** 下拉里展示的参考文件；分语言参考把两个文件名都列出来，避免用户以为包里只有一个 wav。 */
const PRESET_FILE_LABEL: Record<VoicePreset, string> = {
  xll: 'xll.zh.wav / xll.en.wav',
  dfy: 'dfy.wav / dfy.zh.wav / dfy.en.wav',
  female: 'female.wav',
  male: 'male.wav',
};

export const presetFileLabel = (id: VoicePreset): string => PRESET_FILE_LABEL[id];

/** 每种预设在各语言下的参考文件基准名；没有对应语言的参考时回退到该预设的默认语言。 */
const PRESET_LANG_FILES: Record<VoicePreset, Partial<Record<Exclude<SpeechLang, 'auto'>, string>>> = {
  xll: { zh: 'xll.zh', en: 'xll.en' },
  dfy: { ja: 'dfy', zh: 'dfy.zh', en: 'dfy.en' },
  female: { zh: 'female' },
  male: { zh: 'male' },
};

const PRESET_DEFAULT_LANG: Record<VoicePreset, Exclude<SpeechLang, 'auto'>> = {
  xll: 'zh', dfy: 'ja', female: 'zh', male: 'zh',
};

/** 某个预设在这个语音语言下该用哪套参考；`auto` 用预设的默认语言。 */
export function presetRefId(id: VoicePreset, textLang: SpeechLang): string {
  const lang = textLang === 'auto' ? PRESET_DEFAULT_LANG[id] : textLang;
  return PRESET_LANG_FILES[id][lang] ?? PRESET_LANG_FILES[id][PRESET_DEFAULT_LANG[id]]!;
}

export const isPreset = (v: string): v is VoicePreset => (VOICE_PRESETS as readonly string[]).includes(v);
