# Pi-Subagents 与 Hapilon Subagent 系统

> 一句话概括：`@tintinweb/pi-subagents` 是 Pi Coding Agent 的一个扩展，用 Claude Code 风格的 `Agent` 工具让主 agent 派生**隔离子会话**——每个子 agent 有自己的 tools / system prompt / model / thinking level。本调研挖出它全部 features、源码级实现关键点，并为 hapilon 自研 subagent（含 turbo/pro/ultra 三档模型配置）给出落地方案。

---

## 0. 速览：这是什么

Pi 本身是一个单 session 的终端 Coding Agent（一个主循环、一套 tools、一个 system prompt）。`pi-subagents` 扩展给它加上了**派生子 session 的能力**：

```
                  ┌─────────────────────────────────────┐
                  │   主 Pi Session（parent / orchestrator）│
                  │   tools: 全部  + Agent/get_subagent_  │
                  │           result/steer_subagent       │
                  └───────────────┬─────────────────────┬─┘
            Agent(...) spawn      │                     │  Agent(...) spawn
       ┌──────────────────────────┘                     └───────────────────────┐
       ▼                                                                        ▼
┌──────────────────────┐                                          ┌──────────────────────┐
│ 子 Agent Session A   │   独立 tools 子集 / 独立 system prompt     │ 子 Agent Session B   │
│ model: haiku (turbo) │   独立 model / thinking / max_turns        │ model: opus (ultra) │
│ tools: read,grep,... │   独立 cwd（可 worktree 隔离）              │ tools: 全部          │
└──────────────────────┘                                          └──────────────────────┘
```

父 agent 通过 `Agent` 工具 spawn 子 agent，子 agent 在隔离会话里跑完后把结果返回给父 agent——和 Claude Code 的 `Agent` / `Task` 工具语义完全一致（故称 "Claude Code-style"）。

**关键认知**：子 agent **不是新进程**，而是同一个 Pi 运行时内、由 `createAgentSession()` 创建的**独立会话对象**。它复用父会话的 `modelRegistry`（所有 provider 配置都在里面），只是换一个 `model`、换一套 `tools`、换一段 `system prompt`。

---

## 1. 核心概念

### 1.1 Subagent（子 agent）

一个"有自己专属工作"的子 Pi 会话。父 agent 用 `Agent` 工具发起，子 agent 拿到 prompt 后自主跑完（多轮 tool 调用），把结果交回。

| 维度 | 父 session | 子 agent session |
|------|-----------|----------------|
| system prompt | 用户配置 + AGENTS.md/CLAUDE.md | replace 模式：自定义；append 模式：父 prompt + 桥接段 |
| tools | 全部可用 | 可裁剪（built-in 子集 + 扩展子集 + denylist） |
| model | 主 session 配置 | 可单独指定（fuzzy 名或 `provider/modelId`） |
| thinking | 主 session 配置 | 可单独指定（off→max） |
| max_turns | 无限 | 可限定（带 grace 宽限） |
| cwd | 项目根 | 可不同（worktree 隔离） |
| 会话存储 | 落盘 | 默认 in-memory，可 `persist_session: true` 落盘 |

### 1.2 Agent / get_subagent_result / steer_subagent（三个 LLM 工具）

这是扩展注册给父 agent 用的三个 tool（pi-subagents 的全部对外工具）：

| 工具 | 作用 | 关键参数 |
|------|------|---------|
| `Agent` | 派生一个子 agent | `prompt`（必填）、`description`（必填，3-5 词）、`subagent_type`（必填）、`model`、`thinking`、`max_turns`、`run_in_background`、`resume`、`isolated`、`isolation: worktree`、`inherit_context`、`schedule` |
| `get_subagent_result` | 查询/取回后台子 agent 结果 | `agent_id`、`wait`、`verbose` |
| `steer_subagent` | 向运行中的子 agent 注入消息，改方向 | `agent_id`、`message` |

> 类比：`Agent` 是"派活"，`get_subagent_result` 是"催进度/收货"，`steer_subagent` 是"中途改需求"。

### 1.3 Frontmatter Authoritative（前置元数据是权威）

这是整个系统的**核心设计原则**：agent `.md` 文件里 frontmatter 设的字段是**锁定的**，`Agent` 工具调用参数只能**填补 frontmatter 没设的字段**。

```
agent .md frontmatter 设了 model: haiku  →  调用时传 model: opus  →  实际仍用 haiku（frontmatter 赢）
agent .md frontmatter 没设 model          →  调用时传 model: opus  →  用 opus（参数填补）
agent .md frontmatter 没设 model          →  调用时也没传          →  继承父 session 的 model
```

优先级链：**调用参数 > frontmatter > 父继承 > 兜底**（对那些 frontmatter 明确"未指定"的策略字段，如 `inherit_context`，调用参数才能决定）。

### 1.4 model 解析（fuzzy + 跨 provider 回退）

frontmatter 或调用里的 `model` 字段不是死的字符串匹配，而是**容忍式解析**：

- `.` 和 `-` 等价：`claude-haiku-4.5` ≡ `claude-haiku-4-5`
- 尾部日期戳可选：`claude-haiku-4-5-20251001` ≡ `claude-haiku-4-5`
- `provider/modelId` 若该 provider 没这模型，会用裸 id 去**所有 provider** 重试
- 全部失败 → 继承父 model（并标 `(unavailable, fallback: inherit)`）

优先级：精确匹配 > 该 provider 下 fuzzy > 任意 provider 下同模型 > 不可用。

### 1.5 KV Cache 优化（append 模式的字节前缀）

