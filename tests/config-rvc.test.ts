import { describe, expect, it } from 'vitest';
import { configGroups, GPT_SOVITS_DEFAULTS, RVC_DEFAULT_ENDPOINT } from '../src/config.ts';

describe('RVC 出口变声配置', () => {
  it('默认关闭，端点是 RVC 插件的本机接口', () => {
    expect(GPT_SOVITS_DEFAULTS.rvc).toEqual({
      enabled: false,
      endpoint: RVC_DEFAULT_ENDPOINT,
      token: '',
      timeoutMs: 8000,
      pitch: 0,
      indexRate: 0.3,
      protect: 0.33,
    });
  });

  it('七项都在联动组里，且都是热改', () => {
    const link = configGroups('zh').find((g) => g.id === 'world:gpt-sovits:link');
    expect(link).toBeTruthy();
    const props = (link!.schema as { properties: Record<string, { type: string; 'x-hot'?: boolean }> }).properties;
    for (const key of ['enabled', 'endpoint', 'token', 'timeoutMs', 'pitch', 'indexRate', 'protect']) {
      const field = props[`worlds.gpt-sovits.rvc.${key}`];
      expect(field, key).toBeTruthy();
      expect(field['x-hot'], key).toBe(true);
    }
    expect(props['worlds.gpt-sovits.rvc.enabled']!.type).toBe('boolean');
    expect(props['worlds.gpt-sovits.rvc.timeoutMs']!.type).toBe('number');
  });
});
