# ctrl+o 快捷键列表硬编码漂移

## 背景

`hpl-startup-header` 在 ctrl+o 展开模式下显示常用键盘快捷键列表（esc 中断、ctrl+c 清屏、`/` 命令 等）。这些快捷键文本是**写死在 `content.ts` 的 `buildRightColumn()` 中**的。

Pi 支持用户通过 settings 自定义 keybinding 映射，当用户重绑键位后，header 显示的快捷键提示会与实际绑定的键位**不一致**（漂移问题）。

## 目的

确保 header 中展示的快捷键始终与 Pi 实际生效的 keybinding 配置一致，避免误导用户。

## 描述

| 项目 | 内容 |
|------|------|
| 类型 | 技术债 |
| 当前状态 | `buildRightColumn()` 硬编码 10 条快捷键文本。Pi 的 `keyHint` 辅助函数是内部私有实现（`interactive-mode.js` 内部），无法从扩展读取用户 keybinding 配置 |
| 预期用途 | Pi 暴露 keybinding 查询 API 后，读取实际键位映射动态生成快捷键列表。或探索能否通过 `pi.registerShortcut` 反向查询已注册快捷键文本 |
| 创建时间 | 2026-07-19 |

## 参考引用

- `interactive-mode.js:502-524` — Pi 内置 header 的 `keyHint()` / `rawKeyHint()` 实现（私有）
- `types.d.ts:878` — `pi.registerShortcut()` API（注册方向，无法查询）
- `content.ts:buildRightColumn()` — 硬编码位置

## 项目位置

- **定义**: `src/extensions/hpl-startup-header/content.ts` — `buildRightColumn()` expanded 分支
- **上游**: `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:503-531`
