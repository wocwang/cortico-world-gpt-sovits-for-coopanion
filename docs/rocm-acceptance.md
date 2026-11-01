# ROCm 档社区验收清单（RX 9070 / gfx1201 实测用）

给有 AMD 显卡、愿意代验的人照着做。每步把结果贴回
[Discussion #228](https://github.com/Pal-AI-Lab/cortico-extensions/discussions/228)，
格式用最后一节的模板。全部是本机操作，不需要提供任何账号或密钥。

前置条件：

- Windows 11（`winver` 里内部版本 ≥ 22000）
- AMD Adrenalin 26.2.2 或更新（面板「驱动版本」会显示读到的值）
- 显卡在官方列表里：RX 9070 / 9070 XT / 9060 XT / AI PRO R9700 / 7900 XTX / PRO W7900 / RX 7700
- 已开启长路径，或 Coopanion 装在很短的路径下。检查：

```powershell
reg query "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled
```

不是 `0x1` 就先开启（需要管理员，改完重启）：

```powershell
reg add "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f
```

## 1. 档位识别

1. 装好 0.6.0、重启 Coopanion，打开「语音」面板。
2. 「推理档」应显示 `AMD ROCm(V5 turbo)`，下面一行写「自动：检测到 AMD 显卡（gfx1201），使用 ROCm 档」。
3. 把「推理档」手动切到「CPU」，确认档位标签与说明跟着变；再切回「自动」。

记录：面板显示的档位标签、gfx、驱动版本。

## 2. 安装运行时

1. 点「安装」，记下开始时间。
2. 下载完成后应显示解压与替换，最后运行时一行变绿。
3. 失败时把面板底部的日志尾部原样贴回来。

记录：整包大小、耗时、失败时的报错原文。

## 3. 出声与延迟

1. 点「试听」，确认有声音。
2. 连续试听 5 句不同的话，记录每句从点击到出声的时间与音频时长。
3. 记录服务启动耗时（面板「启动用了 N 秒」）与第一句的时间。

记录：启动秒数、首句秒数、稳态每句秒数 / 音频秒数（算 RTF）。

## 4. MIOpen 行为

在 `%APPDATA%` 上一级找不到的话，直接看 `data\logs\core.log` 与
`data\gpt-sovits\voice-server.log`，搜 `MIOpen`：

```powershell
Select-String -Path "D:\Program Files\Coopanion\data\gpt-sovits\voice-server.log" -Pattern "MIOpen" | Measure-Object
```

记录：一次冷启动里 `MIOpen` 告警条数。

## 5. 卸载与回退

1. 「已安装模型」里应能看到「ROCm 运行时（AMD）」，体积标 ≈。
2. 卸载后目录消失，重新安装能起来。
3. 切到 CPU 档能正常出声；再切回「自动」能回到 ROCm 档。

记录：卸载前显示的体积、卸载后是否删干净、切档是否要重启。

## 6. 已知不接受的结果

- 需要手动改注册表以外的系统设置、装驱动、装 Python 或 pip 才能跑通 → 算不通过。
- 面板显示 ROCm 档但服务起不来、日志里 `hipErrorInvalidKernelFile` 或 `0xC0000005` → 贴日志，算 bug。
- 声音正常但比 CPU 档还慢 → 贴 RTF，算性能问题。

## 7. 回帖模板

```text
ROCm 代验结果（插件 0.6.0）
- 系统 / 驱动：Windows 11 <build> / Adrenalin <版本，面板读到的 DriverVersion>
- 显卡：<型号>（<gfx>），长路径：<已开 / 未开，装在短路径>
- 档位识别：<面板标签 + 说明那一行原文>
- 安装：<整包大小>，耗时 <分:秒>，结果 <成功 / 失败原文>
- 启动：<N 秒>；首句 <N 秒>
- 稳态：<N 句，每句秒数 / 音频秒数，RTF 范围>
- MIOpen 告警：<N 条>
- 卸载 / 切档：<结果>
- 异常日志：<贴最后 20 行>
```
