# Pi Coding Agent TUI 扩展方案

> 一句话概括：Pi 提供了一套完整的终端 UI 框架（pi-tui）和丰富的扩展 API，可以定制 footer、header、widget、编辑器、自动补全、消息渲染、叠加层等几乎所有可见元素。理解这套方案才能让 hapilon 的 TUI 体验从"能用"变成"专属"。

## 核心概念

### 三层架构

Pi 的 TUI 体系分三层：

```
┌──────────────────────────────────────────────────┐
│  应用层 (pi-coding-agent)                         │
│  AgentSession → Modes (interactive/print/rpc)     │
│  → Extensions → ctx.ui API                       │
├──────────────────────────────────────────────────┤
│  TUI 框架层 (pi-tui)                              │
│  TUI 主容器 → 组件 (Text/Editor/SelectList...)     │
│  → 差分渲染 → Overlay 系统                        │
├──────────────────────────────────────────────────┤
│  终端抽象层                                       │
│  ProcessTerminal / VirtualTerminal                │
│  → CSI 2026 同步输出 → Kitty 键盘协议              │
└──────────────────────────────────────────────────┘
```

- **pi-tui**：独立的终端 UI 框架（可脱离 Pi 单独使用），提供差分渲染、组件树、overlay 系统
- **pi-coding-agent**：在 pi-tui 之上构建的 Agent 应用，将 LLM 交互包装为 TUI 体验
- **Extensions**：通过 `ctx.ui` 和 `pi-tui` 组件 API 定制 TUI 的每个部分

### ctx.ui vs pi-tui

| 层级 | 接口 | 用途 |
|------|------|------|
| `ctx.ui` | 高级 API | 设置 footer/header/widget/editor、弹出对话框、通知 |
| `pi-tui` | 低级 API | 直接创建组件 (Box/Text/Input/...)、控制渲染、处理键盘 |

简单需求用 `ctx.ui`，复杂自定义 UI（如游戏、自定义编辑器）需要直接操作 `pi-tui` 组件。

## 主要 TUI 扩展 API 全景

### 一、持久化 UI 区域（set* 系列）

这些 API 替换 Pi 内置的对应 UI 区域，效果持续整个 session。

#### 1. ctx.ui.setFooter(factory) — 状态栏全量接管

替换终端底部的 3 行状态栏。**这是 hapilon 目前最核心的定制点。**

```
┌─────────────────────────────────────────────────┐
│  第1行: cwd │ git branch                        │  ← 工作目录 + 分支
│  第2行: up.2k ↓1k │ ctx 41%/1M │ [DING]  模型   │  ← 用量 + 模型
│  第3行: 扩展状态文本                               │  ← ctx.ui.setStatus()
└─────────────────────────────────────────────────┘
```

```typescript
ctx.ui.setFooter((tui, theme, footerData) => {
  // footerData 是 Pi 内部暴露给 footer 的专属数据源
  const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

  return {
    dispose: unsubscribe,     // session 结束时清理
    invalidate() {},          // 缓存失效回调
    render(width: number): string[] {
      // 每个 render 返回字符串数组，一行一个元素
      // 必须 <= 3 行（Pi footer 固定 3 行高度）
      const branch = footerData.getGitBranch();
      const statuses = footerData.getExtensionStatuses(); // Map<string, string>
      return [/* 第1行 */, /* 第2行 */, /* 第3行 */];
    },
  };
});

// 恢复内置 footer
ctx.ui.setFooter(undefined);
```

**footerData 暴露的专属数据**：
| 方法 | 返回 | 说明 |
|------|------|------|
| `getGitBranch()` | `string \| undefined` | 当前 Git 分支名（Pi 内部异步获取） |
| `getExtensionStatuses()` | `Map<string, string>` | 所有扩展通过 `setStatus()` 设置的状态 |
| `onBranchChange(cb)` | 取消订阅函数 | 分支变更时触发（文件编辑后 Pi 重新检测） |

**与 ctx 通用数据的区别**：`ctx.sessionManager.getCwd()`、`ctx.model.id`、`ctx.getContextUsage()` 在 footer 回调内仍然可用——但 footer 的 `render()` 可能在 agent 未运行时被调用，此时 `ctx` 仍然有效（footer 是 session 级持久组件）。

