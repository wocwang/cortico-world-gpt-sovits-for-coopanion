# Tasks — 0.5.11 训练面板

> 状态：已获用户批准（2026-10-27）。按序执行，每项完成即勾选；全部完成后直接给最终回复（不再 NotifyUser）。
> 冻结约定见文末「实现约定」，T1-T7 一律照此实现。

- [x] T0 前置只读勘察
  - 结论：
    - `webui.py` 无 `--port/--host` CLI（仅 `sys.argv[-1]` 当语言参数）→ 必须锚点补丁改 launch 块（`webui.py` 1977-1983，原文见「实现约定」）。
    - `TRAIN_ASSETS` 只缺 1 个文件：`v2Pro/s2Dv2ProPlus.pth`（126,432,639 B，sha256 `635cd84bf6f7f9b8d41c88c7106f81d782c794c61f931845214ea037b0c5bef2`）。v5turbo 训练所需（`s1v3.ckpt`、`gsv-v5-pretrained/s2Gv5turbo.pth`、`gsv-v5-pretrained/vocoder.pth`）与 v2ProPlus 推理权重都在本机权重目录；唯一缺的是 v2ProPlus 训练的判别器 s2D。
    - 源已验证：modelscope `XXXXRT/GPT-SoVITS-Pretrained/.../v2Pro/s2Dv2ProPlus.pth` HEAD 200；HF `lj1995/GPT-SoVITS`（resolve/main）作兜底。
    - 运行时 venv 缺依赖：`gradio(<5)`、`tensorboard`、`funasr(>=1.3.7)`、`modelscope`、`ctranslate2(>=4.0,<5)`；pip 26.1.2 可用。
    - 落盘路径 = `weightsDir/v2Pro/s2Dv2ProPlus.pth`（Junction 使 `weightsDir` ≡ 运行时 `GPT_SoVITS/pretrained_models`，上游才能找到）。
    - 上游训练版本下拉为 `["v2","v2Pro","v2ProPlus","v4","v5dev","v5turbo"]`（webui.py:1499）；本轮只为「推理档对应版本」（v5turbo/v2ProPlus）补资源，其余版本请用户自行准备，不做下载。
- [x] T1 `src/catalog.ts`：新增 `TRAIN_ASSETS` 清单（modelscope 源优先，Hugging Face 兜底）（另给 `install.ts`/`server.ts` 的 `fetchVerified`/`freePort` 加了 `export`）
- [x] T2 `src/trainer.ts`：新建 `TrainerManager`（state / installDeps / downloadAssets / start / stop / 日志环）
- [x] T3 `src/runtime-patch.ts`：新增 `patchTrainer()`（0.0.0.0→127.0.0.1、inbrowser→False、端口读 `COOPANION_TRAINER_PORT`）；`tests/runtime-patch.test.ts` 加 4 例
- [x] T4 `src/world.ts`：invoke 分支 `trainerState/installTrainer/downloadTrainerAssets/startTrainer/stopTrainer` + 面板 `train` + getMethods
- [x] T5 `src/webui/client.ts`：`trainPanel()` + bundle 注册（2s 轮询、打开浏览器、日志折叠、复选框）
- [x] T6 `src/i18n.ts`：zh/en 训练文案（18 键 × 2，两语同步）
- [x] T7 文档与版本：CHANGELOG 0.5.11（含密钥删除说明）、README「训练自己的音色」、`package.json` → 0.5.11、build
- [x] T8 验证：typecheck 0 错 / test 81 全绿（含新 4 例）/ build 0 并刷新 dist（含 `trainerState`）/ grep 密钥残留为空；逐项审计通过。两处发现 → T8.1 修复；dist 在 `.gitignore`（不入库，tgz 内含）
- [x] T8.1 修复 `src/trainer.ts`：训练子进程补 `child.on('error')` 监听（防 spawn 失败时宿主崩溃）——已改，typecheck 0 错、runtime-patch/install 12 例通过
- [ ] T9 本机实测：装依赖 → 下 1 个资源 → 起 WebUI（仅 127.0.0.1，HTTP<500）→ 停 → 9880 推理服务无损
- [ ] T10 打包 0.5.11 tgz（删除过期 0.5.10 tgz），交付用户本地安装验收
- [ ] T11 提交（本地 commit，含未提交的密钥删除改动；dist 在 `.gitignore` 不入库，tgz 里已带；**不 push**，待用户指令）

