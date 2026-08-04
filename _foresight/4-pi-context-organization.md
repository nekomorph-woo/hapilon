# Pi Coding Agent 上下文组织

> 一句话概括：Pi 发给 LLM 的每条消息是怎么来的——System Prompt 如何拼装、会话树如何变线性消息、压缩如何保留精华丢弃冗余、扩展如何插话。理解这套机制才能写出不破坏上下文结构的 hapilon 扩展。

## 核心概念

### 上下文管道：分层装配的流水线

把全文档想象成一条装配线——原材料（会话条目、skills、AGENTS.md）经过多层工序变成最终的 LLM 请求：

```
材料层（全量）              筛选层（取分支）             转换层（消息化）           注入层（拼 System Prompt）
─────────────────    ───────────────────────   ─────────────────────────    ────────────────────────
SessionEntry tree    buildContextEntries()      convertToLlm()                buildSystemPrompt()
  ├─ message           └─ 从 leaf 回走到        ├─ user → 原样               ├─ 默认："You are an
  ├─ custom_message        root 取单条路径        ├─ assistant → 原样             expert coding..."
  ├─ compaction         └─ 遇 CompactionEntry:   ├─ toolResult → 原样       ├─ + contextFiles (AGENTS.md)
  ├─ branch_summary         跳过早于 firstKept   ├─ bashExecution → user     ├─ + skills (name+desc)
  ├─ custom (跳过)      └─ 跳过非当前分支        ├─ compactionSummary→user   ├─ + appendSystemPrompt
  └─ thinking_level                              └─ branchSummary→user      ├─ + cwd
     /model_change                                                           └─ SYSTEM.md 存在时：接管全部
     /label/session_info
     (不参与上下文)
```

关键源码：`core/session-manager.js:198-226` (buildContextEntries)、`core/session-manager.js:232-237` (buildSessionContext)、`core/messages.js:75-122` (convertToLlm)、`core/system-prompt.js` (buildSystemPrompt)

### 会话条目：树形存储，线性输出

Pi 把会话存为 **JSONL 文件**，每行一个 JSON 对象，通过 `id`/`parentId` 形成树。这种方法天然支持分支——换一个 `parentId` 就从那里分叉，不需要复制整个文件。

核心结构（来源：`session-manager.d.ts`）：

| 条目类型 | 参与上下文？ | 转成什么消息 |
|----------|-------------|-------------|
| `message` (user/assistant/toolResult) | ✅ | 原样 |
| `custom_message` | ✅ | role="custom" → LLM 看到的 role="user" |
| `compaction` | ✅ | role="compactionSummary" → LLM 看 role="user" |
| `branch_summary` | ✅ | role="branchSummary" → LLM 看 role="user" |
| `custom` | ❌ | 不参与（纯状态持久化） |
| `thinking_level_change` | ❌ | 仅影响 thinkingLevel 决议 |
| `model_change` | ❌ | 仅影响 model 决议 |
| `label` / `session_info` | ❌ | UI 用途 |

每轮对话组装时，`buildContextEntries()` 从当前叶子节点（leaf）沿 parentId 链回走生成线性请求，其他分支不参与。遇压缩节点则跳过摘要前的旧消息。最后链内所有可读条目通过 `convertToLlm()` 转成 LLM 的消息数组——非标准角色（bashExecution/custom/compactionSummary/branchSummary）全部映射到 `role="user"`。

