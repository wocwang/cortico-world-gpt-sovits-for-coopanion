# 大肥鱼语音全能包

`@wocwang/cortico-world-gpt-sovits-for-coopanion`

原「GPTSovits 语音」（`cortico-world-gpt-sovits-for-coopanion`）。现已全面支持**本地 / 云端双引擎**与
**N 卡 / A 卡 / CPU** 三种方案。

给 Coopanion 桌宠配上真实的 GPT-SoVITS 语音：桌宠每次说话，插件就在**你自己的电脑上**把这句话合成出来、从声卡播出，全程本机运行、不上传任何录音。不想装运行时或这台机器跑不动本地模型时，也可以手动切到**云端接口**（OpenAI 兼容及多家厂商，填自己的 API Key；切到云端后，台词文字会发给所选服务商）。**AMD 与 NVIDIA 显卡都能用**——NVIDIA 走 V5 turbo；AMD 名单内的型号自动走 ROCm 档（**实验性功能，欢迎反馈**），名单外会提示「当前显卡不在支持名单内」，没有独显或 Intel 显卡走 CPU 档（v2ProPlus，慢一些但能用）。CPU / 核显档如果出现「生成慢于播放」的断续，可以打开**播放预缓冲**（默认关闭）。

## 和另外两个声音插件一起用

本机这条声音链路一共三个插件，可以单独装，也可以一起装：

| 插件 | 端口 | 作用 | 启动占用 |
| --- | --- | --- | --- |
| **本插件**（GPTSovits 语音） | `:9880` | 说话：文字 → 语音，本机外放或交给 QQ | 显卡档约 2–3 GB 显存（按需加载后 1.5–2.5 GB）；CPU 档约 4–6 GB 内存 |
| **RVC 变声** | `:9881` | 把干声换成小肥鱼 / 星落落大肥鱼的音色 | 显卡档约 1 GB 显存、内存约 2.5 GB（实测）；启动约 25–30 秒 |
| **DiffSinger 唱歌** | `:9882` | 唱歌：歌词 → 绮萱的歌声 | 纯 CPU，内存约 1.3 GB、不占显存（实测）；引擎载入约 7–11 秒 |

配合方式：

- 说话走本插件，唱歌走 DiffSinger 唱歌插件；
- 本插件的「出口变声」可以让交给 QQ 的语音先过 RVC；
- QQ 里发 `【唱】歌词` 的语音请求会被转给唱歌插件，唱好再回传（「与其他插件联动」里的「唱歌插件地址」）。

---

## 普通用户：装完就能用

1. **安装**：在 Coopanion 插件市场搜索「大肥鱼」或「GPTSovits」安装。
2. **等待自动下载**：装好后插件会自动下载语音运行时和模型（显卡档约 4–7 GB，取决于网速，几分钟到十几分钟）。下载默认走国内镜像，大文件开 4 路分段并发（服务端不支持时自动退回单流）；权重来源会按本机实测速度择优，12 小时内复用测速结果。**期间桌宠暂时没有声音，属正常**，下载完自动出声。
3. **开始聊天**：什么都不用配置——默认音色就是「大肥鱼_星落落版本」，桌宠说话自动带声音。

控制台里的「GPTSovits 语音」按分类页签展示：**语音 / 输出与保存 / 与其他插件联动 / 推理服务 / 音色 / 训练**。每个分类单独点开，字段与配置页是同一份值，改完即时保存；音色、自备权重与台词翻译都在「音色」页里，不再有单独的「音色与台词」页签。

### 电脑上已经装过 GPT-SoVITS

不用再下载一遍运行时。在「语音」页把引擎选成**本地**后，第一次会看到「你已经装过 GPT-SoVITS 了吗」，三选一：

| 你的情况 | 点这个 | 接下来 |
|---|---|---|
| 有整合包 / 仓库目录 | **有，选目录**（默认） | 点「选择目录…」弹出系统目录框，选中后回填并立即检测，列出可用的训练权重与参考音频，点「用这个目录」。老用户也可以点「手动输入路径」直接粘贴根目录 |
| 已经用 `api_v2.py` 跑着服务 | **已经在跑服务** | 填地址（默认 `http://127.0.0.1:9880`），点「测试连接」；连上才保存 |
| 都没有 | **都没有，下载托管** | 回到原来的方式，点「安装」下载运行时 |

- 已经配置好（自备目录校验通过 / 已有服务地址已填 / 托管运行时就绪）之后，这张引导卡会收起成一行摘要 +
  「更换目录 / 改用已有服务」，不再每次问；点「更换」才会重新展开完整引导。
- 目录选择走宿主面板的原生选择器（Windows 系统文件夹对话框等）；取消或打不开时静默返回，不改配置、不报错。
- 目录要能看到 `api_v2.py` 和自带的 `runtime` Python（整合包才有；`git clone` 的仓库请用虚拟环境跑服务，走第二条）。
- 新版 `api_v2.py` 需要 `tools/portable_runtime.py`；缺这个文件的旧整合包会提示先双击 `go-webui.bat`，再回来选「已经在跑服务」。
- 地址不在本机时只提示、不改对面的权重：权重与参考音频的路径只在同机有效。
- 接入只改 `runtimeDir` / `serverUrl` 等既有配置，不改字段含义，也不做数据迁移。



### 常见问题

**第一次装完没声音？**
正在下载运行时与模型（看语音页的下载进度）。显卡档首次启动还要编译一次 CUDA 内核（约 1–2 分钟，只此一次）。之后每次开机都是几秒内就绪。