**关键约束**：
- footer 固定 3 行高度，返回超 3 行会被截断
- `render(width)` 参数是终端当前宽度（列数），用于自适应布局
- 每行必须 ≤ width（用 `truncateToWidth()` 确保）
- ANSI 真彩码在行末会自动 reset，跨行样式需每行独立设置

**来源**：`custom-footer.ts` 示例 + hapilon 已实现的 `hpl-footer/index.ts`

#### 2. ctx.ui.setHeader(factory) — 替换启动 Logo

替换 Pi 启动时显示的 ASCII logo + 快捷键提示。

```typescript
ctx.ui.setHeader((tui, theme) => ({
  render(width: number): string[] {
    return [
      "╔══════════════════════════════╗",
      "║     Welcome to hapilon!      ║",
      "╚══════════════════════════════╝",
    ];
  },
  invalidate() {},
}));

// 恢复内置 header
ctx.ui.setHeader(undefined);
```

- header 没有 dispose（不需要清理订阅）
- 返回 `undefined` 恢复 Pi 内置 logo
- pi-powerline-footer 用此 API 显示品牌 splash screen

**来源**：`custom-header.ts` 示例

#### 3. ctx.ui.setWidget(key, content, options?) — 编辑器周围的持久区块

在编辑器上方或下方显示信息条，自动显示/隐藏。

```typescript
// 简单字符串数组模式（静态内容）
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"]);

// 完整组件模式（动态更新）
ctx.ui.setWidget("my-widget", (tui, theme) => {
  let widgetTui = tui;
  return {
    render: () => renderWidget(theme),  // 返回 string[]
    invalidate: () => {},
    dispose: () => { widgetTui = null; },
  };
});

// 放置在编辑器下方
ctx.ui.setWidget("my-widget", [...], { placement: "belowEditor" });

// 移除
ctx.ui.setWidget("my-widget", undefined);
```

**placement 选项**：
| 值 | 位置 |
|----|------|
| `"aboveEditor"`（默认） | 编辑器上方 |
| `"belowEditor"` | 编辑器下方 |

**用途示例**：CI 状态监控、后台任务进度、快捷键提示条。

**来源**：`widget-placement.ts` 示例 + Joel Claw 博客的实际 widget 案例

#### 4. ctx.ui.setStatus(key, text) — 状态文本

在 footer 第 3 行显示持久状态文本。多个扩展各自独立。

```typescript
// 设置状态
ctx.ui.setStatus("my-ext", theme.fg("dim", "Ready"));

// 更新
ctx.ui.setStatus("my-ext", theme.fg("accent", "●") + " Turn 3...");

// 清除
ctx.ui.setStatus("my-ext", undefined);
```

- key 是扩展自己的标识，不同扩展不冲突
- pi-powerline-footer 支持将 status 提升为独立 powerline 段（`customItems`）
- footer 内通过 `footerData.getExtensionStatuses()` 读取

**来源**：`status-line.ts` 示例 + pi-powerline-footer `customItems` 功能

#### 5. ctx.ui.setEditorComponent(factory) — 自定义编辑器

完全替换输入编辑器（默认是简单的多行文本输入框）。

```typescript
import { CustomEditor } from "@earendil-works/pi-coding-agent";

class ModalEditor extends CustomEditor {
  private mode: "normal" | "insert" = "insert";

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.mode = "normal";
      return;
    }
    super.handleInput(data);  // 委托给内置编辑器
  }

  render(width: number): string[] {
    const lines = super.render(width);
    // 在底部边框添加模式指示器
    lines[lines.length - 1] += " NORMAL ";
    return lines;
  }
}

ctx.ui.setEditorComponent((tui, theme, kb) => new ModalEditor(tui, theme, kb));
```

**关键基类 `CustomEditor`**：
- 继承它获得内置编辑器的所有功能（多行、历史、提交、粘贴处理）
- 覆盖 `handleInput()` 拦截/修改键盘输入
- 覆盖 `render()` 修改渲染输出
- `this.getText()` 读取当前文本
- `this.tui.requestRender()` 触发重绘

