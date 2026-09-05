# Hapilon 产品需求文档（PRD）

> **文档类型**：产品需求文档 + 技术架构基线 + MVP 实施指南  
> **产品名称**：Hapilon  
> **核心运行时**：Pi Coding Agent  
> **内置工作流**：Wokii  
> **文档版本**：v1.1  
> **基线日期**：2026-07-12  
> **状态**：方案定稿，可进入最小版本实现
> **本次修订**：新增异构模型 Context Orchestration（上下文调和）完整设计

## v1.1 修订摘要

本次修订将不同 Context Window 模型的调和从路由器内部细节提升为 Hapilon 核心能力，新增：

- Canonical / Working / Session Context 三层模型；
- Context Budgeter、Assembler 与 Compatibility Matrix；
- Effective Input Budget 与 Context Pressure；
- Direct、Projection、Compact、Handoff、TaskPacket 策略；
- Main 模型切换与 Provider Fallback 的 Context Fit 约束；
- Role Context Profile；
- Tool Output Artifact 化；
- Managed Compaction 与完整性验证；
- Context MVP、测试、可观测性、风险和路线图。

---

## 0. 文档摘要

Hapilon 是一个以 **Pi Coding Agent** 为底层交互与 Agent Runtime、以 **Wokii** 为高级软件工程工作流、以 **多 Provider / 多 Model 调度**为模型资源层的通用终端 Coding Agent。

它首先解决三个现实问题：

1. 单一 Coding Agent 套餐或 API 的额度、时间窗口和价格不可控。
2. 不同模型在代码搜索、规划、实现、审查、总结等任务上的能力与成本并不相同。
3. Wokii 当前依赖 Claude Code 的 Skill、Hooks、Rules、Agents、Subagents 等机制，还需要额外适配 Codex、Cursor，长期维护成本高且受厂商演进牵制。

Hapilon 不 Fork Pi，也不在第一阶段重写 Pi 的 TUI。用户运行：

```bash
hapilon
```

Hapilon 薄启动器完成配置、版本、Profile 与资源注入后，启动其内部锁定版本的 `pi-coding-agent`，并保留 Pi 的原生 TUI、会话树、上下文压缩、模型选择和工具调用体验。

Hapilon 在 Pi 之上增加：

- 多 Provider 注册、额度账本与健康状态；
- Model Capability Registry；
- 按角色与任务选择模型的 Role Router；
- 面向不同 Context Window 的 Context Budgeter、Assembler、Projection 与 Handoff；
- 可使用不同 Provider/Model 的 Subagent Runtime；
- Cursor CLI / ACP 等外部 Coding Agent Backend；
- 深度集成但可关闭的 Wokii Runtime；
- 统一的任务状态、Artifact、Finding、Decision 与 Context Packet；
- 后续可扩展的权限、检查点、Worktree、审查和自动化能力。

Hapilon 的目标不是复制所有厂商 Coding Agent 的功能清单，而是建立一个由使用者掌控、能够长期演进的 Coding Harness。

---

# 1. 背景与问题

## 1.1 模型资源碎片化

当前可用模型资源可能来自：

- ChatGPT Plus / Pro 中的 Codex 配额；
- GLM Coding Plan；
- DeepSeek API；
- xAI、OpenRouter 或其他按量 API；
- 免费或低价模型；
- 公司提供的 Cursor Team 账号；
- 未来增加的其他 Coding Plan、订阅或企业模型服务。

这些资源具有不同的：

- 5 小时、每日、每周等额度窗口；
- 计费方式；
- 模型能力；
- 上下文窗口；
- 工具调用可靠性；
- 延迟；
- 可用性与限流状态；
- 账号和合规边界。

直接依赖某一家 Coding Agent，会导致其他已付费资源难以被统一利用。简单做轮询也无法保证高价值任务使用更好的模型、机械任务使用更便宜的模型。

## 1.2 Coding Harness 机制碎片化

Claude Code、Codex、Cursor 各自维护：

- 项目指令；
- Skills；
- Hooks；
- Rules；
- Agents / Subagents；
- 权限与 Sandbox；
- 会话；
- Plan / Review；
- Plugin / MCP；
- IDE 与云端能力。

这些概念相似，但文件格式、生命周期和语义不同。

Wokii 若继续分别适配每家 Coding Agent，将长期承担：

- 多份配置格式；
- 多份 Hook 映射；
- 多份 Agent 定义；
- 厂商版本变化；
- 行为不一致；
- 无法统一的上下文与工作流状态。

## 1.3 外部 Coding Agent 无法直接成为模型 Provider

Cursor CLI 不是一个普通 LLM Provider：

- Cursor 自己维护 Agent Loop；
- Cursor 自己维护会话；
- `cursor-agent -p --resume ...` 恢复的是 Cursor Thread；
- 其工具、上下文和规则由 Cursor Harness 管理；
- Pi 无法把 Cursor Thread 直接变成 Pi Session 的一部分。

因此，需要区分：

1. **Model Provider**：Pi/Hapilon 自己掌控 Agent Loop；
2. **External Agent Backend**：外部 Coding Agent 自己掌控 Agent Loop，Hapilon负责委派和收回结果。

## 1.4 裸 Pi 与完整 Coding Agent 的差异

Pi 的核心编码闭环已经完整：

```text
用户请求
→ 模型推理
→ read / write / edit / bash
→ 工具结果
→ 继续推理
```

但裸 Pi 有意保持精简，不默认内置完整的：

- Subagent；
- Plan Mode；
- 权限审批；
- Wokii 式状态机；
- MCP；
- 自动记忆；
- 专用 Review 工作流；
- Worktree Worker；
- 后台 Agent 管理。

这并非缺陷，而是 Hapilon 可以建立自身 Harness 的空间。

---

# 2. 产品愿景

## 2.1 一句话定义

> **Hapilon 是一个以 Pi 为交互内核、以 Wokii 为软件工程工作流、能够按照任务、角色、模型能力、额度和成本动态组织异构模型与外部 Coding Agent 协作的通用终端 Coding Agent。**

## 2.2 产品关系

```text
Hapilon
├── 通用 Coding Agent 产品与发行层
├── 多模型资源调度层
├── Agent / Workflow Harness
├── Wokii 官方高级工作流模块
└── Pi Coding Agent 运行内核
```

依赖关系必须保持：

```text
Wokii → Hapilon Core → Pi Runtime
```

禁止形成：

```text
Hapilon Core → 强依赖 Wokii Workflow
```

即：

- Wokii 是 Hapilon 的一等公民；
- Wokii 不是 Hapilon 唯一的人格和唯一运行方式；
- Hapilon 在不启动 Wokii 时，仍是可正常使用的通用 Coding Agent。

## 2.3 长期价值

Hapilon 的价值不只是“配额耗尽后自动换模型”，而是：

- 把多个模型资源组织成不同岗位；
- 把 Wokii 从 Claude Code 附属物升级为独立 Runtime；
- 将厂商机制降级为可选 Adapter，而非核心依赖；
- 保留 Pi 上游升级能力；
- 让用户掌控会话、流程、成本、策略、证据与质量门禁。

---

# 3. 产品目标与非目标

## 3.1 核心目标

### G1：提供稳定的 Hapilon CLI

用户输入：

```bash
hapilon
```

即可进入保留原版体验的 Pi TUI，无需单独安装全局 Pi。

### G2：统一模型资源层

统一管理：

- Provider；
- Model；
- 认证方式；
- 配额窗口；
- API 预算；
- 健康状态；
- 限流冷却；
- 模型能力；
- 路由策略。

### G3：按任务和角色选择 Provider-Model

支持为以下角色选择不同模型：

- Main；
- Scout；
- Planner；
- Worker；
- Reviewer；
- Tester；
- Summarizer；
- Challenger。

### G4：支持异构 Subagent / Multi-Agent

Main Agent 能够委派独立任务给使用不同 Provider/Model 的 Subagent，并通过结构化结果返回主流程。

### G5：将 Wokii 深度集成进 Hapilon

Wokii 具备自己的：

- Workflow；
- Phase；
- Gate；
- Rule；
- Lifecycle Handler；
- Agent Role；
- Artifact；
- Finding；
- Remark；
- Checkpoint；
- Validation。

### G6：保持通用 Coding Agent 能力

用户无需每次进入完整 Wokii 流程，简单任务能够直接完成。

### G7：接入 Cursor 等外部 Coding Agent

Cursor 以 `External Agent Backend` 接入，而不是伪装成 Pi Provider。

### G8：保持升级与维护可控

- 不 Fork Pi 作为常态；
- Pi 版本由 Hapilon 精确锁定并验证；
- Extension 与 Launcher 作为主要扩展点；
- 只有明确遇到 Extension/SDK 边界时，才考虑极小 Core Patch。

### G9：调和不同模型的 Context Window

- 不要求所有模型共享同一份巨大上下文；
- 保持小而稳定的 Canonical Task State；
- 按角色和目标模型生成不同的 Working Context；
- 在模型切换、Fallback、Subagent 和外部 Agent 交接前计算 Context Fit；
- 支持 Direct、Projection、Compaction、Handoff 和 New Session 等上下文策略；
- 完整 Session 与 Artifact 历史保留在存储中，但不默认全部发送给模型。

## 3.2 非目标

首期不追求：

- 复制 Claude Code、Codex、Cursor 的全部功能；
- 自研完整 TUI；
- 自研 IDE；
- 云端长期 Agent 平台；
- 操作系统级通用个人助理；
- 一开始实现强安全 Sandbox；
- 一开始支持多个并行写入 Worker；
- 一开始实现完美的配额预测；
- 一开始打成真正单文件二进制；
- 将 Cursor Team 账号强行转化为通用模型 API；
- 完全兼容所有 Claude Code/Codex 私有行为。

---

# 4. 用户与典型场景

## 4.1 目标用户

首要用户是：

- 同时拥有多个模型套餐或 API 的开发者；
- 已经建立个人 AI Coding 工作流的人；
- 希望掌控 Harness 而不是依赖单一厂商的人；
- 希望通过不同模型分工控制成本与提升质量的人；
- 愿意在终端中使用 Coding Agent 的高级用户。

## 4.2 典型场景

### 场景 A：普通代码修改

```bash
hapilon
```

用户输入：

```text
修复这个接口在 userId 为空时的异常，并补测试。
```

Hapilon 保持普通 Pi Agent Loop，不强制进入 Wokii 完整流程。

### 场景 B：复杂功能进入 Wokii

```bash
hapilon --mode wokii
```

执行：

```text
研究 → 设计 → 计划 → 实现 → 审查 → 验证
```

### 场景 C：廉价模型扫描，强模型规划

