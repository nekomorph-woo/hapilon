---
name: write-a-hapi
description: 引导用户为 hapilon（Pi Coding Agent wrapper）编写 TypeScript 扩展。覆盖注册自定义 Tool、订阅生命周期事件（Hook）、注册 Slash Command、注册 CLI Flag、注册 Provider。基于 doc/pi-wiki.md 权威参考，按 4 阶段工作流引导：需求澄清 → write-plan 编码计划 → 代码生成 → 放置与验证。Use when 用户说"写一个 pi 扩展"、"给 hapilon 加个扩展"、"创建 pi extension"、"写 extension"、"写个 hapi 扩展"、"write pi extension"。
---

# Write a Hapi Extension

为 hapilon（Pi Coding Agent）编写 TypeScript 扩展。

> **权威参考**: `doc/pi-wiki.md` — 当 reference/ 信息不足时应回退到此文件。

## 快速开始

```bash
# 1. 说出你的需求，我会按 4 阶段引导
"给 hapilon 加个扩展，自动记录每次对话的 token 用量"

# 2. 生成代码后，放到 src/extensions/
#    支持两种结构：
#    - src/extensions/token-tracker.ts          # 单文件
#    - src/extensions/token-tracker/index.ts    # 多文件（目录 + index.ts）

# 3. 构建并启动 hapilon
npm run build && hapilon
#    hapilon 启动时自动扫描 src/extensions/，通过 -e 注入 pi
```

## 工作流程

### Stage 1: 需求澄清 — Ask, Don't Assume

引导用户明确需求。按以下维度**一次只问一个问题**，沿决策树追问直到收敛：

| 维度 | 要问什么 | 选项 |
|------|----------|------|
| **功能** | 扩展要做什么？ | 一句话描述 |
| **机制** | 需要哪种 Pi 扩展机制？ | Tool / Hook（事件） / Command（/slash） / Provider / Flag / Shortcut |
| **时机** | 如果是 Hook，在什么时机触发？ | 参见 `reference/event-catalog.md` 事件目录 |
| **参数** | Tool/Command 需要什么参数？ | 参数名、类型、是否必填 |
| **UI** | 是否需要自定义 TUI 渲染？ | renderCall / renderResult / setWidget |

**追问规则**：
- 一次只问一个问题，等用户回答后再继续
- 每个问题附带推荐答案（根据常见场景）
- 从代码库能查到的事实不要问用户

### Stage 2: 模式匹配 → write-plan 编码计划

需求澄清后，将需求映射到代码模式。读取 `reference/code-patterns.md` 对应章节：

| 用户需求 | 对应模式 |
|----------|----------|
| "拦截用户输入并修改" | 模式 3: `pi.on("input", ...)` |
| "注入上下文到 LLM" | 模式 2: `pi.on("before_agent_start", ...)` |
| "添加自定义工具" | 模式 1: `pi.registerTool(...)` |
| "添加 / 命令" | 模式 4: `pi.registerCommand(...)` |
| "阻止危险操作" | 模式 3: `pi.on("tool_call", ...)` + block |
| "注册新 Provider" | 模式 5: `pi.registerProvider(...)` |
| "注册 CLI flag" | 模式 6: `pi.registerFlag(...)` |

**然后通过 `/write-plan` 启动 hpl-planner agent 制定编码计划**：

- 读取 `reference/code-patterns.md` 对应的完整模式代码
- 读取 `reference/event-catalog.md` 确认事件签名和返回值
- 读取 `reference/api-quick-reference.md` 确认 API 方法签名
- 产出结构化编码计划，写入 `_plans/` 目录
- 计划内容：文件清单、每个文件的修改点、类型定义、测试验证方式
- **等待用户批准计划后，才进入 Stage 3 编码**

### Stage 3: 代码生成（用户批准后执行）

按以下规范生成 TypeScript 扩展代码：

**结构规范**：
- 默认 export 工厂函数 `(pi: ExtensionAPI)`，支持 async
- 从 `@earendil-works/pi-coding-agent` 导入 `ExtensionAPI` 类型
- 代码按功能分段：import → 注册机制 → 事件订阅（按生命周期顺序）

**类型规范**：
- Tool 参数用 `typebox` 的 `Type.Object()` 定义
- 枚举用 `StringEnum`（来自 `@earendil-works/pi-ai`），**不用 `Type.Union`/`Type.Literal`**（Google API 不兼容）

