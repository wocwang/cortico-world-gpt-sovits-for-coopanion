# 任务交接单

> 交接时间：2026-11-01 10:10（Asia/Shanghai）
> 仓库：`D:\Users\HW W\Documents\pr-gpt-sovits\repo`
> npm 包：`@wocwang/cortico-world-gpt-sovits-for-coopanion`
> 工作区版本：**0.6.0**（开发中，未发布）；本机 `data\extensions` 装的是 **0.5.28**
> 配套清单：[TODO.md](TODO.md)；ROCm 代验清单：[docs/rocm-acceptance.md](docs/rocm-acceptance.md)

---

## 1. 任务目标

- **一句话目标**：让 Coopanion 桌宠用自己的声音说话——本机 GPT-SoVITS 合成、从声卡播出；现在再加一档：官方支持的 AMD 显卡用 ROCm 跑 V5 turbo，其余 AMD 继续 CPU 档。
- **本轮已完成**：按主人要求把 0.5.29（认证整改）整体回退，恢复到 0.5.28 的「一键写入 QQ 配置」；在这条线上实现 `rocm` 推理档（代码与测试完成，运行时包未构建）。
- **验收标准**：
  - 包内：`pnpm typecheck` 通过、`pnpm test` 全绿（当前 16 文件 189 例）、`pnpm build` 产出 `dist/webui.js`；
  - 二级：Cortico checkout 里 `describe:extension` + `check:extension` 通过（本轮已过，见 §2）；
  - 三级：由有 A 卡的人按 [docs/rocm-acceptance.md](docs/rocm-acceptance.md) 实测并在 #228 回帖；
  - 发布：ROCm 运行时包上传后回填 `catalog.ts` 的 bytes/SHA-256/分片，再 `npm publish`。

## 2. 当前状态

- **macOS 支持（2026-11-02，本轮）**：按 issue #10（作者 @ink1453，补丁在其 fork 的 `feat/macos-own-runtime`，`c78d0a5`，基线
  `e683abc`＝0.5.28）**手工移植**到 0.6.1，因为中间隔了 0.6.0/0.6.1 三十个提交（`player.ts` 128 行、`server.ts` 116 行偏离）。
  落地范围：新增 `src/platform.ts`（解释器 / PATH / tar / 发布判定 / 系统播放器，全部带 `platform` 参数）；
  `player.ts` 的 macOS 分支走 `afplay`（`write()` 攒 PCM → `flush()` 落临时 WAV 排队 → `cut()` 停播清队列）；
  `server.ts` / `trainer.ts` / `install.ts` 改用平台解释器与 PATH，macOS 子进程 `detached` + 按进程组收，
  权重目录在非 Windows 上建普通目录符号链接；**顺带收口** 0.6.0 之后才有的东西：`probeHipDevice` 的解释器、
  `gpu.ts` 非 Windows 短路（不 spawn `powershell`/`nvidia-smi`）、`assertRocmPaths` 跳过读注册表、
  `tierOptions` 只给「自动 / CPU」、`audioBackendOptions` 只给「自动」、面板新增 `tierMac` 说明（`PanelState.platform`）。
  **`package.json` 的 `os` 仍是 `["win32"]`、version 仍是 0.6.1**（主人硬约束：等 M3 实测通过再放开）。
- **进度**：AMD ROCm 档 **已随 0.6.0 发布**（npm latest = 0.6.0）。运行时整包 3,140,067,689 B 已上传到魔搭
  `wocwang/gpt-sovits-for-coopanion`（主源，实测 `206 / 3140067689`）与 GitHub Release `runtime-e91506f-1`
  两个分片（兜底，字节一致）；`catalog.ts` 的 bytes / SHA-256 / 分片都按实测填好。
  #228 已定向回复四位求 AMD 支持的用户与 ANGOSUNG（附支持清单）；**只剩社区真机代验**（A 卡启动与 RTF）。
  若服务起不来，「自动」档会写回 CPU 档，不会把用户卡死。
