# Third-party notices

`assets/voices/` 有七段预设参考音频：

- `female.wav`、`male.wav` 由 [OpenMOSS-Team/MOSS-VoiceGenerator](https://huggingface.co/OpenMOSS-Team/MOSS-VoiceGenerator)(Apache-2.0)按文字描述生成，不是任何真人的录音。
- `dfy.wav`（旧默认音色，5.16 秒日语）**不是** MOSS 生成的：它取自 B 站视频《人是猫》(`BV1freb6iErC`) 的 **AI 合成人声**，
  经人声分离与滤波处理，不含真人录音，因此不涉及真人声音权利；此处标注来源只为说明出处。
  这一段只作为「随包默认音色」使用，不用于训练其他模型。
- `dfy.zh.wav`、`dfy.en.wav` 是用上面这段 AI 合成参考 + GPT-SoVITS 生成的中文/英文同音色参考（seed 20261024），
  同样不含真人录音；生成参数与台本见 `assets/voices/prompts.json`。
- `xll.zh.wav`、`xll.en.wav` 是官模「大肥鱼_星落落版本」的中文/英文参考，来自 B 站 UP 主公开的
  肥鱼 CosyVoice3 音色素材（中英双语，源素材本身即 AI 合成，不含真人录音），
  经仅滤波处理（高通 80 Hz + 工频陷波，未做谱减）与峰值归一 0.9；台本见同名 `.txt`。
  这一段只作为「随包预设音色」的参考使用。

`xll` 预设使用官方底模 + 上述参考音频零样本合成，**不随包分发训练权重**。
`dfy` 预设同样使用官方底模，不加载训练权重。

`vendor/audify/` 是 [audify](https://github.com/almoghamdani/audify) 1.10.1 官方发布的 napi-v10 win32-x64 预编译件(`audify.node`、`rtaudio.dll`、`opus.dll`),原样随包，用来放声。许可：audify MIT(`LICENSE`)、[RtAudio](https://github.com/thestk/rtaudio) MIT 式(`LICENSE.rtaudio`)、[Opus](https://opus-codec.org/) BSD-3-Clause(`COPYING.opus`)。

`vendor/ar/` 是 [RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) `e91506f` 的 `GPT_SoVITS/AR/` 原样副本（49 个文件，约 390 KB，MIT），只在运行时解压不完整、缺 `GPT_SoVITS/AR` 时由插件补到运行时目录，平时不参与推理。

除此之外本包不含第三方代码与权重。托管安装时下载：

| 内容 | 来源 | 许可 |
|---|---|---|
| GPT-SoVITS 推理代码(运行时包内) | [RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) `e91506f` | MIT |
| 预训练权重(s1v3、s2Gv5turbo、vocoder、s2Gv2ProPlus、sv) | [lj1995/GPT-SoVITS](https://huggingface.co/lj1995/GPT-SoVITS)、[XXXXRT/GPT-SoVITS-Pretrained](https://www.modelscope.cn/models/XXXXRT/GPT-SoVITS-Pretrained) | MIT |
| chinese-roberta-wwm-ext-large | [hfl](https://huggingface.co/hfl/chinese-roberta-wwm-ext-large) | Apache-2.0 |
| chinese-hubert-base | [TencentGameMate](https://huggingface.co/TencentGameMate/chinese-hubert-base) | MIT |
| fast_langdetect lid.176.bin | [fastText](https://fasttext.cc/docs/en/language-identification.html) | CC BY-SA 3.0 |
| CPython 3.12(运行时包内) | [python-build-standalone](https://github.com/astral-sh/python-build-standalone) | PSF |
| PyTorch 等 Python 依赖(运行时包内) | PyPI / download.pytorch.org | 各自许可，见运行时包内各包的元数据 |
