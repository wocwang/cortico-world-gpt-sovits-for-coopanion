# TODO — 更好的GPTSovits 语音（Coopanion 插件）

> 最后更新：2026-11-02 11:40（Asia/Shanghai）
> 工作区版本：**0.6.2（已发布 npm latest，已推送）**，macOS 代码已并入但 `os` 仍只有 `win32`；本机 `data\extensions` 装的是 **0.6.0**（未升级）
> 详细交接见 [HANDOFF.md](HANDOFF.md)；ROCm 代验清单见 [docs/rocm-acceptance.md](docs/rocm-acceptance.md)。

## P0 — 0.6.0 / 0.6.1 发布（已完成，待真机代验）

- [x] **0.6.1 已发布**（2026-11-02）：模型版本改下拉；`cut5` → `cut2`（#11）；音频后端 WASAPI/DirectSound 回退（#4、#8）；
      权重联接失败不再拖垮 App（#9）；版本号 0.6.1，已 `git push`（`a9bbc01`）。
- [x] issue 已回复 #2/#3/#4/#5/#6/#7/#9/#11；#9、#11 已关闭。
- [ ] 本机 `data\extensions` 仍是 0.6.0，要验证下拉与新后端需重装 0.6.1。

- [x] **打 ROCm 运行时整包**（2026-11-01）：`gpt-sovits-e91506f-1-win-x64-rocm.zip`
      **3,140,067,689 B**，SHA-256 `0b3f7f70…ccc945`，解压 **7,077 MiB**；
      分片 `.part0` 1,992,294,400 B、`.part1` 1,147,773,289 B。产物在 `D:\gsv-build-rocm\`。
- [x] 回填 `src/catalog.ts`：`RUNTIME_ASSETS.rocm` 的 bytes / sha256 / sources / parts 与
      `RUNTIME_EXTRACT_BYTES.rocm = 7,420,772,352` 已写入（sources 指向 `wocwang/gpt-sovits-for-coopanion`，
      若最终用别的魔搭仓名，改 `MS_SELF` 一处即可）。
- [x] **上传**：魔搭 `wocwang/gpt-sovits-for-coopanion`（整包，实测 `206 / 3140067689`）+ GitHub
      Release `runtime-e91506f-1` 两个分片（字节一致）。
- [x] `npm publish 0.6.0`：registry `dist-tags.latest = 0.6.0`（发布返回 202，约 4 分钟后生效）。
- [x] #228 定向回复：@chenshaoju、@Felixs777、@273126559、@ashfsdd 四位求 AMD 支持的（附清单），
      以及 @ANGOSUNG（告知正式版已上线、欢迎用 RX 9070 试）。
- [ ] **社区真机代验**：按 [docs/rocm-acceptance.md](docs/rocm-acceptance.md) 跑一遍，结果回填 HANDOFF §2；
      起不来时把日志贴回 #228。

## P1 — 收尾

- [x] **模型版本与推理档解耦（#228 新反馈，@niaolong233）**（0.6.0 已实现）：有人用 v5turbo 训出来的模型「太电」，觉得 v2ProPlus 更自然，
      但显卡档只认 v5turbo，自备的 v2ProPlus 权重被 `resolveTrained()` 以「当前推理档用的是 v5turbo」拒掉，放不进去。
      做法：新增配置 `voiceModel: 'auto' | 'v5turbo' | 'v2ProPlus'`（默认 auto = 现在的行为），
      `version()` 改为读它；CPU 档选 v5turbo 仍然忽略（上游实测 >300 s 无输出）；
      权重按钮按所选版本下载（切到 v2ProPlus 多下约 307 MB：s2Gv2ProPlus + eres2netv2）；
      训练面板的默认版本（`COOPANION_TRAINER_VERSION`）跟着这个配置走；`OUTPUT_GAIN` 已按版本区分，不用改。
      验收：显卡档 + 自备 `06` 权重能加载出声；切回 auto 恢复 v5turbo；面板文案中英同步；补 `world`/`weights` 单测。
- [ ] `check:extension` 的两条 warning：
      ① `sovits_speak` 在默认配置下的 description 与 `describe.tools` 声明不一致（历史遗留，市场只显示声明）；
      ② 标签词表读不到（本机证书吊销检查坏了，`UNABLE_TO_VERIFY_LEAF_SIGNATURE`），换台机器或设
      `CORTICO_MARKET_INDEX_BASE` 镜像再核一次。
- [ ] 0.6.0 发布说明里写清：ROCm 只支持官方 8 款卡、要 Win11 + Adrenalin 26.2.2+、要自己开长路径；
      一键写入 QQ 配置会改 QQ 插件配置（认证风险已知）。
- [ ] 可选：把「逐项复制」按钮作为「不想让插件写配置」的替代交互加回来（0.5.29 的那两个提交还在历史里）。

## P1.5 — macOS（代码已合入，等 M3 实测）

- [x] 按 #10 的路线实现（2026-11-02）：`src/platform.ts` 收口解释器/tar/PATH/发布判定/播放差异（全部带 `platform` 参数，
      darwin 分支在 Windows 上也能跑单测）；`player.ts` 走 `afplay`（攒 PCM → 临时 WAV → 排队播，`cut()` 停播+清队列）；
      `server.ts` / `trainer.ts` / `install.ts` 改用平台解释器与 PATH，macOS 子进程独立进程组按组收，
      权重目录在非 Windows 上建普通目录符号链接。`tests/platform.test.ts` 14 例。
- [x] 顺带收口：`gpu.ts` 非 Windows 直接短路（不 spawn `powershell`/`nvidia-smi`）；`assertRocmPaths` 跳过读注册表；
      `tierOptions` 只给「自动 / CPU」、`audioBackendOptions` 只给「自动」；面板新增 `tierMac` 说明。
- [x] 说明写清：自备运行时约 7 GB、`afplay` 只整段播（首字延迟＝合成时间）、无设备选择（音量仍走 `afplay -v`）。
- [ ] **M3 真机实测**（#10 作者 ink1453）：本机只有 Windows，afplay 分支、venv 的 `-I` 隔离、进程组收尾都没跑过真机。
      实测时 `os` 还没有 `darwin`，需要手工放目录或用 `pnpm add <tgz> --force`；步骤见 README「macOS（自备运行时）」。
- [ ] 实测通过后再放开市场：`package.json` 的 `os` 加 `darwin`，发 0.6.2，并在 #10 回帖说明。

## P2 — 冻结项 / 已知但先不动

- [ ] **ONNX / TensorRT 推理引擎：不做**（2026-11-02 主人决定）。收益不确定、要再养一条推理链与一份 3–4 GB 运行时；
      若以后重启，先看 `High-Logic/Genie-TTS` 是否支持 v5turbo，并在本机（RTX 5070 Ti Laptop）量基线再定。

- [ ] 云端 TTS：主人保留意见，未拍板，不实现。
- [ ] QQ 语音投递 `qq_audio`：主人说先不管。
- [ ] 仓库清理：先不动；`*.tgz` 留着备用（注意 0.5.28 的 tgz 已被本轮重打包覆盖）。
- [ ] 显卡档 4.14 GB 真机下载未实测；GitHub 兜底源国内不可用。
- [ ] 解压过程不可取消。
- [ ] ROCm 档没有 A 卡实测，MIOpen 加速倍率只有社区数据。