- **本轮提交（本地，未推送）**：
  - `e11949b` Revert "feat(qq): copy only the four fields that need pasting"
  - `2e91145` Revert "feat(qq): give every value its own copy button"
  - `5e71124` Revert "fix(certify): stop touching other worlds' config …"
  - `bb3006b` `fix(trainer): pin the upstream tools archive to the runtime commit`（回退会连带丢掉归档哈希校验，单独留了这一处安全加固，与 QQ 配置无关）
  - 加上原 `75a5792`/`962bf9e`/`8ed1d42`/`e683abc`/`ff19b29`，全部只在本地；**0.5.29 不推送、不发布、#542 不回帖**（主人决定）。
- **按 #228 最新评论做的修正**：@goumo514 报「语音说的话和气泡里的不一样，大肥鱼意识不到」。现在 `sovits_speak` 的回执带 `Said: "…"`（翻译模式注明是译文），提示词要求中文/自动模式下 text 必须是这次 `pet_say` 的逐字副本、翻译模式气泡保持原文；面板「试听」下方显示最近念的一句。翻译从 `pump` 提前到入队前，回执与合成用的是同一份文字。
- **实测数据（macOS 那一轮，2026-11-02）**：
  - `node node_modules/typescript/bin/tsc --noEmit` 通过；`node node_modules/vitest/vitest.mjs run` → **16 文件 177 例全过**
    （新增 `tests/platform.test.ts` 14 例、`gpu` +2、`install` +3）；`node scripts/build-webui.mjs` → `dist/webui.js` 37.0 KB、`dist/webui.css` 0.9 KB。
  - 移植自 #10（`c78d0a5`）的改动**全部手工重写**，没有 `git apply`：`player.ts` 保留 0.6.1 的 WASAPI/DirectSound 回退，
    `server.ts` 保留 `runtimeEnv()` 的 `MIOPEN_*` 与 `HIP_VISIBLE_DEVICES`（`PATH` 只由 `envWithRuntime` 给）。
  - `package.json` 未改：`os` 仍 `["win32"]`、version 仍 `0.6.1`。
- **实测数据（ROCm 那一轮）**：
  - `pnpm typecheck` 通过；`pnpm test` **14 文件 150 例全过**；`pnpm build` 产出 `dist/webui.js` 36.5 KB、`dist/webui.css` 0.9 KB。
  - **ROCm 运行时包已在本机打出**：`gpt-sovits-e91506f-1-win-x64-rocm.zip` **3,140,067,689 B**，
    SHA-256 `0b3f7f709f7f5f7f0dde62488a7bcab0a4d31dce46d1cf53ecc0e6bbbdccc945`，解压 **7,077 MiB**，共 42,396 个条目；
    分片 `.part0` 1,992,294,400 B、`.part1` 1,147,773,289 B。包内 `torch 2.14.0+rocm10.1.0`、`torchaudio 2.11.0.3`、
    `rocm-sdk 10.1.0`、四套 gfx 内核、`sitecustomize.py` 齐全，没有 `flash_attn` 包；文本栈 `jieba_fast / pyopenjtalk / eunjeon`
    与 `numpy 1.26.4` 在包内解释器里导入通过，`torch.version.hip = 7.16.26385`。
  - 构建环境：uv 0.13.6 + Git Bash；`uv python install` 建联接报 os error 448，改为复用已解压的 CPython 3.12.16；
    `jieba_fast` / `pyopenjtalk` / `eunjeon` 在 PyPI 只有 sdist，从已发布的 CPU 档运行时里取同版本 cp312 编译产物；
    PyPI 直连会卡死，最后用清华镜像 + 独立 `--cache-dir` 装完 143 个包。
  - `npm pack` 出的 0.5.28 tgz 2,553,232 B；装进 `data\extensions` 后 `node_modules\...\package.json` 的 `version` = `0.5.28`，`src/world.ts` 有 `writeQqVoice`，`dist/webui.js` 里有 `writeQqVoice`。
  - Cortico 二级验证：`node --import tsx scripts/extension-describe.ts <repo>` → `tools 2, events 2, prompts 1`；`extension-check.ts` → **Extension check passed**。两条 warning：`sovits_speak` 默认配置下的 description 与声明不一致（历史遗留，市场只显示声明）；标签词表因本机证书吊销检查坏了读不到（`UNABLE_TO_VERIFY_LEAF_SIGNATURE`）。
  - AMD 官方 wheel 体积（HEAD 实测，`stable.repo.amd.com/rocm/whl-next` 10.1.0）：torch 2.14.0+rocm10.1.0 115.6 MB、rocm-sdk-core 777.0 MB、rocm-sdk-libraries 118.6 MB、rocm-sdk-device-gfx1201 314.1 MB、amd-torch-device-gfx1201 51.1 MB、其余三个架构各约 50 MB。

