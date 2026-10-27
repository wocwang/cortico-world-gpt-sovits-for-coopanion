# Spec — 0.5.11：训练面板（可选下载训练资源 + 面板内启动训练 WebUI）

状态：待用户批准（批准前不写实现代码）
依据：用户已口头批准「可以开始做吧」（下载完整训练模型的可选项 + 插件里直接打开 webui 训练新权重）

## 1. 背景与现状（已核实）

- 工作树有未提交改动 = 「删除语义判定密钥相关代码」（world.ts / webui/client.ts / i18n.ts / README.md / CHANGELOG.md），
  已重新构建（dist 于 2026-10-27 08:54 刷新），**未提交、未打包**。
- `wocwang-...-0.5.10.tgz`（07:50 打包）早于上述改动 → 里面仍是带密钥输入框的旧 UI，已过期。
- 训练能力**尚未实现**：`src/` 中无 `trainer*` 方法与训练面板。
- 运行时（`data/home/runtimes/gpt-sovits/e91506f-1/{cuda,cpu}/runtime`）已具备：
  训练脚本（`GPT_SoVITS/s1_train.py`、`s2_train.py`、`s2_train_v3*.py`）、`webui.py`、`api_v2.py`、
  torch 2.7.1+cu128、pytorch-lightning、peft、numpy 1.26.4、pydantic 2.10.6 等；`python.exe` 自带 pip。
- 训练缺的依赖：`gradio(<5)`、`tensorboard`、`funasr(>=1.3.7)`、`modelscope`、`ctranslate2(>=4.0,<5)`。
- 上游 `webui.py`：`server_name="0.0.0.0"` + `inbrowser=True` + 端口写死在 `config.py`（`webui_port_main=9874`）。
- 可复用实现范式：`src/server.ts`（spawn / 就绪轮询 / taskkill / freePort / linkWeights）、
  `src/runtime-patch.ts`（锚点全中才写的纯文本补丁）、`src/weights.ts`（下载清单 + 校验）、
  `src/webui/client.ts`（面板原语 ui.sheet/section/button/pill/msgline/toast）。
- 训练资源清单可枚举：本机实测脚本 `D:\models\feiyu-data\v6\trial_v5\tmp_s1.yaml`、`tmp_s2.json`
  里引用的预训练权重文件名即为准确清单（实施第 0 步读取）。

## 2. 目标（本版做）

1. 控制台新增「训练」面板：状态显示 + 「安装训练依赖」「下载训练资源」「启动训练 WebUI」「停止」
   「打开浏览器」按钮 + 日志尾部折叠区。
2. 训练 WebUI 只绑 `127.0.0.1`、端口自动取空闲（避开推理服务 9880），启动前可勾选「先停推理服务释放显存」。
3. 训练依赖/训练资源为**可选、显式触发**，默认不装不下；运行时升级后安装状态自动失效、可重装。
4. 「删除判定密钥相关代码」的未提交改动随本版本一并落地（合并为一个 0.5.11 提交）。
5. 打包 0.5.11 tgz 供本地安装验收；**不 push、不发 release、不发评论**（发布另行确认）。

## 3. 非目标

- 不做训练参数的图形化（训练页 = 上游原版 WebUI，浏览器打开）。
- 不内置 RVC；不自动下载 ASR 模型（仅安装 `funasr` 库本身）。
- 不改第三方插件代码；不动 `D:\models\feiyu-data` 下的训练产物。
- 飞鱼 v6 权重发布（新 release 权重包 + catalog 清单）不在本 spec，等用户试听结论后另开。

## 4. 变更清单（决策完整）

### 4.0 实施前置（只读）
读 `D:\models\feiyu-data\v6\trial_v5\tmp_s1.yaml` 与 `tmp_s2.json`，枚举训练所需预训练权重文件名与本地路径 → 作为 `TRAIN_ASSETS` 清单依据；
`runtime\python.exe webui.py --help` 确认是否支持 `--port/--host/--bind` CLI（优先 CLI，否则用锚点补丁）。

### 4.1 `src/catalog.ts`
- 新增 `TRAIN_ASSETS: ReadonlyArray<{ name; bytes; urls: string[]; dest: string }>`：
  训练用预训练权重（按 4.0 枚举；预计含 s2G/s2D 基模、缺则补 s1 基模），下载到 `weightsDir/train_assets/`。
- 源按现有惯例：modelscope 自有仓库 `Phantivia/gpt-sovits-for-coopanion` 优先，GitHub release 兜底；
  找不到现成源的文件记入「实施时上传」清单（本轮先只放能下的，缺的标 `pending-upload` 并在面板注明）。

### 4.2 新增 `src/trainer.ts` — `TrainerManager`
- `state()` → `{ deps: 'missing'|'installing'|'ready', depsError?: string, assets: {name,bytes,ready}[], assetsReady: boolean, running: boolean, port?: number, url?: string, logTail: string[] }`
- `installDeps()`：`spawn(runtimeBin/python.exe, ['-I','-m','pip','install','--no-warn-script-location','gradio<5','tensorboard','funasr>=1.3.7','modelscope','ctranslate2>=4.0,<5'])`，
  cwd=runtimeDir，输出同时进日志环形缓冲；成功后写 `join(dataDir,'trainer-deps.json')` = `{ runtime: RUNTIME_VERSION, at }`；
  失败把输出尾部 40 行放进 `depsError`。**异步长任务**：invoke 立即返回，面板轮询 `state()`。
