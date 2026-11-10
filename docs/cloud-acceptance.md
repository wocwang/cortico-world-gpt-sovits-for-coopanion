# 语音真机验收清单（0.8.1）

本清单只做验收，不发布、不提交、不打 tag。每一步把结果记下来，最后一节有回填模板。
验收分两部分：**1–7 节用真实云端厂商**（必须做）；**第 8 节是本地假厂商**（可选，没有密钥或想先验协议时做）。

路径约定（下面用 `$GSV` / `$CFG`）：

```powershell
$GSV = "D:\Program Files\Coopanion\data\gpt-sovits"                  # 插件数据目录
$CFG = "D:\Program Files\Coopanion\data\home\companion\config.json"  # 宿主配置（worlds.gpt-sovits）
$EXT = "D:\Program Files\Coopanion\data\extensions"                  # 扩展安装目录
```

## 0. 安装 0.8.1 并重启

```powershell
cd "D:\Users\HW W\Documents\pr-gpt-sovits\repo"
npm run build
npm pack
# 产出 wocwang-cortico-world-gpt-sovits-for-coopanion-0.8.1.tgz

cd $EXT
$env:XDG_DATA_HOME = "D:\Program Files\Coopanion\data"
pnpm add "D:\Users\HW W\Documents\pr-gpt-sovits\repo\wocwang-cortico-world-gpt-sovits-for-coopanion-0.8.1.tgz" --ignore-scripts
```

核对装进去的版本，然后**完全退出 Coopanion（含托盘）再启动**：

```powershell
(Get-Content "$EXT\node_modules\@wocwang\cortico-world-gpt-sovits-for-coopanion\package.json" -Raw | ConvertFrom-Json).version
# 期望：0.8.1
```

记录：安装包大小、安装耗时、重启后插件是否能正常加载。

## 0b. 云端音色默认值（0.7.3）

- [ ] `cloudVoices` 为空、地址是默认 `https://api.openai.com/v1`：选「云端」后，云端卡列出 6 个音色
      （`alloy` / `echo` / `fable` / `onyx` / `nova` / `shimmer`），当前音色是 `alloy`，并显示「自动列出 6 个默认音色」说明。
- [ ] 只保存密钥、不做其它配置：云端状态变成「就绪 · api.openai.com/v1 · alloy」；试听能出声。
- [ ] 默认清单**不落盘**：检查 `$CFG` 里 `worlds.gpt-sovits.cloudVoices` 仍为 `[]`、`cloudVoiceId` 仍为空。
- [ ] 把地址换成第三方：默认清单消失，回到「手动填厂商 voice id」的提示；已有清单/已选音色的配置不被覆盖。
- [ ] 点「从服务商拉取清单」：OpenAI 官方提示「没有提供音色清单端点（HTTP 404）」；提供端点的厂商应合并清单并提示
      「已从服务商拉取 N 个音色」；没存密钥时提示先保存密钥。
- [ ] 生效音色一致性：面板显示、云端状态与实际合成使用同一个音色（改选后试听应换成该音色）。

记录：默认清单是否出现、`cloudVoices` 是否仍为空、拉取按钮的实际提示。

## 0c. 云端兼容性提示与字段小字（0.7.4）

- [ ] 地址改成第三方（如 `https://tts.example.com/v1`）、清单里保留或选上 `alloy`：
      清单与下拉里该音色带「（OpenAI 官方）」标记；云端卡顶部出现黄色说明，提示厂商可能不支持。
- [ ] 此时仍能保存、仍能发起试听/合成（不是硬拦）：厂商返回错误时，云端卡出现红色「上次云端合成失败：…」，带状态码。
- [ ] 改地址 / 模型 / 音色，或切换引擎后，上面的红字自动消失（旧错误不残留）。
- [ ] 每个字段下都有中英双语小字：地址（必填、默认与 `/v1` 要求）、模型（可不填、默认 `tts-1`）、
      音色（必选、OpenAI 地址留空用 alloy）、超时（可不填、默认 60 秒、范围）、密钥（必填、格式、掩码不修改）、
      添加音色（id 必填、显示名可选）。
- [ ] 把界面语言切成英文，小字与提示仍是通顺英文（不是中文兜底）。

记录：第三方地址下的标记/黄字/红字实际文案，以及切换语言后的显示。