## 依赖与顺序
T0 → T1/T2/T3（并行）→ T4/T5/T6（并行）→ T7 → T8 → T9 → T10 → T11

## 批准后不做的事
- 不 push、不发 release、不发评论
- 不改第三方插件（qq-final 等）
- 不动飞鱼训练产物与 `D:\models\feiyu-data`（只读枚举）

## 另册（不在本任务内）
- 飞鱼 v6 v5turbo 权重发布：等用户试听 `D:\models\feiyu-data\v6\audition\*.wav` 选 epoch → 再打包权重 release + 改 `catalog.ts` 版本

---

## 实现约定（冻结接口，T1-T7 照此实现）

### catalog.ts（T1）
新增（放在 `MODEL_FILES` 附近）：

```ts
/** 训练用的预训练资源：v5turbo 训练所需文件随推理权重已就位，只差 v2ProPlus 的判别器 s2D。 */
export const TRAIN_ASSETS: readonly PinnedFile[] = [
  upstream('v2Pro/s2Dv2ProPlus.pth', 126432639, '635cd84bf6f7f9b8d41c88c7106f81d782c794c61f931845214ea037b0c5bef2'),
];
```
落盘 = `join(weightsRoot,'gpt-sovits','pretrained_models', path)`（与 `MODEL_FILES` 同根）。

### runtime-patch.ts（T3）
- 新增 `export const TRAINER_PATCH_MARKER = '_coopanion_trainer_patch';`、纯函数 `trainerPatchedSource(source: string): string | null`（重复执行返回 null；CRLF 保持；锚点全中才替换）、`export function patchTrainer(runtimeDir: string): PatchResult`（文件 = `join(runtimeDir,'webui.py')`，写法照 `patchRuntime`）。
- 唯一锚点（`webui.py` 1977-1981，缩进 4 空格）：
  find：
  ```
      app.queue().launch(  # concurrency_count=511, max_size=1022
          server_name="0.0.0.0",
          inbrowser=True,
          share=is_share,
          server_port=webui_port_main,
  ```
  replace（注释带 marker，两处中文注释）：
  ```
      app.queue().launch(  # concurrency_count=511, max_size=1022  # [coopanion-trainer] _coopanion_trainer_patch
          server_name="127.0.0.1",  # [coopanion-trainer] 只绑回环
          inbrowser=False,
          share=is_share,
          server_port=int(os.environ.get("COOPANION_TRAINER_PORT", webui_port_main)),
  ```
  （`webui.py` 顶部已 `import os`，无需另插 import）

### trainer.ts（T2，新建）
- `import type { Logger } from 'cortico/core/types.ts';`、`import { TRAIN_ASSETS, RUNTIME_VERSION, type PinnedFile } from './catalog.ts';`、`import { fetchVerified } from './install.ts';`、`import { freePort } from './server.ts';`、`import { patchTrainer, TRAINER_PATCH_MARKER } from './runtime-patch.ts';`
- `install.ts` 为 `fetchVerified` 加 `export`；`server.ts` 为 `freePort` 加 `export`（改动仅加关键字）。
- 类型与类：
  ```ts
  export interface TrainerState {
    deps: 'missing' | 'installing' | 'ready';
    depsError: string | null;
    assets: Array<{ name: string; bytes: number; ready: boolean }>;
    assetsReady: boolean;
    assetsWorking: boolean;
    assetsError: string | null;
    running: boolean;
    starting: boolean;
    port: number | null;
    url: string | null;
    logTail: string[];
  }
  export class TrainerManager {
    constructor(opts: { runtimeDir: () => string; weightsDir: () => string; dataDir: string; log: Logger; stopInference: () => Promise<void> });
    state(): TrainerState;
    installDeps(): Promise<void>;      // 异步长任务：立即返回，面板轮询 state()
    downloadAssets(): Promise<void>;
    start(opts: { stopInference?: boolean }): Promise<void>;
    stop(): Promise<void>;
  }
  ```
