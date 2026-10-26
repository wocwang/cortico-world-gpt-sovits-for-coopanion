# 更好的GPTSovits 语音 — 大肥鱼来咯

`@wocwang/cortico-world-gpt-sovits-for-coopanion`

给 Coopanion 桌宠配上真实的 GPT-SoVITS 语音：桌宠每次说话，插件就在**你自己的电脑上**把这句话合成出来、从声卡播出。全程本机运行，不上传任何录音。

---

## 普通用户：装完就能用

1. **安装**：在 Coopanion 插件市场搜索「大肥鱼」或「GPTSovits」安装。
2. **等待自动下载**：装好后插件会自动下载语音运行时和模型（显卡档约 4–7 GB，取决于网速，几分钟到十几分钟）。**期间桌宠暂时没有声音，属正常**，下载完自动出声。
3. **开始聊天**：什么都不用配置——默认音色就是「大肥鱼_星落落版本」，桌宠说话自动带声音。

### 常见问题

**第一次装完没声音？**
正在下载运行时与模型（看语音页的下载进度）。显卡档首次启动还要编译一次 CUDA 内核（约 1–2 分钟，只此一次）。之后每次开机都是几秒内就绪。

**想换个声音？**
设置 → 「更好的GPTSovits 语音」→ 音色下拉，四个预设任选：

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
有 NVIDIA 显卡自动走显卡档（V5 turbo，又快又好）；没有就自动走 CPU 档（v2ProPlus），能出声但慢一些。

**会联网吗？会泄露隐私吗？**
联网只发生在**下载**运行时与模型的时候；之后所有语音合成都在你电脑上完成，**不上传任何录音与文本**。

**怎么让桌宠闭嘴？**
对话里直接说「安静一下」，桌宠会停掉正在念的句子。

### 和 QQ 一起用（把桌宠的声音发到 QQ）

支持两类 QQ 插件，**二选一，别同时开**（都连 NapCat 会让同一条消息被处理两次）：

| QQ 插件 | 怎么把声音给它 | 说明 |
|---|---|---|
| **`cortico-world-qq-final`**（新，推荐） | 它自己合成语音，所以让它**来取**：打开本插件的「开放本地语音接口」，把它的「语音模型网址」指向本机 | 语音同样是星落落/当前音色的声音；本机不会重复播放 |
| `cortico-world-qq`（老） | 打开「把整句语音交给其他插件」，模型把回执里的 `[blob …]` 句柄填进 `qq_draft` 的 voice | 也能用，但要求模型每次记得带句柄；老插件已不再维护 |

**接新插件（qq-final）的完整步骤：**

1. 本插件设置 →「与其他插件联动」：打开**「开放本地语音接口」**（端口默认 9880，可改），再打开**「其他渠道的语音交给对方插件」**（这样 QQ 的回复不会又在本机念一遍；本机对话页照常出声）。
2. qq-final 设置 →「QQ · 语音收发」：
   ```
   实现方式（provider） = local
   语音模型网址          = http://127.0.0.1:9880
   发语音（tts）         = 开
   音色（voice）         = xll        # 可选：点名音色 xll / dfy / female / male 或自定义音色名；留空用本插件当前音色
   请求超时              = 120
   ```
3. 它的语音由「语义判定」触发（对方明确要语音时才发），判定需要一个 LLM 密钥：填「判定端点」`https://api.deepseek.com`、「判定密钥名」（在部署目录 `.env` 里放好同名密钥）、「判定模型」`deepseek-chat`。**不填就不会发语音**（语音收发开关开着也不发）。
4. 两个插件都别忘：本插件的「推理服务」要处于就绪（面板灯绿）。

**能点名哪些音色？** 本地语音接口的 `voice` / `voice_desc` 支持：预设 `xll`（星落落） / `dfy` / `female` / `male`，以及你自己建的自定义音色的**名字或 id**；认不出就用插件当前音色。

**注意**：`provider = custom` 也能用（同协议，但要同时填 API Key）；`native`（NapCat 自带 TTS）和 `voxcpm`（本地 VoxCPM2 服务）拿到的是**别的声音**，不是本插件的音色。

---

## 进阶配置（可选）

全部在 Coopanion 高级模式的「更好的GPTSovits 语音」页，设置页按下面四组做成可折叠卡片，不填就是合理的默认值。

