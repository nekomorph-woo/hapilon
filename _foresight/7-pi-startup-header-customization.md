# Pi 启动画面自定义 — 预研结论

> 一句话概括：Pi 提供了 `ctx.ui.setHeader()` API 替换启动头部、`quietStartup` 设置抑制默认显示、`PI_SKIP_VERSION_CHECK` 环境变量屏蔽更新检查。三项组合即可实现 Claude Code 风格的自定义启动画面。

## 核心发现

### ✅ 可自定义的部分

| Pi 原始内容 | 如何去除 | 如何替换 |
|------------|---------|---------|
| 版本头 `pi v0.80.8` + 快捷键 | `quietStartup: true` 或 `setHeader()` | `ctx.ui.setHeader(factory)` |
| `[Extensions]` 等加载资源列表 | `quietStartup: true` | 自定义 header 中展示 |
| `Update Available` 通知 | `PI_SKIP_VERSION_CHECK=1` | 自行 version check |
| `Model scope: ...` 日志 | `quietStartup: true` | 自定义 header 中展示 |
| hapilon 自己的 `console.log("hapilon_v0.1.0_alpha")` | 删除 cli.ts 中该行 | — |

### ❌ 不可直接替换的部分

- **`showLoadedResources()`** — Pi InteractiveMode 的私有方法，不向扩展暴露。只能通过 `quietStartup: true` 整体关闭，无法单独定制其格式。
- **`showNewVersionNotification()`** — 同为私有方法。通过 `PI_SKIP_VERSION_CHECK=1` 环境变量即可跳过 Pi 自带的检查。

## 关键技术点

### 1. `ctx.ui.setHeader(factory)` — 替换头部

类型定义来自 `pi-coding-agent/dist/core/extensions/types.d.ts:110`：

```typescript
/** Set a custom header component (shown at startup, above chat),
 *  or undefined to restore the built-in header. */
setHeader(factory: ((tui: TUI, theme: Theme) => Component & {
    dispose?(): void;
}) | undefined): void;
```

**实现位置**: `interactive-mode.js:1577` (`setExtensionHeader`)

**行为**:
- `factory` 接收 `(tui, theme)`，返回一个 pi-tui `Component`（需实现 `render(width) → string[]`）
- 传入自定义 factory → 替换 `builtInHeader` 为自定义组件
- 传入 `undefined` → 恢复内置 header
- `ExpandableText` 组件支持 `setExpanded()` 与 ctrl+o 交互

### 2. `quietStartup: true` — 静默启动

Pi settings 中的设置项（`settings-manager.js:617`）:
- **`quietStartup: true`** → 跳过内置 header 渲染（`interactive-mode.js:501`）
- 同时跳过 loaded resources 渲染（`interactive-mode.js:1043`）
- 同时跳过 model scope 日志（`interactive-mode.js:467`）

⚠️ 注意：`--verbose` flag 会**覆盖** `quietStartup`，因为代码中用的是 `||`：
```javascript
if (this.options.verbose || !this.settingsManager.getQuietStartup())
```

### 3. `PI_SKIP_VERSION_CHECK=1` — 跳过版本检查

环境变量（`version-check.js:34`）：
```javascript
if (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) return undefined;
```

设置后 Pi 不会发起 `https://pi.dev/api/latest-version` 请求，自然也不会显示 "Update Available" 通知。

### 4. Hapilon 的版本打印

`cli.ts:78`：
```typescript
if (!isNonInteractive) {
  console.log("hapilon_v0.1.0_alpha");
}
```

直接删除或替换为其他内容即可。这是在 Pi 进程 spawn 之前的 `stdout.write`。

## 实现方案

### 架构：新建 `hpl-startup-header` 扩展

```
src/extensions/hpl-startup-header/
├── index.ts          # 注册 session_start hook + setHeader
├── content.ts        # 构建 header 内容（render 函数）
└── version-check.ts  # Pi 版本更新检查（可选）
```

### 修改清单

#### A. `src/cli.ts` 变更