- Scout：DeepSeek 或免费模型；
- Planner：Codex 或 GLM 高阶模型；
- Main：稳定的 Coding 模型；
- Reviewer：与 Worker 不同 Provider。

### 场景 D：Cursor Team 作为 Worker

- Pi Main 理解需求；
- Pi Scout 查找代码；
- Wokii 生成 Task Packet；
- Cursor 在独立 Worktree 实现；
- Pi Reviewer 审查 Cursor Diff；
- Cursor Resume 修复 Findings；
- Main 最终验收。

### 场景 E：订阅额度紧张

- Codex 周额度压力较高；
- Role Router 将简单任务切换到 GLM；
- DeepSeek 承担日志总结；
- 保留 Codex 给高风险设计和最终审查；
- 发生 429 后标记冷却并改用可用资源。

---

# 5. 核心设计原则

## 5.1 薄启动器，不代理 TUI

Hapilon 负责启动前事务，Pi 负责 TUI。

```text
hapilon
  ↓
准备 Profile、配置、环境与资源
  ↓
spawn 内部 pi-coding-agent
  ↓
stdio: inherit
  ↓
Pi 原版 TUI
```

Hapilon 不应：

- 解析 Pi 的 ANSI 输出；
- 代理键盘；
- 重绘 Pi TUI；
- 通过 stdout 猜测工具调用；
- 维护第二套终端状态机。

## 5.2 不 Fork 优先

扩展优先级：

```text
Level 1：Pi Extension / Skill / Prompt / Package
Level 2：Hapilon 薄启动器
Level 3：Pi SDK 宿主
Level 4：极小 Core Patch
```

## 5.3 能力存在不等于每次激活

Wokii、Subagent、Reviewer、Workflow Gate 可以内置，但不应强制所有任务使用。

## 5.4 上下文统一不等于会话统一

Hapilon 不强迫：

- Pi Session；
- Cursor Thread；
- 未来 Claude/Codex 外部 Thread；

共享同一个底层会话文件。

统一的是：

- 目标；
- 约束；
- 决策；
- 证据；
- 工作区状态；
- 修改结果；
- Findings；
- 验收状态。

## 5.5 Hapilon 持有权威任务状态

Pi Session、Cursor Thread、Subagent Session 都只是执行上下文和缓存。

```text
Canonical Task State = Hapilon / Wokii Run
```

## 5.6 角色绑定能力，不绑定单一模型

错误：

```yaml
reviewer:
  model: glm-x
```

推荐：

```yaml
reviewer:
  requirements:
    reasoning: high
    structuredOutput: high
    writeAccess: false
  policy:
    differentProviderFrom: worker
```

具体模型由 Role Router 在运行时选择。

## 5.7 多 Agent 必须受预算约束

多 Agent 不是越多越好。默认只在以下条件触发：

- 需要扫描大量代码；
- 可并行拆分；
- 需要独立审查；
- Main 上下文过重；
- 子任务结果可压缩、可验证；
- 委派收益明显高于额外 Token 成本。

## 5.8 共享任务事实，而不是共享完整会话

不同模型的 Context Window、消息协议和 Agent Harness 并不一致。Hapilon 不把“所有参与者读取同一份完整聊天记录”当作连续性的前提。

统一层次为：

```text
Canonical Task State        所有模型共享的权威任务事实
Role Working Context        当前角色需要的任务视图
Session / Artifact History  完整保存、按需检索，不默认发送
```

长窗口模型可以获得更多原始证据和最近历史；小窗口模型只获得 Portable Core 与角色相关内容。模型之间共享目标、约束、决策、证据、Git 状态和结果，而不是复制彼此全部 Tool Call 与聊天消息。

---

# 6. 运行模式

## 6.1 General 模式

```bash
hapilon
hapilon --mode general
```

特点：

- Provider Router 可工作；
- 普通 Subagent 工具可用；
- 通用 Skills 可用；
- 不自动启动 Wokii Run；
- 不强制生成设计和计划；
- 不加载完整 Wokii Phase 规则。

适用：

- 代码解释；
- 简单 Bug；
- 单文件修改；
- 日常问答；
- 快速测试修复。

## 6.2 Assisted 模式

```bash
hapilon --mode assisted
```

建议作为长期默认模式。

特点：

- Wokii 能力可被发现；
- Main Agent 可建议进入某个阶段；
- 用户可显式调用：
  - `/wokii-research`
  - `/wokii-plan`
  - `/wokii-review`
  - `/wokii-verify`
- 简单任务仍可直接执行。

## 6.3 Wokii Workflow 模式

```bash
hapilon wokii
hapilon --mode wokii
```

完整启用：

```text
Research
→ Requirement
→ Design
→ Plan
→ Implement
→ Review
→ Verify
```

具备：

- Workflow Run；
- 阶段状态；
- Gate；
- Artifact；
- Finding；
- Remark；
- Subagent；
- Resume；
- 审计与验收。

---

# 7. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│ Hapilon CLI / Launcher                                      │
│ Profile、版本、配置、参数透传、环境变量、启动与分发          │
└───────────────────────────┬─────────────────────────────────┘
                            │ spawn + stdio inherit
┌───────────────────────────▼─────────────────────────────────┐
│ Pi Coding Agent Runtime                                     │
│ TUI、Agent Loop、Session、Tree、Compaction、Tool Execution   │
└───────────────────────────┬─────────────────────────────────┘
                            │ Hapilon Core Extension
┌───────────────────────────▼─────────────────────────────────┐
│ Hapilon Core                                                 │
│ Provider Registry / Quota / Capabilities / Role Router        │
│ Context Orchestrator / Agent Registry / Backend Adapter / UI   │
└───────────────────────────┬─────────────────────────────────┘
                            │
           ┌────────────────┴────────────────┐
           │                                 │
┌──────────▼──────────┐           ┌──────────▼────────────┐
│ Pi Native Backends  │           │ External Agent Backend│
│ Codex/GLM/DeepSeek  │           │ Cursor CLI / Cursor ACP│
└──────────┬──────────┘           └──────────┬────────────┘
           │                                 │
           └────────────────┬────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ Wokii Runtime                                               │
│ Workflow / Phase / Gate / Artifact / Finding / Decision     │
│ TaskPacket / AgentResult / Checkpoint / Validation          │
└─────────────────────────────────────────────────────────────┘
```

---

# 8. 领域模型

## 8.1 Execution Resource

```text
ExecutionResource
├── ModelProvider
└── AgentBackend
```

### ModelProvider

Pi/Hapilon 掌控 Agent Loop。

例：

- OpenAI Codex subscription；
- GLM Coding Plan；
- DeepSeek API；
- OpenRouter；
- xAI；
- 其他兼容 Provider。

### AgentBackend

外部系统掌控 Agent Loop。

例：

- Cursor CLI；
- Cursor ACP；
- 未来 Claude Code CLI；
- 未来 Codex CLI 外部模式；
- 其他 Headless Coding Agent。

## 8.2 Wokii 内部语义

Wokii 不继续以某一家 Harness 的文件格式作为核心模型。

| 外部概念 | Wokii/Hapilon 内部概念 |
|---|---|
| `SKILL.md` | `WorkflowModule` |
| Claude Rules | `ContextRule` / `PolicyRule` |
| Hooks | `LifecycleHandler` |
| Agent | `RoleDefinition` |
| Subagent | `WorkerSession` |
| Plan | `WorkflowRun + PhaseArtifact` |
| Todo | `WorkItem` |
| `../../CLAUDE.md` / `AGENTS.md` | `ProjectInstruction` |
| Agent 输出 | `AgentResult / Finding / Artifact` |
| Hook State | `RunState / EventRecord` |

Claude、Codex、Cursor 的格式只作为：

```text
Importer / Exporter / Compatibility Adapter
```

而不是 Runtime 本体。

---

## 8.3 Context 领域模型

Hapilon 将 Context 拆成三种不同职责的数据，而不是把“Context”简化为聊天消息数组。

### Canonical Context

权威、结构化、可移植的任务状态：

- 目标；
- 约束；
- 验收标准；
- 已确认决策；
- 当前阶段；
- 关键证据；
- 修改文件；
- Git HEAD；
- 开放 Findings；
- 待解决问题。

它由 Hapilon/Wokii 持久化，设计目标通常控制在约 `4K～16K tokens`，但不以固定硬限制代替实际预算。

### Working Context

当前模型、当前角色和当前步骤真正需要的工作集，例如：

- 当前相关文件；
- 当前 Diff；
- 调用链摘要；
- 测试失败摘要；
- 当前 Phase 规则；
- Reviewer Findings。

Working Context 每次按目标模型重新装配，而不是永久绑定某一 Session。

### Session / Artifact Context

完整执行历史，包括：

- 原始对话；
- Tool Calls 与 Tool Results；
- 长日志；
- 旧方案；
- 失败尝试；
- 完整文件和 Diff Artifact。

这些内容完整保存在 Session、Artifact Store 或 Git 中，但默认不全部发送给模型。需要时通过检索、文件读取或 Context Projection 重新引入。

### Context Segment

```typescript
interface ContextSegment {
  id: string;

  priority:
    | "required"
    | "high"
    | "medium"
    | "optional";

  kind:
    | "system"
    | "task-state"
    | "decision"
    | "evidence"
    | "file"
    | "diff"
    | "recent-turn"
    | "tool-output"
    | "history-summary";

  estimatedTokens: number;

  compression:
    | "none"
    | "summary"
    | "extract"
    | "truncate"
    | "retrieve-on-demand";

