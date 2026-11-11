# TODO — 更好的GPTSovits 语音（Coopanion 插件）

> 最后更新：2026-11-11（Asia/Shanghai）
> 工作区版本：**0.8.8（未发布）**；本机 `data\extensions` 装的是 **0.8.8**
> 详细交接见 [HANDOFF.md](HANDOFF.md)；机器可读的状态见 [docs/STATE.md](docs/STATE.md)（`node scripts/handoff.mjs --write` 重新生成）；
> 开新会话的提示词见 [docs/handoff-prompt.md](docs/handoff-prompt.md)；ROCm 代验清单见 [docs/rocm-acceptance.md](docs/rocm-acceptance.md)。
> 本机训练产物（「祀」音色）在 `D:/Program Files/Coopanion/data/home/companion/data/trainers/shi`，训练记录 `D:/Program Files/Coopanion/data/shi-training.md`。

## P0 — 移除「通用输出端口」+ 入站引导补一句（0.8.8，已装）

- [x] **删除功能**：`src/push.ts`、`tests/push.test.ts` 删除；`world.ts` 去掉 `PushSink`、合成完成入队推送与积压丢弃调用点；
      `client.ts` 删除 `link-push` 卡片（含「发送测试音频」与非本机地址提示）。
- [x] **配置**：`pushEnabled` / `pushUrl` / `pushToken` 从接口、默认值、`configSchema`、中英文案里移除；
      旧配置里残留的三个字段**静默忽略**，保存后不再写出。
- [x] **入站引导**：「本机语音接口（通用）」卡片下方新增一行 `apiHowTo`——地址 `http://127.0.0.1:<端口>`，
      有令牌加 `Authorization: Bearer`；本机插件通常直接填地址、不用带路径。入站接口 `httpApi` / `http-tts.ts` 未改。
- [x] 一级验证：`tsc --noEmit` 通过；`vitest run` 26 文件 **309 例** 全过；`build` / `check:audio` 通过。
- [x] 二级验证：`describe:extension` + `check:extension` 通过。
- [x] 本机安装：0.8.8 tgz 已装进 Coopanion，关键文件哈希与工作区一致。
- [ ] 真机验收（需重启宿主）：联动页没有推送卡片；接口卡下方能看到填写引导；老 `config.json` 带三个字段可正常启动。

## P0 — 接口卡置顶 + 端口占用提示 + 并发说明（0.8.7，已装待真机验收）

- [x] **位置**：`client.ts` 的 `link-api` 卡片在 0.8.6 就已经是联动页第一张（`ctx.root.append(api.el)` 先于其它卡片），
      本次把它变成真正的「主开关」：`httpApi` 关着时 `httpPort` / `httpToken` 置灰，小字换成 `apiOffHint`
      「开关关闭时端口与令牌不生效」。
- [x] **即时生效**：`world.ts` 的 `setConfigValue` 保存 `.httpApi` / `.httpPort` 后调用 `reconcileHttpApi()`：
      关掉 → `close()` 并清空 `httpTts`；开或换端口 → 重新 `startHttpApi()`；`httpApiStarting` 防重入。
- [x] **端口占用**：`startHttpApi` 抓 `EADDRINUSE` 存进 `httpApiIssue`；面板每 2 秒 `ctx.invoke('httpApiState')`，
      显示「被别的程序占用」或「正被本插件的推理地址占着（api_v2 默认也是 9880）」，并提示换成 9883。
      真机验证：对已被占用的 9880 直接调 `startHttpTts` → `REJECTED code=EADDRINUSE`。
- [x] **并发**：`http-tts.ts` 的 `run()` 链本来就是 FIFO 串行（并发 1），不另造队列；卡片小字写明
      「并发上限 1、排队 + 合成合计 120 秒、共用插件当前音色」。真机两路并发打 9880：两路都 200，
      2.09 s / 3.76 s 完成，墙钟 3.76 s ≈ 两段之和（串行、无交叠、无 500）。
- [x] **验证**：`tsc --noEmit` 通过；`vitest run` 26 文件 **315 例** 全过（新增 EADDRINUSE 1 例）；
      `build` 产出 `dist/webui.js` 80.5 KB / `dist/webui.css` 1.7 KB；`check:audio` 通过。
- [ ] 真机验收（需重启宿主）：联动页最上面是这张卡；关掉开关后 9880 应无监听；手动占住 9880 再开开关，
      卡片应显示「被别的程序占用」；改端口后不重启也应恢复监听。

