# 生命周期事件目录

> 来源: `doc/pi-wiki.md` 第 4 章。按类别组织，标注触发时机、可返回值、典型场景。

---

## 启动事件

| 事件 | 触发时机 | 可返回值 | 典型场景 |
|------|----------|----------|----------|
| `project_trust` | Pi 决定是否信任项目之前 | `{ trusted: "yes"\|"no"\|"undecided", remember?: boolean }` | 自定义信任流程、企业安全策略 |
| `resources_discover` | session_start 之后 | `{ skillPaths[], promptPaths[], themePaths[] }` | 动态注册 Skill/Prompt/Theme 路径 |

**注意**：`project_trust` 只有用户/全局扩展和 CLI `-e` 扩展参与。

---

## Session 事件

| 事件 | 触发时机 | 可返回值 | 典型场景 |
|------|----------|----------|----------|
| `session_start` | Session 启动/加载/重载 | — | 初始化扩展状态、显示欢迎信息、从 session entries 重建状态 |
| `session_shutdown` | Session 销毁前 | — | 清理资源、保存状态、关闭连接 |
| `session_before_switch` | `/new` 或 `/resume` 前 | `{ cancel: true }` | 确认是否丢弃当前 session |
| `session_before_fork` | `/fork` 或 `/clone` 前 | `{ cancel: true }` | 确认 fork 操作 |
| `session_before_compact` | compaction 前 | `{ cancel: true }` 或 `{ compaction: {summary, firstKeptEntryId, tokensBefore} }` | 自定义摘要逻辑 |
| `session_compact` | compaction 完成后 | — | 记录压缩日志 |
| `session_before_tree` | `/tree` 导航前 | `{ cancel: true }` 或 `{ summary: {...} }` | 自定义分支摘要 |
| `session_tree` | `/tree` 导航后 | — | 记录导航日志 |
| `session_info_changed` | session 名称变更 | — | 更新 UI 状态 |

**session_start 的 reason 值**：`"startup"` / `"reload"` / `"new"` / `"resume"` / `"fork"`

---

## Agent 事件

| 事件 | 触发时机 | 可返回值 | 典型场景 |
|------|----------|----------|----------|
| **`before_agent_start`** ⭐ | 用户提交 prompt 后、Agent 循环前 | `{ message: CustomMessage, systemPrompt: string }` | **注入上下文到 LLM**、修改 system prompt、添加项目规则 |
| `agent_start` | 底层 agent run 开始 | — | 记录开始时间 |
| `agent_end` | 底层 agent run 结束 | — | 记录结束时间、统计 token |
| `agent_settled` | Agent 完全 settle（无 retry/compaction/follow-up） | — | **状态集成**：确认 Agent 不会再自动运行 |
| `turn_start` | 每个 turn 开始 | — | 记录 turn 开始 |
| `turn_end` | 每个 turn 结束 | — | 记录 turn 结束、获取 tool 结果 |
| `message_start` | 消息开始 | — | 记录消息 |
| `message_update` | 流式更新 | — | 实时显示 |
| `message_end` | 消息完成 | `{ message }`（替换最终消息） | 修改消息内容 |
| **`context`** | 每次 LLM 调用前 | `{ messages }` | **过滤/修改发送给 LLM 的消息列表** |

### before_agent_start 详解

这是**最常用的事件之一**。`event` 对象包含：

```typescript
{
  prompt: string;           // 用户原始 prompt
  images?: ImageContent[];  // 附加图片
  systemPrompt: string;     // 当前链式 system prompt（含前面 handler 的修改）
  systemPromptOptions: {
    customPrompt?: string;
    selectedTools: string[];
    toolSnippets: string[];
    promptGuidelines: string[];
    appendSystemPrompt?: string;
    cwd: string;
    contextFiles: ...;
    skills: ...;
  };
}
```

**链式机制**：多个扩展的 `before_agent_start` 按加载顺序执行，`event.systemPrompt` 包含前面 handler 的修改。

---

## Tool 事件

| 事件 | 触发时机 | 可返回值 | 典型场景 |
|------|----------|----------|----------|
| **`tool_call`** ⭐ | 工具执行前 | `{ block: true, reason?: string }`；可原地修改 `event.input` | **拦截危险命令**、修改工具参数、权限控制 |
| **`tool_result`** ⭐ | 工具执行后、结果发送前 | `{ content, details, isError }` | **修改工具结果**、注入额外信息、后处理 |
| `tool_execution_start` | 工具执行开始 | — | 记录开始 |
| `tool_execution_update` | 工具执行进度 | — | 实时更新 |
| `tool_execution_end` | 工具执行结束 | — | 记录结束 |

### tool_call 行为保证

- 修改 `event.input` 影响实际执行
- 后续 handler 看到前序修改
- 修改后不重新验证参数

### tool_result 链式 middleware

Handler 按加载顺序执行，每个 handler 看到最新的结果。返回部分 patch（省略的字段保持当前值）。

---

## 输入事件

| 事件 | 触发时机 | 可返回值 | 典型场景 |
|------|----------|----------|----------|
| **`input`** ⭐ | 用户输入后、Skill/Template 展开前 | `{ action: "continue"\|"transform"\|"handled" }` | **拦截/转换用户输入**、自定义快捷命令 |

### input 处理顺序

1. Extension commands 先检查
2. `input` 事件触发
3. Skill commands (`/skill:name`) 展开
4. Prompt templates 展开
5. Agent 处理

---

## Model 事件

| 事件 | 触发时机 | 典型场景 |
|------|----------|----------|
| `model_select` | 模型切换（`/model`、Ctrl+P、session 恢复） | 更新 UI、记录模型变更 |
| `thinking_level_select` | Thinking level 变更 | 更新 UI（通知型，返回值忽略） |

---

## 网络事件

| 事件 | 触发时机 | 可返回值 | 典型场景 |
|------|----------|----------|----------|
| `before_provider_headers` | HTTP 头发送前 | 原地修改 `event.headers` | 添加自定义 header、删除追踪 header |
| `before_provider_request` | Provider payload 构建完成 | `{...payload}` 替换请求体 | 调试 provider 序列化 |
| `after_provider_response` | HTTP 响应收到后、流消费前 | — | 监控 rate limit、记录延迟 |

---

## 用户 Bash 事件

| 事件 | 触发时机 | 可返回值 | 典型场景 |
|------|----------|----------|----------|
| `user_bash` | 用户执行 `!` / `!!` 命令 | `{ operations }` 或 `{ result }` | 重定向 shell 执行到远程、包装命令 |
