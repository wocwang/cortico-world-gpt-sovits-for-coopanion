# 交接提示词（复制到新会话即可）

> 用法：开一个新会话，把下面整段粘进去，再补一句「继续做 X」。
> 这段提示词的作用是让新会话**不需要重新摸索**：它会被引导去读快照、交接单和待办清单。

```text
你在接一个已经做了很久的 Coopanion 插件项目，请按下面的顺序恢复上下文，不要从头摸索。

项目：Coopanion 的 GPT-SoVITS 世界插件
- 仓库：d:\Users\HW W\Documents\pr-gpt-sovits\repo（npm 包 @wocwang/cortico-world-gpt-sovits-for-coopanion）
- 本机宿主：D:\Program Files\Coopanion\data（配置在 data\home\companion\config.json，日志在 data\logs\core.log）

恢复上下文的三步（请先做完再动手）：
1. 跑一次快照脚本（只读，不会改任何东西）：
   cd /d "d:\Users\HW W\Documents\pr-gpt-sovits\repo" && node scripts\handoff.mjs
   它会打印：工作区版本 / npm latest / 最近提交 / 工作树是否干净 / 本机已装版本 / 宿主配置要点 / 训练产物。
2. 读这三份文件：
   - docs/STATE.md（机器生成的状态快照）
   - HANDOFF.md（为什么这么做、历史踩过的坑、每个版本做了什么）
   - TODO.md（还没做完的清单，按优先级排的）
3. 再跑 git status 与 git log --oneline -5，确认工作树干净、最近提交是什么。

工作纪律（这个项目一直这样）：
- 改动前先跑基线：node node_modules\typescript\bin\tsc --noEmit、node node_modules\vitest\vitest.mjs run、node scripts\build-webui.mjs
- 改完再跑一遍同样的三条；提交前要跑 npm run build && npm test && npm run typecheck && npm run check:audio
- 扩展契约要重生成：在 d:\Users\HW W\Documents\pr-rvc\Cortina\state\cortico 下跑
  node <repo>\node_modules\tsx\dist\cli.mjs scripts\extension-describe.ts <repo>
  node <repo>\node_modules\tsx\dist\cli.mjs scripts\extension-check.ts <repo>
- 没做完的活儿先提交成 WIP，不要留在工作树里
- 发布要主人点头；发布后：push → 市场同步 issue（Pal-AI-Lab/cortico-extensions）→ 讨论区 #228 回帖 → HANDOFF/TODO 记一笔
- 改文案时不要写未经实测的主观描述（例如底模音色）；要数据就本机实测并写清条件

需要我继续做的事：<在这里写具体任务>
```

## 不想复制粘贴时

新会话的第一句可以直接说：

> 接手 `d:\Users\HW W\Documents\pr-gpt-sovits\repo`，先跑 `node scripts\handoff.mjs` 再读 `docs/STATE.md`、`HANDOFF.md`、`TODO.md`，然后继续做「<任务>」。

脚本的输出也可以直接贴进新会话，它本身就够对方知道现在什么状态。