- deps 判定：`join(dataDir,'trainer-deps.json')` 存在且 JSON 里 `runtime === RUNTIME_VERSION` → `ready`；安装中 → `installing`；否则 `missing`。安装成功写 `{ runtime: RUNTIME_VERSION, at: ISO }`。
- `installDeps()`：spawn `join(runtimeDir,'runtime','python.exe')`，argv `['-I','-X','utf8','-u','-m','pip','install','--no-warn-script-location','gradio<5','tensorboard','funasr>=1.3.7','modelscope','ctranslate2>=4.0,<5']`，`cwd=runtimeDir`，env `{...process.env, PATH: `${runtimeBin};${process.env.PATH ?? ''}`}`（照 server.ts）；stdout/stderr 逐行进日志环；退出码非 0 → `depsError` = 尾部 40 行拼接。
- `downloadAssets()`：TRAIN_ASSETS 逐个 `fetchVerified(f.sources, `${dest}.partial`, f.bytes, f.sha256, onBytes, signal)` 后 `renameSync`（照 `WeightsJob.work`；`dest = join(weightsDir(), f.path)`，自动建目录）；失败把尾部 40 行/错误写 `assetsError`。
- `start({stopInference})`：① 勾选时先 `await opts.stopInference()`；② `port = await freePort()`；③ `patchTrainer(runtimeDir())`，结果写日志（`unsupported`/`missing` 只警告，不阻断，就绪探测回退 9874）；④ spawn `['-I','-X','utf8','-u','webui.py']`，`cwd=runtimeDir`，env 加 `COOPANION_TRAINER_PORT: String(port)`；⑤ 就绪轮询 `GET http://127.0.0.1:<port>/`（500ms 间隔、上限 300s，响应 status < 500 即就绪；补丁未生效时同时试 `127.0.0.1:9874`）；超时或进程退出 → 停掉、日志写明原因。
- `stop()`：`taskkill /PID <pid> /T /F`（照 `SovitsServer.stop`，含 5s 兜底）。
- 日志环：最近 200 行；`state().logTail` 返回尾部 40 行。

### world.ts（T4）
- 懒建：`private trainerManager: TrainerManager | null = null;` + `private trainer(): TrainerManager`（构造入参：`runtimeDir: () => this.runtime.dir()`；`weightsDir: () => this.weights.dir()`；`dataDir: this.opts.dataDir`；`log: this.log`；`stopInference: async () => { this.hush(); await this.server.stop(); }`）。
- 门槛 `trainerGate()`：`backend().kind === 'remote'` → 抛「当前是『已有服务』模式：训练需要本机运行时。」；`'own'` → 抛「自备运行时目录不支持训练面板，请直接用该目录里的 webui.py。」；managed 但 `runtime.status().phase !== 'ready'` → 抛「运行时还没装好，先到『语音』页安装。」。
- `invoke()` 顶层分支（照 `qqGuide` 模式，面板无关也行）：
  - `trainerState` → `this.trainerGate().state()`
  - `installTrainer` → `void mgr.installDeps(); return mgr.state();`
  - `downloadTrainerAssets` → `void mgr.downloadAssets(); return mgr.state();`
  - `startTrainer` → `void mgr.start({ stopInference: args[0] === true }); return mgr.state();`
  - `stopTrainer` → `await mgr.stop(); return mgr.state();`
- `webUi()` panels 追加：`{ id: 'train', title: t.trainPanel, description: t.trainPanelHint, getMethods: ['trainerState'] }`。

### webui/client.ts（T5）
- 新增 `const trainPanel: WebUiPanel = { mount(ctx) { ... } }`，`bundle.panels` 加 `train: trainPanel`。
- 行结构（照 voicePanel 的 `row` 写法）：`trainDeps`、`trainAssets`、`trainServer` 三行 + 日志。
- 按钮：`trainInstallDeps` → invoke `installTrainer`；`trainDownloadAssets` → `downloadTrainerAssets`；`trainStart`（旁边复选框 `ui.checkbox(t.trainStopFirst, { checked: true })`，读 `cb.el.checked`）→ `startTrainer [先停推理]`；`t.stop` → `stopTrainer`；`trainOpen` → `window.open(url, '_blank', 'noopener')`。
- 轮询：`ctx.interval(() => void refresh(), 2000)`，`refresh` = `ctx.invoke<TrainerState>('trainerState')`；失败时把错误写 msgline（`msg.classList.add('bad')`）。
- 红字提示：`ui.msgline(t.trainWarn, true)`；日志：`ui.h('pre','gsv-output')` + `trainLogToggle` 按钮折叠（默认收起，显示尾部 40 行）。
- 类型：`import type { TrainerState } from '../trainer.ts';`（type-only，打包时擦除）。