**用途示例**：
- vim 模式编辑器（`modal-editor.ts`）
- 彩虹文字动画（`rainbow-editor.ts`）
- 自定义自动补全集成

**来源**：`modal-editor.ts` + `rainbow-editor.ts` 示例

#### 6. ctx.ui.setHiddenThinkingLabel(label?) — 折叠思考块标签

当用户按 Ctrl+T 折叠思考块时，显示的自定义文字。

```typescript
ctx.ui.setHiddenThinkingLabel("Pondering...");

// 恢复默认
ctx.ui.setHiddenThinkingLabel();
```

**来源**：`hidden-thinking-label.ts` 示例

#### 7. ctx.ui.setWorkingIndicator(options?) — 流式输出指示器

控制 streaming 时显示在输入区域的内联动画。

```typescript
// 自定义动画 spinner
ctx.ui.setWorkingIndicator({
  frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  intervalMs: 80,
});

// 静态标记
ctx.ui.setWorkingIndicator({ frames: ["●"] });

// 隐藏
ctx.ui.setWorkingIndicator({ frames: [] });

// 恢复默认
ctx.ui.setWorkingIndicator(undefined);
```

- `frames` 数组：每帧一个字符串（可含 ANSI 码），按 `intervalMs` 循环
- `intervalMs`：默认 120ms
- 传 `undefined` 恢复 Pi 内置 spinner

**来源**：`working-indicator.ts` 示例

#### 8. ctx.ui.setTitle(title) — 终端标题栏

修改终端窗口标题（支持 OSC 2 协议的终端）。

```typescript
// 显示 spinner 动画
let frameIndex = 0;
setInterval(() => {
  const frame = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"][frameIndex++ % 10];
  ctx.ui.setTitle(`${frame} π - myproject`);
}, 80);

// 恢复
ctx.ui.setTitle(`π - ${path.basename(process.cwd())}`);
```

**来源**：`titlebar-spinner.ts` 示例

#### 9. ctx.ui.addAutocompleteProvider(factory) — 自动补全

在编辑器中添加自定义补全源（Tab 触发）。

```typescript
ctx.ui.addAutocompleteProvider((current) => ({
  async getSuggestions(lines, cursorLine, cursorCol, options) {
    // 检测 #issue 模式
    const token = extractToken(lines[cursorLine], cursorCol);
    if (!token) return current.getSuggestions(lines, cursorLine, cursorCol, options);

    // 返回补全候选项
    return {
      items: [{ value: "#123", label: "#123", description: "Fix login bug" }],
      prefix: `#${token}`,
    };
  },
  applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
    return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  },
}));
```

**来源**：`github-issue-autocomplete.ts` 示例

---

### 二、交互式 UI（对话框/选择器/自定义组件）

这些 API 弹出临时 UI，获取用户输入后关闭。

#### 10. ctx.ui.confirm(title, body) → boolean

```typescript
const ok = await ctx.ui.confirm("危险操作", "确认执行 rm -rf / ?");
if (!ok) return { block: true };
```

返回 `Promise<boolean>`。

#### 11. ctx.ui.select(title, options) → selectedValue

```typescript
const choice = await ctx.ui.select("选择操作", [
  { value: "fix", label: "🔧 自动修复" },
  { value: "skip", label: "⏭️ 跳过" },
  { value: "abort", label: "🛑 中止" },
]);
```

#### 12. ctx.ui.input(title, placeholder?) → string

```typescript
const name = await ctx.ui.input("Session 名称", "输入名称...");
```

#### 13. ctx.ui.notify(message, level)

```typescript
ctx.ui.notify("Extension loaded!", "info");
ctx.ui.notify("Connection failed", "error");
```

level: `"info"` | `"warning"` | `"error"` | `"success"`

#### 14. ctx.ui.custom(componentFactory, options?) → T （⭐最强大）

创建**完全自定义**的交互组件——从简单菜单到完整游戏。

```typescript
const result = await ctx.ui.custom<{ action: string } | undefined>(
  (tui, theme, keybindings, done) => new MyComponent(theme, done),
  { overlay: true }  // 以 overlay 形式显示（浮在内容之上）
);
```

**componentFactory 参数**：
| 参数 | 类型 | 说明 |
|------|------|------|
| `tui` | `TUI` | pi-tui 主容器引用 |
| `theme` | `Theme` | 当前主题的颜色函数 |
| `keybindings` | `KeybindingsManager` | 键盘绑定管理器 |
| `done` | `(result) => void` | 调用此函数关闭组件并返回结果 |

**options**：
| 选项 | 说明 |
|------|------|
| `overlay: true` | 以 overlay 浮层显示（默认全屏接管） |
| `overlayOptions` | 传递给 `tui.showOverlay()` 的定位/尺寸选项 |

**组件必须实现的接口**：
```typescript
interface Component {
  render(width: number): string[];  // 每行不超过 width
  handleInput?(data: string): void;  // 键盘输入
  invalidate?(): void;              // 缓存失效
  dispose?(): void;                 // 组件销毁时清理
}