官方参考：[session-format.md](https://github.com/earendil-works/pi/blob/master/packages/coding-agent/docs/session-format.md)

### 压缩与分支摘要：不是截断，是重新理解

压缩不是简单砍掉前半段——而是**让 LLM 重新阅读被丢弃的内容并生成结构化摘要**，下次请求时把摘要当消息发出。

触发条件：
```
contextTokens > model.contextWindow - 16384 (reserveTokens)
```

具体算法（`compaction.js:285-329`）：
1. 从最新条目倒推，找到一条按轮次分割的切割点（确保不会把一次完整工具调用砍断），目标是保留最后约 20000 tokens
2. 调用另一个专门的模型处理切割前的旧消息，为丢弃部分生成结构化摘要
3. 在会话中插入压缩记录——它本身不包含原始消息，但引用已压缩的关键文件以保持文件上下文

摘要格式涵盖目标、约束、进度、决策、下一步和关键上下文，每次压缩还会记录文件操作（读取和修改的文件清单），下一次压缩时这些记录合并保留。已有标准摘要时，压缩会在此基础上更新而不是重新开始。

**设计要点**：压缩后刷新会话上下文时，`buildContextEntries()` 只追溯压缩条目加上其引用范围内之后的新消息，所以旧消息不会再送进 LLM。由于 token 消耗减少，`getContextUsage()` 重新计算新的估算值。

分支摘要同理——切换分支时要求模型总结即将离开的分支内容，新分支能看到上游摘要作为上下文延续。

官方参考：[compaction.md](https://github.com/earendil-works/pi/blob/master/packages/coding-agent/docs/compaction.md)

### Skills：渐进式披露

Skills 不一次性塞进 System Prompt。启动时只注入名称和描述（`<available_skills>` XML block），完整指令在 LLM 需要时通过 `read` 工具按需加载。这就是"渐进式披露"——消耗上下文的只有 name/description，详细的 SKILL.md 正文不占上下文。

发现路径（`skills.js:121-386`）：
- 用户级：`~/.pi/agent/skills/`
- 项目级：`.pi/skills/`（需项目信任）
- 包注入：Pi 命令依赖的 npm 包通过 `pi.skills` 路径声明
- 显式：CLI `--skill`、settings.json `skills` 数组
- 扩展：`resources_discover` 事件返回 `skillPaths`

来源：`core/skills.js:121-386`、`core/resource-loader.js:322-331`

官方参考：[skills.md](https://github.com/earendil-works/pi/blob/master/packages/coding-agent/docs/skills.md)

### Prompt Templates：完全按需

Prompt Templates（提示模板）只在用户输入 `/templateName args` 时才展开——模板中的 `$1`、`$2` 等变量替换后作为用户消息发送。不在 System Prompt 中常驻。

来源：`core/prompt-templates.js`

### context 事件：扩展的最后一道阀门

在 LLM 调用前，`context` 事件给每个扩展一次修改**完整消息列表**的机会。扩展可插入、删除、修改任意消息。这是最强大的上下文干预入口——修改结果链式传递给下一个扩展。

`before_agent_start` 也是干预点——扩展可注入自定义消息或替换 System Prompt（链式覆盖）。

来源：`core/extensions/runner.js:702-730` (context)、`runner.js:792-845` (before_agent_start)

### 上下文使用量估算：两层精度

- **精确估算**：从最近一条有效 LLM 响应的 `usage` 字段（`totalTokens`）计算。这是唯一可信的数据。
- **粗估计**：对于没有 usage 数据的消息（bash 执行结果、用户消息、压缩摘要），使用 `字符数 / 4` 保守高估。
- **压缩后未知状态**：压缩会重排上下文，在新 LLM 响应到达前 `getContextUsage()` 返回 `tokens: null`（footer 中显示 `?`）。

来源：`compaction.js:108-133`

## 对其他 Coding Agent 生态的识别

Pi 对「别家 coding agent 留下的文件」的态度分三档——自动认、配了才认、完全不认。

### 第一档：零配置自动识别

**上下文文件**（`resource-loader.js:31`）——每个目录按以下优先级取**第一个命中**（不合并）：

```
AGENTS.md  >  AGENTS.MD  >  CLAUDE.md  >  CLAUDE.MD
```

- 扫描范围：从 cwd 逐级向上到文件系统根目录 + Pi 的 agentDir（`~/.pi/agent/`，hapilon 下是 `~/.hapilon/agent/`）
- 注入方式：以 `<project_context><project_instructions path="...">` XML 包进 System Prompt
- **无信任门槛**：不管项目是否 trusted 都加载
- 人话：**你项目里给 Claude Code 写的 CLAUDE.md，Pi 会直接读进上下文**——这是 Pi 对 Claude Code 项目的天然兼容

**共享 Skills 目录**（`package-manager.js:273-288`）——[Agent Skills 开放标准](https://agentskills.io)的跨 agent 共享目录：

| 路径 | 信任要求 |
|------|----------|
| `~/.agents/skills/`（用户级） | 始终信任（`trust-manager.js:146`） |
| `.agents/skills/`（cwd 及祖先目录，至 git 仓库根） | 需项目 trusted |

### 第二档：手动配置才识别

Claude Code / Codex 的 skills 目录**不会自动扫描**，但格式完全兼容（都是 SKILL.md + frontmatter 标准），在 settings.json 里指一下就能用：

```json
{
  "skills": ["~/.claude/skills", "~/.codex/skills"]
}
```

项目级同理：`.pi/settings.json` 里写 `"skills": ["../.claude/skills"]`。（来源：官方 skills.md；settings 解析在 `settings-manager.js:208-221`）

### 第三档：完全不识别（源码 grep 零命中）

| 文件/机制 | 所属生态 | Pi 的态度 |
|-----------|----------|-----------|
| `.cursorrules` / `.cursor/rules/` | Cursor | ❌ 无任何识别代码 |
| `GEMINI.md` | Gemini CLI | ❌ |
| `.github/copilot-instructions.md` | GitHub Copilot | ❌ |
| `.mcp.json` / MCP servers | MCP 生态 | ❌ Pi 核心无内置 MCP 支持（需扩展自行实现） |
| `.claude/commands/`（slash 命令） | Claude Code | ❌ prompt templates 只认 `~/.pi/agent/prompts/` 和 `.pi/prompts/` |

**对 hapilon 的启示**：想让 hapilon 用户的 Claude Code 资产（rules/commands）在 Pi 内生效，得靠我们自己写扩展做转换——`resources_discover` 事件返回 `skillPaths`/`promptPaths` 就是官方留的口子。

## 与本项目的关系

hapilon 目前已深度接触这套体系的位置：

| 已接触 | 级别 | 说明 |
|--------|------|------|
| `tool_call` / `tool_result` 拦截 | 消息流修改 | hpl-safety-gate / hpl-protected-paths 在扩展层阻止危险操作 |
| `session_start` + `setFooter` | UI 接管 | hpl-footer 替换状态栏 |
| `ctx.sessionManager.getEntries()` | 数据读取 | footer 累加 usage 统计 |
| `ctx.getContextUsage()` | 数据读取 | [DING] 指示灯数据源 |
| `ctx.systemPrompt` 钩子 | 观测 | `before_agent_start` 暴露 `event.systemPrompt` 和 `event.systemPromptOptions` |

**未接触但有潜力**：
- `context` 事件 — 可主动向 LLM 上下文插入 hapilon 安全提示
- `sendUserMessage` / `sendMessage` — 可程序化发送用户消息
- `ctx.ui.setStatus` — 可在 footer 第 3 行显示安全状态

## 入门路线图

1. **先理解方向**：熟读本文"核心概念" 4 节，了解消息从哪来、如何压缩
2. **看源码验证**：对照上面的源码路径，在 `node_modules/@earendil-works/pi-coding-agent/dist/core/` 中验证
3. **用 Pi 实操**：启动 hapilon，跑 `/compact` 手动压缩，观察上下文变小；跑 `/tree` 创建分支，看分支摘要
4. **写扩展实验**：写一个简单扩展监听 `context` 事件，打印 `event.messages.length` 观察消息数量变化；或监听 `session_compact` 事件看压缩发生时机
5. **进阶**：研究 `core/system-prompt.js` 签名——理解 SYSTEM.md 如何接管 system prompt

## 常见陷阱

| 陷阱 | 说明 |
|------|------|
| **custom 条目不参与上下文** | 扩展用 `pi.appendEntry()` 存的 `custom` entry **不会被 LLM 看到**。必须用 `custom_message` entry（或 `sendUserMessage`）才能注入上下文 |
| **压缩后 usage 未知** | `getContextUsage()` 在压缩后新响应到达前返回 `tokens: null`。如果 footer 没处理 null 会显示异常 |
| **context 事件不可取消** | 不像 tool_call 可以 block，context 事件只能修改消息列表（不允许 cancel） |
| **SYSTEM.md 接管一切** | 一旦写 SYSTEM.md，Pi 不再注入 tools/guidelines/pi-docs。如果 SYTSTEM.md 没声明工具引导，LLM 就不知道该用哪些工具 |
| **AGENTS.md 无信任门槛** | AGENTS.md 始终加载（不管 `isProjectTrusted`），但 skills 受信任限制。恶意仓库可的 AGENTS.md 可注入指令 |
| **AGENTS.md 与 CLAUDE.md 同目录只认一个** | 同目录共存时按优先级只加载 AGENTS.md，内容**不合并**。"我写了 CLAUDE.md 为什么不生效"大概率是旁边有个 AGENTS.md 抢了 |

## 参考资源

- [Pi 官方 compaction.md](https://github.com/earendil-works/pi/blob/master/packages/coding-agent/docs/compaction.md) — 压缩与分支摘要机制
- [Pi 官方 session-format.md](https://github.com/earendil-works/pi/blob/master/packages/coding-agent/docs/session-format.md) — 会话文件格式与条目类型
- [Pi 官方 skills.md](https://github.com/earendil-works/pi/blob/master/packages/coding-agent/docs/skills.md) — Skills 发现与注入
- [Pi 官方 extensions.md](https://github.com/earendil-works/pi/blob/master/packages/coding-agent/docs/extensions.md) — 扩展 API 详解
- hapilon 已有文档：`../.fiber/docs/pi-wiki.md` — Pi 生命周期与事件参考
- hapilon 已有文档：`_plans/hpl-footer-custom.md` — footer 扩展中 contextUsage 的使用案例