## P0 — 「开放本机语音接口」确认为全局并移出 QQ 卡片（0.8.6，已装待真机验收）

- [x] 核实：`httpApi`（`config.ts:87/195/451`，分组 `link`）是**全局入站接口**；
      `world.ts:1278` 起服务，`http-tts.ts:220` 只绑 `127.0.0.1`，暴露 `/health`、`/models`、`/audio/speech`、`/tts`，
      token 可选；调用方不限于 QQ。`channelVoice` 才是 QQ 专用提示词开关（`world.ts:1195` 只用于旧 qq-final 的提示词）。
- [x] 面板：新增通用卡片「本机语音接口（通用）」承载 `httpApi` / `httpPort` / `httpToken`（`client.ts:1414-1419`）；
      「新版 QQ 插件」卡片只留 `channelVoice` 与对接指南。
- [x] 文案：中英文改成不绑定 QQ，说明这是入站接口（别人来取）。
      字段名、默认值、原生配置分组与运行语义不变，不做迁移。
- [x] 验证：`tsc` 通过；`vitest run` **26 文件 314 例** 全过；`build` 产出 `dist/webui.js` 77.5 KB；`check:audio` 通过；
      `describe:extension` / `check:extension` 通过；0.8.6 已装本机，关键文件哈希一致。
- [ ] 真机验收（需重启宿主）：联动页确认「本机语音接口（通用）」是独立卡片、QQ 卡片只剩渠道规则；
      开关接口与 QQ 渠道规则互不影响。

## P0 — 已配置收起引导 + 目录点选（0.8.5，已装待真机验收）

- [x] **已配置后收起引导卡**：`PanelState.setup.ready` 由 World 计算：自备目录 `isRuntimeDir` + 有
      `tools/portable_runtime.py`、已有服务地址已填、托管运行时就绪。ready 时引导卡只留
      「当前：… · 路径」+「更换目录 / 改用已有服务」，点开才铺开，改完自动收起。
      未配置 / 检测失败 / 缺 portable / 权重不配对仍显示完整引导；0.8.4 的陈述式标题继续生效。
- [x] **目录改点选**：用宿主面板 `ctx.pickPath({ kind: 'directory' })`（宿主 build 已确认存在），
      主按钮「选择目录…」→ 系统文件夹对话框 → 回填只读框 → 立即 `checkFolder()`；取消 / 异常静默。
      路径框默认只读，「手动输入路径」次要入口默认收起，点开才可编辑。
- [x] 一级验证：`tsc --noEmit` 通过；`vitest run` **26 文件 314 例** 全过；`build` 产出 `dist/webui.js` 78.1 KB；`check:audio` 通过。
- [x] 二级验证：`describe:extension` + `check:extension` 通过（0.8.5；仅既有 `sovits_speak` 默认配置描述告警与标签词表证书跳过）。
- [x] 本机安装：0.8.5 tgz 已装进 Coopanion；`dist/webui.js`、`src/world.ts`、`src/webui/client.ts` 哈希与工作区一致。
- [ ] 真机验收（需重启宿主）：点「选择目录…」确认系统对话框真的弹出、选中后回填并自动检测、取消无副作用；
      已配置状态下确认引导卡只剩一行摘要；清空配置后确认完整引导回来。

## P0 — 引导卡收紧（0.8.4，已装）

- [x] **引导卡提问收紧**：本地引擎下已选定有效目录并识别出权重后，标题改成陈述式「本机 GPT-SoVITS 目录」、
      副标题改成「已识别到目录与权重」；未选目录仍保持提问，检测失败 / 缺 `portable_runtime.py` /
      权重不配对的说明与按钮都不隐藏。
- [x] 一级验证：`tsc --noEmit` 通过；`vitest run` 全过；`build` 产出 `dist/webui.js` 74.2 KB；`check:audio` 通过。
- [x] 二级验证：`describe:extension` + `check:extension` 通过。
- [x] 本机安装：0.8.4 tgz 已装进 Coopanion；`dist/webui.js` 哈希与工作区一致。
- [ ] 真机验收：已配置状态下确认引导卡只剩摘要行。

## P0 — 下载提速（0.8.3 全部落地）

