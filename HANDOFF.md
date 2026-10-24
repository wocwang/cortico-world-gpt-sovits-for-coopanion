# 交接文档 · 更好的GPTSovits 语音（Coopanion 插件）

> 写给接手这个插件改进工作的模型/开发者。读完这一份就能上手，不用翻历史对话。
> 最后更新：2026-10-24 21:55（版本 0.4.1）

---

## 1. 这是什么

Coopanion 桌宠的语音插件（Cortico World）：桌宠每次 `pet_say` 前调用 `sovits_speak`，插件用本机
GPT-SoVITS 合成这句话并从声卡播出。是本机离线合成，不上传任何音频。

| 项 | 值 |
|---|---|
| npm 包 | `@wocwang/cortico-world-gpt-sovits-for-coopanion`（当前 **0.4.1**，已上线） |
| 仓库 | `D:\Users\HW W\Documents\pr-gpt-sovits\repo`（fork 自 Phantivia 的原版，原作者已同意从 fork 发） |
| 远程 | `origin` = https://github.com/wocwang/cortico-world-gpt-sovits-for-coopanion.git |
| 分支 | `main` 与 `release/0.2.0` 同点（`daa3834`）；两个都推，保持一致 |
| 市场收录 | Pal-AI-Lab/cortico-extensions（见 §3） |
| 插件显示名 | 更好的GPTSovits 语音—大肥鱼来咯 |
| 测试 | 44 项（`tests/`），typecheck 干净 |

## 2. 快速开始

```powershell
cd "D:\Users\HW W\Documents\pr-gpt-sovits\repo"
pnpm install
pnpm test          # 44 项
pnpm typecheck     # tsc --noEmit
pnpm build         # src/webui → dist/webui.js/.css（改了面板必须跑）
```

改完代码 → 本机安装验证（见 §6）→ 重启 Coopanion → 验证 → 发布（见 §3）。

## 3. 发布流程

### 3.1 npm

- npm 账号 `wocwang`，**开了两步验证**：发布需要 Automation token 或 OTP。
- token 由主人提供（`npm config set "//registry.npmjs.org/:_authToken" "npm_xxx" --location=user`），
  或用临时 userconfig。**不要**把 token 写进仓库或日志。
- `npm publish` 会跑 `prepublishOnly = build && test && typecheck`，全过才上传。
- registry 同步要 1–3 分钟，`npm view ... dist-tags.latest` 轮询确认。
- 每次发布记得 bump `package.json` 的 version + 在 `CHANGELOG.md` 加 `## x.y.z` 一节
  （市场 Action 会读 CHANGELOG 按版本切更新日志）。

### 3.2 市场收录（Pal-AI-Lab/cortico-extensions）

- Action 每半小时（cron `17,47 * * * *`）扫 npm 关键词 `cortico-world` 自动收录；
  但 npm 的 **search 索引对新包延迟 1–2 小时**，刚发布往往扫不到。
- **立即收录**：新建一个 issue（**不要 reopen 旧 issue，GitHub 会拒**）：

  ```bash
  gh issue create -R Pal-AI-Lab/cortico-extensions \
    --title "[sync] @wocwang/cortico-world-gpt-sovits-for-coopanion" \
    --body "package: @wocwang/cortico-world-gpt-sovits-for-coopanion"
  ```

  Action 会立刻跑一次，回帖「已收录 x.y.z」并自动关闭。`gh` 已在本机登录 wocwang。
- 校验：`catalog.json` 里 `packages["@wocwang/..."]` 的 `version` 是否更新。
- 市场卡片文案：`package.json` 的 `cortico.locales.zh/en`（displayName + description），
  顶层 `description` 是英文（npm 页用），中文简介靠 `locales.zh`。

## 4. 代码地图（src/）

