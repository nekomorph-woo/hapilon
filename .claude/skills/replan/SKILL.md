---
name: replan
description: 启动 replan agent 探索代码库并制定实现计划，输出到 _hapilon_plans/ 目录。Use when 需要制定计划、设计方案、规划架构，或提到 "replan" / "制定计划" / "出个计划"。
---

# Replan

启动 replan agent，探索代码库、设计方案，将结构化计划写入 `_hapilon_plans/` 目录。

## 工作流程

1. 使用 Agent 工具启动 `replan` agent（`subagent_type: "replan"`）
2. 将用户的请求原样传递给 agent
3. agent 探索代码库后，将计划文件写入 `_hapilon_plans/<描述>.md`
4. 将 agent 输出的计划摘要展示给用户
