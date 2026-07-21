# TUI 鼠标划选自动复制到系统剪贴板

## Context

Pi 渲染到普通终端缓冲区（非 alternate screen），主界面不启用鼠标模式，终端原生文本选择可用但复制需手动 Cmd+C。目标是实现「拖选松手即复制到系统剪贴板」，消除手动复制的摩擦。

本计划覆盖 TODO-21（OSC 52 剪贴板 + /copy）、TODO-22（鼠标文本选择引擎）、TODO-23（整合到 Pi 主会话）。

## 可行性分析

### 渲染缓存 — 核心技术难点

**问题**：TODO-22 需要一个行级渲染缓存（`row -> rendered string`），以便将鼠标 `(row, col)` 映射到实际终端内容。但 pi-tui 的 TUI 类：
- 无 `afterRender` / `onRender` 回调钩子
- `previousLines`（存储渲染结果的私有数组）无公开 API
- Widget 组件只能观测自身 `render()` 输出，无法获取完整 TUI 渲染树

**方案评估**：

| 方案 | 可行性 | 风险 | 选择 |
|------|--------|------|------|
| A. monkey-patch `tui.render()` 捕获输出 | 可行 | 依赖 Container.render() 内部实现 | **采纳** |
| B. monkey-patch `terminal.write()` 解析输出缓冲 | 可行但极其复杂 | 需实现迷你终端模拟器解析 diff 协议 | 不采纳 |
| C. `(tui as any).previousLines` 直接读取 | 可行 | 紧耦合私有属性，pi-tui 升级可能破坏 | 备选 fallback |
| D. 遍历 TUI 组件树手动渲染 | 不可靠 | 布局逻辑复杂，无法复制 Pi 的完整渲染流程 | 不采纳 |

**采纳方案（A）的细节**：

`TUI extends Container`，`Container.render(width)` 遍历 children 调用各组件的 `render(width)` 并拼接返回 `string[]`。TUI 自身未覆写 `render()`，所以 monkey-patch `tui.render` 可以在每次渲染周期捕获完整的基础内容（overlay 合成之前）。这恰好是我们需要的 — 选择范围不应包含 overlay 内容。

```typescript
const originalRender = tui.render.bind(tui);
(tui as any).render = function(width: number): string[] {
  const lines = originalRender(width);
  cache.lines = lines;
  cache.width = width;
  return lines;
};
```

**局限性**：无法感知终端滚动位置。鼠标坐标 `(row, col)` 是相对于终端可视窗口的（1-indexed，row 1 = 窗口顶部）。当用户在终端中向上滚动后，鼠标 row 1 不再对应 `cache.lines` 的末尾。本实现仅支持可视视口选择（`cache.lines` 的最后 `terminalHeight` 行），并将此限制记录为已知限制。用户滚动终端后需 Shift+拖拽走终端原生路径。

### 鼠标模式与滚轮冲突

**问题**：启用鼠标模式后，终端不再将滚轮事件转为滚动，而是发送 SGR 序列给应用。Pi 渲染到普通终端缓冲区，滚轮滚动依赖终端原生行为。

**解决**：在我们的 input listener 中检测滚轮事件，写入 CSI Scroll Up/Down 序列（`\x1b[5S` / `\x1b[5T`）模拟终端原生滚动，然后 consume 该事件。这在 iTerm2、Terminal.app、xterm 兼容终端中均可用。

### 视觉反馈

**问题**：TODO-22 要求「选中区域反转颜色或加下划线」，但在渲染周期外注入 ANSI 样式会与 Pi 的差异渲染冲突。

**决策**：Phase 1 仅实现松手通知反馈（`ctx.ui.notify("Copied N chars")`），视觉高亮作为 backlog 项。理由：
- 注入 ANSI 高亮需要修改 render cache 并触发重渲染，形成 render 循环风险
- 无高亮时用户仍可通过 Shift+拖拽获得终端原生视觉反馈
- 松手通知足以确认复制成功

## 核心原则

1. **Monkey-patch 而非重建**：通过 monkey-patch `tui.render()` 建立渲染缓存，避免重建终端模拟器
2. **渐进式交付**：Phase 1 以通知反馈替代视觉高亮，确保核心拖选复制可用后再迭代
3. **模式共存**：主会话鼠标模式（选择用 `?1003h`）与 overlay 鼠标模式（滚轮用 `?1000h`）通过状态机切换，互不干扰

