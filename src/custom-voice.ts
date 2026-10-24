/**
 * 自定义音色：名称 + 参考音频 + 台本（必填）+ 自备权重（可选，成对）。
 * 纯逻辑，方便测试;文件读写与配置持久化在 world.ts。
 */

/** config `voices` 数组的一项。`weights` 两项都空 = 用内置底模（或全局自备权重）。 */
export interface CustomVoice {
  id: string;
  name: string;
  /** 参考音频的绝对路径;文件由添加时的上传写入插件数据目录。 */
  audio: string;
  text: string;
  weights: { gpt: string; sovits: string };
}

export const emptyWeights = (): CustomVoice['weights'] => ({ gpt: '', sovits: '' });

/** 音色下拉里的「＋ 新建音色…」哨兵值;选中它就建一个未命名音色并切过去。 */
export const NEW_VOICE_PRESET = '__new__';

/** 新建出来的音色默认名，用户可在语音页改名。 */
export const UNNAMED_VOICE = '未命名音色';

export const newCustomVoiceId = (): string => `cv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** 添加时的校验;返回中文错误列表,空数组 = 通过。`seconds` 量不出时长时为 null(交给服务端判断)。 */
export function validateCustomVoice(input: {
  name: string; text: string; gpt: string; sovits: string; seconds: number | null;
}): string[] {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push('请填写音色名称。');
  if (!input.text.trim()) errors.push('请填写参考音频的台本（要和音频里说的话逐字一致）。');
  if (input.seconds !== null && (input.seconds < 3 || input.seconds > 10)) {
    errors.push(`参考音频是 ${input.seconds.toFixed(1)} 秒，GPT-SoVITS 只接受 3–10 秒。`);
  }
  const gpt = input.gpt.trim(), sovits = input.sovits.trim();
  if (!!gpt !== !!sovits) errors.push('GPT 权重与 SoVITS 权重必须成对填写，或者都不填（用内置底模）。');
  return errors;
}

/** preset 指向自定义音色时返回它;找不到（比如已删除）返回 null。 */
export function selectedCustomVoice(voices: CustomVoice[], preset: string): CustomVoice | null {
  return voices.find((v) => v.id === preset) ?? null;
}

/**
 * 此刻应生效的自备权重：选中音色配了（成对的）权重就用它的，否则用全局配置。
 * 音色不带权重时全局配置仍然生效——「音色管音色，权重是底座」。
 */
export function effectiveWeights(
  custom: CustomVoice | null, global: { gpt: string; sovits: string },
): { gpt: string; sovits: string } {
  if (custom && custom.weights.gpt && custom.weights.sovits) return custom.weights;
  return global;
}
