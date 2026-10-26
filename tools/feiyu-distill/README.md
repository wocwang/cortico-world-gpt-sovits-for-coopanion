# 肥鱼 CosyVoice3 → GPT-SoVITS 试训工具

这套脚本是**一次性离线工具**，不随插件发布，也不联网下载模型。目标是用官方肥鱼
CosyVoice3 生成一批语音，蒸馏出一个 GPT-SoVITS v2ProPlus 音色，先验证听感和实时性，
再决定要不要铺量、转 v5 LoRA。

> 授权：你已获得作者授权。发布衍生权重前仍要遵守“自用/非商用”的约定，别把模型包、
> 参考音频或训练产物直接公开分发，除非作者另行同意。

## 前置条件

1. 模型包 `FeiyuVoice-CosyVoice3` 已下载（[Hugging Face](https://huggingface.co/Esmerubphire/FeiyuVoice-CosyVoice3)
   或 [ModelScope](https://modelscope.cn/models/Esmerubphire/FeiyuVoice-CosyVoice3)；GitHub 上的
   `astrbot_plugin_feiyu_voice` 只有服务代码，不含权重），且 `runtime.local.json` 已按模型卡填好
   WSL 发行版、Python、CosyVoice 仓库路径。
2. 插件已安装 CUDA 运行时（默认
   `D:\Program Files\Coopanion\data\home\runtimes\gpt-sovits\e91506f-1\cuda`）。
3. v2ProPlus 基础权重已放到本地：
   - `GPT_SoVITS\pretrained_models\v2Pro\s2Gv2ProPlus.pth`
   - `GPT_SoVITS\pretrained_models\sv\pretrained_eres2netv2w24s4ep4.ckpt`
   - 最省事：在插件配置里把推理档切到 **CPU**，点一次「安装并启动」，让插件把
     CPU 权重下载到 `models\gpt-sovits\pretrained_models`；确认上面两个文件出现后，
     再把推理档切回你原来的设置。
   - 运行时里没有的话，也可以手动放到 `<数据集>\trial\pretrained\` 下同样的相对路径。
4. 训练环境有 `tensorboard`。没有就先装一次：

   ```powershell
   & "D:\Program Files\Coopanion\data\home\runtimes\gpt-sovits\e91506f-1\cuda\runtime\python.exe" -m pip install tensorboard
   ```

## 第一步：批量生成

先跑 20 句，确认 WSL、模型、路径都通：

```powershell
cd D:\Users\HW W\Documents\pr-gpt-sovits\repo
.\tools\feiyu-distill\run_generate.ps1 `
  -ModelDir D:\models\FeiyuVoice-CosyVoice3 `
  -Corpus .\tools\feiyu-distill\corpus.sample.jsonl `
  -Out D:\feiyu-data\pilot `
  -Style cute -Limit 20
```

输出：

```
pilot/
  wav/                 24 kHz PCM16，一句一个文件
  metadata.jsonl       文本、语言、时长、种子、哈希
  list.txt             GPT-SoVITS 的 `wav|feiyu|lang|text`
  errors.jsonl         失败行
  stats.json           句数 / 总时长 / 分语言统计
```

确认 `stats.json` 里句数和时长正常。20 句只够验证通路；试训建议先去掉 `-Limit` 跑完整
样例（80 句，约 5–8 分钟），或换成 200–500 句、约 30–60 分钟；正式训练再扩到 3–10 小时。
语料是 JSONL：`{"lang":"zh","text":"..."}`，中英都行；也可以直接给纯文本，脚本会自动判断中英。

如果坚持只用 20 句试训，训练命令要加 `--force`，否则会被 `--min-minutes 3` 拦下。

`-Style gentle` 会用另一套参考音频和原始 LLM，输出到另一个目录；两种风格要分开训。

## 第二步：试训

先 `--dry-run` 看路径和命令对不对：

```powershell
python .\tools\feiyu-distill\prepare_and_train.py `
  --dataset D:\feiyu-data\pilot `
  --s2-epochs 2 --s1-epochs 4 --batch-size 8 --dry-run
```

正式跑：

```powershell
python .\tools\feiyu-distill\prepare_and_train.py `
  --dataset D:\feiyu-data\pilot `
  --s2-epochs 2 --s1-epochs 4 --batch-size 8
```

脚本会依次做：

1. `1-get-text` / `2-get-hubert-wav32k` / `2-get-sv` / `3-get-semantic`
2. `s2_train.py`（v2ProPlus，2 epoch）
3. `s1_train.py`（4 epoch）

产物在 `D:\feiyu-data\pilot\trial\weights\`：
- `feiyu_trial_e*.ckpt`：GPT（s1）权重
- `feiyu_trial_e*_s*.pth`：SoVITS（s2）权重

日志在 `trial\logs\`，失败时先看最后 40 行。

## 第三步：试听

这是 **v2ProPlus** 权重。插件显卡档固定用 v5turbo，所以直接在插件里试听时：

- 把 `tier` 改成 **CPU**，再把两个权重填进「自备 GPT 权重 / 自备 SoVITS 权重」；
- 或者用 GPT-SoVITS WebUI 临时加载，`device: cuda`、`version: v2ProPlus`，这样能听 GPU 速度。

先听几个训练集外的句子，重点看：
- 音色像不像肥鱼；
- 有没有 CosyVoice3 的 24 kHz 高频损失、电音或吞字；
- 和现有 `dfy` 预设对比，是否值得继续。

## 注意事项

- 生成脚本在 **WSL** 里跑；训练脚本在 **Windows** 里调用插件运行时。两边的路径通过
  `run_generate.ps1` 自动转换。
- 生成器一次加载模型，不会每句重载；`-Limit` 只影响本次生成，断点续跑会跳过已有句。
- 数据是 CosyVoice3 合成出来的，不是真人录音；GPT-SoVITS 学到的是“像它的输出”，
  不会和 CosyVoice3 逐比特一致。
- 24 kHz 源音频进 32 kHz 的 v2ProPlus 训练会被重采样，高频不会凭空补回来；这是试训
  要重点听的地方。
- 训练脚本不联网、不改运行时权重；基础权重缺了会直接报错并告诉你放哪。