  content: string;
}
```

Context Segment 是 Context Assembler 的最小装配单元，也是后续可测试、可观测和可解释的基础。

# 9. 功能需求

## 9.1 Hapilon Launcher

### 9.1.1 基本命令

```bash
hapilon
hapilon setup
hapilon doctor
hapilon config
hapilon profiles
hapilon version
hapilon wokii
```

### 9.1.2 参数透传

除 Hapilon 自身命令外，其他参数直接交给 Pi：

```bash
hapilon --resume
hapilon --continue
hapilon --model provider/model
hapilon --thinking high
hapilon -p "分析当前项目"
```

推荐支持分隔：

```bash
hapilon --profile work -- --model provider/model -c
```

- `--` 前属于 Hapilon；
- `--` 后原样交给 Pi。

### 9.1.3 启动前工作

Launcher 负责：

1. 读取 Profile；
2. 检查目录；
3. 检查 Pi 配套版本；
4. 检查 Extension 资源；
5. 配置 Schema 校验；
6. 注入环境变量；
7. 生成 Run ID；
8. 清理过期锁；
9. 执行配置迁移；
10. 启动 Pi；
11. 透传退出码和信号。

### 9.1.4 TTY 要求

必须使用：

```typescript
spawn(command, args, {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
});
```

不得默认使用：

```typescript
stdio: "pipe"
```

交互式主进程中，Pi 必须直接继承：

- stdin；
- stdout；
- stderr；
- TTY；
- Raw Mode；
- Ctrl+C；
- Resize；
- 剪贴板与图片输入。

## 9.2 Profile 与目录

### 9.2.1 默认独立 Profile

推荐：

```text
~/.hapilon/
├── config.json
├── profiles/
│   └── default/
│       ├── pi-agent/
│       ├── sessions/
│       ├── routing.yaml
│       └── providers.yaml
├── quota.db
├── runs/
├── logs/
└── cache/
```

通过环境变量设置：

```text
PI_CODING_AGENT_DIR
PI_CODING_AGENT_SESSION_DIR
HAPILON_HOME
HAPILON_PROFILE
HAPILON_RUN_ID
HAPILON_MODE
```

### 9.2.2 可选共享 Pi Profile

```bash
hapilon --profile shared
```

允许共享 `~/.pi/agent`，但默认不使用，以避免 Hapilon 与普通 Pi 配置互相污染。

## 9.3 Provider Registry

职责：

- 注册 Pi 原生 Provider；
- 注册自定义 Provider；
- 管理 Provider 认证状态；
- 管理模型列表；
- 标记资源类型；
- 提供 Provider 可用性。

示例：

```yaml
providers:
  codex-plus:
    type: subscription
    provider: openai-codex
    authProfile: default

  glm-plan:
    type: coding-plan
    provider: zai
    authProfile: work

  deepseek-api:
    type: metered-api
    provider: deepseek
    budget:
      dailyUsd: 2.0
```

## 9.4 Quota Ledger

记录：

- 使用窗口类型；
- 窗口开始/结束；
- 已使用量；
- 估算剩余量；
- 429；
- Retry-After；
- 最近成功；
- 失败次数；
- 冷却结束时间；
- 每日 API 成本；
- 每任务成本。

首期可采用本地 SQLite 或 JSON，后续优先 SQLite。

### 9.4.1 配额压力

概念公式：

```text
quotaPressure =
  usedFraction / elapsedWindowFraction
```

含义：

- 使用速度超过窗口时间流逝速度时，压力上升；
- 保留关键 Provider 给高价值任务。

### 9.4.2 路由评分

概念模型：

```text
routeScore =
  roleFitness
+ qualityScore
+ resetSoonBonus
+ contextStickiness
- quotaPressure
- monetaryCost
- failurePenalty
- switchPenalty
- latencyPenalty
```

该公式是策略框架，不要求首期一次实现所有项。

## 9.5 Model Capability Registry

每个模型至少记录：

```yaml
models:
  provider/model:
    reasoning: high
    toolCalling: high
    editing: high
    structuredOutput: high
    contextClass: large
    latency: medium
    costClass: subscription
    vision: true
    preferredRoles:
      - main
      - planner
      - reviewer
```

能力信息来源：

- 手工配置；
- 官方模型元数据；
- Hapilon 实际评测；
- 用户覆盖配置。

## 9.6 Role Router

### 9.6.1 核心角色

#### Main

职责：

- 用户沟通；
- 维护主上下文；
- 决策；
- 委派；
- 汇总；
- 验收。

#### Scout

职责：

- 查找文件；
- 调用链；
- 测试；
- 配置；
- 返回证据。

默认只读。

#### Planner / Architect

职责：

- 形成实现计划；
- 评估影响；
- 风险和验证；
- 不直接改代码。

#### Worker

职责：

- 修改代码；
- 运行局部测试；
- 返回 Diff 和结果。

#### Reviewer

职责：

- 独立检查逻辑、边界、安全和一致性；
- 尽量使用与 Worker 不同 Provider。

#### Tester / Debugger

职责：

- 执行测试；
- 分类失败；
- 提取关键错误；
- 给出下一步排查。

#### Summarizer

职责：

- 压缩长日志；
- 压缩子 Agent 输出；
- 减少 Main 上下文。

#### Challenger

职责：

- 不重新完成整个任务；
- 专门寻找方案反例、遗漏与风险。

### 9.6.2 角色策略

```yaml
roles:
  reviewer:
    requirements:
      reasoning: high
      structuredOutput: high
      writeAccess: false
    policy:
      differentProviderFrom: worker
      maxEstimatedCostUsd: 0.30
      maxTurns: 4
    candidates:
      - provider: glm-plan
        model: glm-x
      - provider: deepseek-api
        model: deepseek-reasoner
      - provider: codex-plus
        model: codex-x
        reserveRequired: true
```

## 9.7 Subagent Runtime

### 9.7.1 首期实现方式

> 📍 **架构决策（2026-07-19）**：采用**进程内 `createAgentSession` 路线**（与 `@tintinweb/pi-subagents` 一致），放弃早期设想的 `spawn pi --mode json` 独立子进程方案。决策理由见下方"优点"与 §9.7.1.1 安全模型；调研依据见 `_foresight.md`（Pi-Subagents 与 Hapilon Subagent 系统）。

在同一 Pi 运行时内创建独立会话对象（非新进程），由 `src/extensions/hpl-delegate/` 扩展注册 `delegate` 工具触发：

```typescript
const { session } = await createAgentSession({
  cwd,
  sessionManager: SessionManager.inMemory(),   // 或 .create() 持久化
  modelRegistry: ctx.modelRegistry,            // ★ 复用父会话——所有 provider 配置都在
  model,                                        // resolveModel 解析（支持 tier，见 §9.7.4）
  tools: allowedTools,                          // ★ 构造时钉死的 tool 白名单
  resourceLoader,                               // 按 extensions:/exclude_extensions: 过滤
  thinkingLevel,
});
await session.bindExtensions();                 // 触发 session_start，扩展重新加载
session.subscribe(event => { ... });            // 订阅 turn_end / compaction_end
session.abort();                                // 取消（接 delegate 工具的 AbortSignal）
```

优点：

- 独立上下文（会话隔离，不污染父对话）；
- 独立模型（每 subagent 可设不同 model / tier）；
- 独立工具集（构造时白名单钉死）；
- 低开销（无进程启动，同运行时内创建会话对象）；
- **主进程 `tool_call` hook 在子会话内仍生效**——hpl-safety-gate / hpl-protected-paths 自动覆盖 subagent（见 §9.7.1.1）；
- `modelRegistry` 复用，无需子进程传参；
- 容易并行（多 session 对象）和取消（`session.abort()` / AbortSignal）；
- pi-subagents 的高级 feature（graceful max_turns、mid-run steering、widget、调度）可分阶段移植。

代价：

- 隔离强度弱于独立子进程（同进程共享内存 / modelRegistry）——tool 级由 hook 可控，文件系统级由 `isolation: worktree` 补强；
- subagent 递归 spawn 需在 tool gating 时剔除自注册的 `delegate` 工具（参考 pi-subagents 的 `EXCLUDED_TOOL_NAMES`）。

#### 9.7.1.1 安全模型（进程内路线的关键收益）

进程内路线下，子会话通过 `session.bindExtensions()` **重新加载扩展**，hapilon 的 hpl-safety-gate / hpl-protected-paths 在每个子会话内重新注册生效——`_backlog/prompt-injection-defense.md` 记录的"独立子进程 hook 盲区"问题**不复存在**。

安全控制点：

| 控制点 | 机制 |
|--------|------|
| tool 白名单 | `createAgentSession({ tools })` 构造时钉死 |
| 扩展裁剪 | agent `.md` 的 `extensions:` / `exclude_extensions:` |
| tool denylist | agent `.md` 的 `disallowed_tools:` |
| 防递归 spawn | 剔除 `delegate` 工具本身 |
| 只读策略（首期） | agent 默认 `tools: read,grep,find,ls` |
| 写入隔离 | `isolation: worktree`（临时 git worktree） |

> 注意：扩展工厂在子会话会**重新执行**，工厂应保持无副作用（副作用放 `session_start` 等 hook）。`exclude_extensions:` 不是沙箱——被排除的扩展工厂代码仍会执行一次，只是不暴露 tool、不绑定 hook。

### 9.7.2 支持模式

#### 单次委派

```text
Main → Scout → Main
```

#### 并行侦察

```text
Main
├── Scout A
├── Scout B
└── Tester
```

#### 流水线

```text
Scout → Planner → Worker → Reviewer → Main
```

#### 挑战者

```text
Main 方案 → Challenger → Main 修订
```

### 9.7.3 写入策略

首期：

```text
只有 Main 可写；
Subagent 默认只读。
```

后续：

- Worker 使用独立 Git Worktree；
- 多个并行 Worker 每人一个 Worktree；
- Main 审查 Patch 后合并。

### 9.7.4 Model Tiers（turbo / pro / ultra）

hapilon 将可用 model 抽象为三档，供 subagent（及未来的 Role Router）通过档位名引用，**解耦 agent 定义与具体 provider/model id**——换 provider 或换 model 只改档位映射，不动每个 agent 的 `.md`。

#### 三档语义

| 档位 | 定位 | 典型用途 |
|------|------|---------|
| `turbo` | 快、便宜、上下文适中 | 只读侦察（Scout / Explore）、批量并行、简单分类 |
| `pro` | 平衡，主力 | 通用 subagent（general-purpose）、规划、摘要 |
| `ultra` | 强推理、贵、慢 | 深度审查（Reviewer）、架构设计、挑战者（Challenger） |

档位语义参考 pi-subagents 的默认 agent 分配（Explore→haiku 对应 turbo；深度审查→opus 对应 ultra）。

#### 配置形态（用户配置项，不硬编码）

档位映射存入 `HapilonConfig`（`../src/config-io.ts`），格式 `"provider/modelId"` 单字符串（与 pi-subagents 的 model 字段一致）：

```typescript
interface HapilonConfig {
  defaultProvider?: string;
  defaultModel?: string;
  safetyNoticeShown?: boolean;
  modelTiers?: {
    turbo?: string;   // "zai/glm-4.5-flash"
    pro?: string;     // "zai/glm-4.6"
    ultra?: string;   // "deepseek/deepseek-reasoner"
  };
}
```

三档可跨 provider（turbo 用 zai、ultra 用 deepseek），不强求同一 provider。读取时沿用现有 `readHapilonConfig` 的逐字段类型校验 + "非字符串 warn 并丢弃"防御风格。

#### 交互式配置（复用现有 default 设置范式）

复用 `hapilon config default --set` 的交互范式（readline 编号选择 + `spawn pi --list-models` 拉模型列表，见 `../../src/config.ts` 的 `configSetDefaultInteractive`），新增子命令：

```text
hapilon config tier --set              # 依次为 turbo/pro/ultra 各选 provider + model
hapilon config tier --set turbo        # 只设某一档
hapilon config tier --unset            # 清除所有档位
hapilon config tier --unset turbo      # 清除某一档
hapilon config show                    # 显示三档当前映射（扩展现有 configShow）
```

`config tier --set` 交互流程（每档重复，复用 `configSetDefaultInteractive` 的步骤）：

```text
正在配置 turbo 档位
已配置 auth 的 Provider:
  1. zai              (ZAI GLM)
  2. deepseek         (DeepSeek)
