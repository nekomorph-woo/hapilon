# TUI 鼠标划选与系统剪贴板

> 一句话概括：在终端 TUI 中实现「鼠标划选 → 自动复制到系统剪贴板」需要解决一个 40 年历史的协议冲突——鼠标滚轮和文本选择共享同一个鼠标模式通道，无法同时拥有终端原生的两者。解决方案要么自己实现应用级文本选择 + OSC 52 写入剪贴板，要么利用 Shift 键绕过。

## 核心概念

### 什么是鼠标报告模式（Mouse Reporting Mode）

终端模拟器和终端应用之间通过 **xterm 鼠标协议**（1980 年代设计）通信。这个协议有几种模式：

| 模式 | 代码 | 捕获的事件 | 特点 |
|------|------|-----------|------|
| X10 | 9 | 仅按钮按下 | 最原始，几乎不用 |
| Normal | 1000 | 按下 + 释放 | 不含拖拽和滚轮 |
| **ButtonEvent** | **1002** | 按下 + 释放 + **拖拽 + 滚轮** | **最常用的模式** |
| AnyEvent | 1003 | 全部事件（含鼠标悬停移动） | 最激进，很少用 |

**关键矛盾**：没有「仅滚轮」模式。要捕获滚轮事件（模式 1002），就必然同时捕获点击和拖拽。一旦应用捕获了点击/拖拽，终端模拟器就无法再用它们做文本选择了。

> 类比：就像一条水管，要么全部水流进你的桶里（应用拿到所有鼠标事件），要么全部流过终端（终端处理选择/滚动），没有办法只接走滚轮这一股水。

### 什么是 OSC 52

**OSC 52** 是一种 ANSI 转义序列，允许**终端应用通过 stdout 向系统剪贴板写入内容**。格式如下：

```
\x1b]52;c;<base64编码的内容>\x07
```

- `\x1b]52;` — OSC 52 序列头
- `c` — 目标剪贴板（`c` = system clipboard, `p` = primary selection）
- `<base64内容>` — 要复制的文本，必须 base64 编码
- `\x07` — BEL 终止符（也可用 `\x1b\\`）

终端模拟器收到这个序列后，会将解码后的内容写入系统的剪贴板。

**为什么重要**：这是 TUI 应用写入系统剪贴板的**唯一标准协议级方案**。不需要调用 `pbcopy`（macOS）或 `xclip`（Linux）等外部命令，也不需要安装 npm 包。只要终端支持 OSC 52，一行 `process.stdout.write()` 就够了。

### 什么是 Shift 键绕过

几乎所有主流终端模拟器都支持一个约定：**按住 Shift 键时，鼠标事件绕过应用直接交给终端处理**。

| 终端 | 绕过键 | 说明 |
|------|--------|------|
| iTerm2 | Option + 拖拽 | Option 键绕过 |
| Terminal.app | Shift + 拖拽 | 或 Fn + 拖拽 |
| Alacritty | Shift + 拖拽 | |
| WezTerm | Shift + 拖拽 | |
| tmux | 需要 `allow-passthrough on` | 否则 Shift 也被拦截 |

这意味着即使在鼠标模式 1002 激活的情况下，用户仍然可以通过 Shift+拖拽 来选择文本——只是这不是「自动复制到剪贴板」，而是终端原生的选择行为（需要再手动 Cmd+C 或右键复制）。

### Pi/Hapilon 的渲染模型

Pi Coding Agent 渲染到**普通终端缓冲区**（normal buffer），而不是备用屏幕（alternate screen）。这意味着：

- 终端保留 scrollback 历史
- 终端原生的文本选择/搜索**在鼠标模式关闭时可用**
- 滚动由终端模拟器处理（不需要应用自己捕获滚轮）

这与 Claude Code 的渲染模型相同。Claude Code 之所以能「划选即复制」，是因为它**不启用鼠标模式**，让终端处理所有鼠标操作。

## 主要方案对比

### 方案 A：不启用鼠标模式（Claude Code 的做法）

| 项目 | 说明 |
|------|------|
| **原理** | 不发送 `\x1b[?1002h` 等鼠标模式序列，终端保留原生选择能力 |
| **优点** | 零成本实现；终端原生选择 + 复制完美工作；无需任何额外代码 |
| **缺点** | 无法在 TUI 内部响应滚轮事件（但 Pi 不需要——它渲染到普通缓冲区，终端自己处理滚动） |
| **适用场景** | Pi/Hapilon 主界面（对话流、header/footer） |
| **当前状态** | ✅ **Pi 主界面已经是这样做的**——主界面没有启用鼠标模式 |