1. 删除第 78 行 `console.log("hapilon_v0.1.0_alpha")`
2. 添加环境变量 `PI_SKIP_VERSION_CHECK=1` 到 spawn 的 env 中
3. 设置 Pi `quietStartup` 设置（通过 hapilon config-io 写入 `~/.hapilon/agent/settings.json`）

```typescript
// cli.ts 修改点
env: {
  ...process.env,
  PI_CODING_AGENT_DIR: agentDir,
  PI_SKIP_VERSION_CHECK: "1",  // 新增
},
```

4. 可选：将 hapilon 扩展路径写入文件供 header 扩展读取

#### B. `src/extensions/hpl-startup-header/index.ts`

```typescript
export default function hplStartupHeader(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    
    ctx.ui.setHeader((tui, theme) => {
      return new StartupHeader(tui, theme, ctx);
    });
  });
}
```

#### C. StartupHeader 组件（`content.ts`）

仿 Claude Code 布局:

```
╭─── Hapilon v0.1.0 ──────────────────────────────╮
│                                                   │
│   Welcome back!                                   │
│                                                   │
│   Opus 4.8 · API Usage Billing                    │
│   /Volumes/Under_M2/morphiiouo/hapilon            │
│                                                   │
│   Pi 0.80.10 is available. Changelog: ...         │
│                                                   │
│   Extensions (6):                                 │
│     hpl-context, hpl-footer, ...                  │
│                                                   │
│   Press ctrl+o for startup help                   │
╰───────────────────────────────────────────────────╯
```

**关键细节**：
- Header 不是 overlay！它是 headerContainer 里的 Component，`render(width)` 输出纯文本行
- 不能用 Unicode 边框（pi 内置 header 也是纯文本，没有边框）
- 语言用中文还是英文？参考 Claude Code — 用户界面是英文的，保持一致

#### D. 扩展列表获取

有两种方式：
1. **环境变量传递**：cli.ts 中 `discoverExtensions()` 的结果通过 `HAPILON_EXTENSIONS` env var 传递
2. **文件传递**：将扩展列表写入 `~/.hapilon/loaded-extensions.json`

推荐方案 1（环境变量），更简单直接。

#### E. Pi 版本检查

两种选择：
1. **自己实现**：新建 `version-check.ts`，请求 `https://pi.dev/api/latest-version`
2. **复用 Pi 的函数**：import `checkForNewPiVersion` from pi-coding-agent 内部（耦合度高，不推荐）
3. **不做版本检查**：去掉这部分，保持简洁

## 与本项目的关系

- `cli.ts:78` — hapilon 版本打印，需要删除
- `cli.ts:189` — spawn 的 env，需要加 `PI_SKIP_VERSION_CHECK`
- `src/extensions/hpl-footer/index.ts` — 已有 `ctx.ui.setFooter()` 参考实现
- `src/extensions/hpl-system-prompt/assemble.ts` — 已有 `before_agent_start` hook 参考

## 主要风险

| 风险 | 缓解 |
|------|------|
| `quietStartup` 也会屏蔽 Pi 的错误/警告消息 | 需要确认哪些消息会受影响（migrated providers、models.json error 等不在 `quietStartup` 控制范围内） |
| 扩展列表获取依赖 cli.ts 传递 | env var 方案简单可靠，但需要确保格式正确 |
| 无法在非 TUI 模式下工作 | 已有 `ctx.mode !== "tui"` guard |

## 入门路线图

1. 理解 Pi TUI 组件系统：`Component` 接口 → `render(width)` → `handleInput(data)`
2. 参考 `hpl-footer` 的实现方式（`setFooter` 与 `setHeader` API 几乎相同）
3. 修改 `cli.ts` 设置环境变量和 `quietStartup`
4. 创建 `hpl-startup-header` 扩展实现 header

## 参考资源

- Pi ExtensionAPI 类型定义: `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
- InteractiveMode header 实现: `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:496-538`
- showLoadedResources 实现: `interactive-mode.js:1040`
- version-check 实现: `node_modules/@earendil-works/pi-coding-agent/dist/utils/version-check.js`
- hpl-footer 参考: `src/extensions/hpl-footer/index.ts`
