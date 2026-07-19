# pi-tui devDependency → runtime import 技术债

## 背景

`@earendil-works/pi-tui` 目前是 hapilon 的 devDependency，但在运行时多个扩展通过 import 引用其 API：

- `src/extensions/hpl-panel-viewer/pane.ts` — `wrapTextWithAnsi`, `truncateToWidth`
- `src/extensions/hpl-startup-header/content.ts` — `TUI` 类型导入（虽然只是类型，但 import 语句仍需包存在）
- `src/shared/floating-pane/pane.ts` — `wrapTextWithAnsi`

## 目的

确保 hapilon 以 npm 包形式分发时，`pi-tui` 作为 runtime dependency 被正确安装，避免 `ERR_MODULE_NOT_FOUND` 运行时崩溃。

## 描述

| 项目 | 内容 |
|------|------|
| 类型 | 技术债 |
| 当前状态 | `pi-tui` 在 `devDependencies`，但运行时被 import。当前能工作是因为 dev 环境 `node_modules` 中存在该包。以 npm 包分发给用户时可能缺失 |
| 预期用途 | 将 `@earendil-works/pi-tui` 移至 `dependencies`（或确认 Pi coding-agent 已将其作为 dependency 传递安装） |
| 创建时间 | 2026-07-19 |

## 参考引用

- `package.json` dependencies 段
- 本扩展 (`hpl-startup-header`) 沿用 `floating-pane/pane.ts` 已有的 runtime import 先例

## 项目位置

- **使用**: `src/shared/floating-pane/pane.ts:9` — `await import("@earendil-works/pi-tui")`
- **使用**: `src/extensions/hpl-panel-viewer/pane.ts:9` — 同上
- **使用**: `src/extensions/hpl-startup-header/content.ts:7` — `import type { TUI }`
- **定义**: `package.json` devDependencies
