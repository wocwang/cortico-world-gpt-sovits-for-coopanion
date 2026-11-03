"""
#6 电流声分析：把一段 PCM/WAV 算成「可比较的数字」。

用法（需要 numpy）：
  python scripts/analyze-noise.py <文件.wav|pcm> [--rate 48000] [--channels 1]

输出：
  - 高频占比：4–12 kHz 能量占总能量比例（只统计有声帧，取中位数）——ink 报的「电流声」指标同源
  - 有声/静音 RMS 比：静音底的相对强度（他的数据里静音段高频占 20.7%，说明是宽带底噪）
  - 咔哒尖峰：相邻样点跳变超过 p99.9 的 3 倍的次数（接缝不连续会在这里冒出来）
  - 最大跳变与 p99.9 跳变

同一段音频用同一份脚本算，不同机器/不同版本的结果才可比。
"""
import argparse
import json
import os

import numpy as np

FRAME_MS = 20


def load(path: str, rate: int | None, channels: int | None):
    """读 WAV 或裸 PCM（裸 PCM 要用 --rate/--channels）。

    WAV 手动解析 RIFF，不用 wave 模块：api_v2 流式返回的 WAV 里 data 长度是占位值
    （0x24 / 0xFFFFFFFF），wave 会把它当成 0 帧，读出来是空的（#6 反馈）。
    """
    if path.lower().endswith(".wav"):
        buf = open(path, "rb").read()
        if buf[:4] != b"RIFF" or buf[8:12] != b"WAVE":
            raise SystemExit(f"{path} 不是 WAV")
        at = 12
        wav_rate = wav_channels = wav_bits = None
        data = None
        while at + 8 <= len(buf):
            cid = buf[at:at + 4]
            size = int.from_bytes(buf[at + 4:at + 8], "little")
            if cid == b"fmt ":
                wav_channels = int.from_bytes(buf[at + 10:at + 12], "little")
                wav_rate = int.from_bytes(buf[at + 12:at + 16], "little")
                wav_bits = int.from_bytes(buf[at + 22:at + 24], "little")
            elif cid == b"data":
                # 流式 WAV 的长度是占位值，直接读到文件尾
                data = np.frombuffer(buf[at + 8:], dtype=np.int16).astype(np.float32)
                break
            at += 8 + size + (size & 1)
        if data is None or wav_rate is None:
            raise SystemExit(f"{path} 里找不到 fmt/data 块")
        if wav_bits != 16:
            raise SystemExit(f"只支持 16 位 WAV（现在是 {wav_bits} 位）")
        rate = wav_rate if rate is None else rate
        channels = wav_channels if channels is None else channels
    else:
        if not rate:
            raise SystemExit("裸 PCM 要用 --rate 指定采样率")
        channels = channels or 1
        data = np.fromfile(path, dtype=np.int16).astype(np.float32)
    if channels > 1:
        data = data.reshape(-1, channels)[:, 0]
    return data, rate, channels


def analyse(data: np.ndarray, rate: int) -> dict:
    frame = int(rate * FRAME_MS / 1000)
    usable = len(data) // frame * frame
    frames = data[:usable].reshape(-1, frame)
    rms = np.sqrt((frames ** 2).mean(axis=1)) if len(frames) else np.zeros(1)
    peak = float(rms.max())
    voiced = rms > max(peak * 0.15, 60)
    silence = rms < max(peak * 0.02, 8)

    window = np.hanning(frame)
    if voiced.any():
        spec = np.abs(np.fft.rfft(frames[voiced] * window, axis=1)) ** 2
        freqs = np.fft.rfftfreq(frame, 1 / rate)
        total = spec.sum(axis=1) + 1e-9
        hi = spec[:, (freqs >= 4000) & (freqs <= 12000)].sum(axis=1) + 1e-9
        hi_ratio = float(np.median(hi / total) * 100)
    else:
        hi_ratio = 0.0
    voiced_silence = float(np.median(rms[voiced]) / (np.median(rms[silence]) + 1e-9)) if voiced.any() and silence.any() else 0.0

    diff = np.abs(np.diff(data))
    if len(diff):
        p999 = float(np.percentile(diff, 99.9))
        spikes = int((diff > max(p999 * 3, 4000)).sum())
        worst = float(diff.max())
    else:
        p999 = spikes = worst = 0.0

    return {
        "seconds": round(len(data) / rate, 2),
        "hi_ratio_pct": round(hi_ratio, 2),
        "voiced_silence_rms": round(voiced_silence, 2),
        "spikes": spikes,
        "max_jump": worst,
        "p999": p999,
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--rate", type=int, default=None)
    ap.add_argument("--channels", type=int, default=None)
    args = ap.parse_args()
    for path in args.files:
        data, rate, channels = load(path, args.rate, args.channels)
        result = analyse(data, rate)
        print(os.path.basename(path), json.dumps(result, ensure_ascii=False))
