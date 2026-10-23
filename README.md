# GPTSovits 语音(cortico-world-gpt-sovits-for-coopanion)

Owner: `src/world.ts`

> 本仓库是 [Phantivia/cortico-world-gpt-sovits-for-coopanion](https://github.com/Phantivia/cortico-world-gpt-sovits-for-coopanion)
> 的 fork（原作者同意后维护），在原版 0.1.2 之上补了参考音频时长校验、辅助参考音频、
> 装饰符号导致合成崩溃的修复与采样种子选项，改动见 [CHANGELOG.md](CHANGELOG.md)。

给 Coopanion 的桌宠配上声音：Coo 每次 `pet_say` 之前在同一次回复里先调用 `sovits_speak`,
扩展用本机的 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 流式合成这句话，从声卡播出。
`sovits_speak` 等第一块音频写进声卡才返回，主循环按顺序执行同一次回复里的工具调用，所以紧跟其后的
`pet_say` 在声音开始时出气泡。没调 `sovits_speak` 的 `pet_say` 不出声。

设置在 Coopanion 高级模式的「GPTSovits 语音」页。

## 两档

| 档 | 条件 | 模型 | 本机实测(RTX 5090 Laptop / Core Ultra 9 290HX) |
|---|---|---|---|
| 显卡 | NVIDIA 显卡 | V5 turbo | 首包 0.5–1.0 s,实时率 0.22–0.41,显存 3.5 GB |
| CPU | 其余 | v2ProPlus | 首包 0.8–1.1 s,实时率 0.8–1.1,内存 5.8 GB |

推理档默认自动：`nvidia-smi` 列得出显卡就用显卡档。V5 turbo 在这台机器的 CPU 上首包 3–4 s、实时率 1.2–1.5,
跟不上播放，所以 CPU 档用 v2ProPlus。v2ProPlus 的输出电平低(峰值约 −27 dBFS),播放时乘 8 倍并软限幅。

首次启动显卡档要编译 CUDA 内核，本机第一次 74 s,之后约 11 s。服务起来后用中、英、日各一句预热，预热完才算可用。

## 预设音色

随包带三个预设音色，在配置「音色」里选择：

| id | 名称 | 来源 |
|---|---|---|
| `dfy` | 大肥鱼(日语) | **默认**。5.16 秒日语参考，参考文字 `ティード パラパパパ ニーノ ナラナナナ ピンドン`，随包在 `assets/voices/dfy.wav` / `dfy.txt`。该参考做过降噪预处理：高通 80 Hz + 工频陷波 + 轻度谱减，声音比原样干净一档 |
| `female` | 女声 | [MOSS-VoiceGenerator](https://huggingface.co/OpenMOSS-Team/MOSS-VoiceGenerator) 按文字描述生成 |
| `male` | 男声 | 同上 |

面板上传了自定义参考音频时用自定义的，「改回预设音色」清掉它、回到选中的预设。

`female` / `male` 的参考文字是一句带语气词的口语，时长 3–10 秒，经 Whisper 核对与参考文字一致；
描述、种子与解码参数在 `assets/voices/prompts.json`。

> 换预设音色时，参考音频与台本是一对：`<id>.wav` 与 `<id>.txt` 必须内容一致，差一个字音色就会漂。

## 推理后端

按优先级取第一个：

1. **已有服务**:`worlds.gpt-sovits.serverUrl` 填一个 api_v2 地址，直接连它。
2. **自备目录**:`runtimeDir` 填一个含 `runtime/python.exe` 与 `api_v2.py` 的 GPT-SoVITS 目录(比如官方整合包),
   在里面起服务，权重用它自己的。
3. **托管安装**:面板上「安装并启动」下载本扩展打的运行时包(上游推理代码、独立 CPython 3.12 与依赖、G2PW、NLTK、
   Open JTalk 词典)和权重，装到部署根下的 `runtimes/gpt-sovits/<版本>/<档>/` 与 `models/gpt-sovits/pretrained_models/`,
   目录约定见 Cortico `docs/runtimes.md`。每个文件按顺序试多个来源，大小与 SHA-256 对上才算装好。

本机服务以 `runtime/python.exe -I -X utf8 -u api_v2.py` 在运行时根下启动，监听 127.0.0.1 的空闲端口。

## 工具与事件

- `sovits_speak(text)`:去掉 `【…】` 与 `<…>` 标记后合成，排在没念完的句子后面。
- `sovits_hush()`:停下当前一句并清空队列。
- 事件 `gpt-sovits.state`:语音变为可用或不可用(piggyback,随下一批事件送达)。环境提示词里的状态是前缀重建时的快照，以事件为准。

## 配置(`worlds.gpt-sovits`)

| 键 | 默认 | 说明 |
|---|---|---|
| `tier` | `auto` | `auto` / `cuda` / `cpu`,重启推理服务生效 |
| `voice.preset` | `female` | 预设音色:`female` / `male` |
| `voice.audio`、`voice.text` | 空 | 自定义参考音频(3–10 秒 WAV)与它的台本;配置里可选本机文件，语音页可上传，填了就不用预设音色 |
| `speed` | 1 | 语速，对应 api_v2 的 `speed_factor` |
| `seed` | -1 | 采样种子，对应 api_v2 的 `seed`。`-1` 每次重新采样（同一句每次听起来都不同）；填 0 或正整数则固定，同一句逐字节一致 |
| `volume` | 1 | 0–1 |
| `outputDevice` | 空 | 输出设备名，空为系统默认 |
| `autoStart` | true | World 启动时启动本机推理服务 |
| `serverUrl`、`runtimeDir` | 空 | 见上 |
| `promptLanguage` | `zh` | 环境提示词语言 |

自定义参考音频必须是 **3–10 秒**的 WAV。api_v2 收到范围外的音频只回一个不带原因的 `400 Bad Request`,
所以扩展在合成前自己量一次时长，把「实际多长、要求多长」报出来(`sovits_speak` 的返回和环境提示词里的状态都带上)。

台词里的装饰字符同理：服务端的音素前端会把 ♡ ★ ♪ 与 emoji 丢掉，某一段只剩符号时它会用空音素段去调
`torch.cat()` 并崩掉(`expected a non-empty list`)。扩展在送合成前先把这类符号去掉；
万一还是失败，再去掉标点重试一次(已经出过声时不重试，免得多播半句)。

## 合成结果的不确定性

插件发给 api_v2 的请求**不带 `seed`**，api_v2 默认 `seed=-1` 即每次重新随机采样。
所以同一句话多次合成会有明显差别(实测同一句三次:f0 中位数 308–374 Hz、时长 2.5–4.4 s、
音高标准差 8.9–11.2 半音)。听起来"忽好忽坏"通常是这个原因，不是参考音频配错了。

## 开发

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build        # src/webui → dist/webui.js、dist/webui.css
```

自描述 `describe.json` 用 Cortico 的 `pnpm describe:extension <本目录>` 生成。
