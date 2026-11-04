import { describe, expect, it } from 'vitest';
import { normalizeVoiceModel, resolveModelVersion, voiceModelNeedsNormalizing } from '../src/catalog.ts';
import { GPT_SOVITS_DEFAULTS, modelVersionOptions } from '../src/config.ts';

describe('模型版本与推理档解耦', () => {
  it('auto 跟档位：显卡 / ROCm 用 V5 turbo，CPU 用 V2 Pro Plus', () => {
    expect(resolveModelVersion('auto', 'cuda')).toBe('v5turbo');
    expect(resolveModelVersion('auto', 'rocm')).toBe('v5turbo');
    expect(resolveModelVersion('auto', 'cpu')).toBe('v2ProPlus');
  });

  it('显卡档可以显式选 V2 Pro Plus（自备 06 权重就是靠这条放进来）', () => {
    expect(resolveModelVersion('v2ProPlus', 'cuda')).toBe('v2ProPlus');
    expect(resolveModelVersion('v2ProPlus', 'rocm')).toBe('v2ProPlus');
  });

  it('CPU 档选 V5 turbo 会被忽略：上游在这套机器上跑不动', () => {
    expect(resolveModelVersion('v5turbo', 'cpu')).toBe('v2ProPlus');
    expect(resolveModelVersion('v5turbo', 'cuda')).toBe('v5turbo');
  });

  it('默认值仍是跟随推理档，老配置不受影响', () => {
    expect(GPT_SOVITS_DEFAULTS.voiceModel).toBe('auto');
  });

  it('下拉给三项：跟随、V5 turbo、V2 Pro Plus', () => {
    expect(modelVersionOptions('zh').map((option) => option.value)).toEqual(['auto', 'v5turbo', 'v2ProPlus']);
    expect(modelVersionOptions('en').map((option) => option.value)).toEqual(['auto', 'v5turbo', 'v2ProPlus']);
  });

  it('手填时代留下的显示名归一成 key，不再让 MODEL_FILES 崩', () => {
    expect(normalizeVoiceModel('V2 Pro Plus')).toBe('v2ProPlus');
    expect(normalizeVoiceModel('v2 pro plus')).toBe('v2ProPlus');
    expect(normalizeVoiceModel('V2ProPlus')).toBe('v2ProPlus');
    expect(normalizeVoiceModel('V5 turbo')).toBe('v5turbo');
    expect(normalizeVoiceModel('V5-Turbo')).toBe('v5turbo');
    expect(normalizeVoiceModel(' auto ')).toBe('auto');
    expect(normalizeVoiceModel('something else')).toBe('auto');
    expect(normalizeVoiceModel(undefined)).toBe('auto');
    expect(resolveModelVersion('V2 Pro Plus', 'cuda')).toBe('v2ProPlus');
    expect(resolveModelVersion('V5 turbo', 'rocm')).toBe('v5turbo');
  });

  it('只有非规范写法才需要提示一次', () => {
    expect(voiceModelNeedsNormalizing('v2ProPlus')).toBe(false);
    expect(voiceModelNeedsNormalizing('auto')).toBe(false);
    expect(voiceModelNeedsNormalizing('V2 Pro Plus')).toBe(true);
    expect(voiceModelNeedsNormalizing('whatever')).toBe(true);
  });
});
