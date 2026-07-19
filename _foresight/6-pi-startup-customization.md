# Pi Floating Pane — overlay 浮层方案预研

> 一句话概括：pi-tui 提供了一套完整的 overlay API（`ctx.ui.custom` + `OverlayOptions` + `OverlayHandle`），Pi 官方有 overlay-qa-tests 示例，@ozancakir/pi-pop 展示了实际产品级用法。我们可以借鉴它们，提取一个 hapilon 通用的 floating pane 组件，让所有需要弹窗展示内容的场景（/context、确认框、详情查看）都能复用。

## 核心概念

### Pi TUI 渲染模型

Pi 渲染到**普通终端缓冲区**（不是 alternate screen），所以 scrollback、copy、search 保持可用。代价是：re-draw 会 snap viewport 到底部。

**Overlay 解决这个问题**：在正常渲染层之上叠加一层独立的 UI，不接触底层 conversation 的绘制，因此不会触发 scroll snap。

```
┌──────────────────────────────────────┐
│  Header / Notifications              │  ← Pi 内置，不受 overlay 控制
├──────────────────────────────────────┤
│                                      │
│  Main Content (Conversation + Editor) │  ← 正常渲染
│                                      │
│     ┌──────────────────────┐         │
│     │  Overlay Layer       │         │  ← 独立的浮层
│     │  (ctx.ui.custom)     │         │
│     └──────────────────────┘         │
│                                      │
├──────────────────────────────────────┤
│  Footer                             │  ← Pi 内置/hpl-footer
└──────────────────────────────────────┘
```

**关键限制**：overlay 覆盖 Main Content 区域，但 Pi 的 Header（更新通知、系统消息）和 Footer 在 overlay 的 z-order 之外。这不是 bug，是 Pi 的 overlay 架构决定的——overlay 附加到 TUI Container 的 overlayStack 上，而 Header/Footer 是 Container 之外的独立组件。

### 三层 overlay 机制

Pi 提供了三种使用 overlay 的方式：

| 层级 | API | 用途 | 焦点 |
|------|-----|------|------|
| 高层（推荐） | `ctx.ui.custom()` + `{ overlay: true }` | 扩展开发者的快捷入口 | 自动管理 overlay 生命周期 |
| 中层 | `ctx.ui.custom()` + `{ overlay: true }` + `overlayOptions` | 精确定位/尺寸 | 同上 + 位置控制 |
| 底层 | `tui.showOverlay()` + `OverlayHandle` | 多面板管理、focus 路由 | 手动管理 |

### OverlayOptions 全参数

```typescript
interface OverlayOptions {
  width?: number | `${number}%`;     // 宽度（列数或百分比）
  minWidth?: number;                  // 最小宽度
  maxHeight?: number | `${number}%`;  // 最大高度
  anchor?: 'top-left' | 'top-center' | 'top-right'
         | 'left-center' | 'center' | 'right-center'
         | 'bottom-left' | 'bottom-center' | 'bottom-right';
  offsetX?: number;                   // 水平偏移
  offsetY?: number;                   // 垂直偏移
  row?: number | `${number}%`;       // 绝对行位置
  col?: number | `${number}%`;       // 绝对列位置
  margin?: number | { top, right, bottom, left };  // 边距
  visible?: (termWidth, termHeight) => boolean;    // 响应式显示
  nonCapturing?: boolean;             // 不捕获焦点（passive panel）
}
```

9 个 anchor 点覆盖所有定位需求。百分比支持响应式布局。

### OverlayHandle（底层控制）

```typescript
interface OverlayHandle {
  setHidden(hidden: boolean): void;   // 切换显示/隐藏
  focus(): void;                      // 聚焦该 overlay
  unfocus(): void;                    // 取消聚焦
  isFocused(): boolean;               // 是否聚焦
  hide(): void;                       // 永久关闭
  isHidden(): boolean;                // 是否隐藏
}
```

### Component 接口（你的 overlay 需要实现）

