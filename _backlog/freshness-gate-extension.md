# freshness-gate — Write 工具文件新鲜度门禁扩展

## 背景

Claude Code 有一个 harness 层面的 guard：当 LLM 调用 Write/Edit 工具写入一个文件时，如果该文件在本次会话中**从未被 Read 过**，Claude Code 会直接拒绝执行并提示 "请先读取文件内容"。

这个 guard 的目的是防止 LLM 凭记忆或猜测覆盖文件内容。LLM 的训练数据可能包含过时的文件版本，或者 LLM 根本没有当前文件的实际内容。如果它直接 Write 覆盖，会产生静默数据损坏。

Pi 目前：
- **`edit` 工具**（`edit.js:198`）：每次执行时**当场重新读一次文件**，用最新内容匹配 `oldText`。文件变了 → `oldText` 匹配失败 → edit 报错。这是一种**运行时事后验证**，效果类似但时机不同。
- **`write` 工具**：**无任何保护**。全量覆盖磁盘文件，不检查 LLM 是否真的知道当前文件内容。

因此 `write` 是真正的风险点，需要拦截。

## 目的

为 hapilon 增加 LLM 写文件的新鲜度验证：**如果 write 目标文件已存在但 LLM 在本次会话中从未 read 过它，拒绝写操作**，强制 LLM 先读取再修改。

## 描述

| 项目 | 内容 |
|------|------|
| 类型 | 待实现（预留扩展） |
| 当前状态 | 未创建，仅 backlog 记录 |
| 预期用途 | 拦截 `write` 工具调用，检查目标文件是否被 read 过；未读过的拒绝执行 |
| 创建时间 | 2026-07-19 |

### 设计方案

#### 扩展位置
`src/extensions/freshness-gate/`

```
src/extensions/freshness-gate/
├── index.ts      扩展入口：pi.on("tool_call") 拦截 write
├── tracker.ts    会话级文件读取跟踪器（Set<绝对路径>）
└── types.ts      类型定义
```

#### 拦截逻辑

```
pi.on("tool_call", (event) => {
  if (event.toolName !== "write") return;  // 只拦截 write

  const filePath = resolveToAbsolute(event.input.file_path, event.cwd);
  
  // 新文件：不拦截
  if (!existsSync(filePath)) return;

  // 已存在但没读过 → 拒绝
  if (!readTracker.has(filePath)) {
    return {
      blocked: true,
      reason: "文件未读取: 请先用 read 工具读取此文件的最新内容，再进行修改",
      suggestion: `read("${event.input.file_path}")`,
    };
  }

  // 已读过 → 放行
});

// 同时监听 read 工具的结果，将成功读取的路径加入 tracker
pi.on("tool_result", (event) => {
  if (event.toolName === "read" && !event.error) {
    const path = resolveToAbsolute(event.input.file_path, event.cwd);
    readTracker.add(path);
  }
});
```

#### 会话级跟踪

- `readTracker` 是一个 `Set<string>`（绝对路径），存储本次会话中 LLM 成功 read 过的所有文件
- 每次 `read` 工具成功返回后，将该路径加入 Set
- 每次 `write` 被调用时，检查目标路径是否在 Set 中
- 不需要持久化 — 会话级即可

#### 为什么只拦截 write 不拦截 edit

- `edit` 在 Pi 内部已经做了实时读文件 + `oldText` 匹配（`edit.js:198-205`）。如果文件内容变了，`oldText` 匹配失败，edit 直接报错。拦截 edit 是多余的。
- `write` 是全量覆盖，没有任何内容校验，需要外部 guard。

#### 边界情况

| 场景 | 处理 |
|------|------|
| 新建文件（不存在） | 放行（无覆盖风险） |
| 文件存在但从未 read | 拒绝，提示先 read |
| 文件存在且已 read | 放行 |
| `edit` 工具 | 不拦截（Pi 已做 runtime 校验） |
| 软链接 | resolve symlink 后再判断 |
| 相对路径 | resolve 到绝对路径（基于 event.cwd） |
| session reload | 清空 readTracker（新会话，重新跟踪） |
| `--no-safety` | 本扩展被跳过（与 hpl-safety-gate 同样在 noSafety 过滤列表中） |

#### 与现有扩展的关系

- **hpl-safety-gate**：拦截 bash 危险命令 → 与本扩展互斥无冲突
- **protected-paths**：拦截敏感路径的 read/write → 本扩展拦截的是"文件是否被读过"，是另一个维度。如果 write 同时命中 protected-paths 和 freshness-gate，两个扩展独立判断（Pi 的 tool_call 事件链式传递，任一 block 即 block）
- **hapilon CLI**（`cli.ts:97-112`）：`--no-safety` 标记需扩展，过滤 `hpl-safety-gate` 和 `protected-paths`，freshness-gate 也应加入过滤列表

### 与其他 Coding Agent 的对比

| Agent | 机制 | 时机 |
|-------|------|------|
| **Claude Code** | harness 级 guard，Write/Edit 前检查对话历史是否有 Read | 调用前 |
| **Pi（原生）** | 无 guard（write 无保护，edit 靠 oldText 事后匹配） | — |
| **hapilon（本扩展）** | 扩展级 guard，write 前检查 session 级 readTracker | 调用前 |

### 为什么不用 Pi 的 system prompt guideline

可以在 system prompt 里加一条 "do not write to a file without reading it first" 的 guideline。但 guideline 只是**建议**，LLM 可能忽略。扩展拦截是**强制执行**。

## 参考引用

- Pi `edit.js` 实时读文件逻辑：`node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js:198`
- hapilon `hpl-safety-gate` 扩展（同类 tool_call 拦截模式）：`src/extensions/hpl-safety-gate/index.ts`
- hapilon `protected-paths` 扩展（同类 tool_call 拦截模式）：`src/extensions/protected-paths/index.ts`
- hapilon CLI `--no-safety` 过滤逻辑：`src/cli.ts:97-112`
- Claude Code read-before-write guard：内置 harness 机制

## 项目位置

- **创建**: `src/extensions/freshness-gate/index.ts` — 扩展入口，注册 `tool_call` + `tool_result` 事件
- **创建**: `src/extensions/freshness-gate/tracker.ts` — `ReadTracker` 类，管理会话级文件读取记录
- **创建**: `src/test/unit/freshness-gate.test.ts` — 单元测试
- **修改**: `src/cli.ts:97-112` — `-no-safety` 过滤列表加入 `freshness-gate`
- **参考**: `src/extensions/hpl-safety-gate/index.ts` — 拦截模式完全一致（`tool_call` 事件 → 判断 → block/allow）