### 方案 B：应用级文本选择 + OSC 52 复制

| 项目 | 说明 |
|------|------|
| **原理** | 启用鼠标模式 1002，自己跟踪鼠标拖拽路径，计算选中区域的文本，通过 OSC 52 写入剪贴板 |
| **优点** | 真正的「划选即复制」体验，不需要 Shift 键；可以在浮动面板（FloatingPane）内实现 |
| **缺点** | 实现复杂度高（需要坐标到文本行的映射、ANSI 颜色码剥离、多行选择拼接）；维护成本高 |
| **参考实现** | Charmbracelet 的 `crush` 编辑器就是这样做的 |
| **适用场景** | 需要鼠标模式激活的同时仍能划选复制的场景 |

### 方案 C：键盘快捷键 + OSC 52 复制

| 项目 | 说明 |
|------|------|
| **原理** | 注册一个键盘快捷键（如 `Ctrl+Shift+C`）或 slash command（如 `/copy`），将当前上下文内容（最后一条输出、选中行等）通过 OSC 52 写入剪贴板 |
| **优点** | 实现简单（~20 行代码）；不依赖鼠标；兼容性好 |
| **缺点** | 不是「划选即复制」，而是「一键复制」；需要用户明确触发 |
| **适用场景** | 快速实现剪贴板能力的最小方案 |
| **参考** | Claude Code 的 `/copy` 命令就是用 OSC 52 实现的 |

### 方案 D：混合方案（推荐）

| 项目 | 说明 |
|------|------|
| **原理** | 主界面不启用鼠标模式（方案 A），保留终端原生选择；在 overlay/FloatingPane 打开时临时启用鼠标模式用于滚轮滚动，关闭后恢复；额外提供 `/copy` 快捷方式用 OSC 52 复制 |
| **优点** | 主界面体验最佳（原生选择）；overlay 内滚轮可用；有键盘复制兜底 |
| **缺点** | 需要管理鼠标模式的生命周期（overlay 开/关时切换） |
| **当前状态** | ⚠️ **大部分已实现**——`mouse.ts` 已经在 overlay 开/关时切换鼠标模式；只缺 OSC 52 复制能力 |

## 与本项目的关系

### 当前项目现状

| 方面 | 状态 | 位置 |
|------|------|------|
| 鼠标模式管理 | ✅ 已实现 | `src/shared/floating-pane/mouse.ts` |
| 滚轮滚动 viewer | ✅ 已实现 | `src/extensions/hpl-panel-viewer/input.ts` |
| 鼠标事件解析 | ✅ 已实现 | `src/shared/floating-pane/mouse.ts` — `parseMouseEvent()` |
| OSC 52 复制 | ❌ 不存在 | 项目中无任何 clipboard 相关代码 |
| pi-tui 剪贴板 API | ❌ 不提供 | pi-tui 没有暴露 clipboard 接口 |
| pi-tui 鼠标 API | ❌ 不提供 | 鼠标处理完全靠扩展自行匹配 raw escape sequence |

### 关键发现

1. **Pi 主界面不启用鼠标模式**，所以终端原生的文本选择在主界面是可用的——用户可以直接用鼠标选择 header、对话内容等文本。

2. **FloatingPane/PanelViewer 打开时临时启用鼠标模式**（用于滚轮滚动），此时终端原生选择被拦截，但用户可以用 **Shift+拖拽** 绕过。

3. **要实现 Claude Code 风格的「划选自动复制」**，核心差距是缺少 OSC 52 的实现。如果只是「让用户能选择文本」，当前架构已经基本满足（主界面不拦截鼠标，Shift+拖拽可在 overlay 中选择）。

4. **真正的「划选自动复制」** 需要方案 B（应用级选择 + OSC 52），实现复杂度高。更实际的做法是方案 D 的变体：保持现状 + 增加 `/copy` 命令（OSC 52）。

### OSC 52 最小实现（TypeScript）

```typescript
// src/shared/clipboard.ts

/**
 * 通过 OSC 52 转义序列将文本写入系统剪贴板。
 * 兼容 iTerm2、Terminal.app、Alacritty、WezTerm 等主流终端。
 */
export function copyToClipboard(text: string): void {
  const encoded = Buffer.from(text, "utf-8").toString("base64");
  // \x1b]52;c;<base64>\x07
  const sequence = `\x1b]52;c;${encoded}\x07`;
  process.stdout.write(sequence);
}
```

这就是全部代码——~10 行。剩余工作是将它绑定到键盘快捷键或 slash command。

## 入门路线图

