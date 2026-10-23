/**
 * 随包的预设音色，放在 `assets/voices/<id>.wav`,参考文字在同名 `.txt`。
 * - `dfy`：本仓默认音色（日语，5.16 秒），随包一起发；
 * - `female` / `male`：原作者的 MOSS-VoiceGenerator 生成音色，描述与种子见 `prompts.json`。
 * 面板也用这张表，所以这里不引用 Node 模块;文件路径在 world.ts 里拼。
 */
import type { Language } from 'cortico/core/language.ts';

export const VOICE_PRESETS = ['dfy', 'female', 'male'] as const;
export type VoicePreset = (typeof VOICE_PRESETS)[number];
export const DEFAULT_PRESET: VoicePreset = 'dfy';

const LABEL = {
  zh: { dfy: '大肥鱼(日语)', female: '女声', male: '男声' },
  en: { dfy: 'Fatfish (JP)', female: 'Female', male: 'Male' },
};

export function presetLabel(id: VoicePreset, language: Language): string {
  return (language === 'zh' || language === 'zh-Hant' ? LABEL.zh : LABEL.en)[id];
}

export const isPreset = (v: string): v is VoicePreset => (VOICE_PRESETS as readonly string[]).includes(v);