**错误处理**：
- throw Error = 工具执行失败（会标记 `isError: true`）
- 不要在 execute 里 catch 后 return 正常结果来吞错误
- 检查 `signal?.aborted` 以支持取消

**注释规范**：
- 所有注释用中文
- 文件顶部标注功能描述、用法、来源（pi-wiki.md 章节引用）

**代码模板**：

```typescript
/**
 * <name>.ts — <功能描述>
 *
 * 用法: pi -e ./<name>.ts
 * 来源: doc/pi-wiki.md §X.Y
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
  // 1. 注册扩展机制（Tool / Command / Flag / Provider）
  // 2. 订阅生命周期事件（on session_start / before_agent_start / tool_call ...）
  // 3. 可选：清理逻辑（session_shutdown）
}
```

完整可运行示例见 `examples/`：
- `examples/simple-tool.ts` — 注册自定义 Tool
- `examples/event-hook.ts` — 多事件 Hook 组合
- `examples/slash-command.ts` — /command + CLI Flag

### Stage 4: 放置与验证

**放置规则**：

扩展与 hapilon 源码一起打包发布，放在 hapilon 源码的 `src/extensions/` 目录下：

```
src/extensions/
├── my-tool.ts              # 单文件扩展（自动发现）
└── my-hook/                # 多文件扩展（目录 + index.ts）
    ├── index.ts            # 入口（自动发现）
    └── utils.ts
```

hapilon 启动时通过 `discoverExtensions()`（`src/extensions.ts`）自动扫描该目录，将所有扩展通过 `-e` 标志注入 Pi。不需要手动维护 `-e` 列表。

**自动发现规则**（与 Pi 内置一致）：
- `extensions/<name>.ts` → 编译后 `extensions/<name>.js` → 单文件
- `extensions/<name>/index.ts` → 编译后 `extensions/<name>/index.js` → 多文件
- 隐藏文件（`.` 开头）和 `.gitkeep` 自动跳过
- 没有 `index.js` 的子目录自动跳过

**测试流程**：

```
1. 将代码放到 src/extensions/<name>.ts（单文件）或 src/extensions/<name>/index.ts（多文件）
2. npm run build                    # tsc 编译到 dist/extensions/
3. hapilon                          # 启动 hapilon，自动扫描并注入扩展
4. 在对话中触发扩展功能              # Tool → 让 Agent 调用；Hook → 执行触发操作；Command → 输入 /命令
5. 观察启动日志是否有编译错误         # Pi 通过 jiti 运行 .js 扩展
```

**诊断清单**（出问题时逐项排查）：

- [ ] `npm run build` 是否成功？（TypeScript 编译错误）
- [ ] 文件放在 `src/extensions/` 下？（编译后在 `dist/extensions/`）
- [ ] 单文件是 `<name>.ts`，多文件是 `<name>/index.ts`？
- [ ] 扩展的 `export default function` 签名正确？
- [ ] import 路径指向已安装的包？（`@earendil-works/pi-coding-agent`, `typebox`）
- [ ] 启动 hapilon 后 Pi 输出中是否有 extension 相关错误？

## 参考文档

按需加载以下 reference 文件，避免 pi-wiki.md 全量读入：

| 文件 | 内容 | 何时读取 |
|------|------|----------|
| `reference/api-quick-reference.md` | ExtensionAPI + Context 方法速查 | Stage 2 确认 API 签名 |
| `reference/event-catalog.md` | 全部生命周期事件目录（含场景映射） | Stage 2 匹配事件名 |
| `reference/code-patterns.md` | 6 个核心代码模式（完整可复制） | Stage 2/3 生成代码 |

当 reference/ 信息不足时，回退到 `doc/pi-wiki.md` 查阅完整权威文档。如需参考社区已有扩展的实现，可实时搜索 [pi.dev/packages](https://pi.dev/packages)。

## 关键约束

- **pi-wiki.md 是唯一权威来源**：SKILL 不重复 pi-wiki 内容，只做结构化引导和按需引用
- **先计划后编码**：需求澄清后必须先用 write-plan 出计划、用户批准、再编码
- **引导 > 生成**：先帮用户理清需求（问对问题），再生成代码（生成对的东西）
- **错误可抛不可吞**：遵循项目 `Fail Fast` 原则，不要写兜底逻辑隐藏问题
- **扩展随 hapilon 发布**：放在 `src/extensions/`，由 `discoverExtensions()` 自动扫描注入，不放在 `~/.hapilon/` 用户目录