```typescript
interface Component {
  render(width: number): string[];    // 渲染行数组
  invalidate(): void;                 // 清除缓存
  handleInput?(data: string): void;   // 键盘输入
  isFocusable?: boolean;              // 是否可聚焦
  dispose?(): void;                   // 清理资源
}
```

## pi-pop 的实现方式

pi-pop（@ozancakir/pi-pop v0.1.2）是一个"浮动面板阅读器"，核心理念是：

- **不修改 conversation**：展示面板内容而不展开它，避免 scroll snap
- **注册了定制 tool**（`pi-pop-show`、`pi-pop-config`）让 LLM 可以程序化打开面板
- **注册了 slash command**（`/pop`、`/pop-config`）供用户直接使用
- **注册了键盘快捷键**（Shift+Alt+↓ / Ctrl+Q）

pi-pop 的 overlay 内部实现了：
- 面板列表导航（← → 切换面板）
- 内容滚动（↑ ↓ / mouse wheel / PgUp PgDn）
- 面板行数上限（maxlines 配置）
- 显示/隐藏规则（show/hide 正则匹配）

**对 hapilon 的启示**：
- pi-pop 专注于"读取 collapsed panel"这个单一场景
- 它的 overlay 逻辑（导航、滚动、配置）是场景特定的
- 但它证明了 `ctx.ui.custom()` + `OverlayHandle` 可以实现产品级的 floating pane

## Pi 官方 overlay-qa-tests.ts

Pi 仓库的 `examples/extensions/overlay-qa-tests.ts` 是一个**官方 overlay QA 测试套件**，证明了 overlay API 的完整能力：

| 测试命令 | 演示的能力 |
|----------|-----------|
| `/overlay-animation` | 30 FPS 实时动画（证明可以做游戏级渲染） |
| `/overlay-anchors` | 9 个 anchor 位置遍历 |
| `/overlay-margins` | margin + offset 定位 |
| `/overlay-stack` | 3 层 overlay 堆叠 |
| `/overlay-overflow` | 流式输出 + 滚动 |
| `/overlay-edge` | 边缘定位 |
| `/overlay-percent` | 百分比定位 |
| `/overlay-maxheight` | 内容截断 |
| `/overlay-sidepanel` | 响应式面板（`visible` callback） |
| `/overlay-toggle` | `OverlayHandle.setHidden()` 切换 |
| `/overlay-passive` | `nonCapturing` 被动面板 |
| `/overlay-focus` | focus 循环 + 逐面板 dismiss |
| `/overlay-streaming` | 多输入面板 + Tab 切换焦点 |

### BaseOverlay 模式

官方 QA 代码使用了一个 `BaseOverlay` 抽象类，包含：

```typescript
abstract class BaseOverlay {
  protected theme: Theme;
  
  // Box 边框渲染工具（用 Unicode 边框字符 + theme color）
  protected box(lines: string[], width: number, title?: string): string[] { ... }
  
  invalidate(): void {}
  dispose(): void {}
}
```

这是我们提取通用 FloatingPane 组件的直接参考——`box()` 方法提供标准的边框渲染。

### 键盘处理

官方 QA 使用 `matchesKey(data, "escape")`、`matchesKey(data, "tab")` 等处理键盘输入。`matchesKey` 是 pi-tui 的跨平台键盘匹配工具，自动处理不同终端（Kitty、iTerm2、Windows Terminal）的 key sequence 差异。

## 可以借鉴的方向

### 提取 hapilon FloatingPane 通用组件

当前我们的 `ContextOverlay`（`src/extensions/hpl-context-viewer/overlay.ts`）只服务于 /context 一个场景。参考 pi-pop 和 overlay-qa-tests，可以提取一个通用组件：

```typescript
// 愿景：src/shared/floating-pane.ts
export interface FloatingPaneOptions {
  title: string;
  lines: string[];                           // 内容行
  width?: number | string;                   // 默认 "auto"
  maxHeight?: number | string;               // 默认 80%
  anchor?: OverlayAnchor;                    // 默认 "center"
  onClose?: () => void;                      // 关闭回调
  footer?: string;                           // 底部提示（如 "Press Esc to close"）
}

export class FloatingPane extends BaseOverlay {
  // 复用 BaseOverlay 的 box() 渲染
  // 自动处理 Esc 关闭
  // 内容超出 maxHeight 时自动截断
}
```

