# write-pi-extension SKILL 设计与实现计划

## Context

hapilon 基于 Pi Coding Agent v0.80.6，Extensions 是 Pi 最核心的扩展机制（TypeScript 模块，通过 jiti 加载，无需编译）。然而，查阅 `../.fiber/docs/pi-wiki.md` 虽然覆盖了全部机制，但对于"写一个新的 Pi 扩展"这个具体任务缺乏结构化引导。

本 SKILL 将填补这个缺口：当用户说"写一个 pi 扩展"、"给 hapilon 加个扩展"、"创建一个 pi extension"时自动触发，按结构化工作流引导用户完成从需求到验证的全过程。

## 核心原则

1. **pi-wiki.md 是唯一权威来源**：SKILL 不重复 wi-ki 内容，只做结构化引导和按需引用
2. **引导 > 生成**：先帮用户理清需求（问对问题），再生成代码（生成对的东西）
3. **渐进式披露**：SKILL.md 描述常驻、reference/ 按需加载、examples/ 供复制参考
4. **先计划后编码**：需求澄清后先出编码计划，用户批准后再写代码，避免方向性返工

## 设计过程中的信息来源

编写本 SKILL 及 reference/ 内容时，从以下来源提取结构化信息：

1. **pi-wiki.md**（`../.fiber/docs/pi-wiki.md`）：使用 `/teach-me` SKILL 多次定向提取，每次聚焦一个主题
   - 提取 ExtensionAPI 全部方法签名与用法 → 写入 `reference/api-quick-reference.md`
   - 提取全部事件类型、触发时机、返回值 → 写入 `reference/event-catalog.md`
   - 提取 6 个核心代码模式 → 写入 `reference/code-patterns.md`

2. **Pi 官方 Packages 市场**（https://pi.dev/packages）：搜索已有扩展包作为参考
   - 搜索 Extension 类包，了解社区最佳实践和代码风格
   - 搜索 Tool/SKILL 类包，了解常见模式
   - 将可参考的包链接记录到 reference/ 中

## 文件变更清单

### 新增文件

| 文件 | 职责 |
|------|------|
| `.claude/skills/write-pi-extension/SKILL.md` | 主技能文件：frontmatter + 完整工作流 + 代码生成规范 |
| `.claude/skills/write-pi-extension/reference/api-quick-reference.md` | ExtensionAPI 方法速查表 + ExtensionContext 属性一览 |
| `.claude/skills/write-pi-extension/reference/event-catalog.md` | 生命周期事件分类目录（含典型场景映射） |
| `.claude/skills/write-pi-extension/reference/code-patterns.md` | 常见代码模式（注册 Tool / Hook / Command / Provider / Flag / Shortcut） |
| `.claude/skills/write-pi-extension/reference/community-examples.md` | pi.dev/packages 市场中可参考的扩展包链接与摘要 |
| `.claude/skills/write-pi-extension/examples/simple-tool.ts` | 示例：注册一个自定义 Tool（带中文注释） |
| `.claude/skills/write-pi-extension/examples/event-hook.ts` | 示例：订阅 before_agent_start 注入上下文（带中文注释） |
| `.claude/skills/write-pi-extension/examples/slash-command.ts` | 示例：注册 /command + 注册 Flag（带中文注释） |

## 实现步骤

### Phase 0: 信息收集（设计阶段）

在正式开始编写 SKILL 文件之前，先收集外部信息：

0.1 使用 `/teach-me` SKILL 从 `../.fiber/docs/pi-wiki.md` 定向提取结构化信息：
    - 第 1 次：提取 ExtensionAPI 全部方法（第 6.4 节）→ 输出到 `reference/api-quick-reference.md` 草稿
    - 第 2 次：提取全部生命周期事件（第 4 章）→ 输出到 `reference/event-catalog.md` 草稿
    - 第 3 次：提取 6 个核心代码模式（Tool/Hook/Command/Provider/Flag/Shortcut）→ 输出到 `reference/code-patterns.md` 草稿
    - verify: 每个 reference 文件标注来源 pi-wiki.md 行号

0.2 搜索 https://pi.dev/packages 市场：
    - 搜索关键词：extension、tool、skill、hook
    - 目的：了解社区扩展的代码组织方式、命名规范、package.json 结构
    - 将可参考的包链接记录到 `reference/community-examples.md`
    - verify: 至少找到 2-3 个可参考的扩展包

### Phase 1: SKILL.md 主文件