- [x] 训练依赖按版本判定：读 `gradio-4.*.dist-info`（`funasr>=1.3.7`），gradio 6.x / 缺 dist-info 算未就绪。
- [x] 运行时 GitHub 分片（cuda / rocm part0–part2）补 `ghfast.top` / `gh-proxy.com` 回落，官方仍排第一。
- [x] CPU 整包的 GitHub 兜底同样补两个加速前缀（与 cuda / rocm 分片一致）。
- [x] **多连接分片下载**：`fetchVerified` 对 ≥16 MiB 的文件默认开 4 路 Range 并发，按序合并；
      服务端不认 Range / 某段失败自动退回单流；SHA-256 整包校验与断点续传语义不变。
- [x] **pip 第二源**：训练依赖按 阿里云 → 清华 → 官方 PyPI 依次尝试（实测阿里云 1.47 MB/s > 清华 0.36 > 官方 0.03）。
- [x] **权重源测速择优**：不再写死 hf-mirror 优先；下载前按实测速度排序（每主机读 512 KiB、4 秒超时），
      结果缓存在数据目录 `source-speed.json` 12 小时；全部测速失败时保持清单原顺序。
- [x] 下载来源可见：面板状态行 / 训练日志显示当前来源主机，切源可见。

## P0 — 训练依赖假就绪（issue #14，0.8.1 已修）

- [x] `depsReady(dataDir, runtimeDir)` 实测当前运行时 `site-packages` 里的 `gradio` / `funasr`，不再只信标记。
- [x] 标记新增 `dir` 并绑定运行时目录；旧标记无 `dir` 视为过期，重装一次即重新绑定。
- [x] 启动失败原因（`No module named …` / 退出码 / 超时）进 `TrainerState.startError`，面板红字直显 + 「安装训练依赖」按钮。
- [x] `tests/trainer-deps.test.ts` 7 例；真机 cuda 有包 / cpu 缺包已核。
- [ ] 真机验收：cpu 档启动训练 → 面板直接显示缺 `gradio` 并可一键补装。

## P0 — 已有 GPT-SoVITS 接入（0.8.0，已完成待真机验收）

目标：用户下载插件前已经有完整 GPT-SoVITS 时，不再重复下载运行时。选了「本地」引擎后再问，
三选一（选目录 / 已在跑服务 / 下载托管），默认推「选目录」。

- [x] **目录识别**：新增 `src/gptsovits-folder.ts`——`inspectFolder()` 检查 `api_v2.py`、`runtime` Python、
      `tools/portable_runtime.py`；`walk()` 跳过 `runtime` / `pretrained_models` 等大目录；
      `pairWeights()` 按文件名主干配对 `.ckpt` / `.pth`，版本复用 `sovitsVersion()` / `checkWeights()`；
      参考音频只收 3–10 秒 wav，同名 `.txt` / `.lab` 当台本；Windows 长路径走 `fsPath()`。
- [x] **候选扫描**：`findFolders()` 在桌面 / 下载 / 文档与 Windows 盘根下一层找名字像 GPT-SoVITS 的目录，
      只给用户点选，不自动接入。
- [x] **服务探测**：`probeService()` 只在用户点「测试连接」时 `GET {base}/docs`，不自动扫 9880；
      `isLocalService()` 判断是否本机。
- [x] **World**：`findFolders` / `inspectFolder` / `applyFolder` / `probeService` / `useManaged` 五个方法；
      `applyFolder()` 服务端重新检查目录后才写 `runtimeDir` / `weights` / `voice.audio`；
      `PanelState.setup` 暴露当前接入方式；`applyWeights()` 对非本机服务只警告、不换权重。
- [x] **面板 UI**：「语音」页本地组顶部三选一卡；目录输入 + 检测 / 自动找 + 权重与参考音频列表 + 用这个目录；
      服务地址 + 测试连接 + 跨机提示；托管按钮回到「安装」。中英文案各 33 条。
- [x] **测试**：`tests/gptsovits-folder.test.ts` 20 例；全量 **280 例** 通过。
- [ ] **验收**：按 [docs/cloud-acceptance.md](docs/cloud-acceptance.md) 第 0d 节跑三条接入路径。

## P0 — 云端语音引擎（进行中，2026-11-08 开始）

目标：**本地 + 云端都通用**。手动切引擎；云端走 OpenAI 兼容的 `POST {base}/audio/speech`；
密钥用 AES-256-GCM 加密存盘（主密钥 `CORTICO_SECRET_KEY` 在部署 `.env`，没有就自动生成并追加）；
`config.json` 只留掩码；云端音色单独一份清单，与本地音色互不干扰。