选择 Provider [1-2]: 1
正在获取 ZAI GLM 模型列表...
ZAI GLM 可用模型:
  1. glm-4.5-flash    (128K)
  2. glm-4.6          (128K)
选择模型 [1-2]: 1
✅ turbo = zai/glm-4.5-flash

是否继续配置 pro？(Y/n)
...
```

#### resolveModel 优先级

subagent spawn 时解析 model（沿用 pi-subagents 的 frontmatter-authoritative 哲学）：

```text
调用参数 model  >  agent .md frontmatter model  >  agent .md frontmatter tier  >  父 session model
```

- frontmatter 显式 `model: provider/modelId` → 直接用（最高优先级）；
- frontmatter `tier: turbo` → 查 `HapilonConfig.modelTiers.turbo`；**未配置则明确报错并拒绝 spawn**（Fail Fast，不静默回退父 model——区别于 pi-subagents 的静默继承，呼应 hapilon 原则 1）；
- 都没设 → 继承父 session 的 model。

#### 与 §9.5 / §9.6 的关系

turbo/pro/ultra 是 §9.5 Model Capability Registry（`contextClass` / `costClass` / `preferredRoles`）的**简化先行版**：先用三档打通"agent 定义解耦 model id"，后续随 §9.6 Role Router 落地，档位可演进为按角色自动路由（如 reviewer 角色自动用 ultra 档）。首期不做自动路由，tier 由 agent `.md` 显式指定。

## 9.8 Agent Backend

统一接口：

```typescript
interface ExecutionBackend {
  kind: "native-model" | "external-agent";

  capabilities(): BackendCapabilities;

  startTask(packet: TaskPacket): Promise<TaskHandle>;

  continueTask(
    handle: TaskHandle,
    update: ContextDelta,
  ): Promise<AgentResult>;

  cancelTask(handle: TaskHandle): Promise<void>;
}
```

### 9.8.1 Pi Native Backend

```text
kind = native-model
runtime = pi
session = Pi Session / Pi child process
model = Codex / GLM / DeepSeek / ...
```

### 9.8.2 Cursor Backend

```text
kind = external-agent
runtime = Cursor CLI 或 ACP
session = Cursor Thread
workspace = 指定目录或 Worktree
```

Cursor 不进入 Pi Provider Registry，而进入 Agent Backend Registry。

## 9.9 Cursor 上下文连续性

### 9.9.1 无状态 Worker

第一版优先：

```bash
cursor-agent -p --output-format stream-json "<TaskPacket>"
```

每次传递压缩后的完整任务上下文。

适合：

- Scout；
- Reviewer；
- 边界明确的 Worker；
- 独立修复任务。

### 9.9.2 Sticky Cursor Session

保存：

```text
Wokii Run + Role + Workspace → Cursor Thread ID
```

示例：

```json
{
  "runId": "WK-001",
  "backend": "cursor",
  "role": "worker",
  "workspace": "/repo/.hapilon/worktrees/WK-001-worker",
  "cursorThreadId": "thread-xxx",
  "contextVersion": 14,
  "gitHead": "abc123"
}
```

Resume 时发送增量同步包：

```text
- 新确认的决策
- 新增验收标准
- 代码库 HEAD 变化
- 其他 Agent 修改
- Reviewer Findings
- 已废弃假设
```

### 9.9.3 ACP 适配

长期优先使用 Cursor ACP 作为稳定控制面：

- 长连接；
- JSON-RPC；
- 流式事件；
- 会话管理；
- 权限请求；
- 取消；
- 多会话；
- 结构化状态。

ACP 仍然属于 `AgentBackend`，不是 Pi Provider。

### 9.9.4 Resume 规则

可以 Resume：

- 同一 Run；
- 同一 Role；
- 同一 Workspace；
- 目标基本不变；
- Git 变化可解释；
- Thread 未明显偏航。

应新建 Thread：

- 任务目标改变；
- Worker 切换 Reviewer；
- Worktree 重建；
- 大规模 Rebase；
- 架构决策推翻；
- Thread 积累大量错误假设；
- 模块完全变化。

## 9.10 Canonical Task State

Hapilon/Wokii 保存：

```text
Wokii Run
├── objective
├── originalRequest
├── constraints
├── acceptanceCriteria
├── phase
├── decisions
├── evidence
├── currentGitState
├── changedFiles
├── findings
├── unresolvedQuestions
├── validations
└── completionState
```

Pi Session、Cursor Thread、Subagent Session 丢失时，仍可基于该状态恢复。

## 9.11 TaskPacket

```typescript
interface TaskPacket {
  taskId: string;
  runId: string;
  contextVersion: number;

  role: string;
  objective: string;
  constraints: string[];
  acceptanceCriteria: string[];

  decisions: Array<{
    id: string;
    decision: string;
    rationale?: string;
  }>;

  evidence: Array<{
    path: string;
    lines?: string;
    description: string;
  }>;

  relevantFiles: string[];
  currentFindings: Finding[];

  workspace: {
    root: string;
    branch: string;
    head: string;
    writablePaths?: string[];
  };

  allowedTools: string[];
  expectedOutput: string;

  tokenBudget?: number;
  turnBudget?: number;
  costBudgetUsd?: number;
}
```

## 9.12 AgentResult

```typescript
interface AgentResult {
  taskId: string;
  status: "success" | "partial" | "failed";

  summary: string;
  findings: Finding[];

  changedFiles?: string[];
  commandsRun?: string[];
  tests?: TestResult[];

  decisionsMade?: string[];
  unresolvedQuestions?: string[];

  workspaceHead?: string;

  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    turns?: number;
  };
}
```

## 9.13 Wokii Runtime

### 9.13.1 Workflow

```text
Research
→ Requirement
→ Design
→ Plan
→ Implement
→ Review
→ Verify
```

允许：

- 跳过不必要阶段；
- 从 Artifact 恢复；
- 对复杂任务完整运行；
- 对简单任务只调用单个模块。

### 9.13.2 Phase

每个阶段定义：

- 输入 Contract；
- 允许工具；
- 推荐 Role；
- 模型能力要求；
- 输出 Artifact；
- Gate；
- 完成条件；
- 预算。

### 9.13.3 Gate

Gate 类型：

- 用户确认；
- 自动验证；
- Reviewer Pass；
- 测试通过；
- 无 High Severity Finding；
- Artifact 完整；
- 预算未超限。

### 9.13.4 Artifact

例：

- Research Report；
- Requirement；
- Design；
- Plan；
- Diff；
- Test Report；
- Review Findings；
- Verification Report。

### 9.13.5 Finding

```typescript
interface Finding {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  file?: string;
  line?: number;
  problem: string;
  evidence?: string;
  suggestion?: string;
  status: "open" | "accepted" | "fixed" | "dismissed";
}
```

### 9.13.6 Wokii 激活边界

全局只加载最小规则。

```text
Global Core Context
Project Context
Workflow Context（Run 激活时）
Phase Context（当前阶段）
```

所有 Wokii Hook 必须检查：

```typescript
if (!workflowRun.isActive()) {
  return;
}
```

## 9.14 Claude/Codex 兼容层

不追求将外部 Harness 完整复制为内部实现。

建议拆分：

```text
claude-skill-importer
claude-rules-importer
claude-hooks-adapter
claude-agent-importer

codex-skill-importer
codex-agents-importer
codex-config-importer
```

导入后转换成 Hapilon/Wokii 内部领域模型。

## 9.15 UI 与命令

首期命令：

```text
/hapilon
/providers
/route
/roles
/delegate
/wokii
/wokii-status
```

状态栏建议显示：

```text
Hapilon · assisted · main=codex · quota=medium
```

后期可显示：

- 当前 Profile；
- 当前 Role；
- Provider；
- Model；
- 配额压力；
- Wokii Phase；
- 活跃 Subagent 数；
- 当前预算。

## 9.16 权限与安全

Pi 默认以启动用户权限运行，因此首期必须明确：

- Hapilon 不承诺提供强隔离；
- 只读 Agent 使用工具白名单；
- 写入型 Worker 后期使用 Worktree；
- 危险命令可通过 `tool_call` Hook 阻止；
- 凭证不写入 TaskPacket；
- 外部 Agent 只获得必要 Workspace 与上下文；
- 公司 Cursor Team 的使用必须遵守企业策略。

后期安全能力：

- Tool Policy；
- Writable Paths；
- 命令规则；
- 审批；
- Container / Sandbox；
- Secret Redaction；
- Audit Log。

---


# 10. 异构模型 Context Orchestration

## 10.1 设计目标

不同 Provider-Model 具有不同的：

- Context Window；
- 最大输出 Token；
- Reasoning Token 占用；
- System Prompt 与 Tool Schema 开销；
- 长上下文价格；
- 消息兼容格式；
- 上下文保持与压缩质量。

Hapilon 不通过“把所有会话限制在最小模型窗口”解决差异。该做法会浪费长上下文模型，也无法避免从大窗口模型切换到小窗口模型时发生溢出。

Hapilon 增加独立的：

```text
Context Orchestration Layer
```

其位置为：

```text
Task / Current Session
        ↓
Role Router
        ↓
Context Budgeter
        ↓
Context Assembler
        ↓
Context Compatibility Check
        ↓
Provider + Model / Agent Backend
```

Role Router 决定“谁做”；Context Orchestrator 决定“它能看见什么，以及当前上下文是否装得下”。

## 10.2 Context 的三层结构

### Portable Core

所有可选模型都应能够容纳的最小核心：

```text
Canonical Task State
当前目标
约束与验收标准
关键决策
最重要证据
当前实现状态
开放 Findings
下一步动作
```

Portable Core 不等于全文摘要，而是结构化的任务事实。

### Role Working Set

根据角色动态生成：

```text
Scout      路径、搜索目标、项目结构、只读规则
Planner    证据摘要、约束、影响范围、验收标准
Worker     计划、相关文件、编码约束、可写路径
Reviewer   需求、决策、Diff、测试结果、Findings Contract
Tester     测试命令、失败摘要、相关代码
Summarizer 待压缩 Artifact 与输出 Contract
```

### Extended / Raw Context

仅在预算允许或模型明确需要时加载：

- 更多原始文件；
- 长日志；
- 完整 Diff；
- 较长最近对话；
- 多模块研究材料；
- 旧分支与失败尝试。

这些内容默认保存在 Session、Artifact Store 和 Git 中，通过检索或按需读取进入 Working Set。

## 10.3 模型 Context Metadata

Model Capability Registry 至少记录：

```yaml
models:
  provider/model-a:
    contextWindow: 128000
    maxOutputTokens: 16000
    reasoning: high

    contextPolicy:
      outputReserve: 16000
      systemAndToolsEstimate: 8000
      safetyReserve: 8000
      targetUtilization: 0.75
      longContextCostThreshold: 100000
