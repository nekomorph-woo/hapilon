# ExtensionAPI 速查表

> 来源: `doc/pi-wiki.md` 第 6.4 节

## 事件订阅

| 方法 | 说明 |
|------|------|
| `pi.on(event, handler)` | 订阅生命周期事件，handler 可返回 `{ block: true }` / `{ cancel: true }` 等 |

## 注册扩展机制

| 方法 | 说明 | 关键参数 |
|------|------|----------|
| `pi.registerTool(def)` | 注册 LLM 可调用的自定义 Tool | `name`, `description`, `parameters`(TypeBox), `execute(toolCallId, params, signal, onUpdate, ctx)` |
| `pi.registerCommand(name, opts)` | 注册 `/name` slash 命令 | `description`, `handler(args, ctx)` |
| `pi.registerShortcut(key, opts)` | 注册键盘快捷键 | `description`, `handler(ctx)` |
| `pi.registerFlag(name, opts)` | 注册 CLI flag | `description`, `type`("boolean"\|"string"), `default` |
| `pi.registerProvider(name, config)` | 注册/覆盖 LLM Provider | `baseUrl`, `apiKey`, `api`, `models[]`, `oauth?` |
| `pi.unregisterProvider(name)` | 移除 Provider | — |
| `pi.registerMessageRenderer(type, renderer)` | 自定义消息 TUI 渲染 | `customType` → renderer 函数 |
| `pi.registerEntryRenderer(type, renderer)` | 自定义 entry TUI 渲染 | `customType` → renderer 函数 |

## 消息与 Session 控制

| 方法 | 说明 |
|------|------|
| `pi.sendMessage(msg, opts?)` | 注入自定义消息（参与 LLM 上下文）。opts: `deliverAs`("steer"\|"followUp"\|"nextTurn"), `triggerTurn` |
| `pi.sendUserMessage(content, opts?)` | 注入用户消息。streaming 时必传 `deliverAs` |
| `pi.appendEntry(customType, data?)` | 持久化扩展数据（**不参与** LLM 上下文） |
| `pi.setSessionName(name)` | 设置 session 显示名 |
| `pi.getSessionName()` | 获取 session 名 |
| `pi.setLabel(entryId, label)` | 设置/清除 entry 标签 |

## 工具管理

| 方法 | 说明 |
|------|------|
| `pi.getActiveTools()` | 返回 `string[]` 当前活跃工具名 |
| `pi.getAllTools()` | 返回所有已配置工具元数据 |
| `pi.setActiveTools(names)` | 设置活跃工具列表 |

## 模型与 Thinking

| 方法 | 说明 |
|------|------|
| `pi.setModel(model)` | 设置当前模型。无 API key 返回 `false` |
| `pi.getThinkingLevel()` | 获取 thinking level |
| `pi.setThinkingLevel(level)` | 设置 thinking level（"off"\|"minimal"\|"low"\|"medium"\|"high"\|"xhigh"\|"max"） |

## 工具方法

| 方法 | 说明 |
|------|------|
| `pi.exec(cmd, args, opts?)` | 执行 shell 命令。opts: `signal`, `timeout` |
| `pi.getFlag(name)` | 读取注册的 CLI flag 值 |
| `pi.getCommands()` | 获取当前 session 可用 slash 命令列表 |
| `pi.events` | 扩展间通信 EventBus（`.on()` / `.emit()`） |

---

## ExtensionContext 速查

> 来源: `doc/pi-wiki.md` 第 6.5 节。所有事件 handler 接收 `ctx`。

| 属性/方法 | 类型 | 说明 |
|-----------|------|------|
| `ctx.ui` | UI 对象 | `notify(msg, level)`, `confirm(title, msg)`, `select(title, items)`, `input(title)`, `setStatus(key, text)`, `setWidget(key, lines)`, `custom(component)` |
| `ctx.mode` | string | `"tui"` / `"rpc"` / `"json"` / `"print"` |
| `ctx.hasUI` | boolean | TUI/RPC 下为 true |
| `ctx.cwd` | string | 当前工作目录 |
| `ctx.isProjectTrusted()` | () => boolean | 项目是否被信任 |
| `ctx.sessionManager` | SessionManager | 只读 session 访问：`getEntries()`, `getBranch()`, `buildContextEntries()`, `getLeafId()` |
| `ctx.modelRegistry` | ModelRegistry | 模型注册表 |
| `ctx.model` | Model | 当前模型 |
| `ctx.signal` | AbortSignal\|undefined | 当前 Agent abort 信号（turn 期间有值） |
| `ctx.isIdle()` | () => boolean | Agent 是否空闲 |
| `ctx.abort()` | () => void | 中止当前操作 |
| `ctx.shutdown()` | () => void | 请求优雅关闭 |
| `ctx.compact(opts)` | () => void | 触发 compaction |
| `ctx.getSystemPrompt()` | () => string | 获取当前 system prompt |
| `ctx.getContextUsage()` | () => {tokens} | 获取上下文使用量 |

---

## ExtensionCommandContext 速查

> 来源: `doc/pi-wiki.md` 第 6.6 节。**仅 Command handler 可用**（事件 handler 中用会死锁）。

| 方法 | 说明 |
|------|------|
| `ctx.getSystemPromptOptions()` | 获取 system prompt 构建输入 |
| `ctx.waitForIdle()` | 等待 Agent 完全 settle |
| `ctx.newSession(opts)` | 创建新 session 并切换。opts: `parentSession`, `setup(sm)`, `withSession(ctx)` |
| `ctx.fork(entryId, opts)` | Fork 到新 session。opts: `position`("before"\|"at"), `withSession(ctx)` |
| `ctx.navigateTree(targetId, opts)` | 在 session 树中跳转 |
| `ctx.switchSession(path, opts)` | 切换到另一个 session |
| `ctx.reload()` | 触发 `/reload` 热重载 |