- [x] **后端**（提交 `72e3938`）：`src/cloud.ts`（只收 WAV、错误分类、密钥脱敏）、`src/secret-store.ts`
      （AES-256-GCM、主密钥从 `.env` 读、缺失则生成并追加且写前备份、读不到时降级到 `data/secrets/master.key`）、
      `src/config.ts`（`ttsEngine` / `cloudBaseUrl` / `cloudModel` / `cloudVoiceId` / `cloudVoices` / `cloudKeyMask` / `cloudTimeoutMs` + schema）、
      `src/world.ts`（`engine()` / `cloudReady()` / `cloudIssue()` / `playCloudLine()`、`pump()` 与 9880 分流、
      面板状态字段、`setEngine` / `saveCloudKey` / `clearCloudKey` / `setCloudField` / `setCloudVoices`）。`tsc` 通过。
- [x] **面板 UI**（0.7.1 调整）：「语音」页最顶部是「语音引擎」**下拉**（请选择 / 本地 / 云端），新装默认未选择——
      此时只显示提示、不显示任何引擎设置；选好后只显示所选引擎的设置，另一个整组隐藏。「音色」页的本地/云端卡
      按同一规则显隐；通用设置（插件联动等）不受影响。老配置里的 `local` / `cloud` 视为已选择，未选择时合成按本地走。
- [x] **面板 UI**（「音色」页）：L1 音色分组（本地显示预设+自定义音色，云端显示云端音色清单）；
      云端分组含地址/模型/音色 id/超时 + 密码输入框（保存后只回显掩码，留空或提交掩码＝不修改）+ 音色增删。
      旧宿主没有 `ui.foldSheet` 时退回普通卡。
- [x] **测试**：`tests/cloud.test.ts`（URL 拼装、错误映射、脱敏、非 WAV 报错）、`tests/secret-store.test.ts`
      （加解密往返、掩码、主密钥缺失时写 `.env`、损坏/换钥/clear）。顺带修 `clear()` 留空文件导致「已设置但解不开」。
- [x] **文档**：README 加「云端语音」小节（配置步骤、密钥存放位置、限制：没有首块流式、整段返回）；
      CHANGELOG 新增 `## 0.7.0` 条目，并把已发布的 `## 未发布` 改回 `## 0.6.10`。
- [x] **版本**：工作区升到 **0.7.0**（新增能力，走 minor）；0.7.1 再升一档，改「语音引擎」入口与显隐；
      0.7.2 再升一档，去重「音色与台词」页并改权重/推理档交互。
- [x] **去重（0.7.2）**：「音色与台词」页的 `textLang` / `translateEndpoint` / `translateApiKeySecret` /
      `translateModel` / `speed` / `seed` / `promptLanguage` 搬进「音色」页底部「台词与翻译」卡（同一 schema、
      同一 `setConfigValue`），确认齐全后从 `webUi().panels` 移除整个 `cfg-voice` 页签（`configGroups` 保留供读取）。
- [x] **权重与推理档解耦（0.7.2）**：`weights.ts` 拆出 `checkWeights()`，保存音色只校验文件结构；
      换/新增/编辑选中音色时 `alignModel()` 按 SoVITS 版本头自动改 `voiceModel` 并回执 `modelSwitched`；
      `start()` 写不匹配警告，面板 `mismatch` 显示红字（云端引擎时不提示）。
- [x] **云端音色默认值（0.7.3）**：`src/cloud-voices.ts` 内置 OpenAI 官方 6 个音色；清单为空且地址是
      `api.openai.com` 时自动列出并默认 `alloy`，不写盘、老配置优先；`cloudReady()` / 面板 / 合成统一走
      「生效音色」。新增「从服务商拉取清单」（`GET {base}/audio/voices`，成功合并、失败可读提示），
      `tests/cloud-voices.test.ts` 覆盖默认值、解析、鉴权与脱敏。默认值策略参考 `cortico-world-voice-qq`（MIT），未移植代码。
- [x] **云端兼容性提示与设置小字（0.7.4）**：非 OpenAI 地址下把官方音色标「（OpenAI 官方）」；选中的是官方音色时
      云端卡显示黄色说明（不硬拦）。`lastError` 在云端卡以红字显示，换地址/模型/音色/引擎时清除。
      云端地址/模型/音色/超时/密钥与添加音色表单补中英双语小字（默认值、留空行为、必填与格式）。
- [ ] **发布**：等主人点头再 npm publish + 打 tag / push + 市场同步 + 回帖。
- [ ] **验收**：按 [docs/cloud-acceptance.md](docs/cloud-acceptance.md) 跑（真实厂商出声、9880 走云端、QQ 语音条带云端音频）。


