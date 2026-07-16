---
name: write-changelog
description: 解析根目录 _todo.md 中 TODO-* 已完成条目，追加人类可读的 CHANGELOG 到 _CHANGELOG-alpha.md。Use when 用户说"生成 changelog"、"更新 changelog"、"记录进度"、"记日志"。
---

# Write Changelog

将 `_todo.md` 中已完成的 TODO 条目追加到 `_CHANGELOG-alpha.md`。

## 运行方式

```bash
python3 .claude/skills/write-changelog/scripts/run.py >> _CHANGELOG-alpha.md
```

脚本从 `_todo.md` 提取所有标记为 `[x]` 的 TODO-* 条目，为每个条目生成一行 CHANGELOG。运行后，将已完成的 TODO 从 `[x]` 改为 `[~]`（表示已入 changelog）。

## 格式

```
YYYY-MM-DD HH:MM: <一句话中文描述>
```

示例：

```
2026-07-12 01:30: 完成 hapilon v0.1.0-alpha 最小试验版本——创建 TypeScript CLI 入口，打印版本标识后 spawn pi-coding-agent TUI 交互控制台
```

## 检查清单

- [ ] 运行 `python3 .claude/skills/write-changelog/scripts/run.py >> _CHANGELOG-alpha.md`
- [ ] 确认 `_CHANGELOG-alpha.md` 已追加新条目
- [ ] 确认 `_todo.md` 中对应 TODO 已从 `[x]` 变为 `[~]`