// 如需 IME 支持（中日韩输入法），额外实现 Focusable
interface Focusable {
  focused: boolean;  // TUI 自动设置
}
```

**来源**：`overlay-test.ts` + `question.ts` + `questionnaire.ts` + Joel Claw 博客

---

### 三、自定义渲染

#### 15. pi.registerMessageRenderer(customType, renderer)

控制自定义消息在对话中的显示方式。

```typescript
pi.registerMessageRenderer("status-update", (message, { expanded }, theme) => {
  const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
  box.addChild(new Text(`[INFO] ${message.content}`, 0, 0));
  return box;  // 返回 pi-tui 组件
});
```

- `expanded`：用户是否展开了折叠的消息（按 Enter 展开/折叠）
- 返回 `Component`（通常是 Box/Text 组合）

#### 16. pi.registerEntryRenderer(customType, renderer)

控制自定义 session entry 在 `/tree` 视图中的显示。

#### 17. Tool 渲染（registerTool 的 renderCall / renderResult）

在注册工具时指定渲染器，控制工具调用在对话历史中的紧凑显示：

```typescript
pi.registerTool({
  name: "my_tool",
  // ...
  renderCall(args, theme) {
    return new Text(theme.fg("toolTitle", `my_tool ${args.query}`), 0, 0);
  },
  renderResult(result, opts, theme) {
    return new Text(theme.fg("muted", result.content[0].text), 0, 0);
  },
});
```

---

### 四、pi-tui 组件库（低级 API）

当 `ctx.ui` 不够用时，直接使用 pi-tui 组件构建自定义 UI。

| 组件 | 用途 | 关键功能 |
|------|------|----------|
| **Text** | 多行文本 | 自动换行、内边距、背景色 |
| **TruncatedText** | 单行截断文本 | 超出宽度自动加省略号 |
| **Input** | 单行输入框 | 光标、水平滚动、提交事件 |
| **Editor** | 多行编辑器 | 自动补全、粘贴处理、高度自适应滚动 |
| **Markdown** | Markdown 渲染 | 标题/代码块/引用/列表语法高亮 |
| **Loader** | 加载动画 | Braille spinner |
| **CancellableLoader** | 可取消加载动画 | 带 AbortSignal，Escape 取消 |
| **SelectList** | 选择列表 | 键盘导航、过滤、滚动 |
| **SettingsList** | 设置面板 | 值循环、子菜单 |
| **Spacer** | 垂直间距 | 空行 |
| **Image** | 内联图片 | Kitty/iTerm2 图形协议，自动降级 |
| **Box** | 容器 + 背景色 | 内边距、动态背景 |
| **Container** | 子组件容器 | 组合多个组件 |
| **TUI** | 主容器 | 渲染循环、焦点管理、Overlay |

**Overlay 系统**：浮在现有内容之上，不替换内容。

```typescript
const handle = tui.showOverlay(component, {
  anchor: 'center',        // 定位锚点（9个方位）
  width: 60,               // 固定宽度
  width: "80%",            // 百分比宽度
  maxHeight: 20,           // 最大高度
  margin: 2,               // 距边缘留白
  visible: (w, h) => w >= 100,  // 响应式可见性
  nonCapturing: true,      // 不自动抢占焦点（passive overlay）
});