## 0d. 已有 GPT-SoVITS 接入（0.8.0）

前提：本机有一份完整 GPT-SoVITS（整合包或仓库 + 自带 runtime）。三条路都从「语音」页开始，
**只有把引擎选成「本地」之后**才出现「你已经装过 GPT-SoVITS 了吗」。

### 0d.1 选目录

- [ ] 选「本地」后出现三颗按钮：「有，选目录」（默认展开）/「已经在跑服务」/「都没有，下载托管」；
      顶部显示「当前：…」。
- [ ] 粘贴整合包根目录，点「检测目录」：显示该目录可用，并列出成对的 `.ckpt` + `.pth`（带版本名）
      与 3–10 秒参考音频；点「用这套权重」「用作参考音频」后行高亮。
- [ ] 点「用这个目录」：提示已接上（含权重/参考音频），`config.json` 里 `runtimeDir` 指向该目录、
      `serverUrl` 为空；点「启动」能拉起服务并试听。
- [ ] 点「自动找一找」：列出桌面 / 下载 / 文档与盘根下一层里名字像 GPT-SoVITS 的目录，点一个能填进输入框并检测。
- [ ] 故意选一个没有 `api_v2.py` 的目录：红字说明「不像是 GPT-SoVITS 的根目录」；选出仓库克隆（无 `runtime` Python）：
      提示用虚拟环境跑服务、改走「已经在跑服务」。
- [ ] 缺 `tools/portable_runtime.py` 的旧整合包：提示缺少该文件、请先开 `go-webui.bat`，再回来选「已经在跑服务」。

### 0d.2 已经在跑服务

- [ ] 先用 `python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml` 起服务。
- [ ] 点「已经在跑服务」，填 `http://127.0.0.1:9880`，点「测试连接」：提示「已连接 …；之后本地合成会走这个服务」，
      `serverUrl` 写入、`runtimeDir` 清空；「推理服务」一行显示已有服务，不再启动本地进程。
- [ ] 填一个没启动的端口：提示「连不上 …：服务没启动、端口不对，或被防火墙挡了」；填非 api_v2 的地址：
      提示 `/docs` 不存在或 HTTP 状态码；没有 `http://` 前缀时直接提示。
- [ ] 填局域网 / 另一台机器的地址：输入框下方出现黄色说明「跨机只提示、不改对面权重」。
- [ ] 跨机地址下在「音色」页换权重：不报错、不打断合成；日志里只有「已有服务不在本机，跳过换权重」的警告。
- [ ] 同机地址下换权重：`/set_gpt_weights` 与 `/set_sovits_weights` 生效，试听音色跟着变。

### 0d.3 都没有，下载托管

- [ ] 点「都没有，下载托管」：提示已切回托管；`serverUrl` 与 `runtimeDir` 都清空；在下面点「安装」开始下载运行时。
- [ ] 已经装好时点它不会重复下载，回到原来的托管状态。

### 0d.4 不做自动探测

- [ ] 全程没有点「测试连接」时，插件不会自行请求 `127.0.0.1:9880`（用 `Get-NetTCPConnection` 或厂商/服务日志确认）。
- [ ] 切换页签、重启宿主，输入框回填现有 `runtimeDir` / `serverUrl`，不会自动发起检测。

记录：三条路各自的提示原文、`runtimeDir` / `serverUrl` 的落盘结果、跨机换权重是否只警告。

## 0e. 训练依赖就绪（issue #14，0.8.1）

前提：本机有 cuda / cpu 两档运行时（或任一档），先看旧标记是否还在。

- [ ] 用旧版留下的 `trainer-deps.json`（没有 `dir` 字段）启动：训练页显示「训练依赖：未安装」，
      不再假报「已就绪」；点「安装训练依赖」后能重新绑定并变为已就绪。
- [ ] cuda 档装过依赖、cpu 档没装：切到 cpu 后训练页仍显示未就绪（不会再被 cuda 的标记带成已就绪）；
      切回 cuda 显示已就绪。
- [ ] 把当前档的运行时目录整目录重下/替换（包被清空）后，标记虽在，训练页仍显示未就绪。
- [ ] 在缺依赖的档点「启动」：训练页红字直接给出 `No module named 'gradio'`（或等价原因），
      旁边有「安装训练依赖」按钮；点它能补齐，再启动成功。