## P0 — 0.6.0 / 0.6.1 发布（已完成，待真机代验）

- [x] **0.6.5 已发布**（2026-11-02 23:00，紧急）：修 0.6.4 的**静音回归**——0.6.4 的后端探针把两帧写给 audify
      （`write()` 只接受正好一帧），抛的 `Invalid size of the PCM data!` 被吞 → 两只后端都被判死 → **0.6.4 在 Windows 上
      完全没声**（与 `audioBackend` 取值无关）。修法：帧长统一走 `oneFrameBytes()`（与播放路径同一套算法），
      探针自己写失败不再判后端死刑（只 warn 后放行）。已在本机用随包 audify 真机对过（一帧 5120 B 成功、两帧抛错）。
      同时带 `-I` → `-s` 的自备运行时修复（#5）。
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

- [x] **模型版本与推理档解耦（#228 新反馈，@niaolong233）**（0.6.0 已实现）：有人在显卡档想用自己训的 v2ProPlus 模型，
      但显卡档只认 v5turbo，自备的 v2ProPlus 权重被 `resolveTrained()` 以「当前推理档用的是 v5turbo」拒掉，放不进去。
      做法：新增配置 `voiceModel: 'auto' | 'v5turbo' | 'v2ProPlus'`（默认 auto = 现在的行为），
      `version()` 改为读它；CPU 档选 v5turbo 仍然忽略（社区反馈慢到出不来；我们未在 CPU 上实测过 v5turbo）；
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

## P1.5 — macOS（0.6.6 已正式发布）

- [x] 按 #10 的路线实现（2026-11-02）：`src/platform.ts` 收口解释器/tar/PATH/发布判定/播放差异（全部带 `platform` 参数，
      darwin 分支在 Windows 上也能跑单测）；`player.ts` 走 `afplay`（攒 PCM → 临时 WAV → 排队播，`cut()` 停播+清队列）；
      `server.ts` / `trainer.ts` / `install.ts` 改用平台解释器与 PATH，macOS 子进程独立进程组按组收，
      权重目录在非 Windows 上建普通目录符号链接。`tests/platform.test.ts` 14 例。
- [x] 顺带收口：`gpu.ts` 非 Windows 直接短路（不 spawn `powershell`/`nvidia-smi`）；`assertRocmPaths` 跳过读注册表；
      `tierOptions` 只给「自动 / CPU」、`audioBackendOptions` 只给「自动」；面板新增 `tierMac` 说明。
- [x] 说明写清：自备运行时约 7 GB、`afplay` 只整段播（首字延迟＝合成时间）、无设备选择（音量仍走 `afplay -v`）。
- [x] **M3 真机实测**（#10 作者 ink1453，2026-11-02）：五项全过——启用/面板、自备运行时起服务、试听出声、
      排队不打断（口径作废）、闲置停服后自动拉起；`core.log` 无 warn。实测暴露两个问题，都已修：
      ① CPU 档恒用 V2 Pro Plus（说明书写错了，已改 README，并加「缺权重点名」提示）；
      ② `-I` 与上游 `api_v2.py` 的 `from tools.portable_runtime import …` 冲突——`-I` 会踢掉脚本目录、
      还连带 `-E` 忽略 `PYTHONPATH`，改用 `-s`（`PYTHON_ARGS`）后自备运行时的 venv 能直接 `import tools`。
- [x] **0.6.10 已发布**（2026-11-06）：① 切换音色立刻换权重（选中/增删改后直接调 `/set_*_weights` 并清失败标记；
      官方音色不再继承全局自备权重；权重签名带版本与底模，修掉「切回 dfy 还是祀的声音」）；② 新增「系统播放器
      （安全模式）」音频后端，不加载 audify、WAV 交系统播放，绕开 #13 的 RtAudio 原生崩溃（本机 4.2 s 音频
      5.6 s 播完）；③ 修正官模 LoRA 的过时说法。214 例全过；#13 已回；市场同步 #775。
- [x] **0.6.9 已发布**（2026-11-04）：① 配置页「模型版本」「音频后端」恢复下拉（`panelOptionsFor` 补 case 并抽出导出，
      `tests/config-options.test.ts` 盯着四个选项源）；② `normalizeVoiceModel()` 把旧手填显示名归一成 key（未知回 auto +
      启动 warn），`WeightsJob` 空表兜底，修掉 `baseReady()` 抛 `Cannot read properties of undefined`；③ 文案删掉底模音色
      主观描述，README 补实测速度表（显卡 1.72/1.90 s、CPU 7.74 s）。212 例全过；市场同步 #719。
