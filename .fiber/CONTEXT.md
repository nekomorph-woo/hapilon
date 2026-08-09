# Hapilon 领域上下文（CONTEXT.md）

> 单一真相源：术语与领域知识在此定义，其他地方引用不重复。协议结构头（wayfinder 的 ## Question 等）不翻译。

## 领域定位

Hapilon 是以 Pi Coding Agent（`@earendil-works/pi-coding-agent` + `pi-tui`）为内核的终端 Coding Agent——薄封装 + 扩展层。所有能力通过 Pi 扩展 API（`ExtensionAPI`）构建，`src/extensions/` 下以 `hpl-*` 命名，`discoverExtensions()` 自动发现并以 `-e` 注入。

## Glossary

| 术语 | 含义 |
|------|------|
| **Pi 内核** | pi-coding-agent + pi-tui（monorepo 同步发版，版本号一致）；升级时双包同升，依赖面自动对齐，无需 overrides |
| **hpl-* 扩展** | hapilon 自有扩展（`src/extensions/hpl-*`），一个目录一个扩展，`index.ts` 入口 + 职责文件 |
| **受控上下文** | hapilon 的上下文模型：`--no-context-files --no-skills` 关闭内核任意目录 AGENTS.md/CLAUDE.md 自动识别，改由 HAPILON.md + rules + hpl-context 受控收集接管 |
| **HAPILON.md** | hapilon 的约定文件（AGENTS.md 的 hapilon 版），hpl-system-prompt 从 cwd 向上收集并每轮注入；外部目录的 HAPILON.md 由 hpl-add-dir 注入 |
| **hpl-add-dir** | vendor 自 pi-add-dir 的目录管理扩展：只注入外部目录 HAPILON.md（AGENTS.md/CLAUDE.md 不注入、外部 skills 不注册——遵守受控上下文） |
| **集成分支 A** | destination worktree 的共享集成目标（fork 自 main），feature → A 由 AI 自行 merge，A → main 走 PR（human-only merge） |
| **throwaway / destination** | 两层 worktree 约定：原型/研究产出 throwaway（验证后提取决策删除），实现产出 destination（PR 上主分支） |

## TUI 布局踩坑（#27，重要）

**多行块（logo / banner / 图形）居中必须整体共享 pad，不能逐行独立居中。**

- **现象**：改变终端宽度时首屏 logo 行间错位变形
- **根因**：`centerLines` 对每行独立计算 `Math.floor((maxWidth - line.length) / 2)`——多行块各行长度不同时，取整余数随 maxWidth 变化 → 行间相对位置 ±1 列抖动 → 图形散架
- **修复**：首部连续非空行视为「块」，共享同一 pad（`centerLines` 块感知，`content.ts`）
- **检查清单**：任何多行图形/文本块在宽度自适应布局中，必须验证 resize 后行间相对位置不变（单测断言：`inner41 === inner40`）
- **相关**：象限字符（▗▖▐▛█▜▌▝▘，U+2580-259F）是 East Asian Ambiguous——跨终端渲染宽度可能不同；图形类 logo 优先用确定宽度字符

## 版本知识

- pi-coding-agent / pi-tui 同步发版：0.84.1 起依赖面自动对齐（pi-coding-agent 依赖 `pi-tui ^0.84.x`），**无需 overrides**（0.80.10 时代的 overrides 已移除，#26）
- 0.80 → 0.84 的 breaking 集中在 pi-ai / pi-agent-core / 自定义 provider 面，hapilon 不触及；`session_switch` / `session_fork` 事件在 0.80-0.84 均不存在（扩展注册会类型报错，勿用）
- registerTool 的 parameters 用 JSON Schema 字面量（hapilon 惯例），不依赖 typebox 包
