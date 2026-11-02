import { describe, expect, it } from 'vitest';
import { backendCandidates, pickDefaultDevice } from '../src/player.ts';

describe('音频后端回退', () => {
  it('自动档先 WASAPI，再 DirectSound', () => {
    expect(backendCandidates('auto').map((candidate) => candidate.label)).toEqual(['WASAPI', 'DirectSound']);
  });

  it('手动指定时只试那一个后端', () => {
    expect(backendCandidates('directsound').map((candidate) => candidate.label)).toEqual(['DirectSound']);
    expect(backendCandidates('wasapi').map((candidate) => candidate.label)).toEqual(['WASAPI']);
  });

  it('RtAudio 报 0（没有默认设备）时从枚举结果里挑第一个', () => {
    expect(pickDefaultDevice([{ id: 129 }, { id: 130 }], 0)).toBe(129);
  });

  it('默认设备在列表里就用它', () => {
    expect(pickDefaultDevice([{ id: 129 }, { id: 130 }], 130)).toBe(130);
  });

  it('一台设备都没有时返回 0，由调用方报错', () => {
    expect(pickDefaultDevice([], 0)).toBe(0);
  });
});