使用方式：
```typescript
// 在任意 command handler 中：
await FloatingPane.show(ctx, {
  title: "Context Usage",
  lines: renderContextLines(snapshot),
  width: "80%",
});
```

### 改进当前 /context overlay

1. **使用 `anchor` 而非全屏**：`anchor: "center"` + `width: "80%"` + `maxHeight: "80%"` 更美观
2. **使用 `BaseOverlay.box()`**：Unicode 边框让 overlay 更专业
3. **不尝试覆盖 Header/Footer**：接受 Pi overlay 的架构限制，在 Main Content 区域内居中显示

### /context 可以走的方向

| 方向 | 描述 | 复杂度 |
|------|------|--------|
| A. 修复当前 overlay | anchor: center + box() 边框 + 内容滚动 | 低 |
| B. 提取通用 FloatingPane | 给 /context 和其他场景复用 | 中 |
| C. 用 `nonCapturing` + `tui.showOverlay` | 类似 pi-pop 的持久化被动面板 | 高 |

## 与本项目的关系

hapilon 已有：
- `hpl-context-viewer` + `ContextOverlay` — 第一个 overlay 尝试
- `hpl-footer` — footer 定制（与 overlay 互补）
- `_foresight.md` — Pi TUI API 全景文档

**建议路线**：
1. 修复 /context overlay（方案 A）→ 让它好看
2. 提取 FloatingPane 通用组件 → 所有弹窗场景复用
3. 后续需要 persistent panel（如持续监控 token 用量）时用 `nonCapturing` overlay

## 常见陷阱

| 陷阱 | 说明 |
|------|------|
| **overlay 不能覆盖 Header/Footer** | Pi 的 overlay 在 Container 的 overlayStack 上，Header/Footer 是 Container 之外的独立渲染区域。不要试图用 `width: "100%"` + `maxHeight: "100%"` 全屏覆盖——这会与 Pi 的更新通知、footer 产生 z-order 冲突 |
| **`_tui: unknown` 导致类型丢失** | pi-tui 有嵌套依赖，直接 import 会类型冲突。官方 overlay-qa-tests.ts 的做法是 import `TUI` from `@earendil-works/pi-tui`，依赖拓扑正确。我们的问题是 pi-tui 没装在顶层 node_modules |
| **`ctx.ui.custom()` vs `tui.showOverlay()`** | 前者自动管理 overlay 生命周期（关闭时自动移除），后者返回 `OverlayHandle` 需手动管理。简单场景用前者，多面板/被动面板用后者 |
| **`nonCapturing: true` 不处理输入** | non-capturing overlay 默认不接收键盘事件——需要手动 `focus()` 才能接收。被动信息面板不需要交互时用 nonCapturing |
| **`render(width)` 返回的行数不能超过 `maxHeight`** | 超过会被截断（没有自动滚动）。需要滚动能力时在组件内部维护 scrollOffset |
| **TypeScript 需要 pi-tui 作为直接依赖** | 在 `npm install --save-dev @earendil-works/pi-tui@^0.80.8` 后才能正常 import Component/TUI 等类型 |

## 参考资源

- [Pi overlay-qa-tests.ts 源码](https://github.com/earendil-works/pi/blob/master/packages/coding-agent/examples/extensions/overlay-qa-tests.ts) — 官方 13 种 overlay 场景的完整示例
- [@ozancakir/pi-pop](https://pi.dev/packages/@ozancakir/pi-pop?name=pane) — 产品级 floating pane 扩展（面板阅读器）
- [pi-pop GitHub](https://github.com/ozancakir/pi-pop) — 源码仓库
- [Pi TUI Extension API 预研](_foresight/5-pi-tui-extension-apis.md) — 本项目的 Pi TUI API 全景文档
- [Pi Context Organization 预研](_foresight/4-pi-context-organization.md) — Pi 上下文管理机制
- `hapilon/src/extensions/hpl-context-viewer/overlay.ts` — 当前 /context overlay 实现