- [x] **0.6.8 已发布**（2026-11-04）：QQ Bot（qqbot）「文字+语音条」：新增 `qqbotVoice` 开关，提示词规定
      `sovits_speak(silent: true)` → `[blob …]` → `qqbot_send_message.voice`；旧插件（qq-final / NapCat）
      继续走 9880 的 `qq_send voice=true`；两个开关可同开、按回复工具名分规则。补了两个坑：9880 对 qqbot 无效
      （它只认句柄/公网 URL）、`c2c:<OpenID>` 不能喂给只收纯数字的 `qq_send`。联动页改成五张 `ui.foldSheet`
      折叠卡（带摘要，旧宿主回退普通卡）。206 例全过；市场同步 #715；讨论 #228 已发说明。
- [x] **0.6.7 已发布**（2026-11-04）：① ROCm NLTK 语料同步进运行时（市场评论区 @ANGOSUNG 报告；上游
      `tools/portable_runtime.py` 把 `NLTK_DATA` 硬赋值到 `<运行时>/runtime/nltk_data`，只补数据目录无效）；
      ② AMD 名单补全 7 个同架构型号 + `(TM)`/空格归一化（#12 触发核查）。197 例全过；市场同步 issue #709。
- [x] **0.6.6 已发布**（2026-11-03）：`os` 加 `darwin`，macOS 正式可用；`0.6.5-mac.2` 上 ink 复验通过
      （`api_v2.py` 保持上游原样、服务 11 s 就绪）；PR #10 已评论并关闭（署名保留）；市场同步 issue #691。
- [ ] **等 ink 装正式版后回最后一次结果**：他说过「装正式版后再回一次结果」，通过就关 #5。

## P1.6 — 待主人拍板 / 已调研待做（2026-11-02 记）

- [x] **#6 长句电流声：已按「口径差异、非缺陷」收尾**（2026-11-03）。ink 用同一份 `scripts/analyze-noise.py`
      重算他那批样本：长句 1.73–1.81 %、短句 2.56–2.59 %、spikes 全 0，与我们这边同量级；之前 5–9 % 是
      另一套指标（20 ms 帧高频能量 p95 的相对差）。数据记在 docs/noise-ab.md。**不改默认流式/切句参数**；
      若他主观仍有电流声，另开一条按原始 WAV 查播放链。
- [x] **#6 的本地 A/B 已做完**（2026-11-02，11 组：v5turbo/cuda 9 组 + v2ProPlus/cpu 2 组）：**本机复现不出电流声**
      （高频占比 1.1–1.8 %、咔哒尖峰全 0，各组合差异 <0.3 个百分点），所以「分段/流式接缝」假设在本机不成立，
      **暂不改默认参数**。附带发现：CPU 档流式比非流式慢约 35 %（37.6 s vs 27.7 s / 20 s 音频）。
      方法与数据见 docs/noise-ab.md，分析脚本 scripts/analyze-noise.py 已入库；下一步请 ink 用同一脚本重算他那份样本。
- [x] **#7 响应头已随 0.6.6 发布**：`x-sovits-first-chunk-ms` / `x-sovits-synthesis-ms` / `x-sovits-duration-ms`；
      对方确认「不急需 chunked PCM」，真流式端点单开一轮再做（约束：RVC 要整段、队列并发语义、客户端适配）。
- [x] **正式版已带 `darwin`**：0.6.6 发布，市场同步 #691。

## P2 — 冻结项 / 已知但先不动

- [ ] **ONNX / TensorRT 推理引擎：不做**（2026-11-02 主人决定）。收益不确定、要再养一条推理链与一份 3–4 GB 运行时；
      若以后重启，先看 `High-Logic/Genie-TTS` 是否支持 v5turbo，并在本机（RTX 5070 Ti Laptop）量基线再定。

- [ ] 云端 TTS：主人保留意见，未拍板，不实现。
- [ ] QQ 语音投递 `qq_audio`：主人说先不管。
- [ ] 仓库清理：先不动；`*.tgz` 留着备用（注意 0.5.28 的 tgz 已被本轮重打包覆盖）。
- [ ] 显卡档 4.14 GB 真机下载未实测；GitHub 兜底源国内不可用。
- [ ] 解压过程不可取消。
- [ ] ROCm 档没有 A 卡实测，MIOpen 加速倍率只有社区数据。
