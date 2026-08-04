# Pi Coding Agent 技术 Wiki

> **版本**: 基于 Pi Coding Agent v0.80.6 (`@earendil-works/pi-coding-agent`)
> **文档来源**: Pi 官方 docs/、GitHub [pi-mono](https://github.com/earendil-works/pi-mono)、[npm 页面](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
> **编写日期**: 2026-07-12

---

## 目录

1. [概述](#1-概述)
2. [架构与代码组织](#2-架构与代码组织)
3. [CLI 与运行模式](#3-cli-与运行模式)
4. [生命周期与事件系统 (Hooks)](#4-生命周期与事件系统-hooks)
5. [SKILL 系统](#5-skill-系统)
6. [扩展系统 (Extensions)](#6-扩展系统-extensions)
7. [Provider 与模型系统](#7-provider-与模型系统)
8. [Session 与会话存储](#8-session-与会话存储)
9. [工具系统 (Tools)](#9-工具系统-tools)
10. [Settings 配置系统](#10-settings-配置系统)
11. [编译与上下文压缩 (Compaction)](#11-编译与上下文压缩-compaction)
12. [SDK 编程接口](#12-sdk-编程接口)
13. [RPC 模式](#13-rpc-模式)
14. [Packages 分发机制](#14-packages-分发机制)
15. [安全模型](#15-安全模型)

---

## 1. 概述

Pi 是一个**最小化的终端 Coding Agent 内核**。它的核心理念是保持 core 小而精简，通过 **TypeScript Extensions、Skills、Prompt Templates、Themes、Pi Packages** 五种机制进行扩展。

### 核心原则

| 原则 | 说明 |
|------|------|
| **Kernel 最小化** | 内核只提供 Agent 循环、Tool 执行、Session 管理，不绑定具体工作流 |
| **TypeScript 扩展** | 所有扩展点都用 TypeScript，通过 jiti 实时编译（无需构建步骤） |
| **渐进式披露** | Skills/Extensions 只有描述常驻上下文，完整指令按需加载 |
| **不修改原版体验** | 扩展不破坏内置 TUI、slash 命令、键盘快捷键 |

### 安装

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
# 或者
curl -fsSL https://pi.dev/install.sh | sh
```

### 核心能力一览

| 机制 | 说明 | 加载时机 |
|------|------|----------|
| **Extensions** | TypeScript 模块，注册 Tools/Commands/Hooks/UI | 启动时（可热重载） |
| **Skills** | 自包含技能包，遵循 [Agent Skills 标准](https://agentskills.io/specification) | 按需（描述常驻，正文使用时加载） |
| **Prompt Templates** | 可复用的 prompt 模板，通过 `/templatename` 展开 | 用户触发时 |
| **Themes** | 自定义终端主题 | 启动时加载 |
| **Packages** | npm/git/本地路径分发上述所有资源的打包格式 | 启动时 |

---

## 2. 架构与代码组织

### Monorepo 包结构

Pi 是一个 monorepo（[pi-mono](https://github.com/earendil-works/pi-mono)），包含以下包：

| 包 | npm 名称 | 职责 |
|----|----------|------|
| **coding-agent** | `@earendil-works/pi-coding-agent` | CLI 入口、TUI、Session、Extensions、Tools |
| **agent-core** | `@earendil-works/pi-agent-core` | Agent 循环逻辑、Tool 执行框架 |
| **ai** | `@earendil-works/pi-ai` | Provider 抽象、Model 定义、API 调用 |
| **tui** | `@earendil-works/pi-tui` | 终端 UI 组件库（Box、Text、自定义渲染） |

### configDir 机制

`package.json` 中定义 `piConfig.configDir`：

```json
{
  "piConfig": { "configDir": ".pi" }
}
```

这决定了 Pi 在用户 home 和项目目录下使用的配置目录名称（默认 `.pi`）。hapilon 通过设置 `PI_CODING_AGENT_DIR=~/.hapilon/agent/` 将其隔离。

### 目录布局

```
~/.pi/
└── agent/
    ├── settings.json     # 全局配置
    ├── auth.json         # Provider 认证凭据
    ├── trust.json        # 项目信任决策
    ├── sessions/         # Session JSONL 文件
    ├── extensions/       # 全局扩展 (*.ts)
    ├── skills/           # 全局 Skills
    ├── npm/              # npm 包安装
    └── git/              # git 包安装

项目目录/
└── .pi/
    ├── settings.json     # 项目级配置覆盖
    ├── extensions/       # 项目扩展
    ├── skills/           # 项目 Skills
    ├── SYSTEM.md         # 自定义 system prompt
    └── npm/              # 项目级 npm 包
```

---

## 3. CLI 与运行模式

### 基本用法

```bash
pi [options] [@files...] [messages...]
```

### 运行模式

| 模式 | 命令 | 说明 |
|------|------|------|
| **TUI (交互式)** | `pi`（默认） | 全功能终端 UI，含编辑器、对话树、命令补全 |
| **Print** | `pi -p "prompt"` | 单次问答，打印结果后退出 |
| **RPC** | `pi --mode rpc` | JSON-RPC over stdin/stdout，供 IDE/程序集成 |
| **JSON** | `pi --mode json` | 结构化 JSON 事件流输出 |

### 关键 CLI 参数

| 参数 | 说明 |
|------|------|
| `--provider <name>` | 指定 LLM provider |
| `--model <pattern>` | 指定模型，支持 `provider/id` 和 `:<thinking>` 后缀 |
| `-c` | 继续最近 session |
| `-r` | 浏览并选择历史 session |
| `--no-session` | 不持久化（临时模式） |
| `--name "name"` | 设置 session 显示名称 |
| `--session <path/id>` | 使用特定 session |
| `--fork <path/id>` | 从特定 session fork |
| `--no-context-files` / `-nc` | 禁用上下文文件加载 |
| `--no-skills` | 禁用 Skill 发现 |
| `--no-builtin-tools` | 禁用内置工具 |
| `--extension` / `-e <path>` | 加载额外扩展（可重复） |
| `--skill <path>` | 加载额外 Skill（可重复） |
| `--system-prompt <text>` | 替换 system prompt |
| `--append-system-prompt <text>` | 追加到 system prompt |
| `--list-models` | 列出所有可用模型 |
| `--approve` / `-a` | 信任当前项目 |
| `--no-approve` / `-na` | 不信任当前项目 |
| `--offline` | 禁用所有网络操作 |

### 交互式 Slash 命令

| 命令 | 说明 |
|------|------|
| `/login` / `/logout` | 管理认证 |
| `/model` | 切换模型 |
| `/settings` | 调整 thinking level、theme 等 |
| `/resume` | 浏览历史 session |
| `/new` | 新 session |
| `/name <name>` | 命名 session |
| `/session` | 查看 session 信息 |
| `/tree` | 导航 session 树 |
| `/fork` | 从历史消息 fork 新 session |
| `/clone` | 复制当前分支到新 session |
| `/compact [prompt]` | 手动压缩上下文 |
| `/export [file]` | 导出为 HTML |
| `/import <file>` | 导入 JSONL session |
| `/share` | 上传为 GitHub Gist |
| `/reload` | 热重载扩展/技能/主题/上下文文件 |
| `/changelog` | 查看版本历史 |
| `/quit` | 退出 |

### 消息队列机制

在 Agent 运行时仍可提交消息：

- **Enter** → 排队 steering 消息（当前 tool call 完成后发送）
- **Alt+Enter** → 排队 follow-up 消息（Agent 完全结束后发送）
- **Escape** → 取消并恢复到编辑器

---

## 4. 生命周期与事件系统 (Hooks)

> **这是 Pi 最核心的扩展机制。Extensions 通过订阅生命周期事件来拦截、修改、增强 Agent 行为。**

### 4.1 完整生命周期流程图

```
pi starts
  │
  ├─► project_trust (仅用户/全局扩展和 CLI -e 扩展，在项目资源加载前)
  ├─► session_start { reason: "startup" }
  └─► resources_discover { reason: "startup" }
      │
      ▼
user sends prompt ─────────────────────────────────────────┐
  │                                                        │
  ├─► (先检查 extension commands，匹配则直接执行)         │
  ├─► input (可拦截/转换/处理)                             │
  ├─► (若未被 handle: skill/template 展开)                 │
  ├─► before_agent_start (可注入消息、修改 system prompt)  │
  ├─► agent_start                                          │
  ├─► message_start / message_update / message_end         │
  │                                                        │
  │   ┌─── turn (重复，LLM 调用 tools 期间循环) ───┐       │
  │   │                                            │       │
  │   ├─► turn_start                               │       │
  │   ├─► context (可修改消息列表)                  │       │
  │   ├─► before_provider_headers (可修改 HTTP 头) │       │
  │   ├─► before_provider_request (可检查/替换请求) │       │
  │   ├─► after_provider_response (状态+头，流消费前)│       │
  │   │                                            │       │
  │   │   LLM 响应，可能调用 tools:                 │       │
  │   │     ├─► tool_execution_start               │       │
  │   │     ├─► tool_call (可 block)               │       │
  │   │     ├─► tool_execution_update               │       │
  │   │     ├─► tool_result (可修改)                │       │
  │   │     └─► tool_execution_end                 │       │
  │   │                                            │       │
  │   └─► turn_end                                 │       │
  │                                                        │
  ├─► agent_end                                            │
  └─► agent_settled (无 retry/compaction/follow-up 残留)   │
                                                           │
user sends another prompt ◄────────────────────────────────┘
```

### 4.2 Session 级生命周期

```
/new (新 session) 或 /resume (切换 session)
  ├─► session_before_switch (可取消)
  ├─► session_shutdown
  ├─► session_start { reason: "new" | "resume", previousSessionFile? }
  └─► resources_discover { reason: "startup" }

/fork 或 /clone
  ├─► session_before_fork (可取消)
  ├─► session_shutdown
  ├─► session_start { reason: "fork", previousSessionFile }
  └─► resources_discover { reason: "startup" }

/name 或 pi.setSessionName()
  └─► session_info_changed

/compact 或自动压缩
  ├─► session_before_compact (可取消或自定义摘要)
  └─► session_compact

/tree 导航
  ├─► session_before_tree (可取消或自定义摘要)
  └─► session_tree

/model 或 Ctrl+P
  ├─► thinking_level_select (若模型变化影响 thinking level)
  └─► model_select

exit (Ctrl+C, Ctrl+D, SIGHUP, SIGTERM)
  └─► session_shutdown
```

### 4.3 全部事件类型详解

#### 启动事件

##### `project_trust`

在 Pi 决定是否信任项目之前触发。只有用户/全局扩展和 CLI `-e` 扩展参与。

```typescript
pi.on("project_trust", async (event, ctx) => {
  // event.cwd - 当前工作目录
  // ctx.hasUI - 是否有 UI
  if (await ctx.ui.confirm("Trust project?", event.cwd)) {
    return { trusted: "yes", remember: true };
  }
  return { trusted: "undecided" };
});
```

返回值：`{ trusted: "yes" | "no" | "undecided" }`。首个 yes/no 决策生效，`undecided` 交给后面的 handler 或内置信任流程。

#### 资源事件

##### `resources_discover`

在 `session_start` 后触发，允许扩展贡献额外的 Skill/Prompt/Theme 路径。

```typescript
pi.on("resources_discover", async (event, _ctx) => {
  // event.cwd, event.reason ("startup" | "reload")
  return {
    skillPaths: ["/path/to/skills"],
    promptPaths: ["/path/to/prompts"],
    themePaths: ["/path/to/themes"],
  };
});
```

#### Session 事件

##### `session_start`

Session 启动、加载或重载时触发。

```typescript
pi.on("session_start", async (event, ctx) => {
  // event.reason - "startup" | "reload" | "new" | "resume" | "fork"
  // event.previousSessionFile
  ctx.ui.notify(`Session: ${ctx.sessionManager.getSessionFile()}`, "info");
});
```

##### `session_shutdown`

Session 运行时被销毁前触发。清理资源用。

```typescript
pi.on("session_shutdown", async (event, ctx) => {
  // event.reason - "quit" | "reload" | "new" | "resume" | "fork"
  // event.targetSessionFile
});
```

##### `session_before_switch`

新 session 或切换 session 前。可取消。

```typescript
pi.on("session_before_switch", async (event, ctx) => {
  // event.reason - "new" | "resume"
  // event.targetSessionFile (仅 "resume")
  if (!confirm) return { cancel: true };
});
```

##### `session_before_fork`

Fork/Clone 前触发。可取消。

```typescript
pi.on("session_before_fork", async (event, ctx) => {
  // event.entryId, event.position ("before" | "at")
  return { cancel: true }; // 或 { skipConversationRestore: true }
});
```

##### `session_before_compact` / `session_compact`

压缩事件。`session_before_compact` 可取消或提供自定义摘要；`session_compact` 是通知型事件。

##### `session_before_tree` / `session_tree`

`/tree` 导航事件。可取消或提供自定义摘要。

##### `session_info_changed`

Session 名称变更通知。

#### Agent 事件

##### `before_agent_start` ⭐ 最重要

用户提交 prompt 后、Agent 循环开始前。**可注入消息和修改 system prompt**。

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // event.prompt - 用户 prompt 文本
  // event.images - 附加图片
  // event.systemPrompt - 当前链式 system prompt
  // event.systemPromptOptions - 结构化 options:
  //   .customPrompt, .selectedTools, .toolSnippets,
  //   .promptGuidelines, .appendSystemPrompt,
  //   .cwd, .contextFiles, .skills

  return {
    // 注入持久化消息（存入 session，发给 LLM）
    message: {
      customType: "my-extension",
      content: "Additional context for the LLM",
      display: true,
    },
    // 替换本轮的 system prompt（链式，跨扩展传递）
    systemPrompt: event.systemPrompt + "\n\nExtra instructions...",
  };
});
```

**链式机制**：多个扩展都注册了 `before_agent_start` 时，`event.systemPrompt` 包含前面 handler 的修改结果。`ctx.getSystemPrompt()` 返回当前最新值。

##### `agent_start` / `agent_end` / `agent_settled`

- `agent_start`: 底层 agent run 开始
- `agent_end`: 底层 agent run 结束（但可能还有 auto-retry、auto-compact、follow-up）
- `agent_settled`: Agent 完全 settle（无后续自动操作），适合状态集成

##### `turn_start` / `turn_end`

每个 turn（一次 LLM 响应 + tool calls）的开始和结束。

```typescript
pi.on("turn_start", async (event, ctx) => {
  // event.turnIndex, event.timestamp
});
pi.on("turn_end", async (event, ctx) => {
  // event.turnIndex, event.message, event.toolResults
});
```

##### `message_start` / `message_update` / `message_end`

消息生命周期。`message_end` 可返回 `{ message }` 替换最终消息。

##### `context`

每次 LLM 调用前触发。可非破坏性地修改消息列表。

```typescript
pi.on("context", async (event, ctx) => {
  // event.messages - 深拷贝，可安全修改
  const filtered = event.messages.filter(m => !shouldPrune(m));
  return { messages: filtered };
});
```

##### `before_provider_headers`

HTTP 请求头发送前。可在 `event.headers` 上增/删/改。

```typescript
pi.on("before_provider_headers", (event, ctx) => {
  event.headers["x-session-id"] = ctx.sessionManager.getSessionId();
  event.headers["X-OpenRouter-Title"] = null; // 删除
});
```

##### `before_provider_request`

Provider 特定 payload 构建完成、发送前。可替换请求体。

```typescript
pi.on("before_provider_request", (event, ctx) => {
  console.log(JSON.stringify(event.payload, null, 2));
  // return { ...event.payload, temperature: 0 }; // 可选替换
});
```

##### `after_provider_response`

HTTP 响应收到后、stream body 消费前。

```typescript
pi.on("after_provider_response", (event, ctx) => {
  // event.status, event.headers
  if (event.status === 429) {
    console.log("rate limited", event.headers["retry-after"]);
  }
});
```

#### Model 事件

##### `model_select`

模型变更时（`/model`、`Ctrl+P`、session 恢复）。

```typescript
pi.on("model_select", async (event, ctx) => {
  // event.model, event.previousModel, event.source ("set"|"cycle"|"restore")
});
```

##### `thinking_level_select`

Thinking level 变更时。通知型，返回值忽略。

#### Tool 事件

##### `tool_call` ⭐ 关键

工具执行前触发。**可以 block**。`event.input` 可原地修改。

```typescript
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  if (isToolCallEventType("bash", event)) {
    event.input.command = `source ~/.profile\n${event.input.command}`;
    if (event.input.command.includes("rm -rf")) {
      return { block: true, reason: "Dangerous command" };
    }
  }
});
```

**行为保证**：
- `event.input` 变异影响实际工具执行
- 后续 handler 看到前序 handler 的修改
- 修改后不重新验证参数
- 返回 `{ block: true, reason?: string }` 阻止执行

##### `tool_result`

工具执行完成后、结果消息发送前。**可修改结果**。链式 middleware 模式。

```typescript
pi.on("tool_result", async (event, ctx) => {
  // event.toolName, event.toolCallId, event.input
  // event.content, event.details, event.isError
  return { content: [...], details: {...}, isError: false };
});
```

##### `tool_execution_start` / `tool_execution_update` / `tool_execution_end`

工具执行生命周期的细粒度事件。并行工具模式下，update 事件可能交错。

#### 输入事件

##### `input` ⭐ 输入拦截

用户输入接收后、Skill/Template 展开前触发。处理顺序：

1. Extension commands (`/cmd`) 先检查
2. `input` 事件触发
3. Skill commands (`/skill:name`) 展开
4. Prompt templates (`/template`) 展开
5. Agent 处理开始

```typescript
pi.on("input", async (event, ctx) => {
  // event.text - 原始输入（展开前）
  // event.images - 附加图片
  // event.source - "interactive" | "rpc" | "extension"
  // event.streamingBehavior - "steer" | "followUp" | undefined

  // 转换输入
  if (event.text.startsWith("?quick "))
    return { action: "transform", text: `Respond briefly: ${event.text.slice(7)}` };

  // 自行处理
  if (event.text === "ping") {
    ctx.ui.notify("pong", "info");
    return { action: "handled" };
  }

  return { action: "continue" }; // 默认：继续
});
```

返回值：`continue`（放行）、`transform`（改写）、`handled`（跳过 Agent）。

#### 用户 Bash 事件

##### `user_bash`

用户执行 `!` / `!!` 命令时。可拦截。

```typescript
pi.on("user_bash", (event, ctx) => {
  // event.command, event.excludeFromContext, event.cwd
  return { result: { output: "...", exitCode: 0, cancelled: false } };
});
```

---

## 5. SKILL 系统

Skills 是自包含的能力包，Agent 按需加载。Pi 实现了 [Agent Skills 标准](https://agentskills.io/specification)。

### 5.1 加载位置

```
~/.pi/agent/skills/        # 全局
~/.agents/skills/          # 全局（跨 harness）
.pi/skills/                # 项目（需信任）
.agents/skills/            # 项目（需信任，cwd 及祖先目录）
packages: skills/ 目录      # 从 packages
settings: skills 数组       # settings.json 指定
CLI: --skill <path>         # 可重复
```

### 5.2 工作方式（渐进式披露）

1. 启动时 Pi 扫描所有 Skill 位置，提取 `name` 和 `description`
2. System prompt 中包含所有 Skill 的 XML 格式列表（符合规范）
3. 当任务匹配时，Agent 使用 `read` 工具加载完整 SKILL.md
4. Agent 按指令执行，使用相对路径引用脚本和资源

**关键**：只有描述常驻上下文，完整指令按需加载。

### 5.3 SKILL.md 格式

```markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
license: MIT (可选)
compatibility: requires python3, node>=18 (可选)
metadata: { key: value } (可选)
allowed-tools: bash read write (可选，实验性)
disable-model-invocation: true (可选，隐藏)
---

# My Skill

## Setup
cd /path/to/skill && npm install

## Usage
./scripts/process.sh <input>
```

### 5.4 Frontmatter 规范

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | 1-64 字符，小写字母+数字+连字符。**Pi 不要求 name 匹配目录名**（标准有此要求，但 Pi 认为对共享 skill 目录不合理） |
| `description` | ✅ | 最长 1024 字符。决定 Agent 何时加载此技能。要具体！ |
| `license` | ❌ | 许可证名称 |
| `compatibility` | ❌ | 最长 500 字符，环境要求 |
| `metadata` | ❌ | 任意键值对 |
| `allowed-tools` | ❌ | 预批准工具列表（实验性） |
| `disable-model-invocation` | ❌ | `true` 时从 system prompt 隐藏，只能 `/skill:name` 调用 |

### 5.5 目录结构

```
my-skill/
├── SKILL.md              # 必需：frontmatter + 指令
├── scripts/              # 辅助脚本
│   └── process.sh
├── references/           # 详细参考文档
│   └── api-reference.md
└── assets/
    └── template.json
```

### 5.6 Skill Commands

通过 `/skill:name` 调用：

```bash
/skill:brave-search           # 加载并执行
/skill:pdf-tools extract      # 带参数
```

参数会以 `User: <args>` 形式追加到 Skill 内容后。

### 5.7 与其他 Harness 共用

Pi 可直接加载 Claude Code 和 OpenAI Codex 的 skills：

```json
{
  "skills": ["~/.claude/skills", "~/.codex/skills"]
}
```

### 5.8 验证规则

- name 超 64 字符或含无效字符 → 警告
- name 以连字符开头/结尾或有连续连字符 → 警告
- description 超 1024 字符 → 警告
- **缺少 description → 不加载**
- 未知 frontmatter 字段 → 忽略
- 同名冲突 → 警告，保留第一个

---

## 6. 扩展系统 (Extensions)

Extensions 是 TypeScript 模块，是 Pi 最强大的扩展机制。

### 6.1 加载位置

| 位置 | 作用域 |
|------|--------|
| `~/.pi/agent/extensions/*.ts` | 全局 |
| `~/.pi/agent/extensions/*/index.ts` | 全局（子目录） |
| `.pi/extensions/*.ts` | 项目（需信任） |
| `.pi/extensions/*/index.ts` | 项目（子目录） |
| `settings.json` 的 `extensions` 数组 | 额外路径 |
| CLI `-e ./path.ts` | 临时 |

通过 jiti 加载，TypeScript 无需编译。

### 6.2 基本结构

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 订阅事件
  pi.on("session_start", async (event, ctx) => { ... });

  // 注册工具
  pi.registerTool({ name: "my_tool", ... });

  // 注册命令
  pi.registerCommand("mycmd", { ... });

  // 注册快捷键
  pi.registerShortcut("ctrl+x", { ... });

  // 注册 CLI flag
  pi.registerFlag("my-flag", { ... });
}
```

### 6.3 可用的 Import

| 包 | 用途 |
|----|------|
| `@earendil-works/pi-coding-agent` | Extension 类型（ExtensionAPI、ExtensionContext、事件） |
| `typebox` | Tool 参数 schema |
| `@earendil-works/pi-ai` | AI 工具（StringEnum 等） |
| `@earendil-works/pi-tui` | TUI 组件 |
| Node.js built-ins | `node:fs`, `node:path` 等 |

### 6.4 ExtensionAPI 方法大全

| 方法 | 说明 |
|------|------|
| `pi.on(event, handler)` | 订阅生命周期事件 |
| `pi.registerTool(def)` | 注册自定义 Tool（LLM 可调用） |
| `pi.registerCommand(name, opts)` | 注册 `/command` |
| `pi.registerShortcut(key, opts)` | 注册键盘快捷键 |
| `pi.registerFlag(name, opts)` | 注册 CLI flag |
| `pi.registerProvider(name, config)` | 注册/覆盖 Provider |
| `pi.unregisterProvider(name)` | 移除 Provider |
| `pi.registerMessageRenderer(type, renderer)` | 自定义消息渲染 |
| `pi.registerEntryRenderer(type, renderer)` | 自定义 entry 渲染 |
| `pi.sendMessage(msg, opts)` | 注入自定义消息到 LLM |
| `pi.sendUserMessage(content, opts)` | 注入用户消息 |
| `pi.appendEntry(type, data)` | 持久化扩展数据（不参与 LLM 上下文） |
| `pi.setSessionName(name)` | 设置 session 名 |
| `pi.getSessionName()` | 获取 session 名 |
| `pi.setLabel(entryId, label)` | 设置/清除 entry 标签 |
| `pi.getActiveTools()` | 当前活跃工具列表 |
| `pi.getAllTools()` | 所有已配置工具 |
| `pi.setActiveTools(names)` | 设置活跃工具 |
| `pi.setModel(model)` | 设置当前模型 |
| `pi.getThinkingLevel()` / `pi.setThinkingLevel(lvl)` | 获取/设置 thinking level |
| `pi.exec(cmd, args, opts)` | 执行 shell |
| `pi.events` | 扩展间通信 EventBus |
| `pi.getFlag(name)` | 读取注册的 flag 值 |

### 6.5 ExtensionContext 详解

所有 handler 都接收 `ctx: ExtensionContext`。

| 属性/方法 | 说明 |
|-----------|------|
| `ctx.ui` | UI 方法（notify, confirm, select, input, setStatus, setWidget, custom） |
| `ctx.mode` | `"tui"` / `"rpc"` / `"json"` / `"print"` |
| `ctx.hasUI` | TUI/RPC 下为 true |
| `ctx.cwd` | 当前工作目录 |
| `ctx.isProjectTrusted()` | 项目是否被信任 |
| `ctx.sessionManager` | Session 只读访问 |
| `ctx.modelRegistry` / `ctx.model` | 模型注册表和当前模型 |
| `ctx.signal` | 当前 Agent 的 AbortSignal（turn 期间有值） |
| `ctx.isIdle()` | Agent 是否空闲 |
| `ctx.abort()` | 中止当前操作 |
| `ctx.shutdown()` | 请求优雅关闭 |
| `ctx.compact(opts)` | 触发 compaction |
| `ctx.getSystemPrompt()` | 获取当前 system prompt |
| `ctx.getContextUsage()` | 获取上下文使用量 |

### 6.6 ExtensionCommandContext（仅 Commands 可用）

命令 handler 收到扩展的 context，额外提供 session 控制：

| 方法 | 说明 |
|------|------|
| `ctx.getSystemPromptOptions()` | 获取 system prompt 构建输入 |
| `ctx.waitForIdle()` | 等待 Agent 完全 settle |
| `ctx.newSession(opts)` | 创建新 session 并切换 |
| `ctx.fork(entryId, opts)` | Fork 到新 session |
| `ctx.navigateTree(targetId, opts)` | 在 session 树中跳转 |
| `ctx.switchSession(path, opts)` | 切换到另一个 session |
| `ctx.reload()` | 触发 `/reload` |

### 6.7 异步工厂函数

扩展工厂可以是 async 的。Pi 会等待 async factory 完成后再继续启动。适用于启动时 fetch 远程配置、动态发现模型等。

```typescript
export default async function (pi: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/v1/models");
  const payload = await response.json();
  pi.registerProvider("local-openai", { ... });
}
```

### 6.8 状态管理

有状态的扩展应将状态存在 tool result 的 `details` 中，以支持 session 分支：

```typescript
pi.on("session_start", async (_event, ctx) => {
  // 从 session entries 重建状态
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "toolResult") {
      if (entry.message.toolName === "my_tool") {
        items = entry.message.details?.items ?? [];
      }
    }
  }
});
```

---

## 7. Provider 与模型系统

### 7.1 内置 Provider

Pi 内置支持 30+ Provider。完整列表见 [providers.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)。

主要 Provider 认证方式：

| Provider | 环境变量 | auth.json key |
|----------|----------|---------------|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek` |
| Google Gemini | `GEMINI_API_KEY` | `google` |
| Groq | `GROQ_API_KEY` | `groq` |
| xAI | `XAI_API_KEY` | `xai` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter` |
| 更多... | | |

### 7.2 auth.json 格式

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "deepseek": { "type": "api_key", "key": "sk-..." },
  "openai": { "type": "api_key", "key": "sk-..." }
}
```

### 7.3 认证解析顺序

1. 环境变量
2. `auth.json`
3. OAuth token（订阅 provider）

### 7.4 动态注册 Provider

扩展可通过 `pi.registerProvider()` 动态注册 Provider：

```typescript
pi.registerProvider("my-proxy", {
  name: "My Proxy",
  baseUrl: "https://proxy.example.com",
  apiKey: "$PROXY_API_KEY",    // 环境变量引用
  api: "anthropic-messages",
  models: [{
    id: "claude-sonnet-4-20250514",
    name: "Claude 4 Sonnet (proxy)",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16384
  }]
});
```

### 7.5 模型配置文件

模型定义在 `pi registerProvider` 时提供或 Pi 内置。每个模型包含：

| 字段 | 说明 |
|------|------|
| `id` | 模型 ID |
| `name` | 显示名称 |
| `reasoning` | 是否支持 reasoning/thinking |
| `input` | 支持的输入类型（text, image） |
| `cost` | 价格（input/output/cacheRead/cacheWrite） |
| `contextWindow` | 上下文窗口大小 |
| `maxTokens` | 最大输出 tokens |

---

## 8. Session 与会话存储

### 8.1 存储位置

```
~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl
```

其中 `<path>` 是工作目录路径，`/` 替换为 `-`。

### 8.2 文件格式

Session 是 JSONL 文件，每行一个 JSON 对象。Entry 通过 `id`/`parentId` 形成树结构（支持 in-place 分支）。

**核心 Entry 类型**：

| 类型 | role | 说明 |
|------|------|------|
| UserMessage | `"user"` | 用户输入 |
| AssistantMessage | `"assistant"` | LLM 响应 |
| ToolResultMessage | `"toolResult"` | 工具执行结果 |
| BashExecutionMessage | `"bashExecution"` | 用户 `!` 命令 |
| CustomMessage | `"custom"` | 扩展自定义消息 |
| BranchSummaryMessage | `"branchSummary"` | 分支摘要 |
| CompactionSummaryMessage | `"compactionSummary"` | 压缩摘要 |

### 8.3 消息内容块类型

```typescript
// 文本
{ type: "text", text: "..." }

// 图片
{ type: "image", data: "base64...", mimeType: "image/png" }

// 思考
{ type: "thinking", thinking: "..." }

// 工具调用
{ type: "toolCall", id: "...", name: "...", arguments: {...} }
```

### 8.4 树结构与会话分支

Session 通过 `/tree` 支持 in-place 分支，无需创建新文件：

```text
├─ user: "Hello..."
│  └─ assistant: "Hi!..."
│     ├─ user: "Approach A..."     ← 分支 A
│     │  └─ assistant: "For A..."
│     └─ user: "Approach B..."     ← 分支 B
│        └─ assistant: "For B..."
```

### 8.5 /tree、/fork、/clone 对比

| 特性 | `/tree` | `/fork` | `/clone` |
|------|---------|---------|----------|
| 输出 | 同一文件 | 新文件 | 新文件 |
| 视图 | 完整树 | 用户消息选择器 | 当前活跃分支 |
| 用途 | 原地探索替代 | 从早期 prompt 开始 | 复制当前工作后继续 |
| 摘要 | 可选分支摘要 | 无 | 无 |

---

## 9. 工具系统 (Tools)

### 9.1 内置工具

| 工具 | 说明 |
|------|------|
| `read` | 读取文件内容 |
| `bash` | 执行 shell 命令 |
| `edit` | 精确字符串替换编辑 |
| `write` | 写入/覆盖文件 |
| `grep` | 搜索文件内容 |
| `find` | 按名称搜索文件 |
| `ls` | 列出目录内容 |

### 9.2 注册自定义 Tool

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does (shown to LLM)",
  promptSnippet: "Short description for Available tools section",
  promptGuidelines: [
    "Use my_tool for planning instead of direct file edits."
  ],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) {
    // 可选：schema 变更兼容 shim
    return args;
  },
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // signal.aborted → 检查取消
    // onUpdate({...}) → 流式进度
    return {
      content: [{ type: "text", text: "Done" }],
      details: { result: "..." },
      terminate: true, // 可选：跳过后续 LLM 调用
    };
  },
  // 可选：自定义渲染
  renderCall(args, theme, context) { ... },
  renderResult(result, options, theme, context) { ... },
});
```

### 9.3 Tool 设计要点

- **StringEnum**：Google API 不支持 `Type.Union`/`Type.Literal`，必须用 `StringEnum`
- **错误信号**：throw Error = 失败；return 永远不是错误
- **prepareArguments**：在 schema 验证前运行，用于兼容旧 session
- **promptGuidelines**：必须明确命名工具（"Use my_tool when..."），不能写 "Use this tool when..."
- **文件变异队列**：修改文件的工具应用 `withFileMutationQueue()` 参与并行工具执行的文件锁

### 9.4 覆盖内置工具

扩展可以注册与内置工具同名的工具来覆盖：

```bash
pi -e ./tool-override.ts
```

覆盖时，渲染继承是**按 slot 的**。如果覆盖只提供 `execute` 而省略 `renderCall`/`renderResult`，内置渲染自动使用。

用 `--no-builtin-tools` 完全禁用内置工具。

---

## 10. Settings 配置系统

### 10.1 配置文件位置

| 文件 | 作用域 |
|------|--------|
| `~/.pi/agent/settings.json` | 全局 |
| `.pi/settings.json` | 项目（覆盖全局） |

### 10.2 核心 Settings

#### 模型与推理

| Setting | 类型 | 默认 | 说明 |
|---------|------|------|------|
| `defaultProvider` | string | - | 默认 provider |
| `defaultModel` | string | - | 默认模型 |
| `defaultThinkingLevel` | string | - | `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` |
| `hideThinkingBlock` | boolean | false | 隐藏思考块 |
| `thinkingBudgets` | object | - | 每个 thinking level 的自定义 token 预算 |

#### UI

| Setting | 类型 | 默认 | 说明 |
|---------|------|------|------|
| `theme` | string | `"dark"` | 主题名 |
| `externalEditor` | string | `$VISUAL` | 外部编辑器 |
| `quietStartup` | boolean | false | 隐藏启动头 |
| `enabledModels` | string[] | - | Ctrl+P 模型列表 |

#### 压缩

| Setting | 类型 | 默认 | 说明 |
|---------|------|------|------|
| `compaction.enabled` | boolean | true | 启用自动压缩 |
| `compaction.reserveTokens` | number | 16384 | 留给 LLM 响应的 token |
| `compaction.keepRecentTokens` | number | 20000 | 不摘要的最近 token |

#### 重试

| Setting | 类型 | 默认 | 说明 |
|---------|------|------|------|
| `retry.enabled` | boolean | true | 启用自动重试 |
| `retry.maxRetries` | number | 3 | 最大重试次数 |
| `retry.baseDelayMs` | number | 2000 | 指数退避基础延迟 |
| `retry.provider.maxRetries` | number | 0 | Provider 级重试（建议保持 0） |

#### Shell

| Setting | 类型 | 说明 |
|---------|------|------|
| `shellPath` | string | 自定义 shell 路径 |
| `shellCommandPrefix` | string | 每条 bash 命令的前缀 |
| `npmCommand` | string[] | npm 命令包装器 |

### 10.3 项目覆盖规则

项目 settings 覆盖全局 settings。嵌套对象是合并而非替换：

```json
// 全局
{ "theme": "dark", "compaction": { "enabled": true, "reserveTokens": 16384 } }

// 项目
{ "compaction": { "reserveTokens": 8192 } }

// 结果
{ "theme": "dark", "compaction": { "enabled": true, "reserveTokens": 8192 } }
```

---

## 11. 编译与上下文压缩 (Compaction)

### 11.1 触发条件

自动压缩当以下条件满足时触发：

```
contextTokens > contextWindow - reserveTokens (默认 16384)
```

也可手动触发 `/compact [instructions]`。

### 11.2 工作流程

1. **找切点**：从最新消息向后遍历，累积 token 直到达到 `keepRecentTokens`（默认 20k）
2. **提取消息**：从上一个保留边界（或 session 开头）到切点
3. **生成摘要**：调用 LLM 生成结构化摘要，有前次摘要时作为迭代上下文
4. **追加 entry**：保存 `CompactionEntry`
5. **重载**：Session 重新加载，使用摘要 + 从 `firstKeptEntryId` 往后的消息

### 11.3 分支摘要

`/tree` 导航时可为被放弃的分支生成摘要，保留关键上下文。

### 11.4 压缩扩展钩子

```typescript
// 自定义摘要
pi.on("session_before_compact", async (event, ctx) => {
  return {
    compaction: {
      summary: "custom summary...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    }
  };
});

// 通知
pi.on("session_compact", async (event, ctx) => {
  // event.compactionEntry, event.fromExtension, event.reason
});
```

---

## 12. SDK 编程接口

### 12.1 核心概念

SDK 允许在 Node.js 应用中嵌入 Pi 的 Agent 能力。

```typescript
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
```

### 12.2 createAgentSession()

主工厂函数，创建一个 `AgentSession`。

```typescript
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});
```

### 12.3 AgentSession 接口

```typescript
interface AgentSession {
  prompt(text: string, options?: PromptOptions): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  setModel(model: Model): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  navigateTree(targetId: string, options?): Promise<...>;
  compact(customInstructions?: string): Promise<CompactionResult>;
  abort(): Promise<void>;
  dispose(): void;

  // 状态
  sessionFile: string | undefined;
  sessionId: string;
  model: Model | undefined;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  isStreaming: boolean;
}
```

### 12.4 AgentSessionRuntime

当需要替换活跃 session 时使用（new/resume/fork/clone）。

```typescript
import { createAgentSessionRuntime } from "@earendil-works/pi-coding-agent";

const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(process.cwd()),
});

// Session 替换
await runtime.newSession();
await runtime.fork(entryId);
await runtime.switchSession(path);
```

**重要**：Session 替换后需重新订阅事件和重新 bind extensions。

### 12.5 PromptOptions

```typescript
interface PromptOptions {
  expandPromptTemplates?: boolean;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
  source?: InputSource;
  preflightResult?: (success: boolean) => void;
}
```

---

## 13. RPC 模式

### 13.1 启动

```bash
pi --mode rpc [options]
```

### 13.2 协议概述

- **Commands**: JSON 对象发送到 stdin，每行一个
- **Responses**: `type: "response"` 的 JSON 对象
- **Events**: Agent 事件作为 JSON 行流式输出到 stdout

所有 command 支持可选的 `id` 字段用于请求/响应对应。

### 13.3 主要 Commands

| Command | 说明 |
|---------|------|
| `prompt` | 发送用户 prompt |
| `steer` | 排队 steering 消息 |
| `follow_up` | 排队 follow-up 消息 |
| `abort` | 中止当前操作 |
| `new_session` | 开始新 session |
| `get_state` | 获取当前状态 |
| `get_messages` | 获取所有消息 |
| `set_model` | 切换模型 |
| `set_thinking_level` | 设置 thinking level |
| `set_session_name` | 命名 session |
| `compact` | 手动压缩 |
| `get_commands` | 列出可用命令 |

### 13.4 扩展 UI 协议

RPC 模式下，`ctx.ui` 方法通过 RPC 事件实现：
- `notify` → RPC 事件
- `confirm` / `select` / `input` / `editor` → RPC 请求-响应
- `setStatus` / `setWidget` / `setTitle` / `setEditorText` → RPC 事件

### 13.5 Framing 注意

RPC 使用严格的 JSONL 语义，仅 LF (`\n`) 作为记录分隔符。**不要用 Node.js `readline`**，因为它会把 `U+2028`/`U+2029` 也当成分隔符。

---

## 14. Packages 分发机制

### 14.1 Package 源类型

```bash
# npm
pi install npm:@scope/pkg@1.2.3

# git
pi install git:github.com/user/repo@v1

# 本地
pi install /absolute/path/to/package
pi install ./relative/path/to/package
```

### 14.2 Package 结构

在 `package.json` 中声明：

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

如果不声明 `pi` manifest，Pi 自动从约定目录发现：`extensions/`、`skills/`、`prompts/`、`themes/`。

### 14.3 依赖管理

- Extension/Skill 运行时依赖放在 `dependencies`
- Pi 核心包放在 `peerDependencies`：`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`
- 嵌套 Pi packages 放在 `dependencies` + `bundledDependencies`

### 14.4 过滤

可在 settings 中精确控制 package 加载哪些资源：

```json
{
  "packages": [{
    "source": "npm:my-package",
    "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
    "skills": [],
    "prompts": ["prompts/review.md"]
  }]
}
```

---

## 15. 安全模型

### 15.1 项目信任 (Project Trust)

交互式启动时，Pi 在加载项目本地资源前询问是否信任项目。

- 信任存储：`~/.pi/agent/trust.json`
- 信任前只能加载：上下文文件、用户/全局扩展、CLI `-e` 扩展
- 信任后才加载：`.pi/settings.json`、项目扩展、项目 skills

### 15.2 非交互模式信任

| 模式 | 行为 |
|------|------|
| `-p` / `--mode json` / `--mode rpc` | 不显示信任提示 |
| 无保存决策时 | 使用 `defaultProjectTrust`（默认 `"ask"`） |
| `-a` / `--approve` | 临时信任 |
| `-na` / `--no-approve` | 临时不信任 |

### 15.3 代码执行风险

- **Extensions** 以完整系统权限运行，可执行任意代码
- **Skills** 可指示模型执行任何操作（包括运行可执行文件）
- **Packages** 安装的扩展/skill 有同等权限

### 15.4 推荐的安全实践

- 只从信任源安装 packages
- 审查第三方 skill 和 extension 源码
- 使用 `/reload` 热重载而非重启（保持信任决策）
- 对敏感项目使用 `--no-approve` 标志

---

## 附录：hapilon 与 Pi 的关系

hapilon 是 Pi Coding Agent 的 CLI wrapper，设计要点：

| 方面 | Pi 原生 | hapilon |
|------|---------|---------|
| 配置目录 | `~/.pi/agent/` | `~/.hapilon/agent/`（通过 `PI_CODING_AGENT_DIR` 隔离） |
| Provider 配置 | `~/.pi/agent/auth.json` | `~/.hapilon/agent/auth.json` |
| Settings | `~/.pi/agent/settings.json` | Pi 原生格式，hapilon 不操作 |
| 默认模型 | Pi 原生 `settings.json` 中 | hapilon 自有 `~/.hapilon/config.json` + CLI 参数注入 |
| 管理命令 | `/login`, `/settings` 等 | `hapilon config`, `hapilon setup`, `hapilon doctor` |
| 启动方式 | 直接 `pi` | `hapilon` → spawn `pi` |

hapilon 的设计原则是**不修改 Pi 原生文件格式**，而是通过 CLI 参数注入和环境变量隔离来实现扩展。

---

> **最后更新**: 2026-07-12
> **源文档**: `node_modules/@earendil-works/pi-coding-agent/docs/`（v0.80.6）
> **GitHub**: [earendil-works/pi-mono](https://github.com/earendil-works/pi-mono)