- [ ] 启动正常时红字消失，折叠日志仍保留完整输出。

记录：切换档位前后的就绪状态、启动失败红字原文、点安装后是否恢复。

## 1. 面板结构与引擎显隐（C1）

打开控制台 →「GPTSovits 语音」→「语音」页（第一个页签）：

- [ ] 页面**最上面**是「语音引擎」**下拉**（不是两颗单选），选项：`请选择语音引擎` / `本地` / `云端`。
- [ ] 新装默认是 `请选择语音引擎`：下方**不显示任何**推理档 / 运行时 / 权重 / 推理服务 / 试听，只显示一条
      「还没选择语音引擎」提示；「音色」页同样只有一条提示，两张卡都不出现。
- [ ] 选「本地」后：本地设置整组出现（推理档、运行时、权重、推理服务、试听）；「音色」页出现「本地音色」卡：
      4 个预设（大肥鱼_星落落版本(中英) / 大肥鱼(日中英) / 女声 / 男声）+「自定义音色」列表。
- [ ] 选「云端」后：上一条目里的本地设置整组隐藏，只显示云端就绪摘要 + 去向提示；「音色」页改为显示
      「云端音色」卡：接口地址（默认 `https://api.openai.com/v1`）、模型（默认 `tts-1`）、当前音色、
      超时（默认 60000）、**密码输入框** +「保存密钥 / 清除密钥」、云端音色清单 + 新增（显示名、音色 id）。
- [ ] 随时把下拉改回另一个引擎，显隐立即跟着切换，不用重启。
- [ ] 「与其他插件联动」等通用设置不受影响、照常显示，不随引擎显隐。
- [ ] 点某个预设的「使用」，该行变成「使用中」，其他预设恢复；自定义音色增/改/删仍可用。
- [ ] 旧宿主兼容：如果这个宿主版本没有 `ui.foldSheet`，两张卡应以普通卡片出现（不是空白/报错）。
- [ ] 旧配置兼容：之前存过 `local` / `cloud` 的宿主，重启后下拉应直接停在该值，视为已选择。

记录：截图或文字描述实际布局、有没有字段缺失。

## 1b. 音色页去重与推理档（0.7.2）

- [ ] 控制台里**没有**「音色与台词」页签；只剩「语音 / 输出与保存 / 与其他插件联动 / 推理服务 / 音色 / 训练」。
- [ ] 「音色」页底部有「台词与翻译」卡，含语音语言、翻译地址 / 密钥 / 模型、语速、种子、提示词语言；
      改任一字段后与 `config.json` 的 `worlds.gpt-sovits.*` 一致，效果与以前在「音色与台词」页改时相同。
- [ ] 用 v2ProPlus 权重（`.pth` 版本头 `06`）编辑音色、推理档停在 v5turbo：**能正常保存**，
      底部不再出现「权重用不上」；保存后提示「权重已保存，但它需要 V2 Pro Plus…」这类说明。
- [ ] 选中该音色「使用」后，推理档自动切到 V2 Pro Plus，并提示「已为你切换到 V2 Pro Plus 推理模型」。
- [ ] 手改 `config.json` 把 `voiceModel` 与所选权重版本改得不一致，重启：启动日志有警告，
      「语音」页顶部与「音色」页出现红字说明；已选云端引擎时该红字不出现。

记录：保存/切换后的实际提示文本，以及启动警告是否出现在日志里。

## 2. 云端配置与就绪状态（C2）

在「云端音色」卡里填：

1. 接口地址：你的厂商基址，例如 `https://api.openai.com/v1`（插件会自动补 `/audio/speech`）。
2. 模型：厂商文档里的模型名，例如 `tts-1`。
3. 在「添加云端音色」填显示名（可空）和音色 id（例如 `alloy`），点添加；清单里点「使用」选中它。
4. 在「云端密钥」粘贴真实 API Key，点「保存密钥」。

期望：

- [ ] 保存后密码框清空，密钥行显示掩码（例如 `sk-1…cdef`）；输入框 placeholder 也变成掩码提示。
- [ ] 空着再点「保存密钥」，提示「留空或提交掩码：密钥没有修改」，不会发请求。
- [ ] 把掩码原样粘贴回去再保存，同样不修改。
- [ ] 「云端状态」显示「就绪 · 域名 · 音色 id」；引擎行下面出现同样的摘要。
- [ ] 故意清空音色 id（或删掉所有云端音色）时，状态变成「还没就绪：没选音色」。