`prompts.ts` 里一个容易被忽略但很关键的实现：`prompt_mode: append` 的子 agent，其 system prompt 把**父 prompt 原样放在最前面**，中间不加任何 wrapper 标签。这样子 agent 的 prompt 与父 session 形成**完全相同的字节前缀**，LLM 的 KV cache 能跨每次 spawn 复用这些 token——省 token、降延迟。每调用才变化的 `<active_agent>` 标签和环境块放在缓存前缀之后。

---

## 2. Features 全景（全量挖掘）

以下是从 README + 源码挖出的**全部 features**，按类别分组。

### 2.1 派生与执行

| Feature | 说明 |
|---------|------|
| **前台 / 后台 spawn** | 前台阻塞等结果内联返回；后台立即返回 ID，完成时通知 |
| **并行后台 + 并发队列** | 默认并发上限 4（可配），超额自动排队；前台不排队 |
| **Mid-run steering** | 运行中注入消息，在当前 tool 执行后打断改向（`steer_subagent`） |
| **Session resume** | 用 `resume: <agentId>` 从上次中断处继续，保留完整对话上下文 |
| **Graceful turn limits** | 到 `max_turns` 先发"wrap up"警告，给最多 5 个 grace turn 干净收尾，超时才硬中止 |
| **Context inheritance** | `inherit_context: true` 把父对话 fork 进子 agent，让它知道前情 |
| **Worktree isolation** | `isolation: worktree` 在临时 git worktree 里跑；完成时无改动自动清理，有改动 commit 到 `pi-agent-<id>` 分支 |
| **Schedule（调度）** | `schedule` 字段：cron（6 字段）/ interval（`5m`）/ 一次性相对（`+10m`）/ 一次性绝对（ISO）。会话级，`/new` 重置 `/resume` 恢复，PID 文件锁防跨实例冲突 |

### 2.2 自定义 Agent 类型（`.md` 定义）

| Feature | 说明 |
|---------|------|
| **Claude Code 式 .md 定义** | YAML frontmatter + body（system prompt），文件名即类型名 |
| **三层发现，高优先覆盖低** | `.pi/agents/`（项目权威）> `.agents/agents/`（跨工具共享）> 全局 `~/.pi/agent/agents/` |
| **大小写不敏感** | `explore`/`Explore`/`EXPLORE` 都行 |
| **同名覆盖默认** | 建 `.pi/agents/general-purpose.md` 就覆盖内置 general-purpose |
| **未知类型回退** | 不认识的类型 → 用 general-purpose 兜底并提示 |
| **Eject / Override / Disable** | 内置 agent 可 eject 成 .md、可被同名 .md 覆盖、可 `enabled: false` 单项目禁用 |
| **Skill 预加载** | `skills: api-conventions, error-handling` 把命名 skill 注入 system prompt |
| **持久记忆** | `memory: project|local|user`，MEMORY.md 索引 + 单文件；只读 agent（无 write/edit）自动只读记忆 |
| **Tool denylist** | `disallowed_tools: write, edit` 即便扩展提供也禁用 |

### 2.3 Tool / Extension 裁剪（双轴）

这是 pi-subagents 最精巧的设计之一，**两个独立维度**：

| 维度 | 控制什么 | 取值 |
|------|---------|------|
| `extensions:` | **加载哪些扩展**（loading 权威） | `true`（全载）/ `false`（都不载）/ `[mcp, "/abs/foo.ts"]`（指定） |
| `tools:` | **暴露哪些 tool 给 LLM**（surface） | `*`/`all`（全 built-in）/ `none`/CSV built-in 名 / `ext:foo/bar` 选扩展 tool |

组合规则：
- `extensions:` 是唯一加载权威；`tools: ext:foo` 只能窄化已加载扩展的 tool，不能凭空加载 foo
- 出现任意 `ext:` 项 → 扩展 tool 变成**显式白名单**，没点名的扩展 tool 不暴露（但 handler 仍跑）
- `exclude_extensions:` 后置黑名单，**exclude 永远赢**，连 `ext:` selector 都拉不回
- `isolated: true` = 密封专家模式：强制 `extensions: false` + `skills: false`，只留 built-in
- built-in tool 名**动态获取**（`createCodingTools(".")` + `createReadOnlyTools(".")` 取并集），不硬编码——pi 增删 tool 自动跟随
- typo 大声报错：`tools: reed, grep` 报 `tools-error:` 而非静默生成缺 tool 的 agent

### 2.4 UI / 可观测

| Feature | 说明 |
|---------|------|
| **Above-editor widget** | 持久浮在上面，动画 spinner + 实时 tool 活动 + token 计数 + 状态色标 |
| **FleetView** | editor 下方可导航列表，`↓`/`←` 进、`Enter` 开实时对话 overlay、`Esc` 回；已完成的 linger 几秒再消失 |
| **Conversation viewer** | 实时滚动 overlay 看子 agent 全对话；滚动上移暂停 auto-follow；`Enter` 开 composer 中途 steer，`x` 停止 |
| **Token 标注** | `(NN%)` 上下文窗占用率（<70% 暗 / 70-85% 警告 / ≥85% 错误），`(⇊N)` 压缩次数 |
| **样式化完成通知** | 后台完成渲染成主题化紧凑框（图标/统计/结果预览），可展开；LLM 收到结构化 `<task-notification>` XML |
| **Transcript 文件** | 每子 agent 流式 JSONL transcript 到 `<tmp>/pi-subagents-<uid>/<cwd>/<session>/tasks/<id>.output`（0700，重启清） |

