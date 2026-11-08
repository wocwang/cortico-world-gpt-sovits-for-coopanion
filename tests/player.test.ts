import { describe, expect, it } from 'vitest';
import { backendCandidates, LEAD_CAP_MS, listOutputDevices, normalizeAudioBackend, oneFrameBytes, pickDefaultDevice, playbackLeadMs, probeVerdict } from '../src/player.ts';

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

  it('系统播放器（安全模式）不吃 audify：各种写法都归一到 system，且不枚举设备', () => {
    expect(normalizeAudioBackend('system')).toBe('system');
    expect(normalizeAudioBackend('External')).toBe('system');
    expect(normalizeAudioBackend('soundplayer')).toBe('system');
    // 这条路径不加载 vendor/audify 的原生模块，所以任何平台都能跑、也不会触发 issue #13 的崩溃。
    expect(listOutputDevices('system')).toEqual([]);
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

describe('播放预缓冲门槛', () => {
  const slow = { chars: 20, secondsPerChar: .15, rtf: 1.4 };

  it('默认 0 = 关闭，第一块就播（老行为）', () => {
    expect(playbackLeadMs({ ratio: 0, ...slow })).toBe(0);
  });

  it('生成快于播放时不缓冲：等只会多花首声延迟', () => {
    expect(playbackLeadMs({ ratio: .5, chars: 20, secondsPerChar: .15, rtf: .8 })).toBe(0);
    expect(playbackLeadMs({ ratio: .5, chars: 20, secondsPerChar: .15, rtf: 1 })).toBe(0);
  });

  it('还没有实测样本时按 0 处理（第一句不白等）', () => {
    expect(playbackLeadMs({ ratio: .5, chars: 20, secondsPerChar: 0, rtf: 1.4 })).toBe(0);
    expect(playbackLeadMs({ ratio: .5, chars: 0, secondsPerChar: .15, rtf: 1.4 })).toBe(0);
    expect(playbackLeadMs({ ratio: .5, chars: 20, secondsPerChar: .15, rtf: 0 })).toBe(0);
  });

  it('慢于播放时按「比例 × 预计时长」攒块', () => {
    // 预计 3 秒，先攒 30% = 900 ms
    expect(playbackLeadMs({ ratio: .3, ...slow })).toBe(900);
  });

  it('门槛封顶 2.4 秒，气泡不会比声音早太多（回执最多等 3 秒）', () => {
    expect(LEAD_CAP_MS).toBe(2400);
    expect(playbackLeadMs({ ratio: .62, chars: 30, secondsPerChar: .2, rtf: 1.6 })).toBe(2400);
    expect(playbackLeadMs({ ratio: .5, chars: 30, secondsPerChar: .2, rtf: 1.6, capMs: 1000 })).toBe(1000);
  });

  it('小于两帧（80 ms）的门槛不值得压住第一块', () => {
    expect(playbackLeadMs({ ratio: .02, chars: 20, secondsPerChar: .1, rtf: 1.4 })).toBe(0);
  });

  it('比例非法时退回关闭', () => {
    expect(playbackLeadMs({ ratio: -1, ...slow })).toBe(0);
    expect(playbackLeadMs({ ratio: 1.5, ...slow })).toBe(0);
  });
});