handle.hide();
handle.setHidden(true);   // 临时隐藏（可恢复）
handle.setHidden(false);  // 恢复显示
handle.focus();           // 获取焦点
handle.unfocus();         // 释放焦点
```

**来源**：`pi-tui/README.md` + `overlay-test.ts` + `overlay-qa-tests.ts`

---

### 五、生命周期事件中的 TUI 操作时机

| 事件 | 适合的 TUI 操作 |
|------|----------------|
| `session_start` | 设置 footer/header/widget/editor/autocomplete（仅此一次） |
| `before_agent_start` | 更新 footer status、注入 widget 提示信息 |
| `agent_start` | 显示"工作中"状态、启动 titlebar spinner |
| `turn_start` | 更新 turn 计数、进度指示 |
| `turn_end` | 更新统计信息、刷新 footer |
| `agent_end` / `agent_settled` | 桌面通知（OSC 777）、隐藏 spinner |
| `tool_call` | block 危险操作 + `ctx.ui.notify()` 警告 |
| `tool_result` | 更新 widget 状态 |
| `model_select` | 刷新 footer 模型名 |
| `session_shutdown` | 清理 timer/interval、恢复默认状态 |

---

### 六、Theme 系统

所有 UI 渲染都应使用 theme 颜色函数，而非硬编码 ANSI 码。

```typescript
// ✅ 正确：使用 theme
theme.fg("accent", text);
theme.fg("dim", text);
theme.fg("error", text);
theme.fg("success", text);
theme.fg("warning", text);
theme.fg("muted", text);
theme.fg("text", text);
theme.fg("border", text);
theme.bg("customMessageBg", text);
theme.bold(text);

