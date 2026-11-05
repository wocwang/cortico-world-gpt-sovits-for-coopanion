import { describe, expect, it } from 'vitest';
import { AUDIO_BACKEND_OPTIONS, MODEL_VERSION_OPTIONS, TIER_OPTIONS, VOICE_OPTIONS } from '../src/config.ts';
import { panelOptionsFor } from '../src/world.ts';

describe('配置页的 x-options（下拉选项）', () => {
  it('模型版本给三项，与 schema 的 enum 一致', () => {
    const options = panelOptionsFor(MODEL_VERSION_OPTIONS, 'zh');
    expect(options?.map((option) => option.value)).toEqual(['auto', 'v5turbo', 'v2ProPlus']);
    expect(options?.every((option) => option.label.length > 0)).toBe(true);
  });

  it('音频后端在 Windows 给四项（含系统播放器）、其他平台只给自动', () => {
    const options = panelOptionsFor(AUDIO_BACKEND_OPTIONS, 'zh');
    expect(options?.map((option) => option.value)).toEqual(
      process.platform === 'win32' ? ['auto', 'wasapi', 'directsound', 'system'] : ['auto'],
    );
  });

  it('推理档与音色也都有选项，不再退化成输入框', () => {
    expect(panelOptionsFor(TIER_OPTIONS, 'zh')?.map((option) => option.value)).toContain('cpu');
    const voices = panelOptionsFor(VOICE_OPTIONS, 'zh');
    expect(voices?.length).toBeGreaterThan(0);
    expect(voices?.some((option) => option.value === 'dfy')).toBe(true);
  });

  it('没登记的 kind 返回 undefined（渲染成输入框是合理的）', () => {
    expect(panelOptionsFor('worlds.gpt-sovits:nope', 'zh')).toBeUndefined();
  });
});