- `downloadAssets(onProgress)`：照抄 `weights.ts` 的下载/校验模式，落 `weightsDir/train_assets/`。
- `start(opts: { stopInference?: boolean })`：
  1) 若勾选且推理服务在跑 → 由 world 传入的回调先 `stopServer()`；
  2) `port = freePort(9890)`（复用 server.ts 的 freePort 逻辑）；
  3) `ensureTrainerPatched(runtimeDir)`（见 4.3）；
  4) `spawn(python, ['-I','-X','utf8','-u','webui.py', '--port', String(port) /* 若 CLI 支持 */], { cwd: runtimeDir, env: {...process.env, PATH, COOPANION_TRAINER_PORT: String(port)} })`；
  5) 就绪轮询 `GET http://127.0.0.1:<port>/`（超时 300s，范式同 `SovitsServer.start`）。
- `stop()`：`taskkill /PID <pid> /T /F`（照抄 server.ts）。
- 日志环形缓冲（最近 200 行），面板显示尾部 40 行。

### 4.3 `src/runtime-patch.ts` — 新增 `patchTrainer(runtimeDir)`
锚点全中才写（任一不中 → `'unsupported'`，启动时给提示、不阻断）：
- `server_name="0.0.0.0"` → `server_name="127.0.0.1"`
- `inbrowser=True` → `inbrowser=False`
- `server_port=webui_port_main` → `server_port=int(__import__("os").environ.get("COOPANION_TRAINER_PORT", webui_port_main))`
若 4.0 验证 CLI 已支持端口/绑定，则本补丁只做 `0.0.0.0→127.0.0.1` 与 `inbrowser` 两处（保持最小）。

### 4.4 `src/world.ts`
- `invoke()` 新分支：`trainerState`（GET 点名）、`installTrainer`、`downloadTrainerAssets`、`startTrainer`、`stopTrainer`（均 POST）。
- `getMethods`：仅 `trainerState` 放行 GET。
- 新建 `TrainerManager` 实例（懒加载），把 `stopServer` 与 `runtimeDir/weightsDir/dataDir` 注入。

### 4.5 `src/webui/client.ts`
- 新增 `trainPanel()`：
  - 状态行：依赖（未装/安装中/就绪）、训练资源（n/N）、WebUI（未运行/运行中 + URL）
  - 按钮：`t.trainInstall`、`t.trainAssets`、`t.trainStart`（复选框「先停推理服务」）、`t.trainStop`、`t.trainOpen`（`window.open(url)`）
  - 红字提示：训练吃显存，建议先停推理服务；训练产物（`SoVITS_weights*/GPT_weights*`）可在「自定义音色」里选用
  - 日志折叠 `ui.h('pre', ...)`，运行中每 2s 轮询 `trainerState`
- `bundle.panels` 增加 `train: trainPanel()`。

### 4.6 `src/i18n.ts`
新增 zh/en 文案：`trainTitle/trainHint/trainInstall/trainInstalling/trainAssets/trainAssetsDone/trainStart/trainStop/trainOpen/trainStopFirst/trainRunning/trainMissingDeps/trainDepsReady/trainPort/trainLog/trainArtifactsTip` 等（约 16 条，两语同步）。

### 4.7 文档与版本
- `CHANGELOG.md` 新增 `## 0.5.11`：① 训练面板（可选依赖/资源 + 面板内启动训练 WebUI，仅回环）；② 明记「语义判定密钥不再由本插件代填」（即当前未提交改动）。
- `README.md` 新增「训练自己的音色」小节（装依赖 → 下资源 → 停推理 → 起 WebUI → 产物接自定义音色），并保留 0.5.10 的联动说明。
- `package.json` version → `0.5.11`；`pnpm run build`。
- 打包 `wocwang-cortico-world-gpt-sovits-for-coopanion-0.5.11.tgz`（rollup/pnpm pack，同 0.5.10 方式）。

## 5. 验证

1. `pnpm run typecheck`；`pnpm test`（应 77/77）；`pnpm run build`（dist 刷新）。
2. 本机实测（沙箱外）：
   - 训练依赖安装成功、`trainerState().deps === 'ready'`；
   - 至少下载 1 个训练资源并校验字节数；
   - `startTrainer` 后 `GET http://127.0.0.1:<port>/` 返回 200，`netstat` 确认只监听 127.0.0.1；
   - `stopTrainer` 后进程消失、端口释放；推理服务 9880 全程不受影响。
3. 全仓 grep：`setJudgeKey|secretConfigured|judgeConfigured|qqJudge` 无残留（密钥删除已含在本版）。
4. 交付：0.5.11 tgz + 一句话安装说明；等待用户在 Coopanion 里安装验收。

## 6. 风险

- pip 安装体积大、失败面广（网络/版本冲突）→ 全量日志尾部回传面板，失败可重试。
- 训练显存与推理互斥 → 默认勾选「先停推理服务」+ 面板红字提示。
- 上游 `webui.py` 锚点漂移（运行时升级）→ 补丁失败仅提示、不阻断启动。
- `TRAIN_ASSETS` 个别文件暂无公网源 → 标 `pending-upload`，面板如实显示「暂缺」而非静默失败。

## 7. 待用户决策（批准即执行）

- D1：是否按本 spec 执行（0.5.11 = 训练面板 + 密钥删除落地）？飞鱼 v6 权重发布等你试听后另开一轮。
- D2：0.5.10 的旧 tgz 作废，直接出 0.5.11（推荐）；若坚持 0.5.10 重打包也可，请说明。