```

其中：

- `contextWindow`：Provider 声明或 Hapilon 覆盖的总窗口；
- `maxOutputTokens`：最大输出；
- `outputReserve`：本次任务预留输出；
- `systemAndToolsEstimate`：System、Tools、Skills、Rules 的估算；
- `safetyReserve`：序列化误差、下一轮工具结果和 Provider 差异余量；
- `targetUtilization`：正常路由允许使用的目标比例；
- `longContextCostThreshold`：超过该值后可能触发更高价格或不同策略。

Pi 模型定义支持 `contextWindow` 和 `maxTokens`，内置模型也可通过 `modelOverrides` 覆盖。因此 Hapilon 应优先读取运行时 Model Metadata，而不是复制一张容易过期的模型表。

## 10.4 有效输入预算

模型 Context Window 不能全部用于输入。Hapilon 计算：

```text
effectiveInputBudget =
    contextWindow
  - outputReserve
  - systemAndToolsEstimate
  - safetyReserve
```

示例：

```text
Context Window              128K
预留输出                     16K
System + Tools                8K
安全余量                      8K
--------------------------------
有效输入预算                  96K
```

再计算：

```text
contextPressure =
  projectedInputTokens / effectiveInputBudget
```

`projectedInputTokens` 必须考虑：

```text
当前准备发送的输入
+ 下一轮预计工具结果
+ 预计 Assistant 输出回放成本
```

推荐压力等级：

| 状态 | 比例 | 行为 |
|---|---:|---|
| Green | `< 0.60` | 正常装配和执行 |
| Yellow | `0.60～0.75` | 减少 Optional Segment |
| Orange | `0.75～0.90` | 摘要、提取、外置日志、按需检索 |
| Red | `> 0.90` | 禁止 Direct Route，必须 Compact、Handoff 或换模型 |

这些阈值应可配置，不作为所有模型的绝对真理。某些模型在窗口接近上限时质量会更早下降，应通过实际 Evaluation 调低阈值。

## 10.5 Context Priority 与装配算法

Context 按语义优先级装配，而不是简单保留最后 N 条消息。

```text
P0  System / Tool Contract / 安全策略
P1  目标、约束、验收标准
P2  决策、当前状态、开放 Findings
P3  当前角色相关代码、Diff 和证据
P4  最近必要回合
P5  原始日志、旧工具结果、旧对话
```

预算不足时：

```text
1. 删除或外置 P5
2. 摘要 P4
3. 从 P3 提取关键片段
4. 对重复内容去重
5. P0、P1 不得因普通压缩丢失
```

禁止把以下实现作为核心策略：

```typescript
messages.slice(-20)
```

最后 20 条消息可能只是一次超长测试失败，而早期确定的兼容约束可能已被切掉。

## 10.6 Context Profile

每个 Role 可以声明自己的装配策略：

```yaml
roles:
  scout:
    context:
      canonicalState: compact
      recentTurns: 0
      includeDiff: false
      evidenceMode: paths-and-symbols
      maxInputTokens: 24000

  planner:
    context:
      canonicalState: full
      recentTurns: 2
      evidenceMode: summaries
      includeDiff: summary
      maxInputTokens: 64000

  worker:
    context:
      canonicalState: full
      recentTurns: 1
      relevantFiles: full
      includePlan: full
      maxInputTokens: 96000

  reviewer:
    context:
      canonicalState: full
      recentTurns: 0
      includeDiff: full
      includeWorkerConversation: false
      maxInputTokens: 64000
```

Reviewer 默认不读取 Worker 的完整聊天历史，只读取需求、决策、Diff、测试和验收标准，以降低叙事污染并增强独立性。

## 10.7 Context Compatibility Matrix

路由之前，Hapilon 为候选模型生成兼容性结果：

| 模型 | 有效预算 | 预计输入 | 兼容状态 |
|---|---:|---:|---|
| Model A | 210K | 145K | DIRECT |
| Model B | 105K | 145K | COMPACT_REQUIRED |
| Model C | 52K | 145K | HANDOFF_REQUIRED |
| Model D | 24K | 145K | INELIGIBLE_FOR_MAIN |

状态定义：

```text
DIRECT             当前上下文可直接发送
PROJECTED          使用非破坏性上下文投影
COMPACT_REQUIRED   需先生成目标感知摘要
HANDOFF_REQUIRED   建立新 Session / Subagent 并发送 TaskPacket
INELIGIBLE         当前角色和任务不可路由到该模型
```

Route Decision 必须同时包含模型与 Context Plan：

```typescript
interface RouteDecision {
  backend: string;
  provider: string;
  model: string;

  contextStrategy:
    | "direct"
    | "project"
    | "compact"
    | "new-session"
    | "task-packet";

  estimatedInputTokens: number;
  effectiveBudget: number;
  contextPressure: number;
  reasons: string[];
}
```

`Context Fit` 是候选过滤硬约束，不只是评分加减项。

## 10.8 Main Agent 模型切换策略

### 相同或更大窗口

目标模型预算充足时可以直接切换：

```text
DIRECT → setModel
```

### 小窗口但仍能容纳

准入条件：

```text
projectedInputTokens
< effectiveInputBudget × targetUtilization
```

必须保留后续 Tool Result 和下一轮工作的余量，不能仅因当前 Token 数小于窗口就判定安全。

### 目标模型无法容纳

可选择：

#### Managed Compact

```text
等待 Agent Idle
→ 读取目标模型预算
→ 生成 Target-Aware Compaction
→ 验证压缩后大小与关键字段
→ 切换模型
→ 注入 Handoff Marker
```

目标感知摘要必须保留：

```markdown
## Objective

## Acceptance Criteria

## Confirmed Decisions

## Current Implementation State

## Modified Files

## Evidence

## Open Findings

## Failed Attempts Not to Repeat

## Next Action
```

#### Context Projection

在每次请求前生成面向小模型的消息视图，不修改磁盘中的完整 Session。适合临时两三轮任务，不应成为长期掩盖 Context 已腐化的手段。

#### New Session / Handoff

当任务角色或职责已经变化时，优先新建 Session 或 Subagent：

```text
Long-context Main
      ↓ TaskPacket
Small-context Reviewer
      ↓ AgentResult
Long-context Main
```

原则：

> 角色切换优先使用 Handoff；同一职责下的资源替换才优先考虑 Main Model Switch。

## 10.9 Provider Fallback 与 Context Fit

透明 Fallback 必须满足：

```text
当前请求能够放入目标模型的 effectiveInputBudget
```

例如：

```text
原模型窗口 256K
当前输入 170K
Fallback 有效预算 96K
```

此时不得在同一轮直接透明重试。

正确流程：

```text
1. 标记原 Provider 冷却
2. 暂停或结束当前 Turn
3. 生成 Compact / Handoff
4. 在任务边界切换
5. 使用目标模型继续
```

Fallback 配置应包含 Context 条件：

```yaml
fallback:
  - resource: glm-plan
    minEffectiveContext: 96000

  - resource: deepseek-api
    minEffectiveContext: 48000
    requiresProjection: true
```

候选集合为：

```text
健康
∩ 有额度
∩ 角色能力匹配
∩ Context Fit
∩ 成本允许
∩ 合规允许
```

## 10.10 Subagent 与小窗口模型

Subagent 不继承 Main 的完整会话，而通过 TaskPacket 建立独立 Context。

例如 Main 已有 `180K` 历史，但 Scout 可能只需要：

```text
目标               1K
项目规则           3K
搜索要求           2K
关键入口           5K
输出 Contract      1K
----------------------
总计              12K
```

因此小窗口模型非常适合：

- Scout；
- Summarizer；
- Tester；
- 局部 Reviewer；
- 边界清晰的 Worker。

大窗口模型应保留给：

- Main 长会话；
- 跨模块规划；
- 大范围影响分析；
- 需要大量原始证据的复杂审查。

## 10.11 External Agent Context 调和

Cursor 等外部 Agent 不接收 Pi 完整 Session，而接收：

```text
Canonical Task State
+ Role Context Profile
+ TaskPacket
+ Artifact References
+ Context Delta
```

外部 Thread 只承担局部执行记忆。Hapilon 为每次 Continue 记录：

```text
contextVersion
gitHead
artifactHashes
lastSyncedDecisionId
sessionStaleReason
```

当 Context Version 或 Git 差异超过策略阈值时，禁止 Resume，改为新 Thread 或完整 Handoff。

## 10.12 Tool Output 与 Artifact 外置

Context 爆炸通常来自长日志、超大文件和 Diff，而不只是聊天。

工具结果进入模型时应优先采用：

```text
摘要
+ 关键片段
+ Artifact 路径或 ID
```

完整内容保存：

```text
.hapilon/runs/<runId>/artifacts/
```

示例：

```text
Test failed with 17 errors.

Top causes:
1. AuthTokenTest: expected 401, got 500
2. LegacyTokenParser: NullPointerException
3. UserSessionIT: timeout

Full log:
.hapilon/runs/WK-001/artifacts/test-42.log
```

模型可按需读取具体片段。Hapilon 自定义工具必须实现输出截断、Artifact 落盘和摘要 Contract。

## 10.13 Compaction 策略

Pi 默认会在接近窗口或发生溢出时进行有损 Compaction，并保留完整 JSONL 历史。当前官方机制默认使用：

```text
reserveTokens    = 16,384
keepRecentTokens = 20,000
```

Hapilon 不应假设一组固定值适合所有模型。建议按 Context Class 配置：

```yaml
contextClasses:
  small:
    maxWindow: 64000
    reserveTokens: 12000
    keepRecentTokens: 8000
    canonicalTargetTokens: 8000

  medium:
    maxWindow: 160000
    reserveTokens: 20000
    keepRecentTokens: 20000
    canonicalTargetTokens: 12000

  large:
    maxWindow: 400000
    reserveTokens: 32000
    keepRecentTokens: 40000
    canonicalTargetTokens: 16000
