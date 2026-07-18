# hpl-context-viewer — /context 上下文查看命令

> 一句话：仿照 Claude Code 的 `/context`，用 `pi.registerCommand` 注册 slash 命令 + FloatingPane 浮层渲染上下文组成。

> **状态**: 已实现。v2 新增 FloatingPane 目录化（`src/shared/floating-pane/`），import 路径需更新。

---

## §1 背景

Claude Code 有一个 `/context` 命令，输入后在终端渲染当前会话的上下文占用分解：

```
  ⛀ ⛁ ⛁ ⛁ ⛀ ⛀ ⛁ ⛁ ⛀ ⛶ ⛶ ⛶ ...   model-name[1m]
  ⛁ System prompt: 1.7k (0.2%)
  ⛁ System tools: 16k (1.6%)
  ⛁ MCP tools: 2.7k (0.3%)
  ...
  ⛶ Free: 934.2k (93.4%)
```

hapilon 目前已完全控制 System Prompt（hpl-system-prompt），掌握了 TUI 预研（_foresight.md），现在需要实现自己的 `/context` 命令。

---

## §2 技术方案

### 2.1 核心机制：`pi.registerCommand`

Pi 有三层 slash command dispatch（按优先级）：

| 优先级 | 机制 | 说明 |
|--------|------|------|
| 1（最高） | `pi.registerCommand(name, options)` | 扩展命令，handler 内可执行任意代码 |
| 2 | Prompt 模板（`prompts/*.md`） | 文件名=命令名，仅文本替换 |
| 3 | 内置命令（`/model`、`/compact` 等） | Pi 核心硬编码 |

**选择第 1 层**：`pi.registerCommand("context", { handler })` — handler 拿到 `ExtensionCommandContext`（含 `getSystemPromptOptions()`、`getContextUsage()`、`ui.custom()`），可直接收集数据 + 渲染 TUI overlay。

### 2.2 渲染方案：`ctx.ui.custom()` overlay

```typescript
ctx.ui.custom<void>(
  (tui, theme, keybindings, done) => {
    // 构建 pi-tui 组件树，渲染上下文组成
    // 按 q/Esc 调用 done() 关闭 overlay
    return new Box({ ... });
  },
  { overlay: true }
);
```

`{ overlay: true }` 模式会创建一个全屏浮层，用户看完后按键关闭。

### 2.3 数据源

| 展示项 | 数据来源 | 获取方式 |
|--------|----------|----------|
| 模型名称 + 窗口 | `ctx.model` | `{ id, name, contextWindow }` |
| 总用量/百分比 | `ctx.getContextUsage()` | `{ tokens, contextWindow, percent }` |
| System prompt token 估算 | `ctx.getSystemPromptOptions()` | `toolSnippets` + `promptGuidelines` 等各字段字符数/4 |
| System tools | `ctx.getSystemPromptOptions().toolSnippets` | `Record<string, string>` — 每个 tool 的一行描述 |
| 自定义 agents | hapilon 自身的 agents 扫描 | 复用 shared/files.ts 的 `discoverSkillPaths` 模式 |
| Rules (HAPILON) | hapilon 自身的 rules 扫描 | 复用 shared/files.ts 的 `readRules()` |
| Memory (HAPILON.md) | hapilon 自身的 md 扫描 | 复用 shared/files.ts 的 `readHapilonMd()` |
| Skills | `ctx.getSystemPromptOptions().skills` | `Skill[]` |
| Messages | `ctx.sessionManager` | `getBranch()` 过滤 `type === "message"` |
| 消息数量统计 | `AgentSession.getSessionStats()` | `{ userMessages, assistantMessages, toolCalls, ... }` |
| Session token/cost | `AgentSession.getSessionStats()` | `{ tokens: {input, output, total}, cost }` |

**注意**：`ctx.getSessionStats()` 在 `AgentSession` 上，不在 `ReadonlySessionManager` 上。在 `ExtensionCommandContext` 中可以通过 `ctx` 直接访问吗？需验证。备选方案：自己遍历 `ctx.sessionManager.getEntries()` 统计。