### 版本时间线

| 版本 | 内容 | 状态 |
|---|---|---|
| 0.5.28 | 面板可卸载运行时/权重；体积统计跳过联接 | **npm latest；本机安装中** |
| 0.5.29 | 认证整改（删 QQ 配置读写、归档哈希、唱歌描述） | **已整体回退，不发布** |
| 0.6.0 | ROCm 档 + 长路径预检 + MIOpen/设备探针 + 模型版本选项 + 回执带 `Said:` + 启动失败回落 CPU | **已发布**（npm latest、魔搭 + GitHub 运行时、#228 已回复）；待社区真机代验 |
| 0.6.1 | 模型版本改下拉；`cut5`→`cut2`（#11）；音频后端 WASAPI/DirectSound 回退（#4/#8）；联接失败不再拖垮 App（#9） | **已发布**（npm latest，`a9bbc01` 已推送）；issue #2/#3/#4/#5/#6/#7/#9/#11 已回复，#9/#11 已关 |
| 0.6.2 | ROCm 档改整句非流式（修 Chen Shaoju 的 `terminated`）+ 连接断开重试；macOS 平台代码并入但 `os` 仍只 win32 | **已发布**（npm latest，`ffeca3e` 已推送）；#228 已回复；市场同步 issue #662 |
| 0.6.3 | ROCm 运行时缺 NLTK `cmudict`：启动前自动补 9.5 MB 语料并设 `NLTK_DATA`，构建脚本加校验 | **已发布**（npm latest，`449a472` 已推送）；#228 已回复；市场同步 issue #663 |
| 0.6.4 | 自备运行时预检；`audioBackend` 归一化；开流后 120 ms `isStreamRunning` 探针，自动档识别「开流成功但没声音」退 DirectSound（#8） | **已发布但有静音回归**（探针写帧长度算错 → 全员静音），已被 0.6.5 取代 |
| 0.6.5 | 修 0.6.4 静音回归：探针只写一帧（`oneFrameBytes()`，与播放路径同一套算法），探针写失败不再判后端死刑；`-I` → `-s` 修自备运行时 `import tools` | **已发布**（npm latest，`76dcbce` 已推送）；#8 已回复；市场讨论区已发回归通知；市场同步 issue #685 |
| 0.6.6 | macOS 正式放开（`os` 含 `darwin`）；9880 响应头带首块/合成/时长；简介改短突出 AMD；`analyze-noise.py` 支持流式 WAV | **已发布**（npm latest，`e3d3d94` 已推送）；#5 已请对方复验正式版；PR #10 已关闭；市场同步 issue #691 |
| （未编号） | macOS：`platform.ts` + `afplay` 播放 + 平台解释器/PATH/进程组 + 非 Windows 短路与选项裁剪 | **本地已合入 main，未 push、未发布**；`os` 仍只有 `win32`，等 M3 实测 |

## 3. 关键假设与决策