```

Hapilon 可通过 Extension：

- 读取当前 Context Usage；
- 主动触发 Compaction；
- 在 `session_before_compact` 提供自定义摘要；
- 在 `context` 事件修改即将发送的消息；
- 在安全条件满足后切换模型；
- 必要时创建新 Session。

Compaction 是有损操作，必须提供完整性检查：

```text
目标是否存在
验收标准是否完整
关键决策是否完整
修改文件是否完整
开放 Finding 是否完整
Next Action 是否明确
```

验证失败时不得自动切到小窗口模型。

## 10.14 Context 可观测性

状态栏可显示：

```text
Hapilon · GLM · ctx 47K/96K · 49% · DIRECT
```

记录：

```text
modelContextWindow
outputReserve
systemToolsEstimate
safetyReserve
effectiveInputBudget
estimatedInputTokens
contextPressure
contextStrategy
compactionBeforeTokens
compactionAfterTokens
canonicalStateTokens
workingSetTokens
droppedSegments
artifactReferences
```

路由失败时必须给出可解释原因：

```text
DeepSeek/model-x 未被选择：
- 当前预计输入 71K
- 有效预算 52K
- Reviewer 任务允许 Handoff，但不允许 Main Direct Switch
```

## 10.15 Context Orchestration MVP

### Context v1

```text
1. 读取 model.contextWindow / maxTokens
2. 读取当前 Context Usage
3. 计算 effectiveInputBudget 与 contextPressure
4. Route 前检查 Context Fit
5. 不兼容时拒绝自动 Direct Switch
6. Subagent 永远使用 TaskPacket
7. 状态栏显示 Context Pressure
```

### Context v2

```text
Managed Compact
结构化 Wokii Summary
按角色 Context Profile
Tool Output Artifact 化
```

### Context v3

```text
Context Projection
Context Delta
目标模型感知 Handoff
Compatibility Matrix
```

### Context v4

```text
旧 Session / Artifact 检索
Context 质量评估
摘要完整性自动检查
模型实际长上下文质量曲线
```

## 10.16 Context Orchestration 验收标准

```text
[ ] 模型切换前计算目标有效预算
[ ] 不能容纳时不会直接切换或透明 Fallback
[ ] Canonical Task State 不因普通 Compaction 丢失
[ ] 不同 Role 能使用不同 Context Profile
[ ] Reviewer 默认不继承 Worker 完整对话
[ ] 长日志默认外置为 Artifact
[ ] Subagent 能使用 TaskPacket 在小窗口模型运行
[ ] 状态栏可展示 Context Pressure
[ ] Managed Compact 后可校验关键字段完整性
[ ] Context 路由决策具有可解释原因
```

# 11. 日常开发流程

## 11.1 简单 Bug

```text
User
→ Main
→ read/edit/bash
→ 测试
→ 完成
```

不启用 Wokii Run。

## 11.2 中型功能

```text
User
→ Main 创建轻量 Run
→ Scout（廉价模型）
→ Planner（强推理模型）
→ Main/Worker 实现
→ Reviewer（不同 Provider）
→ Main 验收
```

## 11.3 Cursor Worker

```text
Pi Main / Codex
→ 创建 Wokii Run
→ Pi Scout / DeepSeek
→ Pi Planner / GLM
→ Cursor Worker / Team 账号
→ Pi Reviewer / Codex
→ Cursor Resume 修复
→ Main 验收与合并
```

## 11.4 大仓库并行调查

```text
Main
├── Scout A：入口与调用链
├── Scout B：数据模型
├── Scout C：配置
└── Tester：测试覆盖
```

所有结果先转成 Evidence，而不是把四份完整聊天记录塞回 Main。

---

# 12. 配置示例

## 12.1 Hapilon 主配置

```yaml
mode: assisted
profile: default

routing:
  enabled: true
  conversationStickiness: true
  reserveHighValueModels: true

wokii:
  enabled: true
  autoStart: false

agents:
  maxPerTask: 4
  maxParallel: 3

budgets:
  taskMaxTokens: 180000
  taskMaxApiCostUsd: 1.50
```

## 12.2 Provider 配置

```yaml
providers:
  codex-plus:
    backend: pi
    kind: subscription
    provider: openai-codex

  glm-plan:
    backend: pi
    kind: coding-plan
    provider: zai

  deepseek:
    backend: pi
    kind: metered-api
    provider: deepseek
    budget:
      dailyUsd: 2.0

  cursor-team:
    backend: cursor
    kind: external-agent
    transport: cli
    model: auto
```

## 12.3 角色配置

```yaml
roles:
  main:
    requirements:
      toolCalling: high
      context: large
      reasoning: high

  scout:
    requirements:
      toolCalling: medium
      reasoning: medium
      writeAccess: false
    policy:
      preferLowCost: true

  planner:
    requirements:
      reasoning: high
      writeAccess: false

  worker:
    requirements:
      editing: high
      toolCalling: high

  reviewer:
    requirements:
      reasoning: high
      structuredOutput: high
      writeAccess: false
    policy:
      differentProviderFrom: worker

  summarizer:
    policy:
      preferFreeOrLowCost: true
```

---

# 13. 裸 Pi、Claude Code、Codex 的机制对比

> 本节用于界定 Hapilon 需要补充的 Harness 能力。具体厂商功能会变化，应在实现时以对应官方文档为准。

## 13.1 定位

| 维度 | 裸 Pi | Claude Code | Codex |
|---|---|---|---|
| 定位 | 极简可扩展终端 Harness | 完整 Coding Agent 产品 | 完整 Coding Agent 与多端平台 |
| 默认工具 | read/write/edit/bash | 完整代码与 Shell 工具 | 完整代码与 Shell 工具 |
| 多 Provider | 强 | Claude 生态为主 | OpenAI/Codex 生态为主 |
| 自定义 Harness | 很强 | 中强 | 中强 |
| 开箱即用完整度 | 中 | 高 | 高 |

## 13.2 项目规则与 Skills

| 能力 | 裸 Pi | Claude Code | Codex |
|---|---|---|---|
| 项目指令 | AGENTS.md / CLAUDE.md | CLAUDE.md / Rules | AGENTS.md / Rules |
| Skills | 原生 | 原生 | 原生 |
| 路径条件 Rules | 无完整内置 Rule Engine | 原生 | 有自身规则体系 |
| 自定义命令 | Extension / Prompt | Skills / Commands | Skills / Commands |

## 13.3 Hooks

| 能力 | 裸 Pi | Claude Code | Codex |
|---|---|---|---|
| 用户可配置 Hook Runtime | 无默认配置层 | 完整 | 完整 |
| Tool 前后事件 | Extension 能实现 | 原生 | 原生 |
| Session 生命周期 | Extension 能实现 | 原生 | 原生 |
| 修改/阻止工具调用 | Extension 能实现 | 原生 | 原生 |

## 13.4 Subagent

| 能力 | 裸 Pi | Claude Code | Codex |
|---|---|---|---|
| 内置 Subagent | 无 | 有 | 有 |
| 独立上下文 | 需 Extension | 有 | 有 |
| 不同模型 | 需 Extension | 支持 | 支持 |
| 并行 | 需 Extension | 支持 | 支持 |
| Worktree | 需自行实现 | 支持相关机制 | 支持相关机制 |

## 13.5 权限与安全

| 能力 | 裸 Pi | Claude Code | Codex |
|---|---|---|---|
| 默认权限审批 | 无 | 有 | 有 |
| Sandbox | 无内置强隔离 | 权限/环境机制 | 原生 Sandbox 模式 |
| 只读 Agent | 工具白名单 | 原生模式/权限 | Sandbox/工具配置 |

## 13.6 会话与上下文

| 能力 | 裸 Pi | Claude Code | Codex |
|---|---|---|---|
| 会话持久化 | JSONL | 原生 | 原生 |
| Resume | 有 | 有 | 有 |
| Tree / Fork | Pi 很强 | 有回退/分支能力 | 线程/任务 |
| Compaction | 有 | 有 | 有 |
| 自动代码 Checkpoint | 无，依赖 Git/扩展 | 强 | 以 Git/Sandbox/Review 为主 |

## 13.7 日常开发能力

| 日常任务 | 裸 Pi | Claude Code | Codex |
|---|---|---|---|
| 阅读项目 | 强 | 强 | 强 |
| 单文件 Bug | 强 | 强 | 强 |
| 运行测试 | 强 | 强 | 强 |
| 多文件功能 | 中强 | 强 | 强 |
| 并行调查 | 裸版弱 | 强 | 强 |
| 专用 Review | 手动/Skill | 强 | 强 |
| 权限与隔离 | 弱 | 强 | 强 |
| 多模型成本调度 | 最适合作为底座 | 较弱 | 主要在自身生态内 |
| 深度自定义 | 强 | 中强 | 中强 |

### 结论

Pi 与 Claude Code、Codex 在核心编码闭环上的差距不大，主要差距集中在：

- Subagent；
- Plan；
- Review；
- Permission；
- Sandbox；
- Hook Runtime；
- Worktree；
- IDE / Cloud 产品面。

这些正是 Hapilon/Wokii 需要有选择地补充的 Harness 能力。

---

# 14. 技术方案

## 14.1 技术栈

### 主体

```text
TypeScript + Node.js
```

理由：

- Pi 主体与 Extension 生态使用 TypeScript；
- 可直接复用 Pi 类型；
- CLI、子进程、配置和 Extension 可共享代码；
- 避免额外引入 Python Runtime；
- 后续可用 Bun 构建 Standalone。

### 资源

```text
Skills            Markdown
Rules             Markdown / YAML
Agents            Markdown / YAML
Workflow          YAML
配置              YAML / JSON
状态              SQLite / JSON
```

### Rust

首期不使用。未来可能用于：

- Sandbox；
- PTY；
- 原生进程管理；
- 文件监控；
- 单文件启动器；
- 高性能搜索。

## 14.2 Pi 的交付方式

第一阶段，Pi 不需要变成 Hapilon 自研二进制。

```json
{
  "dependencies": {
    "@earendil-works/pi-coding-agent": "精确版本"
  }
}
```

Hapilon 安装时，Pi 作为 npm 依赖共同安装。

用户不需要单独安装全局 `pi`。

Hapilon 使用模块解析定位自身依赖中的：

```text
@earendil-works/pi-coding-agent/dist/cli.js
```

然后通过当前 Node 子进程启动。

## 14.3 为什么不调用 PATH 中的 Pi

PATH 中的 Pi 可能：

- 未安装；
- 版本不匹配；
- 用户自行修改；
- 资源配置不同。

Hapilon 必须使用自身验证过的 Pi 版本。

## 14.4 工程结构

```text
hapilon/
├── package.json
├── package-lock.json
├── tsconfig.json
│
├── packages/
│   ├── cli/
│   ├── core/
│   ├── pi-extension/
│   ├── provider-runtime/
│   ├── agent-runtime/
│   ├── cursor-backend/
│   └── wokii/
│
├── resources/
│   ├── skills/
│   ├── agents/
│   ├── prompts/
│   ├── rules/
│   ├── workflows/
│   └── themes/
│
└── tests/
    ├── integration/
    ├── providers/
    ├── workflows/
    ├── routing/
    └── compatibility/