### i18n.ts（T6）
zh/en 各新增（键名一致，英文语义对应）：
`trainPanel`('训练')、`trainPanelHint`、`trainWarn`(红字：训练吃显存，建议先停推理)、`trainDeps`('训练依赖')、`trainDepsMissing`('未安装')、`trainDepsInstalling`('安装中')、`trainDepsReady`('已就绪')、`trainInstallDeps`('安装训练依赖')、`trainAssets`('训练资源')、`trainAssetsCount(n, total)`、`trainDownloadAssets`('下载训练资源')、`trainServer`('训练 WebUI')、`trainStart`('启动训练 WebUI')、`trainOpen`('打开浏览器')、`trainStopFirst`('先停推理服务（释放显存）')、`trainLog`('训练服务日志')、`trainLogToggle`('显示/隐藏日志')、`trainArtifactsTip`('训好的权重在运行时的 GPT_weights*/SoVITS_weights* 目录，到「音色」面板当自备权重选用。')。

### 文档与版本（T7）
- `CHANGELOG.md` 新增 `## 0.5.11`：① 新增「训练」面板：可选安装训练依赖、可选下载训练资源（v2ProPlus 的 s2D）、面板内启动只绑回环的训练 WebUI；② 语义判定密钥不再由本插件代填（说明这条是随版落地的改动）。
- `README.md` 新增「训练自己的音色」小节：装依赖 → 下资源 → 停推理 → 起 WebUI → 产物接「自定义音色」（自备权重）。
- `package.json` version → `0.5.11`；`pnpm run build` 刷新 dist。

### 打包（T10）
- 先 `pnpm run prepublishOnly`（build+test+typecheck），再 `pnpm pack`（包名 `@wocwang/...` → 产出 `wocwang-cortico-world-gpt-sovits-for-coopanion-0.5.11.tgz`）；`files` 字段只含 src/dist/assets/vendor/README/LICENSE/THIRD_PARTY_NOTICES/CHANGELOG/describe.json（spec.md/tasks.md 不会入包）。
- 删除过期的 `wocwang-...-0.5.10.tgz`（spec 决策 D2：作废旧包，直接出 0.5.11）。

### 提交（T11）
- 一个本地 commit：训练面板 + 密钥删除（world.ts/client.ts/i18n.ts/README/CHANGELOG 的既有未提交改动一并带上）+ 版本 0.5.11 + dist 产物；**不 push**。
- 提交信息风格照最近提交（`feat: …；…`，中文一句话）。

---

## 后续想做（Backlog）

### 线上模型：让低配用户不跑本机推理（2026-10-27 评估，未开工）

目标：没显卡 / 显存不够的用户也能用；难点是音色——QQ 与桌宠要的是「大肥鱼/星落落」，
不是通用 TTS 音色。

可行路线（按落地成本排序）：

1. **云端 OpenAI 兼容 TTS + 声音复刻（最快落地）**：插件新增「云端」后端与供应商选择，复用
   OpenAI `/audio/speech` 协议；音色靠云厂商的声音复刻（MiniMax / 火山 / Fish Audio / 智谱等）。
   改动集中在 `src/synth.ts` 之外的一层后端适配 + 配置组；失败回退文字/本机（已有 RVC 透传思路可复用）。
2. **远程 api_v2（最省事，但只能服务自己/少数人）**：现有「已有服务」模式已能连远程 GPT-SoVITS。
   多用户/公网还缺：参考音频上传或服务端预置音色、鉴权、隧道、延迟与隐私说明。
3. **自建托管服务（不在插件内做）**：插件只当客户端，服务端统一跑 GPT-SoVITS + RVC；涉及运营、计费、
   合规与声音授权，需要独立项目。

开工前要确认：

- 目标用户是「完全没显卡」还是「显存不够」？前者必须云 TTS，后者可用远程 GPU。
- 音色必须是大肥鱼/星落落，还是可接受厂商音色 / 云端复刻？复刻需要授权与合规。
- 谁出 API Key / 服务器与费用？是否做「自带 Key」模式？
- 文本出网能否接受？要不要保留「全本地」开关？
- 国内网络选哪家、可接受的首响延迟是多少？云端失败时回落本机还是回落文字？
- RVC 继续留本机（低配 CPU 推理慢）还是也上云？
- 是否要把「云端/本机」做成同一个 `serverUrl` 的两种协议，还是新增独立后端类型（建议后者，便于
  配置校验与状态灯）。

建议第一步只做路线 1 的最小闭环：配置里加「云端供应商 + 地址/Key/音色/超时」，合成走
OpenAI `/audio/speech`，失败回落当前本机后端；先不做复刻与计费，验证需求后再扩。