### 2.5 完成状态机（graceful shutdown）

| 状态 | 含义 | 图标 |
|------|------|------|
| `completed` | 自然完成 | `✓` 绿 |
| `steered` | 到上限，grace 期内干净收尾 | `✓` 黄 |
| `aborted` | grace 期超时硬中止 | `✗` 红 |
| `stopped` | 用户手动停 | `■` 暗 |
| `error` | 出错 | `✗` |

### 2.6 Join 策略（多后台完成如何通知）

仅对后台 agent 生效：

| 模式 | 行为 |
|------|------|
| `smart`（默认） | 同一轮 spawn ≥2 个 → 合并成单条通知；单发 → 单独通知 |
| `async` | 每个 agent 完成各自通知（原行为，适合增量处理） |
| `group` | 强制分组（即便单发，预知后面还有） |

分组超时：首个完成后 30s 内没全完成 → 先发已完成的部分，剩余 15s 再补一批。

### 2.7 跨扩展集成

| Feature | 说明 |
|---------|------|
| **Event bus（生命周期事件）** | `subagents:created/started/completed/failed/steered/compacted/scheduled/scheduler_ready/ready/settings_loaded/settings_changed` 经 `pi.events` 发出 |
| **跨扩展 RPC** | 其他扩展经 `pi.events` 也能 spawn/stop 子 agent：`subagents:rpc:ping/spawn/stop`，标准化 `{success, data?, error?}` 信封 + 协议版本号；reply channel 按 requestId 隔离 |
| **`subagents:ready` 握手** | session 启动时发，标志 RPC 就绪；排除该扩展的 session 不发（=不可用） |
| **Model scope 强制** | 可选开关：子 agent model 校验 pi 的 `enabledModels` 白名单；调用方传越界 → 硬错；frontmatter 钉越界 → 警告但照跑（frontmatter 权威） |
| **持久设置** | `~/.pi/agent/subagents.json`（全局）+ `<cwd>/.pi/subagents.json`（项目覆盖），存并发数/max_turns/grace/join/scheduling/scope 等 |

### 2.8 `/agents` 命令（交互菜单）

```
Running agents (2) — 1 running, 1 done
Agent types (6)              ← 默认 + 自定义统一列表，标 •项目 / ◦全局 / ✕禁用
Create new agent             ← 手动向导 或 AI 生成
Settings                     ← 并发 / max_turns / grace / join / 调度 / scope ...
```

支持 Eject（导出默认为 .md）、Disable/Enable、Reset、Delete、手动新建/AI 新建。

---

## 3. 架构与实现关键点（源码级）

### 3.1 文件职责划分

```
src/
  index.ts            # 入口：tool/command 注册、UI 渲染、生命周期 hook（104KB，主控）
  types.ts            # AgentConfig / AgentRecord / ScheduledSubagent 类型
  default-agents.ts   # 三个内置 agent 配置（general-purpose / Explore / Plan）
  agent-types.ts      # 统一注册表（默认+用户），tool 名解析，大小写不敏感
  agent-runner.ts     # 【核心】createAgentSession 拼装、执行、graceful、steer/resume
  agent-manager.ts    # 生命周期、并发队列、完成通知
  cross-extension-rpc.ts  # 跨扩展 spawn/ping 的 RPC handler
  group-join.ts       # 分批完成通知 + 超时
  custom-agents.ts    # .md 发现 + frontmatter 解析
  memory.ts           # 持久记忆（resolve/read/build prompt block）
  skill-loader.ts     # skill 预加载（Pi 标准 + Agent Skills spec 布局）
  output-file.ts      # 流式 transcript
  worktree.ts         # git worktree 隔离
  prompts.ts          # system prompt 拼装（replace/append）
  context.ts          # inherit_context 的父对话 fork
  schedule.ts + schedule-store.ts  # 调度
```

### 3.2 派生子 session 的核心 API（hapilon 落地最关键的契约）

**全部秘密在一行**：`createAgentSession()`（来自 `@earendil-works/pi-coding-agent`）。`agent-runner.ts:689-707`：

```typescript
const sessionOpts = {
  cwd: effectiveCwd,                    // 工作目录（可被 worktree 改写）
  agentDir,                             // agent 配置目录
  sessionManager,                       // SessionManager.inMemory() 或 .create()（落盘）
  settingsManager,                      // SettingsManager.create(configCwd, agentDir)
  modelRegistry: ctx.modelRegistry,     // ★ 复用父会话的 modelRegistry（所有 provider 都在）
  modelRuntime: parentModelRuntime,     // Pi 0.80.8+ 改用 modelRuntime，兼容传两个
  model,                                // ★ 解析后的 Model 对象（resolveModel 得来）
  tools: allowedTools,                  // ★ 最终 tool 白名单（built-in + 扩展，已去 disallowed）
  resourceLoader: loader,               // 已按 extensions:/exclude_extensions: 过滤的扩展加载器
  thinkingLevel,                        // 可选
};
const { session } = await createAgentSession(sessionOpts);
await session.bindExtensions();         // 触发 session_start，让扩展初始化（加载凭据等）
session.setSessionName(`${name}#${id}`);
session.subscribe(event => { ... });    // 订阅 turn_end / compaction_end 等事件
session.abort();                        // 中止
```

**关键洞察**：
1. `modelRegistry` 直接用父会话的（`ctx.modelRegistry`）——所以子 agent 能访问父会话配置的所有 provider，不需要重新配置。
2. `model` 是解析后的 `Model` 对象，不是字符串——由 `resolveModel(modelInput, ctx.modelRegistry)` 把 frontmatter/调用参数的字符串解析成对象。
3. **tool gating 在 session 构造时一次成型**：`tools: allowedTools` 把最终 tool 集合在 `createAgentSession` 时就钉死，pi-mono 的 `allowedToolNames` 同时 gate 注册和初始 active set——不需要事后过滤。
4. `SessionManager.inMemory()` vs `.create()` 决定子会话是否落盘（对应 `persist_session`）。

### 3.3 Tool 白名单的拼装（`agent-runner.ts:628-676`）

```
最终 allowedTools =
  (frontmatter tools 的 built-in 名
   ∪ 按 extensions:/ext: selector 加载并筛出的扩展 tool 名)
  − EXCLUDED_TOOL_NAMES（本扩展自己注册的 Agent/get_subagent_result/steer_subagent，
                        子 agent 绝不能继承这三个，否则递归 spawn）
  − disallowedTools（frontmatter 的 denylist）