| 文件 | 职责 |
|---|---|
| `index.ts` | 包入口，导出 `definition.ts` 的 WorldDefinition |
| `definition.ts` | WorldDefinition：id/defaults/configOptions/create/describe；**音色下拉的选项源在这里**（预设 + 动态自定义音色） |
| `world.ts` | 核心：队列、合成、播放、权重热切换、配置收敛（settlePreset）、两个面板的 invoke |
| `config.ts` | 配置结构与 schema 表单（x-options / x-path / x-hot）、中英文案 |
| `custom-voice.ts` | 自定义音色的纯逻辑：校验、按 id 选、权重联动（8 项测试） |
| `voice-options.ts` | 模块级注册器：world 启动时注册「读当前音色列表」的函数，供 definition 的下拉选项用（避免循环 import） |
| `voices.ts` | 内置预设（`dfy`/`female`/`male`）与 label |
| `weights.ts` | 自备权重：`.pth` 头字节判版本、配对校验、底模路径推导 |
| `synth.ts` | api_v2 请求（`/tts` 流式）、`switchWeights`（`/set_gpt_weights` + `/set_sovits_weights`） |
| `server.ts` | 启动/停止本机 api_v2、写 `tts_infer.<档>.yaml` |
| `install.ts` | 运行时/权重的下载安装（按 SHA-256 校验，多源回退） |
| `catalog.ts` | 运行时版本、档位→模型映射、权重相对路径、输出增益 |
| `player.ts` | audify 播放与队列 |
| `speech-text.ts` | 台本清洗（去 `【…】`/`<…>` 标记、去装饰符号 ♡★♪） |
| `wav.ts` | 读 WAV 时长/采样率 |
| `i18n.ts` | 面板文案（中英）与状态词 |
| `webui/client.ts` | 两个面板：`voice`（状态/试听）与 `voices`（音色增删改） |
| `assets/voices/` | 随包默认音色 `dfy.wav` + `dfy.txt`（**成对，差一个字音色就漂**） |

## 5. 关键设计与必须知道的事实

### 5.1 音色 = 参考音频 + 台本（+ 可选权重）

- 预设音色（dfy/female/male）的音频与台本**成对随包**，选即用，用户零配置。
- 自定义音色 = `name + audio + text + weights(可选，成对)`，存在 `worlds.gpt-sovits.voices[]`。
- 选中自定义音色且它带成对权重时 → 生效权重随之切换（复用热切换）；否则用全局 `weights`。

### 5.2 配置页（cortico 配置表单）的限制——**别再试图在那里做交互**

- 表单只有 `x-hot / x-options / x-path` 三种扩展，**塞不进按钮**。
- 表单值只在进入页面时加载一次，**不会随切换刷新**（无轮询无推送）。切完音色要「再点一下配置 tab」
  才刷新（重复点当前 tab 有效，因为 `enter` 无条件执行）。
- 已向上游提 issue 请求自动重载：**https://github.com/Pal-AI-Lab/Cortico/issues/308**
  如果它被修了，可以把 `world.ts` 里的镜像逻辑简化。
- 因此：**音色的增删改一律在「音色」面板**（`panels[].id = 'voices'`），配置页只负责「选」。

### 5.3 `settlePreset()`（world.ts）——配置收敛的核心

在 `voice()` 与 `panelState()` 开头调用，保证配置字段与当前音色一致：

1. 选中自定义音色且 `seenPreset` 变化 → 把它的 name/audio/text/weights **镜像**进配置字段；
2. 改过字段（name 除外）→ 写回该音色；音频换了要在写回前校验（3–10 秒）；
3. 预设 → 把包内音频/台本镜像进字段（`PRESET_PATH` 识别镜像路径，用户手填的非预设路径仍然优先）；
4. `voice.name` 只做内部镜像，**不再参与变更判断**（面板改名后不会被旧值回写）。

### 5.4 权重热切换

- `switchWeights()` 依次调 `/set_gpt_weights`、`/set_sovits_weights`（GET + `weights_path`），
  **实测 2.5–3.1 秒**（s1 155 MB + s2 LoRA 766 MB 重载），不重启进程、不打断正在播的句子。
- **音色切换是零成本**（每次合成请求自带参考音频与台本），不要为它做任何等待/提示。
- 换失败会退回上一组权重，同一条配置不重复试（`weightsFailed`）。
- `.pth` 头两字节：`08` = v5turbo LoRA（显卡档），`06` = v2ProPlus（CPU 档），其余版本拒绝。

### 5.5 两档与模型

- 显卡档（有 NVIDIA）：v5turbo（`s1v3.ckpt` + `s2Gv5turbo.pth`）；CPU 档：v2ProPlus。
- v5turbo 的 s2 训练产物是 LoRA 增量，**底模必须还在**（不能只来自备权重）。

## 6. 本机安装与验证（改完必须走一遍）

Coopanion 的插件装在 `D:\Program Files\Coopanion\data\extensions`（pnpm workspace）。