记录：状态行原文、掩码文本。

## 3. 密钥存放检查（C3，安全项）

```powershell
# 配置里只应有掩码，没有明文密钥
$w = (Get-Content $CFG -Raw | ConvertFrom-Json).worlds.'gpt-sovits'
$w | Select-Object ttsEngine, cloudBaseUrl, cloudModel, cloudVoiceId, cloudKeyMask, cloudTimeoutMs
$w.cloudVoices | Format-Table

# 密文文件；前 4 字节应为 CTT1
Get-ChildItem "$GSV\secrets"
$b = [IO.File]::ReadAllBytes("$GSV\secrets\cloud-tts.bin")
[Text.Encoding]::ASCII.GetString($b[0..3])

# 明文密钥不应出现在配置或密文里（把 <你的KEY> 换成真实值）
Select-String -Path $CFG -Pattern "<你的KEY>" -SimpleMatch
Select-String -Path "$GSV\secrets\cloud-tts.bin" -Pattern "<你的KEY>" -SimpleMatch
```

- [ ] `cloudKeyMask` 有值，`cloudBaseUrl / cloudModel / cloudVoiceId / cloudVoices` 正确。
- [ ] `secrets\cloud-tts.bin` 存在且以 `CTT1` 开头。
- [ ] 两条 `Select-String` 都**没有命中**。
- [ ] 主密钥：以下 `.env` 之一有 `CORTICO_SECRET_KEY`（按优先级）：
      `D:\Program Files\Coopanion\.env`、`D:\Program Files\Coopanion\data\.env`、`$GSV\.env`；
      都没有时应有 `$GSV\secrets\master.key`。若宿主通过 `ctx.secret` 自己注入部署密钥，文件里没有也算通过。
- [ ] 如果是本轮自动生成进 `.env`：同目录有 `.env.bak-<时间戳>` 备份，且 `.env` 仍保留原有内容。

```powershell
Get-ChildItem "D:\Program Files\Coopanion\.env","D:\Program Files\Coopanion\data\.env","$GSV\.env" -ErrorAction SilentlyContinue |
  ForEach-Object { Select-String -Path $_.FullName -Pattern "CORTICO_SECRET_KEY" }
Get-ChildItem "D:\Program Files\Coopanion\.env*","D:\Program Files\Coopanion\data\.env*","$GSV\.env*" -ErrorAction SilentlyContinue
```

记录：密文文件大小、主密钥落在哪个位置、是否生成了备份。

## 4. 云端出声与「不拉本地服务」（C4）

1. 先到「语音」页，把「推理服务」点「停止」（如果本来在跑）。
2. 回「音色」页确认引擎是「云端」且状态「就绪」。
3. 回「语音」页，「试听」文本框里写一句中文，点「试听」，记录**点击到出声**的秒数。
4. 连点 3 句不同的话，确认排队、播完不打断；点「停止播放」能立刻停。

期望：

- [ ] 能听到声音，音色是云端厂商的 voice（不是本地预设音色）。
- [ ] 「推理服务」一行始终是「已停止」，试听期间没有被拉起。
- [ ] 试听下方「最近念的」显示刚念的句子；没有「上次合成失败」。
- [ ] 控制台日志没有 `云端合成失败`：

```powershell
Select-String -Path "D:\Program Files\Coopanion\data\logs\core.log" -Pattern "云端合成失败" | Select-Object -Last 5
```

记录：3 句的点击→出声秒数、句子长度、服务状态是否始终「已停止」。

## 5. 9880 本地接口走云端（C5）

前提：配置页「与其他插件联动」里 `httpApi` = 开。若刚打开，需要**重启 Coopanion**让接口挂载。
如果设了 `httpToken`，请求要带 `Authorization: Bearer <token>`。

```powershell
# 1) 就绪探活：云端模式下也应为 ready=true
Invoke-RestMethod "http://127.0.0.1:9880/health"

# 2) 合成一句，落成 WAV（无令牌时删掉 Authorization 这一行）
$headers = @{ Authorization = "Bearer <token>" }
$r = Invoke-WebRequest -Uri "http://127.0.0.1:9880/audio/speech" -Method Post `
  -Headers $headers -ContentType "application/json" `
  -Body '{"input":"这是 9880 云端验收，12345"}' `
  -OutFile "$env:TEMP\cloud-9880.wav"