```

`EXCLUDED_TOOL_NAMES` 是个值得注意的细节：pi-subagents 注册的三个 tool 必须从子 agent 的 toolset 里剔除，否则子 agent 能再 spawn 子子 agent，无限递归。

### 3.4 prompt_mode 的两种拼装（`prompts.ts`）

**replace 模式**（独立专家，如 Explore/Plan）：
```
<active_agent name="Explore"/>
You are a pi coding agent sub-agent. ...
# Environment
Working directory: ...
<config.systemPrompt 全文>      ← body 是完整 system prompt
<extras: memory / skills>
```

**append 模式**（父分身，如 general-purpose）：
```
<父 system prompt 原样>          ← ★ 与父 session 字节级一致，KV cache 可复用
<sub_agent_context>桥接段（用 read 不用 cat 等）</sub_agent_context>
<active_agent name="..."/>
# Environment ...
<agent_instructions>自定义 body</agent_instructions>   ← body 追加在末尾
<extras>
```

append 模式 body 为空 = 纯父克隆（继承全部 AGENTS.md/CLAUDE.md 规则）。

### 3.5 三个内置默认 agent（`default-agents.ts`）

| 类型 | tools | model | prompt_mode | 角色 |
|------|-------|-------|-------------|------|
| `general-purpose` | 全部（省略=全） | 继承 | `append` | 父分身，复杂多步、需要写权限 |
| `Explore` | read/bash/grep/find/ls | `anthropic/claude-haiku-4-5` | `replace` | 快速只读搜索（haiku 省 token） |
| `Plan` | read/bash/grep/find/ls | 继承 | `replace` | 只读架构规划 |

Explore 和 Plan 的 system prompt 都硬编码了 `# CRITICAL: READ-ONLY MODE` 段，禁止任何写操作——即便有 bash 工具也限制只读命令。

### 3.6 生命周期 hook（`index.ts`）

扩展在 `export default function(pi: ExtensionAPI)` 里挂钩：

```typescript
pi.on("session_start", async (_event, ctx) => { /* 加载自定义 agent、启动调度器、emit ready */ });
pi.on("session_before_switch", () => { /* 切会话前清理 */ });
pi.on("session_shutdown", async () => { /* 清 worktree 注册 */ });
pi.on("tool_execution_start", async (_event, ctx) => { /* 更新 widget/fleet 的 UICtx */ });
```

### 3.7 pi 扩展 API 全貌（`@earendil-works/pi-coding-agent` 的 `ExtensionAPI`）

从 index.ts 提取的、pi 暴露给扩展的关键能力：

| API | 用途 |
|-----|------|
| `pi.registerTool(defineTool({name, description, inputSchema, run}))` | 注册 LLM 可调用 tool |
| `pi.registerCommand(...)` / `pi.command` | 注册 slash command |
| `pi.registerMessageRenderer<T>(...)` | 注册自定义消息渲染（样式化通知框） |
| `pi.sendMessage<T>({...})` | fire-and-forget 发消息 |
| `pi.appendEntry(key, data)` | 追加日志条目 |
| `pi.events.emit / pi.events.on` | 事件总线（生命周期 + 跨扩展 RPC） |
| `pi.on(lifecycleEvent, handler)` | 生命周期 hook |
| `defineTool` + `Type.String/Type.Boolean/Object(...)` | tool 定义辅助 + schema（effect/schema 风格） |
| `getAgentDir()` / `parseFrontmatter()` / `createAgentSession()` / `createCodingTools` / `createReadOnlyTools` / `SettingsManager` / `SessionManager` | 核心 SDK 函数 |

`ctx`（ExtensionCommandContext / ExtensionContext）暴露：`ctx.model`、`ctx.modelRegistry`、`ctx.ui.notify`、`ctx.cwd`、`ctx.sessionManager.getSessionId()`。

---

## 4. Agent `.md` 定义规范（hapilon 直接参考）

### 4.1 文件布局

```
<project>/.pi/agents/<name>.md          ← 项目级，权威（/agents 菜单写这里）
<project>/.agents/agents/<name>.md      ← 跨工具共享，只读
~/.pi/agent/agents/<name>.md            ← 全局
```

### 4.2 完整 frontmatter 字段表

