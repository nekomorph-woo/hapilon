---
name: handoff
description: 把当前对话压缩成交接文档，供另一个全新 agent 接手继续。产出 .hapilon/handoff/ 下的 Markdown。
disable-model-invocation: true
---

# 交接

写一份概括当前对话的交接文档，让一个全新 agent 能无缝接手这项工作。落盘 `.hapilon/handoff/<slug>-<时间戳>.md`——目录不存在就创建；仓库有 `.gitignore` 就确认 `.hapilon/` 已被忽略。用户点名位置就用点名的。不在 git 仓库时才回落系统临时目录。

要求：

- 文档带一节「建议技能」：接手的 agent 该唤起哪些 skill。
- 别复述其他产物（spec、计划、ADR、issue、commit、diff）已有的内容——用路径或 URL 引用。
- 敏感信息（API key、密码、个人身份信息）一律抹除。
- 用户传了参数时，把参数当作下一会话的聚焦点，文档围绕它裁剪。