**提示 `ModuleNotFoundError: No module named 'AR'`？**
运行时解压不完整，缺 `GPT_SoVITS/AR`。0.5.16 起会在启动推理前自动用包内副本补齐，不用管；旧版可以重装运行时，或从上游 GPT-SoVITS 整包里把 `GPT_SoVITS/AR` 复制到运行时的同名目录。

**想换个声音？**
设置 → 「大肥鱼语音全能包」→ 音色下拉，四个预设任选：

| 音色 | 说明 |
|---|---|
| 大肥鱼_星落落版本(中英) | **默认**。蒸自肥鱼 CosyVoice3，中英双语；底模 + 参考音频零样本合成，不下载训练权重 |
| 大肥鱼(日中英) | 旧默认音色，日语参考（另有中文/英文参考）；使用官方底模 |
| 女声 | 普通话女声 |
| 男声 | 普通话男声 |

选完即生效，音频和台本都是配套的，不用填任何东西。

**想用自己（或别处）的声音？**
两条路：

- **简单**：准备一段 3–10 秒的干净录音（WAV），在语音页上传，并填上录音里说的那句话（逐字一致）。系统默认音色和上传的参考是一对，差一个字音色就会变。
- **进阶**：用 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 自己训练，把训出的两个文件填进「自备 GPT 权重 / 自备 SoVITS 权重」两个框，服务在跑也会就地换上、不用重启。详见下方「自备训练权重」。

**需要什么硬件？**
有 NVIDIA 显卡自动走显卡档（V5 turbo，又快又好）。想换另一套底模、或要加载自己训的 V2 Pro Plus LoRA 时，在「模型版本」里选 V2 Pro Plus 即可（首次切换可能多下约 300 MB 权重，服务会重启一次）；自己训的 V2 Pro Plus LoRA 只在选了这个版本时才能加载。

本机实测（RTX 5070 Ti Laptop 12 GB、同一句 30 字、`dfy` 音色、不开 RVC、暖机后中位数）：

| 推理档 | 模型 | 合成耗时 | 音频时长 | RTF |
|---|---|---|---|---|
| 显卡（CUDA） | V5 turbo | 1.72 s | 6.07 s | 0.28 |
| 显卡（CUDA） | V2 Pro Plus | 1.90 s | 6.19 s | 0.31 |
| CPU | V2 Pro Plus | 7.74 s | 6.34 s | 1.22 |

**显卡上两套底模速度只差约一成**，V2 Pro Plus 并没有慢多少；CPU 档比显卡慢 4–5 倍。CPU 档选不了 V5 turbo：我们没在 CPU 上实测过它，社区反馈是慢到出不来，代码里直接挡掉。没有 NVIDIA 但有官方支持的 AMD 显卡时走 ROCm 档（同样是 V5 turbo）：RX 9070 XT / 9070 GRE / 9070、AI PRO R9700、RX 9060 XT、RX 7900 XTX / 7900 XT / 7900 GRE、PRO W7900 / W7800、RX 7800 XT / 7700 XT / 7700、PRO W7700（四套架构：gfx1201 / gfx1200 / gfx1100 / gfx1101；板卡厂系列名如「大地之神」不影响识别，按芯片名匹配），要求 Windows 11、Adrenalin 26.2.2 或更新。ROCm 的内核库文件名会超过 Windows 260 字符的路径上限，所以这一档要先自己开启长路径（系统设置里改注册表 `LongPathsEnabled=1`，插件不会替你改），或者把 Coopanion 装在很短的路径下。其余显卡（含 RX 6000 系列、RX 7600 系、Intel）自动走 CPU 档（v2ProPlus），能出声但慢一些。

**会联网吗？会泄露隐私吗？**
联网只发生在**下载**运行时与模型的时候；之后所有语音合成都在你电脑上完成，**不上传任何录音与文本**。

**怎么让桌宠闭嘴？**
对话里直接说「安静一下」，桌宠会停掉正在念的句子。

### 和 QQ 一起用（把桌宠的声音发到 QQ）

三类 QQ 插件，按接入方式分两组：

| QQ 插件 | 接入方式 | 怎么把声音给它 | 本插件要开什么 |
|---|---|---|---|
| **`cortico-world-qq-final`**（NapCat，推荐） | NapCat / OneBot | 它自己合成语音：把它的「语音模型网址」指向本机 | 「开放本机语音接口」+「其他渠道的语音交给对方插件」 |
| **`cortico-world-qqbot`**（官方 QQ Bot） | QQ 官方 Bot API | 它只接收音频句柄：bot 先静音合成，再把 `[blob …]` 填进 `qqbot_send_message` 的 `voice` | 「QQ 机器人语音条」 |
| `cortico-world-qq`（老） | NapCat / OneBot | 让 bot 用 `sovits_speak(silent: true)` 念一句，回执带回 `[blob …]` 句柄，填进 `qq_draft` 的 voice | 「把整句语音交给其他插件」（不开时 `silent: true` 也回句柄） |

- `qq-final` 与 `qq` **都连 NapCat**：这两个二选一（同一条消息会被处理两次）。
- `qqbot` 走官方 Bot API，是另一个账号体系，**可以和 NapCat 那条同时开**；本插件里两个开关也互不冲突——提示词按回复工具分开（`qq_send` 走 `voice=true`，`qqbot_send_message` 走句柄）。
- 三条路都支持「文字 + 语音条」在同一条消息里发出，发往 QQ 的那句不在本机外放。

