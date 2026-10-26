import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelsRoot, runtimesRoot } from 'cortico/paths.ts';
import { describeTools, type WorldDefinition, type WorldDescribe } from 'cortico/world.ts';
import {
  DEVICE_OPTIONS, GPT_SOVITS_DEFAULTS, GPT_SOVITS_ID, PROMPT_LANGUAGE_OPTIONS, TEXT_LANGUAGE_OPTIONS, TIER_OPTIONS, VOICE_OPTIONS,
  promptLanguageOptions, systemDeviceLabel, textLanguageOptions, tierOptions, type GptSovitsConfigSection,
} from './config.ts';
import { listOutputDevices } from './player.ts';
import { SOVITS_TOOL_DECLS } from './tools.ts';
import { VOICE_PRESETS, presetFileLabel, presetLabel } from './voices.ts';
import { customVoiceOptions } from './voice-options.ts';
import { GptSovitsWorld, LANGUAGE_EVENT, STATE_EVENT } from './world.ts';

const DESCRIBE: WorldDescribe = {
  tools: describeTools(SOVITS_TOOL_DECLS, {
    sovits_speak: { zh: '用 GPT-SoVITS 把一句台词念出来，排在没念完的句子后面。', en: 'Says a line aloud with GPT-SoVITS, after any line still playing.' },
    sovits_hush: { zh: '停下正在念的句子并清空队列。', en: 'Stops the line playing and drops the queue.' },
  }),
  events: [{
    type: STATE_EVENT,
    description: { zh: '语音变为可用或不可用，随下一批事件送达。', en: 'The voice became available or unavailable; delivered with the next batch of events.' },
    trigger: 'piggyback',
  }, {
    type: LANGUAGE_EVENT,
    description: { zh: '语音语言被切换，随后台词该怎么写（直接照读还是先翻译）。', en: 'The speech language changed, and how the next lines should be written (read as-is or translated first).' },
    trigger: 'piggyback',
  }],
};

/**
 * 自定义音色由 voice-options.ts 提供动态选项（world 启动时注册），这里合并进音色下拉。
 */
/** 预设的参考文字片段，拼进下拉选项里（读包内 `.txt`，读不到就只显示文件名）。 */
const presetSnippet = (id: string): string => {
  try {
    const text = readFileSync(fileURLToPath(new URL(`../assets/voices/${id}.txt`, import.meta.url)), 'utf8').trim();
    const chars = [...text];
    return chars.length ? ` · ${chars.slice(0, 12).join('')}${chars.length > 12 ? '…' : ''}` : '';
  } catch {
    return '';
  }
};

export const GPT_SOVITS: WorldDefinition<GptSovitsConfigSection> = {
  id: GPT_SOVITS_ID,
  label: 'GPTSovits 语音',
  defaults: () => structuredClone(GPT_SOVITS_DEFAULTS),
  configOptions(kind, language) {
    if (kind === TIER_OPTIONS) return tierOptions(language);
    if (kind === PROMPT_LANGUAGE_OPTIONS) return promptLanguageOptions();
    if (kind === TEXT_LANGUAGE_OPTIONS) return textLanguageOptions(language);
    if (kind === VOICE_OPTIONS) {
      const presets = VOICE_PRESETS.map((id) => ({ value: id, label: `${presetLabel(id, language)} · ${presetFileLabel(id)}${presetSnippet(id)}` }));
      return [...presets, ...customVoiceOptions()];
    }
    if (kind === DEVICE_OPTIONS) {
      let devices: Array<{ value: string; label: string }> = [];
      try { devices = listOutputDevices().map((d) => ({ value: d.name, label: d.name })); } catch { /* audify 不可用时只留系统默认 */ }
      return [{ value: '', label: systemDeviceLabel(language) }, ...devices];
    }
    return [];
  },
  // ctx.cfg 是 `worlds.gpt-sovits` 的活引用：热改的键现读即生效
  create: (ctx) => new GptSovitsWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    dataDir: join(ctx.dataDir, 'gpt-sovits'),
    runtimesRoot,
    modelsRoot,
    persist: (patch) => ctx.persist(patch),
  }),
  describe: DESCRIBE,
};
