import { describe, expect, it } from 'vitest';
import { configGroups, GPT_SOVITS_DEFAULTS } from '../src/config.ts';

type Schema = { properties: Record<string, { title?: string; description?: string }> };

describe('QQ 机器人语音条配置', () => {
  it('默认关闭，且不会把 channelVoice 挤掉（两条通道可以同时开）', () => {
    expect(GPT_SOVITS_DEFAULTS.qqbotVoice).toBe(false);
    expect(GPT_SOVITS_DEFAULTS.channelVoice).toBe(false);
    const both = { ...GPT_SOVITS_DEFAULTS, qqbotVoice: true, channelVoice: true };
    expect(both.qqbotVoice).toBe(true);
    expect(both.channelVoice).toBe(true);
  });

  it('挂在「与其他插件联动」组里，中英文都有标题与说明', () => {
    for (const language of ['zh', 'en'] as const) {
      const group = configGroups(language).find((item) => item.id.endsWith(':link'));
      expect(group, language).toBeTruthy();
      const prop = (group!.schema as Schema).properties['worlds.gpt-sovits.qqbotVoice'];
      expect(prop, language).toBeTruthy();
      expect(prop.title?.length).toBeGreaterThan(0);
      expect(prop.description).toContain('qqbot_send_message');
    }
  });

  it('联动组同时保留 channelVoice 与 httpApi，说明里点名 9880 对 qqbot 无效', () => {
    const group = configGroups('zh').find((item) => item.id.endsWith(':link'));
    const props = (group!.schema as Schema).properties;
    expect(props['worlds.gpt-sovits.channelVoice']).toBeTruthy();
    expect(props['worlds.gpt-sovits.httpApi'].description).toContain('cortico-world-qqbot');
  });
});