**接 QQ Bot（`cortico-world-qqbot`）的完整步骤：**

1. **装 FFmpeg**：QQ Bot 插件用它把 WAV 转成 SILK。`ffmpeg` 在 PATH 里就行；不在 PATH 就在 QQ Bot 配置的 `worlds.qq-official.ffmpegPath` 里填绝对路径。
2. 本插件控制台 →「与其他插件联动」→ 打开**「QQ 机器人语音条」**。**不用**开「开放本机语音接口」——qqbot 只接受宿主句柄或公网 URL，`127.0.0.1:9880` 它取不到。
3. 重启 Coopanion（改的是环境提示词，重启后新对话生效）。
4. 在 QQ 里让它用语音回一句：它先 `sovits_speak(silent: true)` 静音合成，再把回执里的 `[blob …]` 填进 `qqbot_send_message` 的 `voice`，文字与语音条在同一条消息里到达，本机不出声。

QQ Bot 这条的限制：语音条只在**私聊与群**可用，频道/频道私信只收图片；单条语音上限 **20 MiB**（常见台词 1–3 MB，不会撞）；整句 **45 秒**没合成完时回执不带附件，只会发文字。

**版本要求**：qq-final **0.6.29 起**已删除语音语义判定模型，**不需要任何密钥**——是否发语音由主模型在调 `qq_send` 时自己带 `voice=true` 决定。0.6.24 及更早的版本仍要自己配判定密钥（本插件不再代填）。

**接 qq-final 的完整步骤：**

1. 本插件控制台 →「与其他插件联动」：打开**「开放本机语音接口」**（端口默认 9880，可改），再打开**「其他渠道的语音交给对方插件」**（这样 QQ 的回复不会又在本机念一遍；本机对话页照常出声）。
2. 同一页往下有**「QQ 语音对接」**：会按当前端口和音色生成要填的值，可直接点**「一键写入 QQ 配置」**（先备份 `config.json`，然后写进 QQ 插件；重启 Coopanion 生效）；也可以点「复制全部」照着填到 qq-final 的「QQ · 语音收发」：
   ```
   实现方式（provider） = local
   语音模型网址          = http://127.0.0.1:9880
   发语音（tts）         = 开
   音色（voice）         = xll        # 可选：点名音色 xll / dfy / female / male 或自定义音色名；留空用本插件当前音色
   TTS 模型名            = tts-1
   请求超时              = 120
   ```
3. **不用配判定模型，也不用填 Key**：qq-final 0.6.29 起删掉了语音语义判定（端点/密钥/模型三项都没了），
   要不要发语音由主模型自己调 `qq_send(voice=true)` 决定；`local` 供应商本来就免 API Key。
   点「一键写入」只会写实现方式、语音模型网址、音色、超时这几项。旧版 qq-final（< 0.6.29）
   仍走它自己的判定配置，需要你自行指定密钥变量并在部署 `.env` 里配同名变量。
4. 两个插件都别忘：本插件的「推理服务」要处于就绪（面板灯绿）。本插件的接口 Token 建议留空；填了 Token 时 qq-final 的 local 方式不会带上它。改完 qq-final 的语音配置后重启 Coopanion。

**能点名哪些音色？** 本地语音接口的 `voice` 支持：预设 `xll`（星落落） / `dfy` / `female` / `male`，以及你自己建的自定义音色的**名字或 id**；认不出就用插件当前音色。

**注意**：`provider = custom` 也能用（同协议，但要同时填 API Key）；`native`（NapCat 自带 TTS）拿到的是**别的声音**。`voxcpm` 协议与本插件一致：把「VoxCPM 服务地址」填成 `http://127.0.0.1:9880`，用的就是本插件的声音（`/health` 探活 + `/tts` 合成，无需 API Key）。

---

## macOS（自备运行时）

内置运行时包只有 Windows（win-x64）版，macOS 这边**不下载任何运行时**，走「自备运行时目录」这条已有的入口，播放交给系统自带的 `afplay`。

**准备一个运行时目录**（`python3 -m venv runtime` 生成的布局正好是插件要找的 `runtime/bin/python3`）：

```bash
git clone https://github.com/RVC-Boss/GPT-SoVITS.git gpt-sovits
cd gpt-sovits
python3 -m venv runtime
runtime/bin/python3 -m pip install -r requirements.txt
```

**权重**：macOS 只有 CPU 档，而 CPU 档固定用 **V2 Pro Plus**（V5 turbo 在 CPU 上跑不动，配置里选了也会退回）。
`GPT_SoVITS/pretrained_models/` 下要有：

| 文件 | 字节 | 地址 |
|---|---|---|
| `s1v3.ckpt` | 155,284,856 | `https://www.modelscope.cn/models/XXXXRT/GPT-SoVITS-Pretrained/resolve/master/pretrained_models/s1v3.ckpt` |
| `chinese-hubert-base/`（3 个文件） | 188,812,078 | 同目录 `chinese-hubert-base/…` |
| `chinese-roberta-wwm-ext-large/`（3 个文件） | 651,495,070 | 同目录 `chinese-roberta-wwm-ext-large/…` |
| `fast_langdetect/lid.176.bin` | 131,266,198 | 同目录 `fast_langdetect/lid.176.bin` |
| `v2Pro/s2Gv2ProPlus.pth` | 200,125,741 | 同目录 `v2Pro/s2Gv2ProPlus.pth` |
| `sv/pretrained_eres2netv2w24s4ep4.ckpt` | 107,528,697 | 同目录 `sv/pretrained_eres2netv2w24s4ep4.ckpt` |

