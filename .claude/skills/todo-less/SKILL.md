---
name: todo-less
description: 基于 PRD 和 CHANGELOG，重新梳理待办清单并写入 _todo.md。Use when 用户说"重新规划 todo"、"刷新任务清单"、"重新整理 todo"、"我想下一步做什么"。
---

# Todo Lesson

从 PRD 和 CHANGELOG 中沉淀经验，重新规划下一步待办任务。

## 工作流程

### 1. 探索 PRD

使用 `/look` 探索 `Hapilon-PRD-v1.1.md`，重点关注：

- **版本路线**（第 16 章）— 当前完成到哪个版本、下一版本要做什么
- **MVP 验收标准**（第 15.9 节）— 已完成/未完成的项目
- **功能需求**（第 9 章）— 各模块描述与优先级
- 提取关键信息后，**在控制台用 look SKILL 的结构化格式展示结果**

### 2. 查阅 CHANGELOG

如果 `_CHANGELOG-alpha.md` 非空：

- 从步骤 1 提取的关键内容（如版本号、模块名）作为线索
- 使用 `/look` 探索 `_CHANGELOG-alpha.md`，寻找已记录的进度
- **在控制台用 look SKILL 的结构化格式展示结果**

如果 `_CHANGELOG-alpha.md` 不存在或为空，跳过此步骤。

### 3. 编排 TODO

综合步骤 1 和 2 的发现，确定"下一件最重要的事"为新的 TODO。

**优先级原则**：按 PRD 版本路线顺序推进，当前版本未完成项优先。

### 4. 写入 _todo.md

清空当前 `_todo.md`，按以下模板写入：

```markdown
# Hapilon 实施任务清单

> 基于 [Hapilon-PRD-v1.1.md](./Hapilon-PRD-v1.1.md) 提取

---

## [ ] TODO-NNN：<任务标题>

### 来源

PRD 第 X 章「...」

### 目标

<一句话目标描述>

### 实现要点

| 项目 | 内容 |
|------|------|
| ... | ... |

### 验收标准

- [ ] <标准 1>
- [ ] <标准 2>
```

保持当前 `_todo.md` 的格式风格。每个 TODO 对应一个明确可交付的增量。

## 检查清单

- [ ] `/look` 已探索 PRD 版本路线和功能需求
- [ ] `/look` 已探索 CHANGELOG（存在且非空时）
- [ ] look 结果已结构化展示到控制台
- [ ] `_todo.md` 已清空并写入新 TODO