```

第一版可以是单包仓库，但内部目录保持模块边界。不要为了模块化仪式感，立即发布十几个 npm 包。

## 14.5 分发

### 第一阶段：npm Global

```bash
npm install -g hapilon
hapilon
```

### 内部或个人分发：tgz

```bash
npm pack
npm install -g ./hapilon-x.y.z.tgz
```

### 私有 Registry

```bash
npm install -g @scope/hapilon
```

### 后期 Standalone

按平台发布压缩包：

```text
hapilon-darwin-arm64/
├── hapilon
├── runtime/pi
├── extensions/
├── skills/
└── workflows/
```

第一阶段不追求真正单文件，因为动态 Extension、Skills、Themes、WASM 与资源目录会让单文件带来不必要复杂度。

---

# 15. 最小可运行版本：Hapilon 0.0.1

## 15.1 目标

仅证明：

1. `hapilon` 命令可以运行；
2. 启动内部 Pi；
3. 保留 Pi TUI；
4. 自动注入 Hapilon Extension；
5. 自动发现一个 Wokii Skill；
6. Pi 参数可以透传。

## 15.2 明确不做

```text
Provider Pool
Quota Ledger
Role Router
Subagent
Cursor
完整 Wokii 状态机
独立二进制
权限系统
SQLite
GUI
```

## 15.3 最小目录

```text
hapilon/
├── package.json
├── tsconfig.json
├── src/
│   ├── cli.ts
│   └── extension.ts
└── resources/
    └── skills/
        └── wokii-start/
            └── SKILL.md
```

## 15.4 `../package.json`

> Pi 版本应在实际开发时重新确认并精确锁定。本文基线日期所验证的仓库版本为 `0.80.6`。

```json
{
  "name": "hapilon",
  "version": "0.0.1",
  "description": "A multi-provider coding agent powered by Pi and Wokii",
  "private": true,
  "type": "module",
  "bin": {
    "hapilon": "./dist/cli.js"
  },
  "files": [
    "dist",
    "resources"
  ],
  "scripts": {
    "clean": "node -e \"require('fs').rmSync('dist', { recursive: true, force: true })\"",
    "build": "npm run clean && tsc -p tsconfig.json",
    "dev": "npm run build && node dist/cli.js",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "engines": {
    "node": ">=22.19.0"
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "0.80.6"
  },
  "devDependencies": {
    "@types/node": "24.12.4",
    "typescript": "5.9.3"
  }
}
```

## 15.5 `../tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": [
    "src/**/*.ts"
  ]
}
```

## 15.6 `../src/cli.ts`

```typescript
#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  name?: string;
  bin?: {
    pi?: string;
  };
}

function resolvePiCli(): string {
  const packageEntryUrl = import.meta.resolve(
    "@earendil-works/pi-coding-agent",
  );

  const packageEntryPath = fileURLToPath(packageEntryUrl);
  let currentDirectory = dirname(packageEntryPath);

  while (true) {
    const manifestPath = join(
      currentDirectory,
      "package.json",
    );

    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(
        readFileSync(manifestPath, "utf8"),
      ) as PackageManifest;

      if (
        manifest.name ===
          "@earendil-works/pi-coding-agent" &&
        manifest.bin?.pi
      ) {
        return resolve(
          currentDirectory,
          manifest.bin.pi,
        );
      }
    }

    const parentDirectory = dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      throw new Error(
        "Unable to locate the bundled pi-coding-agent CLI.",
      );
    }

    currentDirectory = parentDirectory;
  }
}

function main(): void {
  const piCliPath = resolvePiCli();

  const extensionPath = fileURLToPath(
    new URL("./extension.js", import.meta.url),
  );

  const forwardedArguments = process.argv.slice(2);

  const child = spawn(
    process.execPath,
    [
      piCliPath,
      "--extension",
      extensionPath,
      ...forwardedArguments,
    ],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        HAPILON_RUNTIME: "1",
        HAPILON_VERSION: "0.0.1",
        HAPILON_MODE: "general"
      }
    },
  );

  child.on("error", error => {
    console.error(
      `Failed to start Hapilon: ${error.message}`,
    );
    process.exitCode = 1;
  });

  child.on("exit", code => {
    process.exitCode = code ?? 1;
  });
}