缺文件时 0.6.5 起会在启动失败的原因里点名缺哪个（以及上面这两条 CPU 档专用权重）。

**在配置里填**：`runtimeDir` = 上面那个 `gpt-sovits` 目录（要能看到 `api_v2.py` 与 `runtime/bin/python3`）。填好后推理档只剩「自动 / CPU」：macOS 没有可下载的运行时包，「自动」就是 CPU 档。

**限制与实测**（Apple M3，官方 GPT-SoVITS + 本插件的 xll 权重，纯 CPU）：

- 自备运行时约 7 GB（Python 依赖 + 权重），插件不会替你下。
- 播放是「整段落盘交给 `afplay`」：首字延迟等于这句的合成时间（CPU 档本来就这样）。
- 新台词**排队**，不会打断正在播的那句；要停用「停止播放」（`sovits_hush` / 面板停止），0.1 秒内 `afplay` 退出并清队列。
- 输出设备只有「系统默认」，面板不再列设备；音量仍由配置里的 `volume` 控制（`afplay -v`）。
- 速度参考：11 字 4.6 s、25 字 16.0 s、93 字约 42 s。
- 训练面板按「自备目录不支持训练」处理；要训模型请在 Windows 那边或另开一份上游仓库。
- 上游 `api_v2.py` 在设置 `sys.path` 之前就 `from tools.portable_runtime import …`，0.6.5 起插件给子进程设了 `PYTHONPATH=<运行时目录>`，不必再改运行时的 `api_v2.py`；更早的版本会报 `No module named 'tools'`。

> macOS 从 **0.6.6** 起正式放开（`os` 含 `darwin`，市场在 Mac 上也会展示）。装法同 Windows，但**没有一键运行时**：
> 必须先自备一份 GPT-SoVITS（见上）并在面板里填「自备运行时目录」。已在 Apple M3 上实测：服务就绪约 11 s、
> 试听出声、闲置停服后自动拉起，`api_v2.py` 保持上游原样即可。

---

## 云端语音（可选，0.9.0 起支持多厂商）

不想装运行时、或这台机器跑不动本地模型时，可以把引擎切到云端：合成完照常在本机播放，
9880 本地语音接口与 QQ 语音条也照样能用这份音频。云端模式不下载运行时与权重，也不会拉起本地推理服务。

**支持的厂商**（面板「服务商」下拉）：自定义（OpenAI 兼容）、OpenAI、Breeze Blue、Azure、MiniMax、
ElevenLabs、火山引擎、小米 MiMo、Fish Audio（实验）。每家的地址、默认模型 / 音色、鉴权头和返回格式
都由插件适配，切厂商会带出该家的默认值，面板里也有对应小字说明。

**配置**：控制台「GPTSovits 语音」：

1. 在「语音」页最顶部的「语音引擎」下拉里选「云端」（新装默认未选择：此时只显示这一条提示，
   本地与云端的设置都不显示；选好后只显示所选引擎的设置，随时可改回「本地」）；
2. 选「服务商」。地址与模型有默认值（自定义 / OpenAI 是 `https://api.openai.com/v1` / `tts-1`）。
   **服务商是 OpenAI、且音色留空时，会自动列出 6 个官方音色并默认选中 `alloy`**；
   其余厂商按面板里的默认值或厂商文档填；
3. 在「云端密钥」粘贴 API Key，点「保存密钥」。面板只回显掩码（如 `sk-1…cdef`）；
   **留空或把掩码原样提交都表示不修改**，想换就粘贴新密钥；
4. 「超时」默认 60 秒，慢厂商可以调大。

**音色清单**：有清单端点的服务商（自定义 OpenAI 兼容、Breeze Blue、Azure、ElevenLabs）可以点
「从服务商拉取清单」，清单按当前语种过滤（台词语种是「自动识别」时按当前台词推断），还可以加关键词
优先显示匹配项。每页 7 条，可上一页 / 下一页，也可以把整块清单收起；点某一行的「使用」会立刻写入配置并选中，
不用再保存。选中的音色在别的页时，页脚会提示它在第几页并可一键跳过去。

没有清单端点的服务商（OpenAI 官方、MiniMax、火山引擎、小米 MiMo、Fish Audio）在清单下方给一行
「音色 id」+「保存云端音色」：填厂商文档里的 voice id（显示名默认与 id 相同），点保存即写入并立刻选中；
id 为空时按钮是灰的。

换到非 OpenAI 地址后，清单里的 OpenAI 官方音色会标上「（OpenAI 官方）」；如果当前选中的正是这类音色，
云端卡会显示黄色说明（厂商很可能不支持），引导你换成厂商音色或点「从服务商拉取清单」。插件不硬拦——
你仍然可以保存并尝试合成，但上次云端失败的原因会以红字显示在云端卡上，不会静默失败。
地址、模型、音色、超时、密钥与手填音色 id 下都有一行小字，写明默认值、留空行为与必填格式。

旧配置里已有 `local` / `cloud` 的都视为已选择；没选时合成仍按本地走（与旧版默认一致），但面板不会先展示本地设置。
旧配置里若存着暂未在面板开放的服务商，会自动回退到「自定义（OpenAI 兼容）」，地址、模型与音色仍可正常使用。

