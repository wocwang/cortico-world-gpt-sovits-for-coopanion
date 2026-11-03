# #6 电流声：本地 A/B 数据（2026-11-02）

同一句 117 字中文台词，在本机（RTX 5070 Ti Laptop + 已装的 cuda 运行时）用不同「流式 × 切句 × 底模」组合各跑一遍，
PCM 直接取自 api_v2 的返回字节（不经过播放链路），指标用 `scripts/analyze-noise.py` 算。

## 方法

```bash
# 1) 起一个 api_v2（本例用插件自带的 cuda 运行时，端口随意）
cd "<运行时目录>"
runtime/python.exe -s -X utf8 -u api_v2.py -a 127.0.0.1 -p 9888 -c config.yaml

# 2) 请求（streaming_mode / text_split_method 是变量）
curl -s -X POST http://127.0.0.1:9888/tts -H "content-type: application/json" -d '{
  "text": "<117 字台词>",
  "text_lang": "zh",
  "ref_audio_path": "<参考音频 wav>",
  "prompt_text": "<台本>",
  "prompt_lang": "zh",
  "media_type": "wav",
  "streaming_mode": 3,
  "text_split_method": "cut2",
  "fragment_interval": 0.1,
  "batch_size": 1,
  "speed_factor": 1
}' -o out.wav

# 3) 算指标
python scripts/analyze-noise.py out.wav
```

## 结果（11 组）

| 组 | 底模/档 | 流式 | 切句 | 参考音 | 音频时长 | 高频占比 4–12 kHz | 有声/静音 RMS 比 | 咔哒尖峰 | 合成耗时 |
|---|---|---|---|---|---|---|---|---|---|
| A | v5turbo / cuda | 3 | cut2 | dfy | 20.8 s | 1.10 % | 241 | 0 | 28.2 s（冷启） |
| B | v5turbo / cuda | 0 | cut2 | dfy | 21.2 s | 1.14 % | 74 | 0 | 5.2 s |
| C | v5turbo / cuda | 0 | cut0 | dfy | 20.7 s | 1.13 % | 168 | 0 | 4.8 s |
| D | v5turbo / cuda | 2 | cut2 | dfy | 21.1 s | 1.34 % | 113 | 0 | 5.0 s |
| E | v5turbo / cuda | 3 | cut0 | dfy | 21.9 s | 1.16 % | 122 | 0 | 4.8 s |
| F | v5turbo / cuda | 3 | cut2 | xll | 20.0 s | 1.39 % | 65 | 0 | 5.8 s |
| G | v5turbo / cuda | 0 | cut0 | xll | 20.2 s | 1.46 % | 62 | 0 | 4.6 s |
| H | v5turbo / cuda | 3 | cut2 | dfy（热） | 19.8 s | 1.15 % | 189 | 0 | 5.2 s |
| I | v5turbo / cuda | 2 | cut2 | xll | 20.9 s | 1.41 % | 45 | 0 | 5.1 s |
| J | v2ProPlus / cpu | 3 | cut2 | dfy | 20.9 s | 1.83 % | 749 | 0 | 37.6 s |
| K | v2ProPlus / cpu | 0 | cut0 | dfy | 19.9 s | 1.64 % | 607 | 0 | 27.7 s |

## 结论

1. **本机复现不出电流声**：11 组里高频占比都在 1.1–1.8 %，咔哒尖峰全为 0。@ink1453 那边报的是 5–9 %（且静音段高频占 20.7 %，
   更像宽带底噪），量级差着好几倍。
2. **「分段 / 流式拼接导致接缝」这个假设，在本机没有支撑**：mode 3 / mode 0 / mode 2、cut2 / cut0 的高频占比差异在 0.3 个百分点内，
   接缝处也没有跳变尖峰。因此**暂时不改默认的流式与切句参数**——改了也看不出好处。
3. **但发现一个真实代价**：CPU 档（v2ProPlus）上，流式比非流式慢约 35 %（37.6 s vs 27.7 s，同一段 20 s 音频）。
   GPU 档上差别很小（5.2 s vs 4.8 s），但流式的价值是**首块更早到**，所以 GPU 档仍保留流式。
4. **还剩的嫌疑**（需要对方的数据才能定）：他的权重与参考音、静音底噪的来源（环境噪声？重采样？）、以及指标定义差异
   （我们这里算的是「有声帧里 4–12 kHz 占总能量」，他可能算的是相对静音段的分贝差）。

## 对方样本复算（同一脚本，2026-11-03）

@ink1453 用本仓的 `scripts/analyze-noise.py` 重算了 20261029 那包样本（Windows / RTX 3060 / cuda v5turbo / 48 kHz）：

| 文件 | 时长 | 高频占比 | 咔哒尖峰 |
|---|---|---|---|
| long-01 / 02 / 03 | 18.96 / 18.32 / 18.68 s | **1.73 / 1.74 / 1.81 %** | 0 |
| short-01 / 02 | 1.84 / 1.72 s | **2.59 / 2.56 %** | 0 |
| ab-A-nostream | 18.68 s | 2.10 % | 0 |
| parts/clause-1..5 | 1.72–5.64 s | 1.39–2.60 % | 0 |

- 换成同一脚本后，他那边与我们这边同量级（1.x–2.x %），**之前报的 5–9 % 是指标口径差异**（他用的是「20 ms 帧高频能量 p95 的相对差」）；
- 短句 2.56–2.59 % **高于**长句 1.73–1.81 %，推翻「长句更差」的早先判断；
- 流式返回的 WAV（`ab-B-stream3*.wav`）RIFF 的 `data` 长度是占位值，旧脚本读成 0 秒——已修：手动解析 RIFF，读到文件尾；裸 PCM 用 `--rate/--channels`。

## 下一步

- 用 `scripts/analyze-noise.py` 重算他那批样本（`voice-bug-20261029.zip` 里的 `long-01/02/03.wav`、`short-01/02.wav`、
  `ab-A-nostream.wav`、`ab-B-stream3*.wav`、`parts/clause-*.wav`），同一份脚本出的数字才可比；
- 如果重算后差异依旧，方向就转到「静音底噪」（录音/重采样/回放链路），而不是合成参数。