| 字段 | 默认 | 说明 |
|------|------|------|
| `description` | 文件名 | tool 列表里显示的描述 |
| `display_name` | — | UI 显示名（widget/list） |
| `tools` | 全部 7 个 | built-in 名 / `*`/`all` / `none` / `ext:扩展/tool`，CSV |
| `extensions` | `true` | `true`/`false`/`[mcp, "/abs.ts", "*"]`——加载哪些扩展 |
| `exclude_extensions` | — | 扩展黑名单（CSV，纯名，exclude 赢） |
| `skills` | `true` | `true`（继承）/ `false` / CSV skill 名（预加载） |
| `memory` | — | `project`/`local`/`user`，持久记忆范围 |
| `disallowed_tools` | — | tool denylist（CSV） |
| `isolation` | — | `worktree`——临时 git worktree 隔离 |
| `model` | 继承父 | `provider/modelId` 或 fuzzy 名（`haiku`/`sonnet`），容忍解析 |
| `thinking` | 继承 | off/minimal/low/medium/high/xhigh/max |
| `max_turns` | 无限 | 到上限前 graceful 收尾；0/省略=无限 |
| `persist_session` | `false` | 是否落盘成正常 pi session |
| `output_transcript` | `true` | 是否写 .output transcript |
| `session_dir` | pi 默认 | persist_session 时的会话目录 |
| `prompt_mode` | `replace` | `replace`（body=全 system prompt）/ `append`（body 追加父 prompt） |
| `inherit_context` | `false` | fork 父对话进子 agent |
| `run_in_background` | `false` | 默认后台跑 |
| `isolated` | `false` | 密封专家：强制无扩展/无 skill/无 context |
| `enabled` | `true` | `false` 禁用 |

### 4.3 示例（README 原例）

```markdown
---
description: Security Code Reviewer
tools: read, grep, find, bash
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
---

You are a security auditor. Review code for vulnerabilities including:
- Injection flaws (SQL, command, XSS)
- Authentication and authorization issues
...
```

---

## 5. 与本项目（hapilon）的关系

> **一句话现状**：hapilon 源码层对 subagent **零实现**（全仓搜 `subagent/spawnAgent/delegate` 无运行时匹配），但 PRD §9.7（v0.0.7 目标）已把首期方案定死。本节把 pi-subagents 的实现路线与 hapilon PRD 路线对照，给出 turbo/pro/ultra 三档的精确落地点。
>
> 📍 **架构决策（2026-07-19）**：采用**进程内 `createAgentSession` 路线**（与 pi-subagents 一致），放弃 PRD §9.7.1 原定的独立子进程方案。下文 §5.1–§5.5 基于此决策论述；**PRD §9.7 需同步更新**（否则违反 Living Documentation 原则）。

### 5.1 ⚠️ 关键架构分歧：进程内 vs 独立子进程（本调研最重要的发现）

**pi-subagents 和 hapilon PRD 走的是两条不同的 subagent 实现路线**：

| 维度 | pi-subagents（本调研对象） | hapilon PRD §9.7.1（已定方案） |
|------|---------------------------|-------------------------------|
| **子 agent 形态** | 进程内独立会话对象 | 独立 Pi 子进程 |
| **核心 API** | `createAgentSession()`（SDK） | `spawn pi --mode json -p --no-session --model ... --tools ... --append-system-prompt role.md "Task"`（child_process） |
| **运行时** | 同一 Pi 运行时 | 全新 Pi 进程 |
| **启动开销** | 低（无进程启动） | 高（每次 spawn 一个 Pi） |
| **隔离强度** | 弱（同进程，共享 modelRegistry） | 强（独立进程，独立上下文） |
| **主进程 tool_call hook** | ✅ **仍生效**（同进程） | ❌ **不触发**（盲区！） |
| **并行/取消** | `session.abort()` / AbortSignal | kill 子进程 / signal |
| **UI 集成** | 进程内直接渲染 widget/FleetView | 需解析子进程 stream-json 再渲染 |
| **现有 spawn 链路** | — | hapilon `src/cli.ts:194-202` 已有 `spawn(piCli, ..., {stdio:"inherit"})`，子进程方案复用同一套 |

**含义**：pi-subagents 的**大量 features（FleetView、widget、graceful max_turns、mid-run steering、调度、跨扩展 RPC、KV cache 优化）都建立在"进程内会话对象"基础上**。hapilon 若坚持 PRD 的子进程路线，这些 features **不能直接照搬**——要么放弃，要么用解析 stream-json + 进程间通信重新实现。

**结论（已决策 → 进程内路线）**：hapilon subagent 采用**进程内 `createAgentSession` 路线**（与 pi-subagents 一致），放弃 PRD §9.7.1 原定的独立子进程方案。理由：① 低启动开销（无进程启动）；② 主进程 `tool_call` hook 在子会话内**仍生效**，safety-gate / protected-paths 自动覆盖 subagent，**安全盲区消失**；③ `modelRegistry` 复用，turbo/pro/ultra 三档解析直接走 `ctx.modelRegistry`；④ widget / FleetView / steering / 调度等高级 feature 可直接搬。**代价**：偏离 PRD §9.7（需同步更新 PRD）；隔离强度弱于子进程（但 hook 生效反而让 tool 级可控）。**第一参考**因此从"Pi 官方子进程示例"变回 **pi-subagents 本身**（路线一致，可 fork 其 `agent-runner.ts` 架构）；Pi 官方子进程示例降为隔离/沙箱场景的备选。

### 5.2 hapilon 扩展机制现状（subagent 落点已明确）