| 决策 | 理由 | 是否已确认 |
|---|---|---|
| 回退到 0.5.28 并恢复「一键写入 QQ 配置」 | 主人要这个交互；代价是认证整改归零 | 是（主人明确选择，对外发布自担风险） |
| 放弃 0.5.29 的 push/publish 与 #542 回帖 | 同上 | 是 |
| 保留归档 SHA-256 校验（`bb3006b`） | 与 QQ 配置无关，去掉会让下载的上游代码失去校验 | 是（本轮自行判断，主人可否决） |
| ROCm 做成独立 `rocm` 档，不覆盖共享的 `cuda` 目录 | 三个语音插件共用 `runtimes/gpt-sovits/<版本>/<档>`；覆盖会破坏 RVC/DiffSinger | 是 |
| 只认官方 4 架构（gfx1100/1101/1200/1201，8 款卡） | 官方 Windows 矩阵只支持这些；RDNA2/Intel 硬上只会变成「装了不出声」 | 是 |
| 「自动」优先级：NVIDIA → 官方 A 卡 ROCm → CPU；显式选择一律尊重 | 主人的选择；避免把省显存的用户拽回 GPU | 是 |
| 不改注册表、不装驱动、不改系统策略 | Cortico `docs/runtimes.md` §3 | 是 |
| ROCm 运行时和代码分开发布，`bytes = 0` 时自动回落 CPU | 先落代码、后传包；不留死路 | 是 |
| 版本号 0.6.0 | 回退后 0.5.28 已被 npm 占用，新功能只能往上走 | 是 |
| macOS 只做「自备运行时」，不内置 darwin 运行时包 | 内置包要多养一份 arm64 CPython + torch（数值百 MB～1 GB）与一条发布链；自备目录这个入口已经有了 | 是（主人同意本轮只到代码） |
| `os` 先不加 `darwin` | 主人硬约束：先让 #10 作者在 M3 上实测通过，再放开市场 | 是 |
| 平台差异一律参数化 `platform` | darwin 分支能在 Windows 上跑单测，结果不随跑测试的机器漂移 | 是（本轮自行判断） |
| 非 Windows 直接短路显卡探测、裁剪档位/后端选项 | 没有 PowerShell、没有注册表、没有 win-x64 运行时包；跑一遍只会白等并给出误导文案 | 是（主人选「一并收口」） |

## 4. 待办事项

- [ ] **构建 ROCm 运行时包**（需 Git Bash + `uv` + 约 15 GB 空闲）：`bash scripts/build-runtime.sh rocm <工作目录>`；脚本会校验四套 `*device*gfx*` 包齐全、`flash_attn` 不在、`sitecustomize.py` 已写入，最后打印整包 bytes、sha256 与分片字节。
- [ ] 上传：魔搭整包 `runtime/gpt-sovits-e91506f-1-win-x64-rocm.zip`；GitHub Release `runtime-e91506f-1` 放 1900 MiB 分片。
- [ ] 回填 `src/catalog.ts` 的 `RUNTIME_ASSETS.rocm`（file/bytes/sha256/sources/parts）与 `RUNTIME_EXTRACT_BYTES.rocm`（解压实测）。
- [ ] 在 #228 贴 [docs/rocm-acceptance.md](docs/rocm-acceptance.md) 请人代验（@ANGOSUNG 已在 RX 9070 上手工跑通过 ROCm）；结果按模板回填到本文件 §2。
- [ ] 代验通过后再考虑 `npm publish 0.6.0`；**未获主人同意不 push、不 publish**。
- [x] **模型版本与档位解耦（#228 @niaolong233）**：已随 0.6.0 实现——新增配置 `voiceModel`（`auto` / `v5turbo` / `v2ProPlus`），
      显卡与 ROCm 档可选 V2 Pro Plus（自备 `06` 头权重不再被挡），CPU 档一律 V2 Pro Plus；换版本时重启一次推理服务。
- [ ] 可选：`sovits_speak` 的 describe 声明与默认配置下的 description 对齐（`check:extension` 的 warning）。
- [x] **macOS 真机实测**（2026-11-02，#10 @ink1453 在 Apple M3 / macOS 27.2 上跑的）：五项全过——启用与面板、
      自备运行时起服务、试听出声、排队不打断（口径作废）、闲置停服后自动拉起，`core.log` 无 warn。
      实测暴露两点，均已修：① CPU 档恒用 V2 Pro Plus（说明书写错，已改 README 并加「缺权重点名」提示）；
      ② `-I` 隔离模式与上游 `api_v2.py` 的 `from tools.portable_runtime import …` 冲突（`-I` 踢掉脚本目录、
      还连带 `-E` 忽略 `PYTHONPATH`）→ 改用 `-s`（`PYTHON_ARGS`）。
- [ ] **等 ink 复验 `-s`**：测试包 `0.6.5-mac.2`（dist-tag `mac-test`）；他说通过就放 `darwin`。他已选「路子 1」：
      我们并 `os: darwin` 发 0.6.5 → 市场同步 → 关 PR #10（历史保留署名）。正式版还没发，`latest` 仍是 0.6.4。