$r.StatusCode
$r.Headers["x-sovits-first-chunk-ms"]
$r.Headers["x-sovits-synthesis-ms"]
$r.Headers["x-sovits-duration-ms"]

# 3) 校验是 WAV 并试听
$b = [IO.File]::ReadAllBytes("$env:TEMP\cloud-9880.wav")
[Text.Encoding]::ASCII.GetString($b[0..3])   # RIFF
[Text.Encoding]::ASCII.GetString($b[8..11])  # WAVE
Start-Process "$env:TEMP\cloud-9880.wav"
```

期望：

- [ ] `/health` 返回 `ready: true`，且此时本地推理服务仍是「已停止」（`state` 字段描述的是本地服务状态，云端模式下仅供参考）。
- [ ] `POST /audio/speech` 返回 200，文件是 RIFF/WAVE，能播放。
- [ ] `x-sovits-*` 响应头存在；云端没有首块流式，`first-chunk-ms` 与 `synthesis-ms` 基本相等（都等于整段合成耗时）。
- [ ] 接口**不会**因为调用方在 body 里点名 `voice:"xll"` 就切回本地音色——云端只用「当前云端音色」。
- [ ] 厂商后台/用量页在这次请求后计数 +1（最直接的「确实走了云端」证据）。

记录：状态码、三个响应头、文件时长、厂商用量变化。

## 6. QQ 语音条（C6）

前提：QQ Bot 插件已装且在线；本插件 `qqbotVoice` = 开（旧 QQ 插件走 `channelVoice`，不是本条）。
QQ Bot 的路径是 `sovits_speak(silent: true)` → 回执里的 `[blob …]` → `qqbot_send_message` 的 `voice`。

1. 在 QQ 私聊里让 bot「用语音说一句：云端验收成功」。
2. 收到语音条后播放，确认声音是云端音色。
3. 同时看厂商用量是否又 +1；本地推理服务仍为「已停止」。

期望：

- [ ] 语音条能正常发出、能播放，不是空白/0 秒文件。
- [ ] 云端模式下不需要本地服务参与。
- [ ] 若失败：记录是「没收到语音条 / 收到但无声 / 报错原文」，并贴 `core.log` 相关行。

如果暂时没有 QQ 环境，可退一步验句柄交付：临时把 `shareAudio` 打开，让 bot 调 `sovits_speak`（带 `silent: true`），
确认回执里带 `[blob …]`；验完把 `shareAudio` 关回去。记录这一步只能算「部分通过」。

记录：QQ 场景（私聊/群）、是否出声、耗时、日志。

## 7. 错误路径、重启与切回本地（C7）

### 7.1 错密钥

1. 保存一个假密钥，例如 `sk-invalid-acceptance-0000`。
2. 点「试听」或让 bot 说话。
3. 期望：提示「云端拒绝鉴权（HTTP 401/403）…」，不是笼统失败；错误文本里没有完整假密钥。
4. 检查日志与配置都没有明文：

```powershell
Select-String -Path "D:\Program Files\Coopanion\data\logs\core.log" -Pattern "sk-invalid-acceptance-0000" -SimpleMatch
```

5. 重新保存真实密钥，确认恢复「就绪」。

### 7.2 清除密钥

1. 点「清除密钥」并在确认框里确认。
2. 期望：状态变「还没就绪：密钥没填」，试听失败并提示「云端密钥还没设置…」。
3. `secrets\cloud-tts.bin` 应消失；重新保存真实密钥后恢复。

### 7.3 DNS / 连不上

1. 把接口地址临时改成 `https://no-such-host.invalid/v1`。
2. 试听，期望提示「云端地址解析失败（DNS）」；改回真实地址后恢复。
3. 若厂商地址端口写错，期望「连不上云端（连接被拒或中断）」。

### 7.4 重启保持

1. 完全退出并重启 Coopanion。
2. 期望：引擎仍是云端、云端音色清单与选中项仍在、密钥掩码仍显示、试听直接可用（不需要重填密钥）。
3. 如果本轮是自动生成主密钥写进 `.env`，重启后仍能解密；`.env` 不应被重复追加第二条 `CORTICO_SECRET_KEY`。

