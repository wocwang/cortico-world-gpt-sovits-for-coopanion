# 贡献者

这个插件不是一个人做出来的。下面按「做了什么」记，不分先后。

## 代码与方案

- **@ink1453**（[GitHub](https://github.com/ink1453)）—— macOS 支持。PR [#10](https://github.com/wocwang/cortico-world-gpt-sovits-for-coopanion/pull/10)
  里的 `src/platform.ts`（解释器 / tar / PATH / 播放差异收口）、`player.ts` 的 `afplay` 分支、子进程按组收尾；
  并在 [#5](https://github.com/wocwang/cortico-world-gpt-sovits-for-coopanion/issues/5) 指出 `-I` 隐含 `-E`、
  会忽略 `PYTHONPATH`，0.6.5 的 `-s` 修法直接来自他的三组对照。
- **@ANGOSUNG** —— AMD ROCm 档。独立 `rocm` 目录、按 `gfx` 选卡、MIOpen `FAST`、soundfile 兜底、
  四套设备内核、「只检测长路径、不代改注册表」；并在 RX 9070 上手工跑通整条链路，0.6.0 按他的清单实装。
- **@aiAsuka** —— 音频后端探针。`isStreamRunning()` 判据与「audify 的 `write()` 只接受正好一帧」的实测，
  0.6.5 修掉 0.6.4 的静音回归靠的就是这两条。
- **@niaolong233** —— 提出「模型版本」与推理档解耦（显卡档也能加载自备的 V2 Pro Plus 权重），
  0.6.0 落地成配置项。

## 真机验证

| 谁 | 平台 | 验了什么 |
|---|---|---|
| @ink1453 | Apple M3 / macOS | 自备运行时、`afplay` 出声、闲置停服再拉起、`-s` 复验、0.6.6 正式版确认 |
| @ANGOSUNG | RX 9070（gfx1201） | ROCm 全链路：装运行时、起服务、出声 |
| @aiAsuka | Windows 11 / WASAPI + DirectSound | 「开流成功但没声音」的判据与修复复验（#8） |

## 问题反馈（每条都对应一次具体修复）

| 谁 | 问题 | 结果 |
|---|---|---|
| @Lime809 | [#11](https://github.com/wocwang/cortico-world-gpt-sovits-for-coopanion/issues/11) 2–4 字短句被整段吞掉 | `cut5` → `cut2`（0.6.1） |
| @Lime809 | [#1](https://github.com/wocwang/cortico-world-gpt-sovits-for-coopanion/issues/1) 重装运行时清空权重 | 权重与运行时分离 |
| @Parjch | [#9](https://github.com/wocwang/cortico-world-gpt-sovits-for-coopanion/issues/9) 联接异常导致 App 启动即退出 | 拆联接 + 失败收口（0.6.1） |
| @hefengchang | [#4](https://github.com/wocwang/cortico-world-gpt-sovits-for-coopanion/issues/4) WASAPI 枚举 0 个设备 | 后端回退 DirectSound（0.6.1） |
| @ZYU-XU | [#3](https://github.com/wocwang/cortico-world-gpt-sovits-for-coopanion/issues/3) 默认设备切换后仍走旧设备 | 每秒跟随当前后端（0.6.1） |
| @zhiyu111111 | [#2](https://github.com/wocwang/cortico-world-gpt-sovits-for-coopanion/issues/2) `sovits_speak` 不产出句柄 | 回执带 `[blob …]` 句柄 |
| @chenshaoju | [#228](https://github.com/Pal-AI-Lab/cortico-extensions/discussions/228) ROCm 上长句 `terminated` | 整句非流式（0.6.2） |
| @chenshaoju @Felixs777 @273126559 @ashfsdd | #228 求 AMD 支持 | ROCm 档上线（0.6.0） |
| @aiAsuka | [#8](https://github.com/wocwang/cortico-world-gpt-sovits-for-coopanion/issues/8) 0.6.4 静音回归 | 帧长统一 + 探针失败不再判死（0.6.5） |

## 上游与素材

- [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 上游作者与贡献者：推理链、底模与 `api_v2` 都来自这里；
- **@Phantivia**：本插件最初版本作者（本项目由其版本分叉而来），并托管底模与 V5 权重、维护插件市场索引；
- 内置「大肥鱼 / 星落落」参考音色的素材来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 怎么记

- 这份文件记「人 + 做了什么 + 落在哪个版本」；
- 每个版本的 `CHANGELOG.md` 末尾有一行致谢，指向这里；
- `package.json` 的 `contributors` 收录代码 / 方案层面的贡献者（会显示在 npm 页面）；
- 提交里能用 `Co-authored-by:` / `Reported-by:` 的，尽量在提交信息里带上。