### 第一步：理解为什么「划选即复制」在 TUI 中不是默认行为

1. 知道 xterm 鼠标协议有 4 种模式
2. 理解模式 1002 同时捕获滚轮和点击/拖拽
3. 知道启用鼠标模式 = 终端无法做原生文本选择

### 第二步：理解 Pi/Hapilon 的渲染模型

1. 知道 Pi 渲染到**普通缓冲区**（不是 alternate screen）
2. 知道普通缓冲区 = 终端保留 scrollback 和原生选择能力
3. 知道 Pi 主界面**不启用鼠标模式**

### 第三步：实现 OSC 52 复制

1. 理解 OSC 52 转义序列格式
2. 编写 `copyToClipboard()` 函数
3. 绑定到 `/copy` slash command 或键盘快捷键
4. 在常用终端中测试

### 第四步（可选，高级）：应用级文本选择

1. 在 overlay 内跟踪鼠标拖拽路径
2. 将坐标映射到渲染文本的行列
3. 提取选中区域的纯文本（剥离 ANSI 颜色码）
4. 鼠标释放时通过 OSC 52 复制

## 常见陷阱

### 1. tmux 中 OSC 52 被拦截

tmux 默认不转发 OSC 52 序列。需要在 `~/.tmux.conf` 中添加：

```
set -g allow-passthrough on
```

或仅允许 OSC 52：

```
set -g set-clipboard on
```

否则 OSC 52 序列被 tmux 吞掉，剪贴板不会更新。

### 2. 终端不支持 OSC 52

极少数老旧终端不支持 OSC 52。兼容性列表：

| 终端 | OSC 52 支持 | 备注 |
|------|-------------|------|
| iTerm2 | ✅ | 原生支持 |
| macOS Terminal.app | ✅ | 10.13+ |
| Alacritty | ✅ | |
| WezTerm | ✅ | |
| Kitty | ✅ | |
| VS Code 集成终端 | ✅ | xterm.js 支持 |
| tmux | ⚠️ | 需配置 allow-passthrough |
| screen | ❌ | 不转发 |
| Linux framebuffer | ❌ | 不支持 |

### 3. Base64 编码长度限制

OSC 52 的 base64 内容没有协议级长度限制，但实际中建议控制在 **100KB 以内**。大多数终端对单条序列有内部缓冲区限制。如果需要复制大量文本，应分批发送或改用 `pbcopy`/`xclip` 等外部命令。

### 4. ANSI 颜色码污染

TUI 输出的文本通常包含 ANSI 转义码（颜色、粗体等）。如果直接将包含 ANSI 码的文本通过 OSC 52 复制到剪贴板，粘贴到其他地方时会看到乱码。复制前需要用正则剥离 ANSI 码：

```typescript
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
```

### 5. Pi overlay 打开时鼠标模式的生命周期

`mouse.ts` 在 overlay 打开时启用鼠标模式（`OVERLAY_MOUSE_ON`），关闭时恢复（`MOUSE_OFF`）。如果 overlay 异常退出（crash），鼠标模式可能没有被正确关闭。确保在 `dispose()` / finally 块中始终恢复鼠标模式。

### 6. 模式 1000 vs 1006

项目当前使用 `\x1b[?1000h\x1b[?1006h`（Normal + SGR）。模式 1000 启用基本鼠标报告，模式 1006（SGR）使用更可解析的编码格式。关闭时对应 `\x1b[?1000l\x1b[?1006l`。**必须成对使用，否则会泄漏到后续 shell 会话。**

## 参考资源

- [xterm 控制序列文档](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html) — 权威的终端转义序列参考
- [Why Terminal TUI Apps Can't Have Both Scroll and Text Selection](https://yogirk.dev/posts/why-terminal-tui-apps-cant-have-both-scroll-and-text-selection/) — 最佳的文章，详细解释了协议层根因
- [OSC 52: My Cut & Paste Journey](https://miek.nl/2024/january/31/osc52-my-cut-paste-journey/) — OSC 52 实战指南
- [@tsports/go-osc52](https://www.npmjs.com/package/@tsports/go-osc52) — TypeScript OSC 52 库（npm）
- [theimpostor/osc](https://github.com/theimpostor/osc) — 纯 CLI 工具，pipe → clipboard
- [SSH + tmux + Neovim + OSC 52 Clipboard Guide](https://woojar.com/posts/osc52-clipboard-ssh-tmux-neovim/) — tmux + OSC 52 配置指南
- [项目 mouse.ts](src/shared/floating-pane/mouse.ts) — 本项目已有的鼠标模式管理实现