// ❌ 错误：硬编码 ANSI
`\x1b[31m${text}\x1b[0m`;
```

**为什么重要**：用户切换主题时硬编码颜色不会跟随变化。`pi-powerline-footer` 支持 51 个 color token，通过 `theme.json` 自定义。

**例外**：ANSI 真彩码（如 `[DING]` 的渐变背景）因为 theme 系统不支持动态 RGB 计算，需要直接使用 `\x1b[48;2;R;G;Bm` 格式。

---

## 与本项目的关系

### hapilon 已实现的 TUI 扩展

| 扩展 | 使用的 API | 定制内容 |
|------|-----------|----------|
| **hpl-footer** | `setFooter()` + `footerData` | 全量接管 footer：cwd/branch、stats/[DING]/model、扩展状态 |
| **hpl-context** | `before_agent_start` (非 TUI) | 注入 HAPILON.md + rules 到 systemPrompt |
| **safety-gate** | `tool_call` + `confirm/notify` | 危险命令拦截 + 确认弹窗 |
| **protected-paths** | `tool_call` + `notify` | 保护路径写入拦截 |

### 尚未使用但有潜力的 TUI API

| API | 潜力 | hapilon 的可能用途 |
|-----|------|-------------------|
| `setHeader()` | 中 | 替换启动 Logo 为 hapilon 品牌标识 |
| `setWidget()` | **高** | 编辑器上方显示 [DING] 上下文占用条、活动技能列表、后台任务进度 |
| `setEditorComponent()` | 中 | 自定义 hapilon 风格的编辑器（vim 模式、快捷键提示） |
| `setWorkingIndicator()` | 低 | 自定义 streaming 动画风格 |
| `setHiddenThinkingLabel()` | 低 | 自定义思考块折叠标签 |
| `addAutocompleteProvider()` | **高** | `@hapilon` 前缀的文件/skill/TODO 引用自动补全 |
| `setTitle()` | 低 | 终端标题显示 session 名 + 项目名 |
| `custom()` + overlay | **高** | `/hapilon config` 设置面板、skill 浏览器、TODO 看板 |
| `registerMessageRenderer()` | 中 | 自定义安全警告消息的渲染样式 |
| Tool `renderCall/renderResult` | 中 | hapilon 自定义工具的紧凑显示 |

### pi-powerline-footer 的启示

pi-powerline-footer 是目前 Pi 生态最成熟的第三方 TUI 扩展。它的设计思路对 hapilon 很有参考价值：

1. **Presets 体系**：提供 default/minimal/compact/full 多种预设，用户 `/powerline <preset>` 切换
2. **customItems**：将 `setStatus()` 的内容提升为独立 powerline 段——hapilon 也可以用此模式让其他扩展的状态更显眼
3. **Layout 自定义**：`powerline.layout` 让用户自由排列段顺序
4. **Responsive**：宽终端显示更多段，窄终端自动折叠
5. **settings.json 集成**：所有配置持久化到 Pi 的 settings.json

hapilon 的 hpl-footer 目前是**单一固定布局**。未来可借鉴 presets + layout 模式做配置化。

---

## Pi TUI 扩展 API 速查表

### ctx.ui 完整 API

| 方法 | 参数 | 返回值 | 持久/临时 | 模式限制 |
|------|------|--------|-----------|----------|
| `setFooter(factory)` | `FooterFactory \| undefined` | void | 持久 | TUI only |
| `setHeader(factory)` | `HeaderFactory \| undefined` | void | 持久 | TUI only |
| `setWidget(key, content, opts?)` | `string, WidgetContent, WidgetOpts?` | void | 持久 | TUI only |
| `setStatus(key, text)` | `string, string \| undefined` | void | 持久 | TUI only |
| `setEditorComponent(factory)` | `EditorFactory \| undefined` | void | 持久 | TUI only |
| `setHiddenThinkingLabel(label?)` | `string \| undefined` | void | 持久 | TUI only |
| `setWorkingIndicator(opts?)` | `WorkingIndicatorOptions \| undefined` | void | 持久 | TUI only |
| `setTitle(title)` | `string` | void | 持久 | TUI only |
| `addAutocompleteProvider(factory)` | `(current) => AutocompleteProvider` | void | 持久 | TUI only |
| `confirm(title, body)` | `string, string` | `Promise<boolean>` | 临时 | TUI only |
| `select(title, items)` | `string, SelectItem[]` | `Promise<string>` | 临时 | TUI only |
| `input(title, placeholder?)` | `string, string?` | `Promise<string>` | 临时 | TUI only |
| `notify(msg, level?)` | `string, NotifyLevel?` | void | 临时 | 所有模式 |
| `custom(factory, opts?)` | `ComponentFactory, CustomOpts?` | `Promise<T>` | 临时 | TUI only |
| `theme` | — | `Theme` | — | TUI only |

### footerData 专属 API

| 方法 | 返回 | 说明 |
|------|------|------|
| `getGitBranch()` | `string \| undefined` | 异步获取（Pi 内部管理缓存） |
| `getExtensionStatuses()` | `Map<string, string>` | 所有 `setStatus()` 的实时快照 |
| `onBranchChange(cb)` | `() => void` (取消订阅) | 文件编辑/切换分支后触发 |

### pi-tui 关键导出

| 导出 | 类型 | 用途 |
|------|------|------|
| `Text` | class | 多行文本组件 |
| `TruncatedText` | class | 单行截断文本 |
| `Input` | class | 单行输入框 |
| `Editor` | class | 多行编辑器（Pi 的主输入框） |
| `Markdown` | class | Markdown 渲染器 |
| `Loader` / `CancellableLoader` | class | 加载动画 |
| `SelectList` | class | 交互式选择列表 |
| `SettingsList` | class | 设置面板 |
| `Spacer` | class | 垂直间距 |
| `Image` | class | 内联图片渲染 |
| `Box` | class | 容器 + 背景色 |
| `Container` | class | 子组件容器 |
| `matchesKey()` | function | 键盘输入匹配 |
| `Key` | namespace | 标准键名常量 |
| `visibleWidth()` | function | 可见字符宽度（忽略 ANSI） |
| `truncateToWidth()` | function | 截断到指定宽度（保留 ANSI） |
| `wrapTextWithAnsi()` | function | 按宽换行（保留 ANSI） |
| `CURSOR_MARKER` | const | IME 光标位置标记 |
| `fuzzyFilter()` | function | 模糊匹配过滤 |

---

## 入门路线图

1. **先看懂已有实现**：读 `hpl-footer/index.ts`（70 行），理解 `setFooter()` 的 factory → render 模式
2. **跑官方示例**：在 hapilon 项目中 `pi -e` 加载官方 `custom-footer.ts` / `status-line.ts` / `widget-placement.ts`，直观感受每个 API 的效果
3. **理解 pi-tui 组件**：读 `node_modules/@earendil-works/pi-tui/README.md`（或 zread.ai 文档），了解 Text/Box/SelectList 等组件
4. **做一个简单 widget**：用 `setWidget()` 实现一个显示当前上下文占用的进度条
5. **做一个 overlay 菜单**：用 `custom()` + overlay 做一个 `/hapilon` 设置面板
6. **（进阶）自定义编辑器**：继承 `CustomEditor` 添加模式指示器或快捷键提示
7. **（进阶）自定义补全**：用 `addAutocompleteProvider()` 实现 `@todo` / `@skill` 补全

---

## 常见陷阱

| 陷阱 | 说明 |
|------|------|
| **render() 行宽超限** | `render(width)` 中每行必须 ≤ width，否则 TUI 直接报错。始终用 `truncateToWidth()` 保护 |
| **ANSI 真彩码与 theme 混用** | theme 颜色函数会自动适应主题切换；硬编码 `\x1b[31m` 不会。只在需要动态 RGB 计算时用真彩码 |
| **忘写 dispose 清理** | `setFooter()` 的 `onBranchChange` 订阅、timer/interval 必须在 dispose 中清理，否则内存泄漏 |
| **footer 返回超过 3 行** | Pi 固定 footer 高度为 3 行，多出的会被截断。第 3 行留给扩展状态 |
| **print/RPC 模式无 UI** | `ctx.hasUI === false` 或 `ctx.mode !== "tui"` 时所有 TUI API 不可用。始终先检查 |
| **setFooter 覆盖 setStatus 显示?** | 不会——但你自己写的 footer 需要通过 `footerData.getExtensionStatuses()` 主动渲染扩展状态，否则用户看不到 |
| **overlay 中的焦点管理** | passive overlay (`nonCapturing: true`) 不抢焦点，用户可继续编辑；capturing overlay 会阻止输入直到关闭 |
| **硬件光标与 IME** | 中日韩输入法需要硬件光标定位。实现 `Focusable` 接口 + `CURSOR_MARKER` 才能正确支持 |
| **pi-tui 组件不支持嵌套过深** | TUI 的差分渲染策略假设组件树扁平。避免 3 层以上的 Container 嵌套 |
| **`ctx.ui` 只在扩展 handler 内有效** | 不要在 `setTimeout`/`setInterval` 回调里保存 `ctx` 引用——session 切换后 ctx 失效。用 footer 的 `tui.requestRender()` 代替 |

---

## 参考资源

- [Pi 官方 extensions.md](https://github.com/earendil-works/pi/blob/master/packages/coding-agent/docs/extensions.md) — 扩展 API 完整文档
- [pi-tui README](https://github.com/badlogic/pi-mono/blob/main/packages/tui/README.md) — TUI 框架组件 API
- [Pi 官方扩展示例](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions) — 25+ 个实际可跑的扩展源码
- [pi-powerline-footer](https://pi.dev/packages/pi-powerline-footer) — 最成熟的第三方 TUI 扩展，预设/布局/customItems 体系
- [Joel Claw: Extending Pi with Custom Tools](https://joelclaw.com/extending-pi-with-custom-tools) — Widget + silent message 实战模式
- hapilon 已实现：`src/extensions/hpl-footer/` — hpl-footer 完整实现（setFooter + footerData + 真彩 [DING]）
- hapilon 已有文档：`doc/pi-wiki.md` — Pi 生命周期与事件参考
- hapilon 已有文档：`_foresight/4-pi-context-organization.md` — Pi 上下文组织研究