try {
  main();
} catch (error) {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  console.error(`Hapilon startup failed: ${message}`);
  process.exitCode = 1;
}
```

## 15.7 `src/extension.ts`

```typescript
import type {
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { fileURLToPath } from "node:url";

const skillsPath = fileURLToPath(
  new URL("../resources/skills", import.meta.url),
);

export default function hapilonExtension(
  pi: ExtensionAPI,
): void {
  pi.on("resources_discover", async () => {
    return {
      skillPaths: [skillsPath],
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    const mode =
      process.env.HAPILON_MODE ?? "general";

    ctx.ui.setStatus(
      "hapilon",
      `Hapilon · ${mode}`,
    );
  });

  pi.registerCommand("hapilon", {
    description:
      "Show Hapilon runtime information",

    handler: async (_args, ctx) => {
      const version =
        process.env.HAPILON_VERSION ??
        "development";

      const mode =
        process.env.HAPILON_MODE ??
        "general";

      ctx.ui.notify(
        [
          `Hapilon ${version}`,
          `Mode: ${mode}`,
          "Runtime: pi-coding-agent",
        ].join("\n"),
        "info",
      );
    },
  });
}
```

## 15.8 最小 `SKILL.md`

```markdown
---
name: wokii-start
description: Starts a lightweight Wokii analysis and planning workflow for a coding task.
disable-model-invocation: true
---

# Wokii Start

## 1. Understand

Restate:

- requested outcome;
- important constraints;
- acceptance criteria;
- unresolved questions that materially affect implementation.

Do not ask questions that can be answered by inspecting the repository.

## 2. Inspect

Inspect only relevant files and code paths.

Record:

- entry points;
- affected modules;
- existing conventions;
- tests;
- likely risks.

## 3. Plan

Produce:

1. files to change;
2. changes for each file;
3. validation commands;
4. risks and rollback considerations.

Do not edit files unless explicitly requested.
```

## 15.9 构建与验证

```bash
npm install
npm run build
npm link
hapilon
```

进入后：

```text
/hapilon
/skill:wokii-start
```

### 0.0.1 验收标准

```text
[ ] hapilon 命令可运行
[ ] 不要求全局安装 pi
[ ] 使用 Hapilon 锁定的 Pi 版本
[ ] 保留 Pi 原版 TUI
[ ] Extension 自动注入
[ ] /hapilon 可用
[ ] Wokii Skill 可发现
[ ] Pi 参数原样透传
[ ] Ctrl+C 与退出码正常
```

---

# 16. 版本路线

## 16.1 v0.0.1：启动链路

- Launcher；
- 内部 Pi；
- Extension；
- Wokii Skill；
- 参数透传。

## 16.2 v0.0.2：Profile

- Hapilon Home；
- 独立 Pi 配置；
- Profile；
- `setup`；
- `doctor`。

## 16.3 v0.0.3：Provider 可观察性

- `/providers`；
- `/route`；
- Provider Registry；
- 手动模型选择；
- 健康状态。

## 16.4 v0.0.4：Quota

- 429；
- Retry-After；
- 冷却；
- API 日预算；
- 简单额度账本。

## 16.5 v0.0.5：Role Router

- Model Capability；
- Main/Scout/Reviewer；
- 动态模型选择；
- 预算限制；
- Context Metadata 基线。

## 16.6 v0.0.6：Context Orchestration v1

- Effective Input Budget；
- Context Pressure；
- Context Fit 硬约束；
- Direct / Handoff 判定；
- Role Context Profile；
- 状态栏 Context 指标。

## 16.7 v0.0.7：只读 Subagent

- `delegate` 工具；
- 独立 Pi JSON 子进程；
- Scout；
- Planner；
- Reviewer；
- Summarizer；
- 单次与并行；
- TaskPacket Context。

## 16.8 v0.0.8：Managed Context 与 Wokii Runtime

- Managed Compact；
- Artifact 外置；
- Run；
- Phase；
- Finding；
- Decision；
- Gate；
- Resume。

## 16.9 v0.0.9：Cursor Backend

- 无状态 CLI；
- TaskPacket；
- AgentResult；
- Worktree；
- Thread 映射；
- Resume；
- Context Version / Delta。

## 16.10 v0.1.0：ACP 与 Context Projection

- Cursor ACP；
- 长连接；
- 事件；
- 权限；
- 取消；
- Session 管理；
- Context Projection；
- Compatibility Matrix。

## 16.11 v0.1.1：写入型 Worker

- Git Checkpoint；
- Worktree；
- Patch；
- Reviewer Gate；
- 合并与回滚。

# 17. 测试策略

## 17.1 Launcher Tests

- Pi 路径解析；
- 参数透传；
- 环境变量；
- 信号；
- 退出码；
- macOS / Windows / Linux。

## 17.2 Extension Contract Tests

- Extension 加载；
- Event 顺序；
- Skill 发现；
- Command；
- Provider 注册；
- Tool 阻止；
- Pi 升级回归。

## 17.3 Provider Tests

- 认证；
- 模型列表；
- 429；
- Retry-After；
- 网络失败；
- 超时；
- API 预算。

## 17.4 Routing Tests

- 角色匹配；
- 配额压力；
- Provider 冷却；
- 不同 Provider Reviewer；
- 保留高价值模型；
- Fallback。


## 17.5 Context Orchestration Tests

- Model Metadata 读取；
- Effective Budget 计算；
- System/Tools/Output Reserve；
- Context Pressure 阈值；
- Direct / Projection / Compact / Handoff 判定；
- Fallback Context Fit；
- Role Context Profile；
- Segment 优先级与裁剪；
- Canonical State 保留；
- Managed Compact 完整性；
- Artifact 外置；
- 小窗口 Subagent TaskPacket；
- Context Version 与 Cursor Resume 失效。

## 17.6 Agent Tests

- 单次委派；
- 并行；
- 取消；
- 输出 Schema；
- Token 预算；
- Tool 白名单；
- 子进程泄漏。

## 17.7 Wokii Tests

- Phase 转移；
- Gate；
- Artifact；
- Resume；
- Finding 状态；
- Context Version；
- 幂等性。

## 17.8 Cursor Tests

- 无状态调用；
- JSON/Stream 输出；
- Thread 映射；
- Resume；
- Worktree；
- 失效条件；
- Cursor 不可用时回退。

## 17.9 Evaluation

建立固定代码任务集：

- 小 Bug；
- 中型功能；
- 大仓库搜索；
- Review；
- 测试失败；
- 重构；
- 安全问题；
- 多 Provider 路由。

测量：

- 成功率；
- 修改正确性；
- 测试通过率；
- Token；
- 成本；
- 时间；
- 用户干预；
- Reviewer 发现率；
- 回滚率。

---

# 18. 可观测性

至少记录：

```text
runId
sessionId
taskId
role
backend
provider
model
start/end
tokens
estimatedCost
toolCalls
status
failure
retry
quotaState
gitHead
changedFiles
contextWindow
effectiveInputBudget
estimatedInputTokens
contextPressure
contextStrategy
compactionBeforeTokens
compactionAfterTokens
contextVersion
```

原则：

- 不默认记录 Secret；
- 不记录完整凭证；
- Prompt 日志可配置；
- 公司项目可关闭详细内容日志；
- Artifact 与运行日志分开。

---

# 19. 主要风险与缓解

## R1：Pi 上游变化

缓解：

- 精确锁定版本；
- 兼容矩阵；
- 升级回归测试；
- 不依赖私有内部路径；
- 优先正式 Extension API。

## R2：多 Agent 反而更贵

缓解：

- 默认不自动大量委派；
- 角色 Token/Turn/Cost Budget；
- 只传 TaskPacket；
- 使用 Challenger 代替多份完整方案；
- Summarizer 使用低价模型。

## R3：不同模型工具调用不稳定

缓解：

- Model Capability；
- Role Eval；
- 结构化输出校验；
- 自动重试；
- 不合格模型禁止写入角色。

## R4：Cursor 上下文陈旧

缓解：

- Canonical Task State；
- Context Version；
- Git HEAD；
- Delta Packet；
- 明确 Resume 失效规则。

## R5：并行写入冲突

缓解：

- 首期子 Agent 只读；
- 后期 Worktree；
- Patch 合并；
- Main 验收。

## R6：权限风险

缓解：

- 明确 Pi 默认权限模型；
- 工具白名单；
- Tool Hook；
- Worktree；
- 后期 Sandbox；
- 企业资源合规检查。

## R7：Wokii 过度流程化

缓解：

- General / Assisted / Wokii 三模式；
- 阶段可跳过；
- 简单任务不创建 Run；
- Context 按阶段加载。

## R8：产品范围失控

缓解：

- 首期只证明启动链路；
- 每一版本只增加一个核心闭环；
- 不追求厂商全部功能；
- 通用 Coding Agent 优先于“无所不能 Agent”。

## R9：Compaction 丢失关键任务事实

缓解：

- Canonical Task State 独立持久化；
- 使用结构化 Target-Aware Summary；
- 压缩后校验目标、验收标准、决策、修改文件和 Findings；
- 验证失败时禁止自动切换模型；
- 完整 Session 与 Artifact 继续保留。

## R10：小窗口模型获得不完整上下文却过度自信

缓解：

- Route Decision 显式记录 Context Strategy；
- TaskPacket 声明已提供与未提供的信息；
- 不允许不满足 Context Fit 的 Direct Route；
- 小窗口模型优先承担边界清晰角色；
- 关键任务由 Main 或 Reviewer 验收。

---

# 20. 成功指标

## MVP

- `hapilon` 启动成功率 > 99%；
- 不依赖全局 Pi；
- TUI 行为与直接运行 Pi 基本一致；
- Extension 和 Skill 稳定加载；
- 三平台至少完成基本验证。

## Provider 阶段

- 可同时配置不少于 3 类模型资源；
- Provider 状态可见；
- 429 后能够正确进入冷却；
- 手动路由稳定。

## Role Router 阶段

- Scout/Reviewer 可使用不同 Provider；
- 简单任务相较全部使用 Main 强模型降低明显成本；
- Reviewer 跨 Provider 能发现可验证问题。

## Context Orchestration 阶段

- 所有模型切换均产生 Context Compatibility 结果；
- 不发生已知的目标模型窗口溢出式直接切换；
- Canonical Task State 经 Compaction 后关键字段保持率达到 100%；
- 小窗口 Scout/Reviewer 能通过 TaskPacket 独立完成边界清晰任务；
- 长日志与大 Tool Result 默认 Artifact 化；
- Context 路由原因对用户可解释。

## Wokii 阶段

- Workflow Run 可恢复；
- Artifact 与 Finding 不依赖某个 Agent Session；
- Pi/Cursor 切换后任务状态不丢失。

---

# 21. 待决策项

1. 最终 npm 包名是否可用；
2. 默认模式是 `general` 还是 `assisted`；
3. 默认 Profile 是否完全隔离；
4. Quota Ledger 首期使用 JSON 还是 SQLite；
5. Provider 额度无法直接查询时的估算方式；
6. Cursor CLI 的正式命令名和输出 Contract 版本；
7. Cursor Team 企业政策是否允许自动化调用；
8. 首期是否支持 Windows；
9. Wokii 现有文件的迁移策略；
10. 是否开放第三方 Hapilon Module；
11. 何时需要 Pi SDK；
12. 是否需要极小 Core Patch 实现同一轮透明 Provider Retry；
13. Effective Budget 的默认 Safety Reserve 如何按模型校准；
14. Context Token 估算采用 Pi Usage、字符估算还是 Provider Tokenizer；
15. Managed Compact 使用当前模型、目标模型还是专用 Summarizer；
16. Canonical Task State 的默认 Token 目标和完整性 Schema；
17. Context Projection 是否允许长期启用，还是仅用于短期任务。

---

# 22. 关键结论

1. **Hapilon 应以 Pi Coding Agent 为运行内核，而不是 Fork Pi。**
2. **Hapilon 第一阶段使用薄启动器启动内部锁定版本的 Pi，并保留原版 TUI。**
3. **Hapilon 使用 TypeScript + Node.js。**
4. **Pi 作为 npm 依赖共同安装，第一版不必转为二进制。**
5. **Wokii 深度集成，但必须可以按需激活。**
6. **Hapilon 即使深度集成 Wokii，仍然是通用 Coding Agent。**
7. **Provider Pool 解决资源可用性，Role Router 解决不同任务由谁执行。**
8. **Context Orchestrator 解决不同模型能够看见什么，以及当前任务是否适合切换。**
9. **不同模型不应共享同一份巨大 Context，而应共享 Canonical Task State。**
10. **长窗口模型获得更大的 Working Set，小窗口模型获得 Portable Core 与角色相关视图。**
11. **Main 模型降级、Provider Fallback 和 Resume 前都必须进行 Context Fit 检查。**
12. **Subagent 可以使用与 Main 不同的 Provider/Model，并应通过 TaskPacket 建立独立小 Context。**
13. **Cursor 不是 Pi Provider，而是 External Agent Backend。**
14. **Pi Session、Cursor Thread 和 Worker Session 都是局部执行记忆，不是全局事实源。**
15. **上下文连续性依赖 TaskPacket、Artifact、Decision、Finding、Git 与 AgentResult，而不是复制完整聊天记录。**
16. **Compaction 是有损操作，必须结构化并校验关键任务事实。**
17. **长日志、超大 Diff 与 Tool Result 应默认外置为 Artifact。**
18. **首期只做启动链路，避免在项目开始时同时实现全部宏伟能力。**

# 23. 官方资料基线

以下资料用于校准本文中的外部产品机制。厂商能力会变化，实际开发时应重新确认版本与文档。

## Pi

1. [Pi Agent Harness GitHub Repository](https://github.com/earendil-works/pi)
2. [Pi Coding Agent README](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/README.md)
3. [Pi Extension Documentation](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md)
4. [Pi Skills Documentation](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/skills.md)
5. [Pi SDK Documentation](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sdk.md)
6. [Pi Packages Documentation](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/packages.md)
7. [Pi Custom Provider Documentation](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/custom-provider.md)
8. [Pi Subagent Extension Example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent)
9. [Pi Coding Agent package.json](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/package.json)
10. [Pi Models Documentation](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/models.md)
11. [Pi Compaction Documentation](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/compaction.md)
12. [Pi Compaction Source](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/compaction/compaction.ts)

已验证基线：

- Pi 将自身定位为可通过 Extensions、Skills、Prompt Templates、Themes 扩展的精简终端 Coding Harness；
- 支持 Interactive、Print/JSON、RPC 和 SDK；
- 默认工具包括 `read`、`write`、`edit`、`bash`；
- 支持多个订阅/API Provider；
- Extension 可监听生命周期、拦截工具、注册 Provider、命令与资源；
- Extension 可读取 Context Usage、主动 Compact、自定义 `session_before_compact`、在 `context` 事件修改消息并切换模型；
- 模型元数据支持 `contextWindow`、`maxTokens` 和模型级覆盖；
- Pi Compaction 是有损摘要，但完整历史保留在 JSONL；
- 默认 Compaction 基线为 `reserveTokens=16384`、`keepRecentTokens=20000`，Hapilon 将按模型动态覆盖；
- 官方仓库提供通过独立 Pi JSON 子进程实现 Subagent 的示例；
- 2026-07-12 文档基线对应仓库最新发行版 `0.80.6`。

## Cursor

1. [Cursor CLI Parameters](https://cursor.com/docs/cli/reference/parameters)
2. [Cursor Headless CLI](https://cursor.com/docs/cli/headless)
3. [Cursor CLI Usage](https://cursor.com/docs/cli/using)
4. [Cursor ACP](https://cursor.com/docs/cli/acp)

设计上将 Cursor 视为独立 Agent Backend，而非普通模型 Provider。

## Claude Code

1. [Claude Code Overview](https://code.claude.com/docs/en/overview)
2. [Claude Code Hooks](https://code.claude.com/docs/en/hooks)
3. [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents)

## Codex

1. [Codex Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
2. [Codex Skills](https://learn.chatgpt.com/docs/build-skills)
3. [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
4. [Codex Sandboxing](https://learn.chatgpt.com/docs/sandboxing)
5. [Codex Code Review](https://learn.chatgpt.com/docs/code-review)

---

# 24. 文档终点与开发起点

本 PRD 的实施起点不是 Provider Pool，也不是完整 Wokii。

第一条可执行任务应当是：

```text
创建 TypeScript 项目
→ 精确依赖 pi-coding-agent
→ 实现 hapilon CLI
→ stdio inherit 启动 Pi
→ 自动注入一个 Extension
→ 自动发现一个 Wokii Skill
→ 验证 /hapilon
```

当这一条链路稳定之后，再依次增加 Profile、Provider 可观察性、Quota、Role Router、Context Orchestration v1、只读 Subagent、Managed Context、Wokii Runtime 和 Cursor Backend。

宏伟愿景先被迫通过一百行能运行的代码接受现实教育，这是一个项目能活下来的良好开端。