**密钥存放**：密钥用 AES-256-GCM 加密后写到插件数据目录的 `secrets/cloud-tts.bin`，`config.json` 里只有一个掩码。
主密钥优先取部署 `.env` 的 `CORTICO_SECRET_KEY`（32 字节 hex 或 base64）；没有就自动生成并追加
（写前留 `.env.bak-*` 备份），`.env` 不存在时退回 `data/secrets/master.key`。换过主密钥后旧密钥解不开，
面板会提示重新填写，不会假装成功。

**限制**：

- **只接受 WAV 响应**。请求会显式带 `response_format: "wav"`；厂商忽略它而回了 mp3 时直接报错，不会静默播放失败。
- **没有首块流式**：等整段音频返回才开始播，长句首字延迟等于这句的合成时间。
  也正因为这样，`sovits_speak` 会等整句音频到手才回执，气泡与开口同步（本地仍是首块音频进声卡就回执，
  至多 3 秒）。代价是云端下这次工具调用会等完整的合成耗时。
- 新台词仍然排队，不打断正在播的那句；停止播放的行为与本地一致。

**排错**：401/403 是密钥问题、402 是额度不足、429 是限流，DNS 与连接失败单独归类；
错误文本里出现的密钥会自动抹成 `[redacted]`。

---

## 进阶配置（可选）

全部在控制台「GPTSovits 语音」的分类页签里（**输出与保存 / 与其他插件联动 / 推理服务**），音色、自备权重与台词翻译在「音色」页里设置；不填就是合理的默认值。原来的「配置」页与「音色与台词」页都已移除，两处不再重复。云端引擎的地址、密钥与音色只在「音色」页设置，不进配置表单（见上文「云端语音」）。

**① 「音色」页：音色、权重与台词**（音色与权重在页面上半部，语音语言 / 翻译 / 语速 / 种子在下方的「台词与翻译」卡）

| 配置 | 默认 | 说明 |
|---|---|---|
| `voice.preset` | `xll`（大肥鱼_星落落版本） | 预设音色：`xll` / `dfy` / `female` / `male` |
| `voice.audio`、`voice.text` | 空 | 自定义参考音频（3–10 秒 WAV）与它的台本；填了就优先于预设音色 |
| `weights.gpt`、`weights.sovits` | 空 | 自备训练权重：自己训的 s1（`.ckpt`）与 s2（`.pth`），两个都填才生效 |
| `textLang` | `zh` | 语音语言，与界面语言无关：`zh` 直接照读聊天文字；`en` / `ja` 先把聊天文字翻译成该语言再念（气泡不变）；`auto` 跟随原文 |
| `speed` | 1 | 语速 |
| `seed` | -1 | 采样种子：`-1` 每次随机（同一句每次听起来都不同）；填 0 或正整数则固定，同一句逐字节一致 |
| `promptLanguage` | `zh` | 发给模型的那段环境提示词用中文还是英文 |

**② 输出与保存**

| 配置 | 默认 | 说明 |
|---|---|---|
| `playLocally` | true | 本机外放。关掉后语音只合成、不在本机出声；某一句想临时不播，让 bot 调 `sovits_speak` 时带 `silent: true` |
| `volume` | 1 | 音量 0–1 |
| `outputDevice` | 空 | 输出设备名，空为系统默认 |
| `saveAudio` | false | 每句合成完另存一个 WAV，方便交给其他程序查看或归档 |
| `saveDir` | 空 | 语音保存目录，空为插件数据目录下的 `gpt-sovits\out` |
| `saveKeepHours` | 0 | 保存的语音保留多少小时，过期的在下次保存时清掉；只清理本插件写出的 `line-*.wav`。0 为一直留着 |
| `playbackLead` | 0 | 播放预缓冲比例（0–0.62，默认关闭）。只在本机生成慢于播放（RTF>1.05）时生效：先攒够本句预计时长的这个比例再开播，减少 CPU / 核显档的断续；首句无实测样本不缓冲，门槛封顶 2.4 秒。缓冲只吸收爬坡与抖动，消不掉整句平均慢于播放的尾段缺口 |

**③ 与其他插件联动**（QQ 语音，详见上文「和 QQ 一起用」）

| 配置 | 默认 | 说明 |
|---|---|---|
| `httpApi` | false | 开放本机语音接口（只监听 127.0.0.1）：任何会自己合成语音的插件把「语音模型网址」指过来就能用这个声音；qq-final / NapCat 是其中一个使用者。**qqbot 不吃这个地址**。联动页最上面那张卡的开关，即时生效，关着时端口/令牌不生效 |
| `httpPort` | 9880 | 语音接口端口；被占用（包括本插件自己的 api_v2）时卡片会提示，改成 9883 之类即可，改完立即重试 |
| `httpToken` | 空 | 语音接口令牌。留空不校验；填了以后对方要带 `Authorization: Bearer` 或 `?token=` |
| `channelVoice` | false | 旧 QQ 插件（qq-final / NapCat）那条路：开启后提示词让 bot 走 `qq_send` 时不要调 `sovits_speak`，改传 `voice=true`，由对方来取 9880 |
| `qqbotVoice` | false | QQ Bot 插件（qqbot）那条路：开启后提示词让 bot 先 `sovits_speak(silent: true)`，再把 `[blob …]` 填进 `qqbot_send_message` 的 `voice`。与 `channelVoice` 可同时开 |
| `shareAudio` | false | 把整句语音作为 `sovits_speak` 回执的附件交出去（qqbot / `qq_draft` 都吃这个句柄）。开启后这句要等整句合成完才回执，气泡会晚一点出现；只发 QQ 语音条时不用开，`silent: true` 也会回句柄 |