- **扩展组织**：`src/extensions/<name>/index.ts`，默认导出 `function(pi: ExtensionAPI): void`，一目录一扩展（现有 9 个：safety-gate / protected-paths / hpl-system-prompt / hpl-context / hpl-context-viewer / hpl-panel-viewer / hpl-startup-header / hpl-footer / hpl-clipboard）
- **发现机制**：`discoverExtensions()`（`src/extensions.ts:15-42`）扫 **`dist/extensions/`**（编译后产物），支持 `<name>/index.js` 或单文件 `<name>.js`，按名排序加载（决定 `before_agent_start` 等链式 hook 顺序）
- **注入方式**：`src/cli.ts:117-127` 把发现的扩展通过 Pi 原生 `-e` flag 注入（临时扩展机制，路径是 dist，不是 `~/.pi/agent/extensions/`）
- **Tool 注册范例**：`src/extensions/hpl-panel-viewer/index.ts:59-99` 已注册过 LLM tool，可直接参照；Tool 签名见 `doc/pi-wiki.md:978-1006`（`parameters: Type.Object(...)`、`execute(toolCallId, params, signal, onUpdate, ctx)`、`signal` 支持取消、`terminate:true` 跳过后续 LLM 调用）
- **subagent 落点**：新建 `src/extensions/hpl-delegate/`（或 `hpl-subagent/`），`pi.registerTool({ name: "delegate", ... })`，`discoverExtensions()` 自动发现，**无需改 cli.ts**

### 5.3 hapilon provider/model 现状：零 tier，turbo/pro/ultra 是全新设计

本次调研为 hapilon 落地的**核心增量**。探索确认的现状：

| 现状 | 位置 | 说明 |
|------|------|------|
| `ProviderDef = {id, name}` | `src/providers.ts:11-45` | **只有 id/name，9 个常用 provider + 16 个扩展，无 tier/role/capability** |
| `HapilonConfig = {defaultProvider?, defaultModel?, safetyNoticeShown?}` | `src/config-io.ts:7-11` | **单默认 provider + 单默认 model，无档位概念** |
| 配置文件位置 | `~/.hapilon/config.json` | `readHapilonConfig/writeHapilonConfig`，"非字符串 warn 并丢弃"防御风格 |
| 模型列表 + context window | `src/config.ts:392-440` `listModelsForProvider()` | 已能 `spawn pi --list-models` 拉模型 + context，tier 映射可复用 |

**turbo/pro/ultra 三档的精确落地点**：

```
┌─ src/config-io.ts ──────────────────────────────────────────────┐
│  扩展 HapilonConfig：                                            │
│    modelTiers?: {                                                │
│      turbo: string   // "zai/glm-4.5-flash"                      │
│      pro:   string   // "zai/glm-4.6"                            │
│      ultra: string   // "zai/glm-4.6-thinking"                   │
│    }                                                             │
│  （沿用 readHapilonConfig 现有的"非字符串 warn 并丢弃"防御风格）   │
└──────────────────────────────────────────────────────────────────┘
           │  hapilon config model-tier set turbo zai/glm-4.5-flash
           ▼
┌─ src/extensions/hpl-delegate/ + agent .md ───────────────────────┐
│  agent .md frontmatter 新增 tier 字段（hapilon 扩展，参考 §4.2）： │
│    tier: turbo      ← 解析时查 HapilonConfig.modelTiers.turbo    │
│  resolveModel 优先级（沿用 pi-subagents frontmatter-authoritative）：│
│    调用参数 model > frontmatter model > frontmatter tier > 父继承  │
└──────────────────────────────────────────────────────────────────┘
```

**与 PRD 既有设计的关系**：PRD §9.5 已设计了 `contextClass: small/medium/large`、`costClass: subscription/metered-api`、`preferredRoles: main/planner/reviewer/...`，PRD §10.13 还给了 small/medium/large 的 token 配额——但**全部未落地**（`ProviderDef` 仍是裸 id/name）。hapilon 的 turbo/pro/ultra 可视为这套设计的**简化先行版**：先用三档打通"agent 定义解耦具体 model id"，后续再演进到完整 capability registry + role router（PRD §9.6）。

> 📍 **本节设计已正式纳入 PRD §9.7.4（Model Tiers）**——含三档语义、`HapilonConfig.modelTiers` 配置形态、`hapilon config tier --set` 交互式配置（复用 `configSetDefaultInteractive` 范式）、resolveModel 优先级。**以 PRD §9.7.4 为权威单一来源**，本调研笔记保留作设计脉络参考。

### 5.4 安全模型：进程内路线下 hook 自动覆盖（决策带来的关键收益）

**进程内路线的最大安全收益**：`_backlog/prompt-injection-defense.md` 记录的"独立子进程 hook 盲区"问题**不复存在**——子会话由 `createAgentSession` 在同进程创建，并通过 `session.bindExtensions()` 重新加载扩展（见 §3.2），hapilon 的 safety-gate / protected-paths 会在**每个子会话内重新注册生效**，subagent 的 tool 调用自动受同样保护。

进程内路线的安全控制点（对应 pi-subagents 的机制）：

| 控制点 | 机制 | 出处 |
|--------|------|------|
| tool 白名单 | `createAgentSession({ tools: allowedTools })` 构造时钉死 | §3.2、§3.3 |
| 扩展裁剪 | `extensions:` / `exclude_extensions:` frontmatter | §2.3 |
| tool denylist | `disallowed_tools:` frontmatter | §2.3 |
| 防递归 spawn | `EXCLUDED_TOOL_NAMES` 剔除自注册的 delegate 工具 | §3.3、§7.1 |
| 首期只读策略 | agent 默认 `tools: read,grep,find,ls`（参考 Explore/Plan） | §3.5 |
| 隔离写入 | `isolation: worktree` 把可写 agent 关进临时 git worktree | §2.1 |