## 文件变更清单

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/shared/clipboard.ts` | OSC 52 剪贴板写入：`copyToClipboard(text)` + `stripAnsi(str)` + 大文本保护 |
| `src/shared/text-selection.ts` | 选择引擎：渲染缓存安装、选择状态机、坐标映射、文本提取、鼠标模式常量 |
| `src/extensions/hpl-clipboard/index.ts` | 扩展入口：`/copy` 命令 + `session_start` 鼠标模式整合 |
| `src/test/unit/clipboard.test.ts` | OSC 52 序列生成、base64 编码、ANSI 剥离、大文本保护的单元测试 |
| `src/test/unit/text-selection.test.ts` | 选择状态机、坐标映射、文本提取、边界条件的单元测试 |

### 修改文件

无。所有功能通过新增文件实现，不修改现有源文件。

> 注：如需扩展 `floating-pane/mouse.ts`（如导出更多常量），为最小改动可在 `text-selection.ts` 中自行定义选择模式的鼠标序列常量，复用已有的 `SGR_MOUSE_RE` 和 `parseMouseEvent`。

## 实现步骤

### Phase 1: TODO-21 — OSC 52 剪贴板工具 + /copy 命令

#### Step 1.1: 实现 `src/shared/clipboard.ts`

实现内容：
- `stripAnsi(str: string): string` — 用正则 `\x1b\[[0-9;]*[a-zA-Z]` 剥离所有 ANSI 转义码
- `copyToClipboard(text: string, write: (data: string) => void): { success: boolean; reason?: string }`
  - 输入 `text` 先经 `stripAnsi()` 处理
  - 检查长度：UTF-8 字节 > 100KB 时拒绝并返回 `{ success: false, reason: "text too large" }`
  - 生成 OSC 52 序列：`\x1b]52;c;<base64>\x07`（`c` = clipboard, 非 primary selection）
  - base64 编码使用 `Buffer.from(text, "utf-8").toString("base64")`
  - 通过传入的 `write` 回调写入终端（而非硬编码 `process.stdout`，方便测试）
  - 返回 `{ success: true }`

设计要点：
- `write` 参数注入而非硬编码，使单元测试可以用 mock 替代真实终端输出
- 100KB 限制参考 OSC 52 协议的典型缓冲区上限，设为可调常量 `MAX_CLIPBOARD_BYTES`

→ verify: 单元测试覆盖（见 Step 1.2）

#### Step 1.2: 实现 `src/test/unit/clipboard.test.ts`

测试用例：
1. `copyToClipboard("hello")` 生成的序列匹配 `\x1b]52;c;<base64(aGVsbG8=)>\x07`
2. 包含中文 "你好" 时 base64 编码正确（`5L2g5aW9`）
3. 包含 emoji "🎉" 时 base64 编码正确
4. 包含特殊字符 `\n\t\r` 时 base64 编码正确
5. 输入含 ANSI 颜色码 `"\x1b[32mgreen\x1b[0m"` 时，写入序列的内容为纯文本 `"green"` 的 base64
6. 超过 100KB 的文本触发保护，`write` 未被调用，返回 `{ success: false, reason: "text too large" }`
7. `stripAnsi()` 正确剥离各种 ANSI 序列（颜色、粗体、斜体、256色、真彩色、underline）

→ verify: `npx vitest run src/test/unit/clipboard.test.ts` 全绿

#### Step 1.3: 实现 `src/extensions/hpl-clipboard/index.ts` — /copy 命令

实现内容：
- 扩展工厂函数 `export default function hplClipboard(pi: ExtensionAPI): void`
- 注册 `/copy` 命令：
  - 无参数时：遍历 `ctx.sessionManager.getEntries()` 找到最后一条 `role === "assistant"` 的 message entry，提取其文本内容（遍历 `entry.message.content`，拼接 `type === "text"` 的 `text` 字段），经 `stripAnsi()` 后调用 `copyToClipboard()` 写入系统剪贴板，通知用户
  - 有参数时：将参数字符串直接作为复制内容
  - 写入时通过 monkey-patch 获取的 `tui.terminal.write` 调用（Step 3 中会在 session_start 中捕获 tui 实例）

设计要点：
- `/copy` 命令的 `ctx` 类型为 `ExtensionCommandContext`（自动获得），其中 `ctx.ui` 可访问 TUI
- session_start 中需要捕获 `tui` 实例供后续使用，此处与 Step 3 整合
- 首次实现时，/copy 的 `write` 回调暂用 `(data) => process.stdout.write(data)` 占位，Step 3 整合时替换为 `tui.terminal.write`

→ verify: 在 Pi 中输入 `/copy hello` 后，在系统剪贴板中粘贴验证内容为 "hello"

### Phase 2: TODO-22 — 鼠标文本选择引擎

#### Step 2.1: 实现渲染缓存 — `src/shared/text-selection.ts` 基础设施

实现内容：

```typescript
// 渲染缓存
interface RenderCache {
  lines: string[];       // 全量渲染行（含 ANSI 码，overlay 合成前）
  width: number;         // 渲染宽度
  updatedAt: number;    // timestamp
}