### 2.4 Token 估算策略

Pi 的 `estimateTokens()` 用 **chars/4** 启发式（保守高估）。我们沿用相同策略：

```
估算 token = Math.ceil(文本字符数 / 4)
```

各分类的 token 估算：
- **System prompt**：hapilon assembled system prompt 全文长度 / 4
- **System tools**：所有 tool snippet 的字符总和 / 4
- **Rules**：所有规则文件内容字符总和 / 4
- **Skills**：所有 skill name+description 字符总和 / 4
- **Messages**：从 `getContextUsage().tokens` 减去上述 static 部分（粗略分解）

### 2.5 System Prompt 元数据传递

hpl-system-prompt 扩展在 `before_agent_start` 中组装 system prompt。需要新增一个**共享元数据模块**，存储最后一次组装的各部分 token 估算：

```
src/extensions/hpl-system-prompt/metadata.ts (NEW)
  → export interface SystemPromptMeta { ... }
  → export function setLastMeta(meta): void
  → export function getLastMeta(): SystemPromptMeta | undefined
```

`hpl-context-viewer` 的 handler 读取这个 metadata 来分解 system prompt 的组成。

---

## §3 实现计划

### Phase 1：基础架构

**文件**：`src/extensions/hpl-context-viewer/`

```
src/extensions/hpl-context-viewer/
├── index.ts          # 扩展入口：pi.registerCommand("context", ...)
├── collector.ts      # 数据收集：从 ctx 各 API 聚合上下文组成
├── renderer.ts       # 渲染：构建 pi-tui 组件树（Bar chart + 列表）
└── types.ts          # ContextSnapshot、CategoryBreakdown 等类型
```

**修改文件**：
- `src/extensions/hpl-system-prompt/` — 新增 `metadata.ts` 导出模块
- `src/extensions/hpl-system-prompt/assemble.ts` — 组装后调用 `setLastMeta()`

### Phase 2：数据收集 (collector.ts)

`collector.ts` 导出一个 `collectContextSnapshot(ctx)` 函数：

```typescript
export interface ContextSnapshot {
  model: { id: string; name: string; contextWindow: number };
  usage: { tokens: number | null; percent: number | null; contextWindow: number };
  categories: CategoryBreakdown[];
  details: {
    tools: ToolInfo[];       // name + estimated tokens
    rules: RuleInfo[];       // name + path + estimated tokens
    hapilonMds: MdInfo[];    // path + estimated tokens
    skills: SkillInfo[];     // name + description + estimated tokens
    messages: MessageStats;  // user/assistant/tool counts
  };
  session: { totalTokens: number; cost: number };
}
```

### Phase 3：TUI 渲染 (renderer.ts)

使用 pi-tui 组件构建 overlay：

```
┌─────────────────────────────────────────────┐
│  Context Usage                    model[128k] │
│                                               │
│  ████░░░░░░░░░░░░░░░░░░░░░░░░░░  12.8k (10%) │
│                                               │
│  Estimated usage by category                  │
│  ▓ System prompt:    1.7k (1.3%)              │
│  ▓ System tools:     4.2k (3.3%)              │
│  ▓ Rules & memory:   2.1k (1.6%)              │
│  ▓ Skills:           1.5k (1.2%)              │
│  ▓ Messages:         3.3k (2.6%)              │
│  ░ Free space:      114.2k (89.1%)            │
│                                               │
│  Skills · ~/.hapilon/agent/skills/            │
│  └ 3 skills · 1.5k tokens                     │
│                                               │
│  Rules · ~/.hapilon/                          │
│  └ 5 rules · 2.1k tokens                     │
│                                               │
│  Press q or Esc to close                      │
└─────────────────────────────────────────────┘
```

组件结构：
```
Box (overlay container)
├── Text (title: "Context Usage")
├── Bar (总用量进度条 — Unicode blocks)
├── Text (section header: "Estimated usage by category")
├── CategoryBar × N (每类一行：图标 + 名称 + bar + 数值)
├── Text (section header: "Skills")
├── Text (skills detail)
├── Text (section header: "Rules")
├── Text (rules detail)
└── Text (hint: "Press q to close")
```

