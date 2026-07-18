# TODO 清单

> 当前任务：hpl-floating-pane 通用浮层组件 + hpl-panel-viewer 折叠面板查看器

---

## [~] TODO-18：hpl-floating-pane 通用浮层组件 + hpl-panel-viewer

### 目标

借鉴 pi-pop 的产品级设计，创建通用 floating-pane 组件（src/shared/floating-pane.ts），重构 /context 使用它，并新建 hpl-panel-viewer 折叠面板浮动查看器。

### 实现要点

| 项目 | 内容 |
|------|------|
| FloatingPane | 通用组件，Unicode 边框(╭─╮│╰─╯) + 滚动(↑↓/PgUp/PgDn/Home/End) + 长行换行(wrapTextWithAnsi) |
| 渲染方式 | `ctx.ui.custom()` + overlay: true，anchor: "center"，width: "90%"，maxHeight: "85%" |
| /context 重构 | 删除 overlay.ts，handler 改为 FloatingPane.show(ctx, options) |
| hpl-panel-viewer | /pop 命令 + Shift+Alt+↓ 快捷键，从 session entries 提取面板 |
| 参考 | pi-pop (viewer.ts 渲染) + overlay-qa-tests (BaseOverlay.box()) |

### 验收标准

- [ ] FloatingPane.show() 显示 Unicode 边框浮层 + ↑↓ 滚动 + Esc 关闭
- [ ] /context 使用 FloatingPane，功能不变，overlay.ts 已删除
- [ ] /pop 命令弹出面板查看器，← → 切换面板
- [ ] 全量测试通过
- [ ] 详细计划：`_plans/hpl-floating-pane.md`
