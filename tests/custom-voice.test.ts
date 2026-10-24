import { describe, expect, it } from 'vitest';
import { effectiveWeights, newCustomVoiceId, selectedCustomVoice, validateCustomVoice, type CustomVoice } from '../src/custom-voice.ts';

const voice = (patch: Partial<CustomVoice> = {}): CustomVoice => ({
  id: 'cv-1', name: '测试', audio: 'D:\\v\\cv-1.wav', text: '你好', weights: { gpt: '', sovits: '' }, ...patch,
});

describe('自定义音色', () => {
  it('名称、台本、音频时长都合规时通过', () => {
    expect(validateCustomVoice({ name: '大肥鱼', text: '你好', gpt: '', sovits: '', seconds: 5.2 })).toEqual([]);
  });

  it('名称与台本必填', () => {
    const problems = validateCustomVoice({ name: '  ', text: '', gpt: '', sovits: '', seconds: 5 });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('名称');
    expect(problems[1]).toContain('台本');
  });

  it('音频时长超出 3–10 秒要说明', () => {
    const problems = validateCustomVoice({ name: 'x', text: 'y', gpt: '', sovits: '', seconds: 12.4 });
    expect(problems.join()).toContain('12.4 秒');
  });

  it('量不出时长时不拦(交给服务端)', () => {
    expect(validateCustomVoice({ name: 'x', text: 'y', gpt: '', sovits: '', seconds: null })).toEqual([]);
  });

  it('权重必须成对：只填一个要报', () => {
    const onlyGpt = validateCustomVoice({ name: 'x', text: 'y', gpt: 'a.ckpt', sovits: '', seconds: 5 });
    const onlySovits = validateCustomVoice({ name: 'x', text: 'y', gpt: '', sovits: 'b.pth', seconds: 5 });
    expect(onlyGpt.join()).toContain('成对');
    expect(onlySovits.join()).toContain('成对');
    expect(validateCustomVoice({ name: 'x', text: 'y', gpt: 'a.ckpt', sovits: 'b.pth', seconds: 5 })).toEqual([]);
  });

  it('按 id 选中，找不到返回 null', () => {
    const list = [voice(), voice({ id: 'cv-2', name: '另一个' })];
    expect(selectedCustomVoice(list, 'cv-2')?.name).toBe('另一个');
    expect(selectedCustomVoice(list, 'nope')).toBeNull();
  });

  it('权重联动：音色配了成对权重就用它的，否则用全局', () => {
    const plain = voice();
    const weighted = voice({ id: 'cv-2', weights: { gpt: 'a.ckpt', sovits: 'b.pth' } });
    const global = { gpt: 'g.ckpt', sovits: 's.pth' };
    expect(effectiveWeights(plain, global)).toEqual(global);
    expect(effectiveWeights(weighted, global)).toEqual(weighted.weights);
    // 半填的音色权重不生效(校验层已拦，这里兜底)
    expect(effectiveWeights(voice({ weights: { gpt: 'a.ckpt', sovits: '' } }), global)).toEqual(global);
    expect(effectiveWeights(null, global)).toEqual(global);
  });

  it('id 唯一且带 cv- 前缀', () => {
    const a = newCustomVoiceId(), b = newCustomVoiceId();
    expect(a).toMatch(/^cv-/);
    expect(a).not.toBe(b);
  });
});
