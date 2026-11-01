# TODO — 更好的GPTSovits 语音（Coopanion 插件）

> 最后更新：2026-11-01 10:10（Asia/Shanghai）
> 工作区版本：**0.6.0**（开发中，未发布）；本机 `data\extensions` 装的是 **0.5.28**
> 详细交接见 [HANDOFF.md](HANDOFF.md)；ROCm 代验清单见 [docs/rocm-acceptance.md](docs/rocm-acceptance.md)。

## P0 — 0.6.0 的 ROCm 档（阻塞在构建）

- [ ] **打 ROCm 运行时整包**：在装有 Git Bash + `uv` 的 Windows 机器上跑
      `bash scripts/build-runtime.sh rocm <工作目录>`。脚本会校验四套 `*device*gfx1100…1201*`
      内核包齐全、没有 `flash_attn`、`sitecustomize.py` 已写入，最后打印整包 bytes 与 sha256。
- [ ] 上传：魔搭 `runtime/gpt-sovits-e91506f-1-win-x64-rocm.zip` 整包；GitHub Release
      `runtime-e91506f-1` 放 1900 MiB 分片（`.part0`、`.part1`…）。
- [ ] 回填 `src/catalog.ts`：`RUNTIME_ASSETS.rocm` 的 `bytes` / `sha256` / `sources` / `parts`，
      以及 `RUNTIME_EXTRACT_BYTES.rocm` 的解压实测值。回填后 `RuntimeJob.published()` 变 true，
      「自动」档才会真正落到 ROCm。
- [ ] 在 Discussion #228 贴代验清单（@ANGOSUNG 的 RX 9070 已手工跑通过 ROCm），结果按模板回填 HANDOFF §2。
- [ ] 代验通过、主人点头后再 `npm publish 0.6.0`；未获同意不 push、不 publish。

## P1 — 收尾

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
