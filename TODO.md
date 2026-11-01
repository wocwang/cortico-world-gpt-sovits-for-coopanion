# TODO — 更好的GPTSovits 语音（Coopanion 插件）

> 最后更新：2026-11-01 10:10（Asia/Shanghai）
> 工作区版本：**0.6.0**（开发中，未发布）；本机 `data\extensions` 装的是 **0.5.28**
> 详细交接见 [HANDOFF.md](HANDOFF.md)；ROCm 代验清单见 [docs/rocm-acceptance.md](docs/rocm-acceptance.md)。

## P0 — 0.6.0 的 ROCm 档（阻塞在构建）

- [x] **打 ROCm 运行时整包**（2026-11-01）：`gpt-sovits-e91506f-1-win-x64-rocm.zip`
      **3,140,067,689 B**，SHA-256 `0b3f7f70…ccc945`，解压 **7,077 MiB**；
      分片 `.part0` 1,992,294,400 B、`.part1` 1,147,773,289 B。产物在 `D:\gsv-build-rocm\`。
- [x] 回填 `src/catalog.ts`：`RUNTIME_ASSETS.rocm` 的 bytes / sha256 / sources / parts 与
      `RUNTIME_EXTRACT_BYTES.rocm = 7,420,772,352` 已写入（sources 指向 `wocwang/gpt-sovits-for-coopanion`，
      若最终用别的魔搭仓名，改 `MS_SELF` 一处即可）。
- [ ] **上传**（要主人的账号）：魔搭仓 `wocwang/gpt-sovits-for-coopanion` 下建 `runtime/`，
      放整包；GitHub Release `runtime-e91506f-1` 放两个分片。传完用
      `Invoke-RestMethod` 或 `curl -I` 核对字节数，和 catalog 里对不上就是传错了。
- [ ] 在 Discussion #228 贴代验清单（@ANGOSUNG 的 RX 9070 已手工跑通过 ROCm），结果按模板回填 HANDOFF §2。
- [ ] 代验通过、主人点头后再 `npm publish 0.6.0`；未获同意不 push、不 publish。

## P1 — 收尾

- [ ] **模型版本与推理档解耦（#228 新反馈，@niaolong233）**：有人用 v5turbo 训出来的模型「太电」，觉得 v2ProPlus 更自然，
      但显卡档只认 v5turbo，自备的 v2ProPlus 权重被 `resolveTrained()` 以「当前推理档用的是 v5turbo」拒掉，放不进去。
      做法：新增配置 `voiceModel: 'auto' | 'v5turbo' | 'v2ProPlus'`（默认 auto = 现在的行为），
      `version()` 改为读它；CPU 档选 v5turbo 仍然忽略（上游实测 >300 s 无输出）；
      权重按钮按所选版本下载（切到 v2ProPlus 多下约 307 MB：s2Gv2ProPlus + eres2netv2）；
      训练面板的默认版本（`COOPANION_TRAINER_VERSION`）跟着这个配置走；`OUTPUT_GAIN` 已按版本区分，不用改。
      验收：显卡档 + 自备 `06` 权重能加载出声；切回 auto 恢复 v5turbo；面板文案中英同步；补 `world`/`weights` 单测。
      建议版本号 0.6.1，等 ROCm 包发完再动，避免和包体同时验。
- [ ] `check:extension` 的两条 warning：
      ① `sovits_speak` 在默认配置下的 description 与 `describe.tools` 声明不一致（历史遗留，市场只显示声明）；
      ② 标签词表读不到（本机证书吊销检查坏了，`UNABLE_TO_VERIFY_LEAF_SIGNATURE`），换台机器或设
      `CORTICO_MARKET_INDEX_BASE` 镜像再核一次。
- [ ] 0.6.0 发布说明里写清：ROCm 只支持官方 8 款卡、要 Win11 + Adrenalin 26.2.2+、要自己开长路径；
      一键写入 QQ 配置会改 QQ 插件配置（认证风险已知）。
- [ ] 可选：把「逐项复制」按钮作为「不想让插件写配置」的替代交互加回来（0.5.29 的那两个提交还在历史里）。

## P2 — 冻结项 / 已知但先不动

- [ ] 云端 TTS：主人保留意见，未拍板，不实现。
- [ ] QQ 语音投递 `qq_audio`：主人说先不管。
- [ ] 仓库清理：先不动；`*.tgz` 留着备用（注意 0.5.28 的 tgz 已被本轮重打包覆盖）。
- [ ] 显卡档 4.14 GB 真机下载未实测；GitHub 兜底源国内不可用。
- [ ] 解压过程不可取消。
- [ ] ROCm 档没有 A 卡实测，MIOpen 加速倍率只有社区数据。