> ⚠️ **仍需注意**：进程内路线下扩展在子会话**重新加载**，意味着子会话会**重新执行扩展工厂代码**。若某扩展工厂有副作用（如直接订阅共享 `pi.events` 总线），它会在每个子会话里再跑一次——和 pi-subagents §7.3（exclude_extensions 不是沙箱）是同一个问题。hapilon 自研时扩展工厂应保持无副作用，副作用放到 `session_start` 等 hook 里。

> OS 沙箱（`--sandbox`）在进程内路线下不再是 subagent 的必需项（hook 已覆盖 tool 级），但仍可用于需要文件系统级强隔离的场景（如 `isolation: worktree`）。

### 5.5 hapilon 落地路径（改动面积从小到大）

| Tier | 改动 | 内容 |
|------|------|------|
| **1 纯扩展** | 新建 `src/extensions/hpl-delegate/` + `src/shared/subagent/` | `pi.registerTool("delegate")`，`execute()` 里 `createAgentSession({ cwd, sessionManager: SessionManager.inMemory(), modelRegistry: ctx.modelRegistry, model: <tier解析后的Model>, tools: allowedTools, resourceLoader })` 创建子会话；`session.subscribe()` 订阅 turn_end/compaction_end 做轮次/压缩统计；`session.abort()` 取消（接 Tool 的 `signal`）；`onUpdate` 上报进度。**直接 fork pi-subagents 的 `agent-runner.ts` 架构** |
| **2 配置层** | 扩展 `HapilonConfig`（config-io.ts）+ `ProviderDef`（providers.ts） | 加 `modelTiers`（turbo/pro/ultra）；`hapilon config model-tier ...` 子命令（扩 `src/config.ts:444-488` handleConfig） |
| **3 安全** | OS 沙箱 + 输出审计 | 复用 `--sandbox`；主进程层 stream-json 验证（补 hook 盲区，呼应 `_backlog/prompt-injection-defense.md`） |
| **4 持久化** | 启用预留目录 | `~/.hapilon/sessions/`（`hapilon-home.ts:24` 已创建未用）落 subagent session JSONL；`~/.hapilon/cache/`、`logs/` 同样预留 |
| **5 上层** | TaskPacket / 状态栏 | PRD §10 Context Orchestration（TaskPacket 装配，§10.10 的 12K Scout 例子）；hpl-footer 显示活跃 subagent 数（PRD line 1520） |

**建议起步**：先做 Tier 1 + 2——一个能 `delegate`（进程内 `createAgentSession`）、带 turbo/pro/ultra 三档、agent 由 `.md` 定义（frontmatter + tier）的 minimal 实现，验证整条链路。进程内路线下，pi-subagents 的 widget/FleetView/steer/调度等高级 feature **可分阶段直接搬**（首期可只搬 graceful max_turns + 基础并发，UI 留到后续）。

> ✅ **决策已定（2026-07-19）**：采用**进程内 `createAgentSession` 路线**。代价是偏离 PRD §9.7.1 的子进程方案——**PRD §9.7 需同步重写**（§9.7.1 启动参数从 `spawn pi --mode json ...` 改为 `createAgentSession(...)`，§9.7.3 写入策略、安全论述随之调整），否则违反 Living Documentation / Single Source of Truth 原则。建议在进入 `/write-plan` 前先更新 PRD。

---

## 6. 入门路线图（从零到能给 hapilon 写 subagent）

### 第一步：理解"子 agent = 隔离会话，不是新进程"
1. 知道 `createAgentSession()` 在同一运行时内造一个新会话对象
2. 知道子会话复用父会话的 `modelRegistry`，只是换 model/tools/prompt
3. 知道 frontmatter authoritative 原则

### 第二步：会用 `@tintinweb/pi-subagents`
1. `pi install npm:@tintinweb/pi-subagents`
2. 在 `.pi/agents/auditor.md` 写一个自定义 agent
3. 让主 agent 用 `Agent({subagent_type: "auditor", ...})` 调用它
4. 观察 widget / FleetView / 完成通知

### 第三步：读懂源码三件套
1. `custom-agents.ts`——.md 怎么被发现和解析
2. `agent-runner.ts:689-707`——子 session 怎么被 `createAgentSession` 拼出来
3. `prompts.ts`——system prompt 怎么按 replace/append 拼装

### 第四步：为 hapilon 设计 tier
1. 定 hapilon 的 turbo/pro/ultra 各映射到哪个 provider/model
2. 在 frontmatter 加 `tier` 字段，扩展 `resolveModel` 先解 tier
3. 写 hapilon 自己的默认 agent（Explore→turbo 等）

### 第五步：实现三工具 + 生命周期
1. `Agent` / `get_subagent_result` / `steer_subagent`
2. 挂 `session_start` / `session_shutdown` hook
3. 并发队列 + graceful max_turns

---

## 7. 常见陷阱

### 7.1 子 agent 递归 spawn
若不把 `Agent`/`get_subagent_result`/`steer_subagent` 从子 agent 的 toolset 剔除（`EXCLUDED_TOOL_NAMES`），子 agent 会再 spawn 子子 agent，指数爆炸。hapilon 自研时务必在 tool gating 时排除自注册的 spawn 工具。

### 7.2 frontmatter 字段的三态语义
很多字段是**三态**：`undefined`（省略=用默认/继承）≠ `false`（明确禁用）≠ 未设。例如 `inherit_context`：省略=调用方决定，`false`=锁定不继承。hapilon 解析 frontmatter 时要严格区分 `!= null`（已设）和值本身。

### 7.3 `exclude_extensions:` 不是沙箱
被 exclude 的扩展**工厂代码仍会在加载时执行一次**，只是不暴露 tool、不绑定 session 生命周期 hook。若工厂直接订阅了共享 `pi.events` 总线，它依然活跃。别用它隔离不可信扩展。