- [ ] **待主人拍板**（TODO P1.6）：#6 长句电流声的 A/B 实验（本机可做：RTX 5070 Ti + 已装 cuda 运行时）；
      #7 的 9880 流式接口（先做响应头，再考虑 chunked PCM）；正式版要不要现在带 `darwin`。
- [ ] 冻结项：云端 TTS（主人保留意见）、QQ `qq_audio`、仓库清理、显卡档 4.14 GB 真机下载。

## 5. 已知问题 / 风险

- **卡点**：本机没有 `uv`，`bash` 是 WSL 的而不是 Git Bash，`scripts/build-runtime.sh` 跑不了；ROCm 整包必须在另一台机器上打。没有包时 ROCm 档装不了（面板会明说）。
- **没有 A 卡**：三级验证只能靠社区代验，作者侧只能保证代码、类型、单测与二级验证。
- **本机 pnpm 坏了（2026-11-01，2026-11-02 又踩一次）**：`pnpm`/`corepack` 报 `ERR_PNPM_PACKAGE_MANAGER_INSPECT_OPTIONAL_DEPENDENCY`，`node_modules` 里的联接被 Windows 判为「不受信任的装入点」（os error 448 / errno -4094），连 `dir`、`Get-ChildItem`、`readFileSync` 都读不了。本轮用 `npm install` 重建了本仓库与 Cortico checkout 的 `node_modules`（真实目录），测试与二级验证都是在 npm 装出来的依赖上跑的（typescript 5.9.3 / vitest 2.1.9 / tsx 4.23.15，与 lockfile 版本不完全一致）；npm 生成的 `package-lock.json` 已删除。下次开工先确认 `pnpm test` 能跑，跑不了就照这个办法恢复，并把版本差异记在这里。
  - 2026-11-02 的 macOS 那一轮：`pnpm typecheck` 触发 verify-deps 的 install，报
    `EPERM: rename node_modules\cortico -> node_modules\.ignored_cortico`，并把 `cortico`/`esbuild`/`tsx`/`typescript`/`vitest`
    五个真实目录改名成 `.ignored_*`。**这几个是真实目录，`Move-Item` 改回来就恢复了**（不用重装）。之后一律直连本地二进制：
    `node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/vitest/vitest.mjs run`、`node scripts/build-webui.mjs`。
- **长路径是硬门槛**：默认 `D:\Program Files\Coopanion\data\home\runtimes\gpt-sovits\e91506f-1\rocm` 加最长相对路径（220 字符）后超过 259，没开 `LongPathsEnabled` 就会被预检拦下。这是社区实测的 272 字符路径问题的直接后果，不是文案问题。
- **认证风险**：一键写入 QQ 配置是 #542 明确要求删除的行为；恢复后对外发布可能被市场拒绝收录或撤销认证（主人已知悉并接受）。
- **描述一致性**：`package.json` 描述、`README`、`config.ts` 文案都改成了「AMD 官方支持型号走 ROCm」，以后改实现要同步，别再出现 0.5.29 那种描述与实现不一致。
- **v5turbo 的「电音」是模型固有**：0.5.x 实测输出端降噪无效，别再加降噪/后处理去「修」；能给的只有换 v2ProPlus（见 §4 的 `voiceModel` 计划）。
- **未复现的风险**：MIOpen `FAST` 的加速倍率来自社区单机（换新句 9.18 s → 3.22 s），本机无法验证；TorchCodec 兜底、`HIP_VISIBLE_DEVICES` 选卡、探针缓存都只在单测层面验证过。
- **0.6.4 的静音回归（0.6.5 已修）**：后端探针把两帧写给 audify（它只接受正好一帧），抛错被吞 → 两只后端都被判死 → 那版在 Windows 上全员静音。两条教训：① 帧长只能有一处算法（现在是 oneFrameBytes()，播放与探针共用）；② 探针自己失败不能当证据，没证据就放行、别判死刑。防线：scripts/check-audio-backend.mjs 已进 prepublishOnly，发布前必须真机过一遍（一帧能写、两帧必被拒）。

## 6. 上下文与约束

