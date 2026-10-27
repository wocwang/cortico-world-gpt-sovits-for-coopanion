# Checklist — 0.5.11 训练面板

- [ ] `catalog.ts` 导出 `TRAIN_ASSETS`，含 `v2Pro/s2Dv2ProPlus.pth`（126432639 B / sha256 635cd84b…），双源为 modelscope+HF
- [ ] `runtime-patch.ts` 新增 `patchTrainer`：纯函数幂等、CRLF 保持、锚点不中返回 `unsupported`、不改上游其它内容
- [ ] `trainer.ts` 的 `TrainerManager` 五项能力齐备（state/installDeps/downloadAssets/start/stop），日志环 200 行、`logTail` 40 行
- [ ] 训练 WebUI 只绑 127.0.0.1（补丁生效后），端口来自 `COOPANION_TRAINER_PORT` 且与推理端口不同
- [ ] world 面板 `train` 注册，`getMethods` 仅 `trainerState`；写操作走 invoke 分支
- [ ] 前端面板有：依赖/资源/服务三行状态、四个按钮、先停推理复选框、红字提示、可折叠日志、2s 轮询
- [ ] i18n zh/en 训练文案成对齐全（无缺键）
- [ ] CHANGELOG 0.5.11 含训练面板 + 密钥删除两条；README 有「训练自己的音色」；package.json = 0.5.11
- [ ] `tsc --noEmit`、`vitest run` 全绿；`grep -E "setJudgeKey|secretConfigured|judgeConfigured|qqJudge" src/` 无输出
- [ ] 本机实测：起训练 WebUI 后 `netstat` 仅 127.0.0.1、HTTP 返回 <500；停止后端口释放；9880 推理服务全程仍在
- [ ] 产出 `wocwang-...-0.5.11.tgz`，旧 0.5.10 tgz 已删
- [ ] 本地 commit 已建（不 push），工作树干净