// 安装渲染缓存（monkey-patch tui.render）
function installRenderCache(tui: any): RenderCache
// 卸载渲染缓存
function uninstallRenderCache(tui: any, cache: RenderCache): void
```

- `installRenderCache` 将原始 `tui.render` 保存到 cache 上，替换为 wrapper
- wrapper 调用原始 render，捕获输出到 cache，返回原始结果
- `uninstallRenderCache` 恢复原始 render

→ verify: 单元测试 — mock tui.render，验证 wrapper 调用原始函数且 cache.lines 被更新

#### Step 2.2: 实现选择状态机 + 文本提取

实现内容：

```typescript
interface SelectionState {
  active: boolean;       // 是否正在选择
  startRow: number;       // 起始行（cache 索引，0-based）
  startCol: number;       // 起始列（1-based，SGR 编码）
  endRow: number;
  endCol: number;
}

// 鼠标模式常量
const SELECTION_MOUSE_ON = "\x1b[?1003h\x1b[?1006h";  // any-event + SGR

// 初始化选择引擎
function createSelectionEngine(tui: any, cache: RenderCache, write: (data: string) => void): {
  enable(): void;                              // 开启鼠标模式
  disable(): void;                             // 关闭鼠标模式
  handleMouseEvent(data: string): boolean;      // 处理鼠标事件，返回是否消费
  getSelectedText(): string;                    // 获取当前选中文本（纯文本）
  cancel(): void;                              // 取消选择
  isActive(): boolean;
  dispose(): void;
}
```

选择状态机逻辑：
1. 收到 button 0（左键）press 且无 Shift 修饰 → 开始选择，记录 startRow/startCol
2. 收到 button 0 motion → 更新 endRow/endCol，clamp 到合法范围
3. 收到 button 0 release → 结束选择，提取文本
4. 收到 wheel event (button & 64) → 写入 `\x1b[5S` / `\x1b[5T` 模拟滚动，consume
5. 收到 Shift 修饰的事件 (button & 0x20) → 返回 false，不消费（走终端原生路径）
6. 收到 Escape → 取消选择

坐标映射（核心逻辑）：
```
鼠标 row（1-based，视口顶部 = 1）
→ 视口偏移：viewportOffset = cache.lines.length - terminalHeight
→ cache 索引：cacheIndex = viewportOffset + (mouseRow - 1)
→ clamp：max(0, min(cache.lines.length - 1, cacheIndex))
```

文本提取：
- 单行选择：`cache.lines[row]` → 用 `sliceByColumn`（pi-tui 导出）截取 `[minCol, maxCol]` → `stripAnsi()`
- 多行选择：首行从 startCol 到行尾，中间行全选，末行从行首到 endCol → 各行 `stripAnsi()` 后用 `\n` 连接
- 使用 pi-tui 导出的 `sliceByColumn` 进行 ANSI 感知的列截取

→ verify: 单元测试覆盖（见 Step 2.3）

#### Step 2.3: 实现 `src/test/unit/text-selection.test.ts`

测试用例：

**渲染缓存**：
1. `installRenderCache` 后调用 tui.render(width) 返回正确结果且 cache.lines 被填充
2. `uninstallRenderCache` 后 tui.render 恢复原始行为
3. 多次 render 后 cache.lines 保留最新结果

**选择状态机**：
4. button 0 press → `isActive() === true`
5. button 0 motion → endRow/endCol 更新
6. button 0 release → `isActive() === false`，`getSelectedText()` 返回正确文本
7. Escape → 取消选择，`isActive() === false`
8. Shift+click (button 32) → `handleMouseEvent` 返回 false（不消费）
9. Wheel event (button 64) → 消费且 write 被调用 `\x1b[5S`

**坐标映射与文本提取**：
10. 单行选择：cache 3 行，终端高 5，鼠标 row 3 col 2 到 col 10 → 正确提取第 3 行的 2-10 列纯文本
11. 多行选择：鼠标 row 1 col 5 到 row 3 col 15 → 正确提取 3 行（首行 5 到行尾，中间行全选，末行行首到 15）
12. 含 ANSI 码的行：`"\x1b[32mhello world\x1b[0m"` 选择 col 3-8 → 纯文本 `"llo wo"`
13. 边界：选择范围超出 cache 行数时 clamp 到合法范围
14. 边界：空 cache 时 `getSelectedText()` 返回空字符串
15. 单击不拖拽（press + 立即 release 同位置）→ 选中单行或单点

→ verify: `npx vitest run src/test/unit/text-selection.test.ts` 全绿

### Phase 3: TODO-23 — 整合到 Pi 主会话

#### Step 3.1: 扩展入口 — session_start 集成

在 `src/extensions/hpl-clipboard/index.ts` 的扩展工厂函数中添加 `session_start` 事件处理：

```typescript
pi.on("session_start", (_event, ctx) => {
  if (ctx?.hasUI !== true || ctx.mode !== "tui") return;

  // 通过 widget 捕获 live TUI 实例（复用 hpl-panel-viewer 的成熟模式）
  ctx.ui.setWidget("hpl-clipboard", (tui: any, _theme: any) => {
    // 安装渲染缓存
    const cache = installRenderCache(tui);

    // 创建选择引擎
    const engine = createSelectionEngine(tui, cache, (data) => tui.terminal.write(data));

    // 注册全局 input listener
    const unsubInput = tui.addInputListener((data: string) => {
      if (tui.hasOverlay?.()) return undefined;  // overlay 打开时不干扰
      if (engine.handleMouseEvent(data)) return { consume: true };
      return undefined;
    });

    // 监听 overlay 开关以切换鼠标模式
    // （详见 Step 3.2）

    // 替换 /copy 的 write 回调
    state.tuiWrite = (data: string) => tui.terminal.write(data);

    return {
      render: () => [],  // 不可见 widget
      invalidate() {},
      dispose() {
        unsubInput();
        engine.dispose();
        uninstallRenderCache(tui, cache);
      },
    };
  });
});
```

设计要点：
- 复用 `hpl-panel-viewer` 的「不可见 widget 捕获 TUI」模式（`render: () => []`）
- Widget key `"hpl-clipboard"` 不与现有 widget 冲突
- `tui.hasOverlay()` 检查确保 overlay 打开时 input listener 不干扰
- dispose 时清理所有资源（取消订阅、关闭鼠标模式、恢复 render）

→ verify: 启动 Pi 后，扩展加载无报错，widget 注册成功

#### Step 3.2: 鼠标模式切换 — overlay 冲突处理

问题：当 overlay 打开时，`PanelViewer` 构造函数写入 `OVERLAY_MOUSE_ON`（`?1000h`+`?1006h`），关闭时写入 `MOUSE_OFF`。我们需要在 overlay 关闭后恢复选择模式（`?1003h`+`?1006h`），在 overlay 打开前关闭选择模式。

方案：利用 `tui.addInputListener` 的执行时机 — 它在 Pi 的 input handler 之前运行。当检测到 `hasOverlay()` 状态变化时切换鼠标模式。

实现方式：在 input listener 回调中检测 overlay 状态变化：

```typescript
let overlayWasActive = false;

const unsubInput = tui.addInputListener((data: string) => {
  const overlayActive = tui.hasOverlay?.() ?? false;

  // Overlay 刚打开 → 关闭选择模式，让 overlay 自己管理鼠标模式
  if (overlayActive && !overlayWasActive) {
    engine.disable();  // 写入 MOUSE_OFF
  }

  // Overlay 刚关闭 → 重新启用选择模式
  if (!overlayActive && overlayWasActive) {
    engine.enable();  // 写入 SELECTION_MOUSE_ON
  }

  overlayWasActive = overlayActive;

  // overlay 打开时不处理鼠标选择事件
  if (overlayActive) return undefined;

  if (engine.handleMouseEvent(data)) return { consume: true };
  return undefined;
});
```

状态转换图：

```
初始状态: selection mode ON (?1003h + ?1006h)
  │
  ├─ overlay 打开 → selection mode OFF (MOUSE_OFF)
  │   └─ overlay 内部自己写入 OVERLAY_MOUSE_ON (?1000h + ?1006h)
  │
  └─ overlay 关闭 → selection mode ON (SELECTION_MOUSE_ON)
      └─ 用户可以继续拖选
```

→ verify: 打开 PanelViewer overlay → 关闭 overlay → 拖选仍可正常工作

#### Step 3.3: 松手自动复制 — 连接选择引擎到剪贴板

在 `createSelectionEngine` 中，当鼠标释放事件触发选择结束时：

```typescript
// 在 handleMouseEvent 的 release 分支中
if (!press) {
  const text = this.getSelectedText();
  if (text.length > 0) {
    const result = copyToClipboard(text, this.write);
    if (result.success) {
      // 通知反馈
      const preview = text.length > 50 ? text.slice(0, 50) + "..." : text;
      this.onCopy?.(`Copied ${text.length} chars: ${preview}`);
    }
  }
  this.active = false;
}
```

`onCopy` 回调在 Step 3.1 中注入，使用 `ctx.ui.notify()` 显示复制通知。

→ verify: 在 Pi 主会话中拖选对话文本 → 松手 → `ctx.ui.notify` 显示 "Copied N chars" → 在其他应用粘贴验证

#### Step 3.4: 端到端验证

手动测试清单：
1. Pi 主会话中拖选 assistant 输出文本 → 松手 → 在 Notes.app 粘贴验证内容正确（纯文本，无 ANSI 码）
2. 拖选包含中文/emoji 的文本 → 粘贴验证编码正确
3. 打开 FloatingPane overlay（/pop）→ 滚轮滚动正常 → 关闭 overlay → 拖选恢复正常
4. Shift+拖拽 → 终端原生选择生效（终端高亮显示）
5. Escape → 取消当前选择
6. 滚轮滚动 → 终端视口正常滚动（CSI 5S/5T）
7. `/copy hello` → 系统剪贴板包含 "hello"
8. `/copy`（无参数）→ 复制最后一次 assistant 输出
9. 运行全量测试：`npx vitest run` 确认现有 502 测试不受影响

→ verify: 以上 9 项全部通过

## 关键风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| **终端滚动位置未知** | 用户向上滚动终端后拖选，坐标映射错误 | 仅支持可视视口选择，Shift+拖拽走终端原生路径作为 fallback |
| **monkey-patch tui.render()** | pi-tui 升级可能改变 Container.render() 实现 | 在 `installRenderCache` 中加入防御性检查：如果 `tui.render` 不是函数或签名变化，graceful 降级 |
| **CSI Scroll 序列兼容性** | 少数终端不支持 `\x1b[5S`/`\x1b[5T` | 在 iTerm2 + Terminal.app 实测；如果某终端不支持，用户可通过键盘 PageUp/PageDown 滚动 |
| **鼠标模式切换时序** | overlay 打开的瞬间，选择模式和 overlay 模式可能短暂冲突 | overlay 打开前先 `MOUSE_OFF`，overlay 构造函数再写入 `OVERLAY_MOUSE_ON`，时序安全 |
| **无视觉选择反馈** | Phase 1 用户不知道自己选择了什么范围 | 松手通知作为反馈；Shift+拖拽走终端原生选择有高亮；视觉反馈作为 backlog 项 |
| **`sliceByColumn` 可用性** | pi-tui 可能不导出此函数或签名不同 | 优先使用；如不可用则自行实现 ANSI 感知的列截取 |

## 验收标准

### TODO-21
- [ ] `copyToClipboard("hello")` 生成正确的 OSC 52 序列
- [ ] 复制内容包含中文、emoji、特殊字符时 base64 编码正确
- [ ] ANSI 颜色码被正确剥离
- [ ] 超过 100KB 内容触发保护，不发送 OSC 52
- [ ] `/copy` 命令注册成功，执行后系统剪贴板包含复制内容
- [ ] `/copy`（无参数）复制最后一次 assistant 输出
- [ ] 在 iTerm2 + Terminal.app 中实测复制可用

### TODO-22
- [ ] 渲染缓存通过 monkey-patch tui.render() 正确捕获渲染输出
- [ ] 鼠标按下开始选择，拖拽扩展选区，松开结束选择
- [ ] 从渲染缓存中正确提取选中区域的纯文本（剥离 ANSI 码）
- [ ] 多行选择正确处理（行首/行尾对齐）
- [ ] 点击不拖拽 = 选中点击位置所在行
- [ ] 滚轮事件不影响选择状态且终端正常滚动
- [ ] Shift+拖拽返回 false（不消费，走终端原生路径）
- [ ] Escape 取消选择

### TODO-23
- [ ] Pi 主会话中鼠标拖选文本 → 松手 → `ctx.ui.notify` 显示 "Copied N chars"
- [ ] 系统剪贴板自动包含选中文本（纯文本，无 ANSI 码）
- [ ] 在其他应用中粘贴验证内容正确
- [ ] 打开 FloatingPane overlay 时滚轮仍可滚动内容
- [ ] 关闭 overlay 后文本选择恢复工作
- [ ] Shift+拖拽走终端原生路径（终端高亮显示）
- [ ] Escape 取消选择
- [ ] `/copy` 命令使用 `tui.terminal.write` 而非 `process.stdout.write`
- [ ] 全量测试通过（含新增 clipboard + text-selection 测试）