- **核心文件**：`src/platform.ts`（**新**：平台差异唯一出口——`runtimePublished` / `pythonInRuntime` / `runtimeBinDir` / `tarBinary` / `envWithRuntime` / `useSystemPlayer`，全部带 `platform` 参数）、`src/player.ts`（`afplay` 分支与 audify 并存）、`src/gpu.ts`（gfx 映射、`pickTier`、长路径、HIP 探针解析、非 Windows 短路）、`src/catalog.ts`（`RUNTIME_ASSETS.rocm`）、`src/install.ts`（`rocmPathProblem` / `assertRocmPaths` / `tarBinary` / `isRuntimeDir(dir, platform)`）、`src/server.ts`（`infererYaml` 二分、`runtimeEnv`、`probeHipDevice`、`cachedHipIndex`、进程组收尾）、`src/world.ts`（`tier()` 回落、`usage()` 认 `rocm`、`PanelState.amd` / `PanelState.platform`）、`src/config.ts`（`tierOptions` / `audioBackendOptions` 按平台裁剪）、`src/i18n.ts`（`tierMac`）、`src/webui/client.ts`、`scripts/build-runtime.sh`、`scripts/rocm-sitecustomize.py`。
- **测试**：`tests/platform.test.ts`（**新**，14 例，全平台参数化）、`tests/gpu.test.ts`（+2 例非 Windows 短路）、`tests/install.test.ts`（+3 例 `isRuntimeDir` 平台布局）；另有 `tests/server.test.ts` 与路径预检用例。测试不联网。
- **命令**：
  ```powershell
  cd "D:\Users\HW W\Documents\pr-gpt-sovits\repo"
  pnpm typecheck; pnpm test; pnpm build; npm pack
  npm run check:audio   # 音频后端真机自检：一帧能写、两帧必被拒（0.6.4 的静音回归就是漏了它）

  cd "D:\Users\HW W\Documents\pr-rvc\Cortina\state\cortico"
  node --import tsx scripts/extension-describe.ts "D:\Users\HW W\Documents\pr-gpt-sovits\repo"
  node --import tsx scripts/extension-check.ts "D:\Users\HW W\Documents\pr-gpt-sovits\repo"
  # 不要用 pnpm run：pnpm 11 的 verify-deps-before-run 会先跑一次完整 install，容易超时。
  ```
- **本机安装命令**（当前 0.5.28）：
  ```powershell
  cd "D:\Program Files\Coopanion\data\extensions"
  $env:XDG_DATA_HOME="D:\Program Files\Coopanion\data"
  pnpm add "<tgz 路径>" --ignore-scripts
  # pnpm add 不接受 --no-frozen-lockfile；装完必须重启 Coopanion
  ```
- **约束**：不读/写别的插件配置（现在例外只有主人要的「一键写入 QQ 配置」，只在面板按钮触发时写）；密钥只走部署 `.env`；不提交未跟踪的 `AGENTS.md`、`CLAUDE.md`；按显式路径暂存。

## 7. 交接说明

- **接手方先做**：跑 §6 的 `typecheck`/`test` 核对 189 例，并跑 npm run check:audio；`git log --oneline -8` 核对 §2 的提交；确认 `package.json` 版本是 `0.6.5`、本机安装是 `0.6.0`。
- **下一步**：按 §4 第 1 条找一台有 `uv` + Git Bash 的机器打 ROCm 包，再回填 catalog。
- **可以直接发给下一个接手方的提示词**：

```text
你是接手「更好的GPTSovits 语音」Coopanion 插件的模型/开发者。先读
D:\Users\HW W\Documents\pr-gpt-sovits\repo\HANDOFF.md、AGENTS.md、TODO.md 与 docs\rocm-acceptance.md。
当前工作区版本 0.6.0（未发布）：0.5.29 已按主人要求整体回退到 0.5.28（恢复一键写入 QQ 配置），
AMD ROCm 推理档的代码/测试/构建脚本已完成，但运行时整包还没构建上传，catalog 里 bytes=0，
所以「自动」档在 A 卡上会回落到 CPU 档。
下一步是打 ROCm 包（需要 Git Bash + uv）→ 上传魔搭与 GitHub 分片 → 回填 catalog → 请社区代验。
未经主人明确同意不要 git push、不要 npm publish、不要改 AGENTS.md/CLAUDE.md。
汇报用中文、给实测数据。
```