**④ 推理服务**

| 配置 | 默认 | 说明 |
|---|---|---|
| `tier` | `auto` | 推理档：`auto` / `cuda` / `cpu` |
| `autoStart` | true | 启动时自动拉起本机推理服务 |
| `idleMinutes` | 0 | 本机推理服务空闲这么多分钟就停掉，释放显存与内存；下一句自动重新拉起（会先排队等加载）。0 为不停 |
| `serverUrl` | 空 | 填了就连这个已有的 api_v2 服务，不在本机启动、不下载运行时 |
| `runtimeDir` | 空 | 自备运行时目录（含 `runtime/` 与 `api_v2.py`；Windows 的 Python 在 `runtime/python.exe`，macOS 在 `runtime/bin/python3`），填了不下载运行时 |

> 同一句话「忽好忽坏」通常是 `seed=-1` 每次重新采样的缘故，不是坏了。想要稳定输出就把 `seed` 固定。

## 自备训练权重（进阶）

用 GPT-SoVITS 训出来的模型这样接：

- `.ckpt` 填 `weights.gpt`（s1 / 文本→语义），`.pth` 填 `weights.sovits`（s2 / 音色与声学），**两个必须来自同一次训练的同一轮**（如 `-e8.ckpt` 配 `_e8_*.pth`）。
- 版本自动判定：读 `.pth` 头两字节，`08` = v5turbo（显卡档）、`06` = v2ProPlus（CPU 档），其他版本会拦下并说明原因。
- 服务在跑时改配置会走 `/set_gpt_weights` + `/set_sovits_weights` 就地热换，不打断正在播的句子；清空两个框则换回内置底模。

## 训练自己的音色

想用完全属于自己的声音，可以直接在面板里训练，不必另装一套 GPT-SoVITS：

- 入口在「语音」插件的「训练」页；**训练依赖与训练资源都是可选的、手动触发**，默认不装不下。
- 训练版本跟着「模型版本」走：V5 turbo 训 **LoRA**，V2 Pro Plus 训 **v2ProPlus**；训练很吃显存，建议先勾上**「先停推理服务（释放显存）」**再开训。
- 步骤：① 点「安装训练依赖」（gradio / tensorboard / funasr / modelscope 等）→ ② 点「下载训练资源」（v2ProPlus 需要判别器 s2D，显卡档通常已就绪）→ ③ 依次「启动训练 WebUI」并「打开浏览器」→ ④ 在上游页面里走完 数据准备 → 训练。
- 训练产物（`GPT_weights*` / `SoVITS_weights*` 目录里的 `.ckpt` / `.pth`）拿到「音色」页当**「自备权重」成对选用**；v5turbo 的 s2 产物是 LoRA（版本头 `08`），v2ProPlus 是 `06`。
- 训练 WebUI 只监听 `127.0.0.1`，端口自动挑空闲的，不影响推理服务端口。

---

## 开发者信息

