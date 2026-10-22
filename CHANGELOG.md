# Changelog

## Unreleased

- 参考音频时长不在 3–10 秒时，合成前就报出实际时长；之前只拿到一个不带原因的 `HTTP 400`。
- 配置里可填「辅助参考音频」(`voice.auxAudio`)：与主参考一起融合音色，语调起伏更丰富。

## 0.1.2

- 配置里加「自定义参考音频」(选择本机 WAV)和「参考音频的台本」,不用进语音页上传也能换音色。

## 0.1.1

- 随包带 audify 的预编译件，不再从 npm 装 audify:它安装时要从 GitHub 下预编译件，下不到就现场编译，没有编译工具的机器装不上。

## 0.1.0

- 首个版本：`sovits_speak` / `sovits_hush`,显卡档 V5 turbo、CPU 档 v2ProPlus,已有服务、自备目录与托管安装三种后端，
  高级模式「GPTSovits 语音」页(状态、安装、启动、音色、试听)。
- 女声、男声两个预设音色，由 MOSS-VoiceGenerator 生成。