1. 创建 `.claude/skills/write-pi-extension/SKILL.md`
   - frontmatter: `name: write-pi-extension` + 中英文触发词 description
   - 工作流 4 阶段：需求澄清 -> 模式匹配 -> 代码生成 -> 放置与验证
   - 每个阶段有明确的输入/输出/验证标准
   - verify: 文件存在、frontmatter 合法、触发词覆盖"写一个 pi 扩展"/"给 hapilon 加个扩展"/"创建一个 pi extension"

**SKILL.md 内容大纲：**

```
---
name: write-pi-extension
description: 引导用户编写 Pi Coding Agent 的 TypeScript 扩展。
  覆盖：注册自定义 Tool、订阅生命周期事件、注册 Slash Command、
  注册 CLI Flag、注册 Provider。Use when 用户说"写一个 pi 扩展"、
  "给 hapilon 加个扩展"、"创建 pi extension"、"写 extension"。
---

# Write Pi Extension

## 工作流程

### Stage 1: 需求澄清（Ask, Don't Assume）

引导用户明确以下 5 个维度，一次只问一个：
1. 扩展要做什么？（功能描述）
2. 需要哪种扩展机制？
   - Tool：LLM 可调用的自定义工具
   - Hook：拦截/修改 Agent 行为（事件订阅）
   - Command：用户手动触发的 /slash 命令
   - Provider：注册新的 LLM Provider
   - Flag：注册 CLI flag
   - Shortcut：注册键盘快捷键
3. 在什么时机触发？（如果是 Hook，映射到事件名）
4. 需要什么参数？（如果是 Tool/Command，设计参数 schema）
5. 需要自定义 UI 吗？（renderCall/renderResult）

### Stage 2: 模式匹配 → replan 编码计划

根据用户需求匹配代码模式 → 读取 reference/code-patterns.md 对应章节。

常见组合：
- "拦截用户输入并修改" → `pi.on("input", ...)` 模式
- "注入上下文到 LLM" → `pi.on("before_agent_start", ...)` 模式
- "添加自定义工具" → `pi.registerTool(...)` 模式
- "添加 / 命令" → `pi.registerCommand(...)` 模式
- "阻止危险操作" → `pi.on("tool_call", ...)` + block 模式

**匹配完成后，启动 `/replan` agent 制定编码计划**：
- 读取 `reference/code-patterns.md` 对应的代码模式
- 读取 `reference/event-catalog.md` 确认事件签名
- 产出结构化编码计划，包含：文件清单、每个文件的修改点、类型定义、测试验证方式
- 计划写入 `_plans/` 目录
- **等待用户批准计划后，才进入 Stage 3 编码**

### Stage 3: 代码生成（用户批准计划后执行）

生成规则：
- 默认 export 工厂函数 `(pi: ExtensionAPI)`，支持 async
- 从 `@earendil-works/pi-coding-agent` 导入 ExtensionAPI 类型
- Tool 参数用 `typebox` 的 `Type.Object()` 定义
- 枚举用 `StringEnum`（来自 `@earendil-works/pi-ai`），不用 `Type.Union`
- 所有注释用中文
- 错误处理：throw Error = 失败，禁止吞异常

代码结构模板：
```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 1. 订阅事件
  // 2. 注册扩展机制
  // 3. 可选：清理逻辑
}
```

### Stage 4: 放置与验证

放置规则：
- 全局扩展：`~/.hapilon/agent/extensions/<name>.ts`
- 项目扩展：`.pi/extensions/<name>.ts`（需项目信任）
- 默认推荐全局

测试方法：
1. `pi -e <path>` 临时加载测试
2. 放入 extensions/ 目录后 `/reload` 热重载
3. 观察启动日志是否有错误
4. 对于 Tool：在对话中触发使用
5. 对于 Command：输入 `/command名`
6. 对于 Hook：执行触发操作，观察行为
```

### Phase 2: reference/ 参考文档（基于 Phase 0 收集的信息精炼）

2. 创建 `reference/api-quick-reference.md`
   - 从 pi-wiki.md 第 6.4 节提取 ExtensionAPI 方法表
   - 从 pi-wiki.md 第 6.5 节提取 ExtensionContext 属性表
   - 从 pi-wiki.md 第 6.6 节提取 ExtensionCommandContext 方法表
   - 每个方法附带 1 行使用示例
   - verify: 覆盖所有 ExtensionAPI/ExtensionContext/ExtensionCommandContext 方法

