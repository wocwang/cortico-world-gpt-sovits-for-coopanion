import { describe, expect, it } from 'vitest';
import { backendCandidates, normalizeAudioBackend, oneFrameBytes, pickDefaultDevice, probeVerdict } from '../src/player.ts';

describe('音频后端回退', () => {
  it('自动档先 WASAPI，再 DirectSound', () => {
    expect(backendCandidates('auto').map((candidate) => candidate.label)).toEqual(['WASAPI', 'DirectSound']);
  });

  it('手动指定时只试那一个后端', () => {
    expect(backendCandidates('directsound').map((candidate) => candidate.label)).toEqual(['DirectSound']);
    expect(backendCandidates('wasapi').map((candidate) => candidate.label)).toEqual(['WASAPI']);
  });

  it('照描述手写成 DirectSound / WASAPI 也认（大小写、空格、ds 缩写）', () => {
    expect(normalizeAudioBackend('DirectSound')).toBe('directsound');
    expect(normalizeAudioBackend(' wasapi ')).toBe('wasapi');
    expect(normalizeAudioBackend('DS')).toBe('directsound');
    expect(backendCandidates('DirectSound').map((candidate) => candidate.label)).toEqual(['DirectSound']);
  });

  it('认不出的值按 auto 处理，不再静默退回 WASAPI', () => {
    expect(normalizeAudioBackend('Direct Sound 声卡')).toBe('auto');
    expect(normalizeAudioBackend(undefined)).toBe('auto');
    expect(backendCandidates('nonsense').map((candidate) => candidate.label)).toEqual(['WASAPI', 'DirectSound']);
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

describe('后端探针', () => {
  it('audify 只接受正好一帧：frameSize × 声道 × 2 字节', () => {
    expect(oneFrameBytes(1280, 2)).toBe(5120);
    expect(oneFrameBytes(1280, 1)).toBe(2560);
    // 与播放路径一致：单声道一帧字节 × 声道数（upmix 之后的交错帧）
    expect(oneFrameBytes(1280, 2)).toBe(1280 * 2 * 2);
  });

  it('写帧成功且流停了才判死（issue #8）', () => {
    expect(probeVerdict(true, false)).toBe('dead');
    expect(probeVerdict(true, true)).toBe('alive');
  });

  it('探针自己写失败没有证据力，放行后端（0.6.4 就是这里把所有人静音的）', () => {
    expect(probeVerdict(false, false)).toBe('unknown');
    expect(probeVerdict(false, true)).toBe('unknown');
  });
});