> 本仓库是 [Phantivia/cortico-world-gpt-sovits-for-coopanion](https://github.com/Phantivia/cortico-world-gpt-sovits-for-coopanion)
> 的 fork（原作者同意后维护），在原版 0.1.2 之上补了参考音频时长校验、装饰符号导致合成崩溃的修复、
> 采样种子选项、自备训练权重入口与随包默认音色，改动见 [CHANGELOG.md](CHANGELOG.md)。
> 原包名仍由原作者在 npm 上维护，本 fork 发布为 `@wocwang/cortico-world-gpt-sovits-for-coopanion`。

### 检测运行中的参考切换

```powershell
pnpm check:refs           # 查当前语音语言、参考音频、台本与时长是否对得上
pnpm check:refs -- --tts  # 再向正在跑的 api_v2 发一句测试（只写临时 WAV，不播放）
```

默认读 `D:\Program Files\Coopanion\data\home\companion\config.json`；换部署时加 `--config <路径>`。

Owner: `src/world.ts`

### 两档

| 档 | 条件 | 模型 | 本机实测(RTX 5090 Laptop / Core Ultra 9 290HX) |
|---|---|---|---|
| 显卡 | NVIDIA 显卡 | V5 turbo | 首包 0.5–1.0 s,实时率 0.22–0.41,显存 3.5 GB |
| CPU | 其余 | v2ProPlus | 首包 0.8–1.1 s,实时率 0.8–1.1,内存 5.8 GB |

推理档默认自动：`nvidia-smi` 列得出显卡就用显卡档。V5 turbo 在这台机器的 CPU 上首包 3–4 s、实时率 1.2–1.5,
跟不上播放，所以 CPU 档用 v2ProPlus。实测 v2ProPlus 的峰值约 −7~−8 dBFS，播放乘 2 倍；
以前按 −27 dBFS 乘 8 倍，会把 20% 以上样本压进软限幅，听起来发糊，已修正。

首次启动显卡档要编译 CUDA 内核，本机第一次 74 s,之后约 11 s。服务起来后用中、英、日各一句预热，预热完才算可用。

### 预设音色

随包带四个预设音色，音频与台本成对放在 `assets/voices/<id>.wav` / `<id>.txt`：

| id | 名称 | 来源 |
|---|---|---|
| `xll` | 大肥鱼_星落落版本(中英) | **默认**。蒸自肥鱼 CosyVoice3（该模型卡只声明 `zh` / `en`，没有日语），中文参考 4.00 秒、英文参考 3.20 秒，台本分别是 `你听起来有点累，要不要休息一下？` / `You can always come back here.`。两段都走**仅滤波**处理：高通 80 Hz + 50/100/150/200 Hz 工频陷波，未做谱减，峰值归一 0.9。**用官方底模 + 参考音频零样本合成**，不加载随包训练权重 |
| `dfy` | 大肥鱼(日中英) | 旧默认音色。日语参考 5.16 秒（AI 合成人声，非真人录音，来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)），参考文字 `ティード パラパパパ ニーノ ナラナナナ ピンドン`；另带中文/英文同音色参考 `dfy.zh.wav` / `dfy.en.wav`，选中文或英文语音时自动换用。三段参考都走同一套**仅滤波**处理：高通 80 Hz + 50/100/150/200 Hz 工频陷波，未做谱减（保留气声与呼吸），峰值归一 0.9。**用官方底模**，不加载训练权重 |
| `female` | 女声 | [MOSS-VoiceGenerator](https://huggingface.co/OpenMOSS-Team/MOSS-VoiceGenerator) 按文字描述生成 |
| `male` | 男声 | 同上 |

选了「语音语言」里的中文/英语/日语时，预设音色会自动换用对应语言的参考音频与台本（`xll.zh.wav` / `xll.en.wav`、`dfy.zh.wav` / `dfy.en.wav` / `dfy.wav`）。参考音频是每次合成请求自带的，**换参考不需要重启服务，也不需要换权重**；没有对应语言参考的预设（`xll` 的日语、`female` / `male` 的日语与英语）回退到它的默认参考。

面板上传了自定义参考音频时用自定义的，「改回预设音色」清掉它、回到选中的预设。

`female` / `male` 的参考文字是一句带语气词的口语，时长 3–10 秒，经 Whisper 核对与参考文字一致；
描述、种子与解码参数在 `assets/voices/prompts.json`。

> 换预设音色时，参考音频与台本是一对：`<id>.wav` 与 `<id>.txt` 必须内容一致，差一个字音色就会漂。

### 训练权重

当前**不随包分发训练权重**：`xll` 也走官方底模 + 参考音频的零样本合成，安装时只下载底模。
之前 Release 里的 `voice-xll-v1` 权重不再进下载清单（已装过的文件留在权重目录里也不会被加载），
避免额外 220 MiB 下载，也避免蒸馏模型的高频质感。

想用自己训练的权重：在「音色」页或配置里填「自备 GPT 权重 / 自备 SoVITS 权重」这一对，
服务会原地切换，不需要重启。

### 给别的插件取音频（本机语音接口，入站）

`httpApi` 打开后，本插件在 `127.0.0.1:<httpPort>` 上开一个小接口，**任何**会自己合成语音的插件都可以直接拿这个声音合成；
它与 QQ 无关，qq-final / NapCat 只是其中一个使用者。

**怎么填给对方**：地址填 `http://127.0.0.1:<httpPort>`（默认 `9880`），设了令牌就再带 `Authorization: Bearer <令牌>`。
本机插件通常直接填这个地址、不用带路径——figure 的「GPT-SoVITS 地址」、qq-final 的「语音模型网址」都是这么填的。

| 路由 | 用途 |
|---|---|
| `GET /health` | 就绪状态：`{"ready":true,"state":"available"}` |
| `GET /models`（或 `/v1/models`） | OpenAI 兼容探活：返回一个模型列表，`qq-final` / `QQ-ProMAX` 的 `local` 供应商据此判断服务活着 |
| `POST /audio/speech` | OpenAI 兼容：`{model?, voice?, input, speed?}` → `audio/wav` 字节 |
| `POST /tts` | VoxCPM 形状：`{text, voice_desc?, speed?, seed?}` → `48 kHz audio/wav` 字节 |

`voice` 可以点名音色（预设 `xll` / `dfy` / `female` / `male`，或自定义音色的名字/id），不填就用插件当前音色；
`voice_desc` 是 VoxCPM 的音色描述，只在能对上已知音色时采用，对不上不会告警。

响应头里还带三个数，方便对方按真实节奏安排气泡（0.6.6 起）：

| 响应头 | 含义 |
|---|---|
| `x-sovits-first-chunk-ms` | 从收到请求到第一块音频就绪用了多少毫秒（含冷启动拉服务的时间） |
| `x-sovits-synthesis-ms` | 整句合成完用了多少毫秒 |
| `x-sovits-duration-ms` | 这段音频的实际时长（毫秒） |
合成不经过播放器，本机不会出声；多个请求自动排队，一次只合成一句。

- 这张卡在「与其他插件联动」页**最上面**，开关就是主开关：关着时端口与令牌置灰、不监听。开关与端口**即时生效**，
  改完直接停/起或重绑，不用重启 Coopanion；关掉就真的停止监听。
- **并发上限 1（FIFO）**：多个插件同时来取会按到达顺序排队；每个请求「排队 + 合成」合计最多 120 秒，超时回 502。
  所有调用共用插件当前音色，不会因为并发换权重。
- 端口默认 9880，和自备/托管的 `api_v2` 默认端口相同。被占用时卡片会直接说明是「被别的程序占用」还是
  「正被本插件的推理地址占着」，把端口改成 9883 之类没被占用的就会立刻重试。

配合 `cortico-world-qq-final`（它的语音是自己合成的）时的两种填法，二选一：

**方式 A：OpenAI 兼容（可点名音色）**

```
worlds.qqbot.voice.provider     = local          # 或 custom（要同时填 API Key）
worlds.qqbot.voice.voiceBaseUrl = http://127.0.0.1:9880
worlds.qqbot.voice.voiceVoice   = xll            # 可选：指定音色；不填用插件当前音色
worlds.qqbot.voice.voiceTimeout = 120            # 本地合成慢，默认值够
worlds.qqbot.voice.tts          = true           # 允许主模型把回复发成语音（0.6.29+ 由它自己决定，无需判定模型）
```

**方式 B：VoxCPM 形状（不需 API Key，但不能点名音色）**

```
worlds.qqbot.voice.provider  = voxcpm
worlds.qqbot.voice.voxcpmUrl = http://127.0.0.1:9880
worlds.qqbot.voice.tts       = true
```

`QQ-ProMAX` 的语音供应商与 qq-final 同源，以上两种填法同样适用。

再把本插件的 `channelVoice` 打开：提示词会告诉 bot 在 QQ 这类渠道不要自己念，避免同一句本地又响一遍。
老插件 `cortico-world-qq`（用 `[blob …]` 句柄的 `qq_draft`）继续走 `shareAudio`，两条路别同时开。

### 推理后端

按优先级取第一个：

1. **已有服务**:`worlds.gpt-sovits.serverUrl` 填一个 api_v2 地址，直接连它。
2. **自备目录**:`runtimeDir` 填一个含 `runtime/python.exe` 与 `api_v2.py` 的 GPT-SoVITS 目录(比如官方整合包),
   在里面起服务，权重用它自己的。
3. **托管安装**:面板上「安装并启动」下载本扩展打的运行时包(上游推理代码、独立 CPython 3.12 与依赖、G2PW、NLTK、
   Open JTalk 词典)和权重，装到部署根下的 `runtimes/gpt-sovits/<版本>/<档>/` 与 `models/gpt-sovits/pretrained_models/`,
   目录约定见 Cortico `docs/runtimes.md`。每个文件按顺序试多个来源，大小与 SHA-256 对上才算装好。

本机服务以 `runtime/python.exe -I -X utf8 -u api_v2.py` 在运行时根下启动，监听 127.0.0.1 的空闲端口。

### 自备训练权重细节

- **底模还得留着**：v5turbo 的 s2 训练产物是 LoRA 增量，加载时先读 `s2Gv5turbo.pth` 再合并，
  所以自备权重不代替底模下载。
- **生效方式**：托管与自备目录两种后端在启动时把这两条路径写进 `tts_infer.<档>.yaml`；
  服务在跑时改这两项，扩展调 `/set_gpt_weights` 与 `/set_sovits_weights` 就地换，**不用重启**，
  也不打断正在播的句子。清空这两项也走同一条路换回底模（只有连已有服务时不知道底模在哪，需要重启一次）。
- **`serverUrl`（连已有服务）也能用**：那种后端不写 yaml，自备权重完全靠就地换这条路生效。

`.pth` 头字节对照（同一张表在 `src/weights.ts`）：

| 头 | 版本 | 本扩展可用 |
|---|---|---|
| `08` | v5turbo LoRA | ✅ 显卡档 |
| `06` | v2ProPlus | ✅ CPU 档 |
| `07` | v5 LoRA | ❌ 底座不同 |
| `05` | v2Pro | ❌ |
| `04` / `03` / `02` / `01` / `00` | v4 / v3 / v2 / v1 | ❌ |

### 工具与事件

- `sovits_speak(text)`:去掉 `【…】` 与 `<…>` 标记后合成，排在没念完的句子后面。
- `sovits_hush()`:停下当前一句并清空队列。
- 事件 `gpt-sovits.state`:语音变为可用或不可用(piggyback,随下一批事件送达)。环境提示词里的状态是前缀重建时的快照，以事件为准。

### 输入防护

自定义参考音频必须是 **3–10 秒**的 WAV。api_v2 收到范围外的音频只回一个不带原因的 `400 Bad Request`,
所以扩展在合成前自己量一次时长，把「实际多长、要求多长」报出来(`sovits_speak` 的返回和环境提示词里的状态都带上)。

台词里的装饰字符同理：服务端的音素前端会把 ♡ ★ ♪ 与 emoji 丢掉，某一段只剩符号时它会用空音素段去调
`torch.cat()` 并崩掉(`expected a non-empty list`)。扩展在送合成前先把这类符号去掉；
万一还是失败，再去掉标点重试一次(已经出过声时不重试，免得多播半句)。

### 致谢

AMD 与 macOS 这两块不是我一个人做出来的，完整的名单与「每个人做了什么」见 [CONTRIBUTORS.md](CONTRIBUTORS.md)。

- **@ink1453**：macOS 平台层（PR #10，`platform.ts` / `afplay` / 进程组）与 M3 真机验收，还找出了 `-I` 忽略 `PYTHONPATH` 的根因；
- **@ANGOSUNG**：ROCm 档的选卡、MIOpen、内核与长路径方案，并在 RX 9070 上跑通；
- **@aiAsuka**：音频后端探针的判据，0.6.5 的静音回归就是靠他的实测定位的。

### 开发

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build        # src/webui → dist/webui.js、dist/webui.css
```

自描述 `describe.json` 用 Cortico 的 `pnpm describe:extension <本目录>` 生成。