3. 创建 `reference/event-catalog.md`
   - 从 pi-wiki.md 第 4 章提取所有事件
   - 按类别组织：启动事件、Session 事件、Agent 事件、Tool 事件、输入事件、Model 事件
   - 每个事件标注：触发时机、可返回值类型、典型使用场景
   - verify: 覆盖 pi-wiki.md 中列出的所有事件类型

4. 创建 `reference/code-patterns.md`
   - 6 个核心模式，每个含完整代码片段：
     a. 注册自定义 Tool（含 StringEnum 参数 + execute + renderCall）
     b. 订阅 before_agent_start 注入上下文
     c. 订阅 tool_call 拦截/修改工具调用
     d. 注册 /slash 命令（含 ExtensionCommandContext）
     e. 注册 Provider
     f. 注册 Flag + 在事件中使用 getFlag()
   - 每个模式标注对应的 pi-wiki.md 章节引用
   - verify: 6 个模式代码片段均可直接复制使用

### Phase 3: examples/ 完整示例

5. 创建 `examples/simple-tool.ts`
   - 实现一个 `get_timestamp` 工具
   - 参数：`format`（StringEnum: ["iso", "unix", "readable"]）+ `timezone`（可选 string）
   - execute 返回格式化时间戳
   - 完整中文注释，标注每一行目的
   - verify: 复制到 `~/.hapilon/agent/extensions/` 后 `pi -e` 可加载，对话中可调用

6. 创建 `examples/event-hook.ts`
   - 实现 before_agent_start 钩子：读取项目 README.md 注入为附加上下文
   - 实现 tool_call 钩子：拦截 `rm -rf` 命令并 block
   - 实现 session_start 钩子：通知 session 路径
   - 演示多个事件的组合使用
   - verify: 复制到 extensions/ 后启动 pi，观察通知、测试危险命令 block

7. 创建 `examples/slash-command.ts`
   - 注册 `/todos` 命令：列出项目 `_todo.md` 中的待办项
   - 注册 `--todos-file` CLI flag：允许用户指定自定义 todo 文件路径
   - 演示 ExtensionCommandContext 的 session 控制方法
   - verify: `/todos` 可执行，`hapilon --todos-file ./my-todos.md` 可传参

## 关键风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| pi-wiki.md 过时（Pi 版本升级） | 生成的代码不兼容新版 Pi | SKILL.md 明确标注基于 Pi v0.80.6；reference/ 中引用 pi-wiki.md 行号，方便 diff 定位 |
| 用户需求描述模糊 | 生成无用代码 | Stage 1 追问协议强制执行，一次一个问题直到收敛 |
| ExtensionAPI 类型导入路径变更 | 代码编译失败 | examples/ 中的 import 路径与 pi-wiki.md 保持一致；标注"如有变化参考 pi-wiki.md" |
| 扩展文件放置后不生效 | 用户困惑 | Stage 4 给出明确诊断步骤（检查启动日志、确认文件名 .ts、确认目录路径） |
| reference/ 和 examples/ 与 SKILL.md 内容不一致 | 用户遵循错误指引 | SKILL.md 中所有引用标记为"详见 reference/xxx.md"，reference/ 标注来源 pi-wiki.md 行号 |

## 验收标准

- [ ] `write-pi-extension` SKILL 在 hapilon 项目的 `.claude/skills/` 下存在且结构完整
- [ ] SKILL.md frontmatter description 包含中英文触发词，覆盖所有 3 种用户表述
- [ ] SKILL.md 工作流 4 阶段完整：需求澄清 -> replan 编码计划（等待用户批准）-> 代码生成 -> 放置与验证
- [ ] reference/api-quick-reference.md 覆盖全部 ExtensionAPI 方法、ExtensionContext 属性、ExtensionCommandContext 方法
- [ ] reference/event-catalog.md 覆盖 pi-wiki.md 第 4 章全部事件类型，按类别组织
- [ ] reference/code-patterns.md 包含 6 个核心模式，每个可直接复制使用
- [ ] examples/simple-tool.ts 可独立加载并在 Pi 对话中调用
- [ ] examples/event-hook.ts 可独立加载并演示 hook 行为（通知 + block）
- [ ] examples/slash-command.ts 可独立加载，`/todos` 命令可执行
- [ ] 所有 TypeScript 示例：默认 export 工厂函数、typebox 参数定义、StringEnum 枚举
- [ ] 所有示例注释为中文，标注代码目的和关键设计决策
- [ ] SKILL.md 和 reference/ 文件中标注 pi-wiki.md 引用行号
- [ ] 扩展默认放置路径为 `~/.hapilon/agent/extensions/`，与 hapilon 的 `PI_CODING_AGENT_DIR` 配置一致
