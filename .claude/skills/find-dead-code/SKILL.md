---
name: find-dead-code
description: 启动 dead-code-finder agent 分析 git diff 变更中的死代码。Use when 需要检测死代码、清理无用代码，或提到 "find-dead-code" / "死代码" / "dead code"。
---

# Find Dead Code

启动 dead-code-finder agent，仅分析 `git diff`（未 staged）+ `git diff --cached`（已 staged）变更范围内的死代码。

## 工作流程

1. 使用 Agent 工具启动 `dead-code-finder` agent（`subagent_type: "dead-code-finder"`）
2. agent 自动执行 `git diff` 和 `git diff --cached` 获取变更
3. agent 逐文件检测死代码模式并输出报告
4. 将 agent 检测结果展示给用户