### Phase 4：hpl-system-prompt 元数据导出

在 `assemble.ts` 的 `assembleSystemPrompt()` 末尾，记录各部分内容长度：

```typescript
setLastMeta({
  assembledAt: Date.now(),
  cwd: opts.cwd,
  sections: {
    roleAndIdentity: ROLE_SECTION.length,
    piDocumentation: piDocText.length,
    systemPrompt: effectiveSystemPrompt.length,  // Pi's original or custom
    tools: toolsSection.length,
    guidelines: guidelinesSection.length,
    hapilonInstructions: hapilonInstructions.length,
    hapilonRules: hapilonRulesSection.length,
    contextFiles: contextFilesSection.length,
    skills: skillsSection.length,
    knowledgeCutoff: KNOWLEDGE_CUTOFF_SECTION.length,
    additionalData: additionalDataSection.length,
  },
});
```

### Phase 5：Pi TUI bar chart 渲染

Unicode block characters 八档渐变：

```
" " (U+0020)  → 0%
"▏" (U+258F)  → 1/8
"▎" (U+258E)  → 2/8
"▍" (U+258D)  → 3/8
"▌" (U+258C)  → 4/8
"▋" (U+258B)  → 5/8
"▊" (U+258A)  → 6/8
"▉" (U+2589)  → 7/8
"█" (U+2588)  → 8/8 (full)
```

每条 bar 固定宽度（如 30 chars），按百分比映射到 series of blocks。

---

## §4 风险与缓解

| 风险 | 缓解 |
|------|------|
| `ctx.getSessionStats()` 在 `ExtensionCommandContext` 上不可用 | 降级：手动遍历 `ctx.sessionManager.getEntries()` 统计 |
| System prompt metadata 未及时更新（command 在 agent idle 时执行） | metadata 在 `before_agent_start` 中更新，command handler 在 idle 时读取 — 时间线一致 |
| `ctx.ui.custom()` overlay 在非 TUI 模式下不可用 | `if (ctx.mode !== "tui")` → 降级为 `ctx.ui.notify()` 文本输出 |
| Pi 版本升级改变 `getSystemPromptOptions()` 返回结构 | 单元测试覆盖 collector，版本升级后 CI 捕获 |
| Token 估算不精确（chars/4 是粗略值） | 标注 `est.`（estimated），与 Pi footer 的估算保持一致性 |

---

## §5 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/extensions/hpl-context-viewer/index.ts` | 新建 | 扩展入口 |
| `src/extensions/hpl-context-viewer/collector.ts` | 新建 | 数据收集 |
| `src/extensions/hpl-context-viewer/renderer.ts` | 新建 | TUI overlay 渲染 |
| `src/extensions/hpl-context-viewer/types.ts` | 新建 | 类型定义 |
| `src/extensions/hpl-system-prompt/metadata.ts` | 新建 | 元数据共享模块 |
| `src/extensions/hpl-system-prompt/assemble.ts` | 修改 | 组装后记录 metadata |
| `src/test/unit/hpl-context-viewer.test.ts` | 新建 | 单元测试 |

---

## §6 验收标准

- [ ] `/context` 命令注册成功，在 hapilon TUI 中输入 `/context` 触发 overlay
- [ ] overlay 显示：模型名称 + 上下文窗口大小
- [ ] overlay 显示：总 token 使用量 + 百分比（Unicode bar chart）
- [ ] overlay 显示：按类别分解（System prompt、Tools、Rules、Skills、Messages）+ 各占 token 和百分比
- [ ] overlay 显示：Skills 数量 + Rules 数量
- [ ] overlay 显示：Session 统计（消息数、总 token、cost）
- [ ] 按键（q/Esc）关闭 overlay，回到正常 TUI
- [ ] 非 TUI 模式（print/rpc）降级为文本输出
- [ ] 不影响 hpl-footer / hpl-system-prompt / hpl-context 等其他扩展
- [ ] 单元测试覆盖 collector + renderer 核心逻辑
- [ ] 全量测试不受影响