### 7.4 model 写错静默回退
frontmatter `model` 解析失败会**静默继承父 model**（只在 `/agents → Agent types` 标 `(unavailable, fallback: inherit)`）。若你指望某个 agent 用特定 model 却没核对，可能一直在用父 model。hapilon 的 tier 解析也要有明确的"解析失败"信号，别静默兜底（呼应 hapilon 的 Fail Fast 原则）。

### 7.5 worktree 隔离的硬保证
`isolation: worktree` 是**严格保证**不是提示——非 git 仓库 / 无 commit / `git worktree add` 失败时直接报错，不会降级成非隔离运行。hapilon 若实现此特性，别加"失败就跑普通模式"的兜底，那会破坏隔离承诺。

### 7.6 KV cache 与 prompt_mode 选择
append 模式刻意把父 prompt 原样前置以复用 KV cache。若 hapilon 自研时随意在父 prompt 外裹一层 wrapper 标签，会破坏字节前缀一致性，每次 spawn 都 cache miss。要么完全原样前置，要么接受 cache miss。

### 7.7 schedule 与 inherit_context / resume 互斥
`schedule` 不能配 `inherit_context`（调度触发时没有父对话）也不能配 `resume`（调度总是新 agent）。`run_in_background` 被强制 `true`，且调度触发**绕过并发队列**（防止短间隔被长任务阻塞）。

---

## 8. 参考资源

### 官方
- [pi.dev 包页 — @tintinweb/pi-subagents](https://pi.dev/packages/@tintinweb/pi-subagents) — 完整 README（本调研主要来源）
- [GitHub — tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) — 源码（master 分支）
- [Pi Package Catalog](https://pi.dev/packages) — 还有 `@gotgenes/pi-subagents`（in-process 版）、`nicobailon/pi-subagents`、`amosblomqvist/pi-subagents` 等同类实现可对比

### 源码关键文件（本调研精读）
- `src/index.ts` — 扩展入口、tool 注册、生命周期 hook、UI（104KB）
- `src/types.ts` — `AgentConfig` / `AgentRecord` 完整类型
- `src/custom-agents.ts` — .md 三层发现 + frontmatter 解析
- `src/agent-types.ts` — 统一注册表 + tool 名动态获取 + 大小写不敏感解析
- `src/agent-runner.ts:689-707` — **`createAgentSession` 子会话拼装**（hapilon 落地最关键）
- `src/agent-runner.ts:628-676` — tool 白名单拼装（含 `EXCLUDED_TOOL_NAMES` 防递归）
- `src/prompts.ts` — replace/append 双模式 + KV cache 字节前缀优化
- `src/default-agents.ts` — 三个内置 agent 配置（general-purpose/Explore/Plan）

### 上游官方（hapilon 进程内路线第一参考）
- **`@tintinweb/pi-subagents` 源码（本调研对象）** — 路线一致，直接 fork 其 `agent-runner.ts` / `agent-manager.ts` / `custom-agents.ts` / `prompts.ts` 架构
- [Pi 官方 subagent 扩展示例](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent) — 独立子进程样板（PRD 第 23 节引用），**降级**为隔离/沙箱场景备选参考
- [同类实现对比] `@gotgenes/pi-subagents`（in-process 版，与 tintinweb 路线对照）、`nicobailon/pi-subagents`、`amosblomqvist/pi-subagents`

### 本项目内（hapilon 现状，探索确认）
- `Hapilon-PRD-v1.1.md` §9.7（subagent 首期方案：子进程 + 只读白名单）、§9.5（capability registry 设计，未落地）、§9.6（role router，未落地）、§10.10（subagent 与小窗口模型）、§16.7（v0.0.7 只读 subagent 路线）
- `doc/pi-wiki.md` — Pi 扩展 API 权威参考：ExtensionAPI 全方法（:725-752）、Tool 注册签名（:978-1006）、Provider 注册（:858-873）、生命周期 hook（:185-229）、SDK createAgentSession（:1149-1232）
- `src/extensions.ts:15-42` — `discoverExtensions()`（扫 dist/extensions/，hapilon 扩展发现机制）
- `src/cli.ts:117-127, 194-202` — 扩展 `-e` 注入 + 现有 `spawn(piCli,...)` 链路（subagent 子进程复用基础）
- `src/providers.ts:11-45` — `ProviderDef={id,name}`（无 tier，turbo/pro/ultra 待扩展）
- `src/config-io.ts:7-11` — `HapilonConfig`（无 tier，`modelTiers` 待扩展）
- `src/config.ts:392-440` — `listModelsForProvider()`（已能拉模型 + context，tier 解析可复用）
- `src/extensions/hpl-panel-viewer/index.ts:59-99` — hapilon 已有的 LLM tool 注册范例
- `_backlog/prompt-injection-defense.md` — **subagent hook 盲区**（子进程路线最大安全约束）
- `_backlog/sessions-directory-reserved.md` / `cache-directory-reserved.md` / `logs-directory-reserved.md` — subagent 状态/产物预留落点
- `_foresight/1-pi-provider-config.md` — hapilon 多 provider 配置（tier 解析复用基础）
- `_foresight/2-pi-wrapper-roadmap.md:25` — hapilon 自己评估 subagent 为"P3 锦上添花，可通过扩展实现"
- `_foresight/5-pi-tui-extension-apis.md` — pi-tui above-editor 等 UI API（若未来搬 widget/FleetView）
