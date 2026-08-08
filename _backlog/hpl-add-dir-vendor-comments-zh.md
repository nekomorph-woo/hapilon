# hpl-add-dir vendor 源码注释中文化

## 背景

hpl-add-dir vendor 自 pi-add-dir v1.3.1（#29）。上游源码注释为英文，与 `b3oy1-conversation-style.md`「代码注释用简体中文」规则冲突。code-review（2026-08-09，feat/afk-trio）将其列为硬违规；关键改造路径已中文注释，vendor 保留部分未动。

## 目的

统一 hpl-add-dir 三个文件（index.ts / context.ts / suggestions.ts）的注释语言为简体中文，消除风格违规。

## 技术债描述

- `suggestions.ts`（~950 行）vendor 原样保留的英文 docstring 与 section 注释（约 60-80 处）
- `index.ts` / `context.ts` 中从上游保留的英文注释（widget、commands、tools 相关段落）

## 参考引用

- `.claude/rules/b3oy1-conversation-style.md` — Language 规则
- code-review report（Standards 轴，2026-08-09）

## 项目中指向的位置

- `src/extensions/hpl-add-dir/index.ts`
- `src/extensions/hpl-add-dir/context.ts`
- `src/extensions/hpl-add-dir/suggestions.ts`