**① 音色与台词**

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

**③ 与其他插件联动**（QQ 语音，详见上文「和 QQ 一起用」）

| 配置 | 默认 | 说明 |
|---|---|---|
| `httpApi` | false | 开放本地语音接口（只监听 127.0.0.1）：新 QQ 插件把「语音模型网址」指过来就能用这个声音合成并发到 QQ |
| `httpPort` | 9880 | 语音接口端口；与别的程序冲突时换一个 |
| `httpToken` | 空 | 语音接口令牌。留空不校验；填了以后对方要带 `Authorization: Bearer` 或 `?token=` |
| `channelVoice` | false | 由对方插件自己合成语音的渠道（如 QQ）：开启后提示词让 bot 不为这些回复调用 `sovits_speak`，本机对话页照常出声 |
| `shareAudio` | false | 老 QQ 插件那条路：把整句语音作为 `sovits_speak` 回执的附件交出去，模型把 `[blob …]` 句柄填给 `qq_draft`。开启后这句要等整句合成完才回执，气泡会晚一点出现 |

**④ 推理服务**

| 配置 | 默认 | 说明 |
|---|---|---|
| `tier` | `auto` | 推理档：`auto` / `cuda` / `cpu` |
| `autoStart` | true | 启动时自动拉起本机推理服务 |
| `idleMinutes` | 0 | 本机推理服务空闲这么多分钟就停掉，释放显存与内存；下一句自动重新拉起（会先排队等加载）。0 为不停 |
| `serverUrl` | 空 | 填了就连这个已有的 api_v2 服务，不在本机启动、不下载运行时 |
| `runtimeDir` | 空 | 自备运行时目录（含 `runtime/python.exe` 与 `api_v2.py`），填了不下载运行时 |

> 同一句话「忽好忽坏」通常是 `seed=-1` 每次重新采样的缘故，不是坏了。想要稳定输出就把 `seed` 固定。

## 自备训练权重（进阶）

用 GPT-SoVITS 训出来的模型这样接：

- `.ckpt` 填 `weights.gpt`（s1 / 文本→语义），`.pth` 填 `weights.sovits`（s2 / 音色与声学），**两个必须来自同一次训练的同一轮**（如 `-e8.ckpt` 配 `_e8_*.pth`）。
- 版本自动判定：读 `.pth` 头两字节，`08` = v5turbo（显卡档）、`06` = v2ProPlus（CPU 档），其他版本会拦下并说明原因。
- 服务在跑时改配置会走 `/set_gpt_weights` + `/set_sovits_weights` 就地热换，不打断正在播的句子；清空两个框则换回内置底模。

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

### 给别的插件取音频（本地语音接口）

`httpApi` 打开后，本插件在 `127.0.0.1:<httpPort>` 上开一个小接口，别的插件可以直接拿这个声音合成：

| 路由 | 用途 |
|---|---|
| `GET /health` | 就绪状态：`{"ready":true,"state":"available"}` |
| `POST /audio/speech` | OpenAI 兼容：`{model?, voice?, input, speed?}` → `audio/wav` 字节 |
| `POST /tts` | VoxCPM 形状：`{text, voice_desc?, speed?, seed?}` → 48 kHz `audio/wav` 字节 |

`voice` / `voice_desc` 可以点名音色（预设 `xll` / `dfy` / `female` / `male`，或自定义音色的名字/id），不填就用插件当前音色。
合成不经过播放器，本机不会出声；多个请求自动排队，一次只合成一句。

配合 `cortico-world-qq-final`（它的语音是自己合成的）时的填法：

```
worlds.qqbot.voice.provider     = local          # 或 custom（要同时填 API Key）
worlds.qqbot.voice.voiceBaseUrl = http://127.0.0.1:9880
worlds.qqbot.voice.voiceVoice   = xll            # 可选：指定音色；不填用插件当前音色
worlds.qqbot.voice.voiceTimeout = 120            # 本地合成慢，默认值够
worlds.qqbot.voice.semanticJudge = true          # 由它判断哪些回复用语音
```

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

### 开发

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build        # src/webui → dist/webui.js、dist/webui.css
```

自描述 `describe.json` 用 Cortico 的 `pnpm describe:extension <本目录>` 生成。