```powershell
# 1) 打包
cd "D:\Users\HW W\Documents\pr-gpt-sovits\repo"; npm pack

# 2) 装到本机（⚠️ 必须带 XDG_DATA_HOME，否则 store 会切到盘根，拓展中心随后报错）
cd "D:\Program Files\Coopanion\data\extensions"
$env:XDG_DATA_HOME="D:\Program Files\Coopanion\data"
pnpm add "D:\Users\HW W\Documents\pr-gpt-sovits\repo\wocwang-cortico-world-gpt-sovits-for-coopanion-<ver>.tgz" --ignore-scripts

# 3) 检查顶层链接；缺了就补（.pnpm 里多版本并存时按 package.json 的 version 选最高）
pnpm install --force
```

- **「本机包缺失」的固定解法**：`pnpm install --force` 再重启。普通 `install` 会说
  "Already up to date" 不重建链接（宿主安装器会清掉其他插件的顶层链接）。
- 判断 store 是否正确：`node_modules/.modules.yaml` 的 `storeDir` 应为
  `D:\Program Files\Coopanion\data\pnpm\store\v11`。
- 装完**重启 Coopanion**（插件在启动时加载；面板改动要重启才生效）。

## 7. 运行环境速查

- 推理服务端口是**动态**的，别记死：
  `Get-CimInstance Win32_Process -Filter "Name='python.exe'"` 看 `-p` 参数。
- 运行时：`data\home\runtimes\gpt-sovits\e91506f-1\<cuda|cpu>\`；权重：
  `data\home\models\gpt-sovits\pretrained_models\`。
- 日志：`data\logs\core.log`（插件）、`data\gpt-sovits\voice-server.log`（api_v2）。
- **不要让 agent 启动常驻语音服务**（会话结束会回收子进程树）；由应用自启或主人双击。
- 本机证书吊销检查坏了：`git push` / `curl` 访问 GitHub 需要
  `git config --local http.sslVerify false`（本仓库已设）或 `curl --ssl-no-revoke`。

## 8. 踩过的坑（别再踩）

1. **双参考（aux）在 V3+ 完全无效**：`TTS.py` 只取 `refer_spec[0]`，多参考融合是 V1/V2 专属。
   已彻底移除相关代码，不要加回来。
2. **「忽好忽坏」= 插件不传 seed**：已加 `seed` 配置；做 A/B 必须固定 seed，否则结论全是噪声。
3. **跨进程 MD5 不可比**（cuDNN 算法自选），判断音色变化只能看时长 + 听感。
4. **v5turbo 有固有「电音感」**（谱平坦度是参考的 30–47 倍，集中在 100–1000 Hz），
   输出端降噪无效，只能靠参考端滤波缓解。别浪费时间在输出端处理。
5. **测试偶发 `Errors 1 error / 31 passed`**：esbuild 在系统临时目录写缓存报 EPERM，
   与代码无关，重跑一次即 44 全绿。
6. **`.pnpm` 里可能有多个版本目录**：补链接时按版本号选最高，否则会指向旧版。
7. 面板 `client.ts` 的 `ui.*` API 是 cortico 的 web/shared/client-panel，改动前先看现有用法。

## 9. 待办 / 可改进

- [ ] 上游 #308 修好后，可简化 `settlePreset` 的镜像逻辑（配置表单能自动刷新后就不需要「点一下配置」）。
- [ ] 「音色」面板可加「试听这一句」（用选中音色合成一小段试听）。
- [ ] 自定义音色的权重目前是**路径输入框**（浏览器 file input 拿不到本机路径）；
      如果框架以后给出路径选择 API，换成文件选择器。
- [ ] 删除音色目前没有二次确认，容易误删。
- [ ] `config.ts` 里 `voice.name` 已从表单移除，但数据结构仍保留（内部镜像用）；后续可考虑彻底清理。

## 10. 跟主人配合的约定

- 用中文，称呼「主人」；语气可以可爱，但**干活必须硬**（禁止糊弄、编造、偷懒）。
- **汇报要有实测数据**，不要只给判断；猜错要主动纠正。
- 改完要能自证：给出日志/命令/实测结果，别只说「应该好了」。
- 发布（npm / 市场收录）属于对外动作，**先问主人**再执行；npm token 由主人提供。
- 大的方案调整先说清约束（比如本文件 §5.2 的框架限制），再给选择，别闷头硬做。