### 7.5 切回本地

1. 引擎切回「本地」。
2. 期望：本地卡出现（预设 + 自定义音色），云端卡隐藏；点预设「使用」能选中并换权重。
3. 「推理服务」按 `autoStart` 拉起，试听出声。
4. 云端配置与密钥保留，下次切回云端不用重填。

记录：每条错误的提示原文、重启前后差异、切回本地是否正常。

## 8. 可选：本地假厂商（离线验协议与错误映射）

没有真实密钥、或想反复验错误路径时用。把下面代码存成 `%TEMP%\mock-cloud-tts.mjs`，用 Node 22 运行：

```js
import { createServer } from 'node:http';

function wav(seconds = 1) {
  const rate = 24000;
  const n = rate * seconds;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    console.log(req.method, req.url, body);
    if (req.url.endsWith('/audio/speech')) {
      if (process.env.MOCK_BAD === '1') {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        res.end('ID3 this is not a wav');
      } else {
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(wav());
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}).listen(9900, '127.0.0.1', () => console.log('mock: http://127.0.0.1:9900'));
```

```powershell
node "$env:TEMP\mock-cloud-tts.mjs"
```

面板里填：地址 `http://127.0.0.1:9900/v1`、模型 `mock`、音色 id `mock`、密钥 `sk-mock-123456`。

- [ ] 试听能听到 440 Hz 提示音；mock 终端打印 `POST /v1/audio/speech` 与请求 JSON（含 `response_format:"wav"`）。
- [ ] 9880 的 `/audio/speech` 也返回这段 WAV。
- [ ] 以 `$env:MOCK_BAD=1` 重启 mock，再试听 → 提示「云端回的不是 WAV」，不是静默失败。
- [ ] 错误文本里不出现 `sk-mock-123456`。

验完把地址/密钥改回真实值（或清除假密钥）。

## 9. 判定标准

出现以下任一情况算**不通过**：

- 面板显示「就绪」但试听/9880/QQ 任意一条没有声音，或返回空 WAV。
- 云端模式下仍拉起本地运行时；或本地「推理服务」状态与进程不符。
- 明文密钥出现在 `config.json`、`core.log`、面板回显或错误文本里。
- 非 WAV 响应被当成正常音频播放（应在面板明确报错）。
- 重启后密钥解不开，或主密钥被重复生成导致旧密文失效。
- 切回本地后预设/自定义音色不能选中，或本地试听不响。
- 已有 GPT-SoVITS 的三条路里，任一条把不可用的目录/服务写进配置，或跨机地址下真的去改了对面权重。

## 10. 回填模板

```text
语音验收（插件 0.8.0）
- 安装：tgz <大小>，装后版本 <0.8.0>，重启 <正常 / 异常原文>
- 已有 GPT-SoVITS：选目录 <可用/不可用与提示原文>；服务 <已连接/失败原文>；托管 <切回正常>；
  `runtimeDir` <路径>；`serverUrl` <地址>；跨机换权重 <只警告 / 实际切换>
- 厂商 / 模型 / 音色：<厂商域名> / <model> / <voice id>
- 面板：引擎单选 <正常>，本地卡 <正常>，云端卡 <正常>，旧宿主回退 <不适用 / 正常>
- 密钥：掩码 <sk-1…cdef>；cloud-tts.bin <大小>，CTT1 <是>；主密钥位置 <.env 路径 / master.key>；备份 <有/无>
- 明文检查：config <未命中>，日志 <未命中>，密文 <未命中>
- 试听：3 句点击→出声 <N/N/N 秒>；推理服务 <始终已停止>
- 9880：/health <ready 原文>；/audio/speech <200>；响应头 <first/synthesis/duration ms>；厂商用量 <+1>
- QQ：场景 <私聊/群>；语音条 <收到并出声 / 失败原文>
- 错误路径：401 <提示原文>；清除密钥 <提示原文>；DNS <提示原文>；非 WAV <提示原文>
- 重启：配置/密钥/试听 <正常 / 异常>；.env 是否重复追加 <否>
- 切回本地：预设切换 <正常>，自定义音色 <正常>，本地试听 <正常>
- 异常日志：<贴最后 20 行>
```
