# hpl-context — hapilon 自有上下文体系

> 状态：待实现（TODO-14 + TODO-15）
> 调研方式：本源码级确认（`_foresight.md` §对其他 Coding Agent 生态的识别）
> 前置依赖：foresight 研究已完成（Pi system prompt 构建 / skills 引擎 / resources_discover 事件）

---

## 1. 背景

Pi Coding Agent 自动识别以下上下文资产：
- **上下文文件**：`AGENTS.md > AGENTS.MD > CLAUDE.md > CLAUDE.MD`（每目录取第一个命中）
- **Skills**：`~/.pi/agent/skills/` + `.pi/skills/` + `.agents/skills/`
- **扫描范围**：从 cwd 逐级向上到文件系统根目录 + Pi agentDir（hapilon 下为 `~/.hapilon/agent/`）
- **无信任门槛**：项目级内容不论是否 trusted 都加载

hapilon 应以自己的 `~/.hapilon/` / `.hapilon/` 体系**完全替代**上述原生识别，建立与 Claude Code 对标的三层上下文 — HAPILON.md / rules / skills。

## 2. 可行性确认（详见 §2-4）

| # | 需求 | 结论 | 关键 API / Flag |
|---|------|------|-----------------|
| 1 | 禁用 Pi 原生上下文识别 | ✅ `--no-context-files --no-skills` 两个 CLI flag | `cli.ts` 始终注入 |
| 2 | hapilon 自有体系 | ✅ 一个 `hpl-context` 扩展覆盖全部三种内容类型 | `resources_discover` + `before_agent_start` |
| 3 | Skills 渐进式披露 | ✅ **自动**——Pi 原生引擎接管 `resources_discover` 返回的 skillPaths，自动做格式校验 / 名称去重 / 渐进式注入 | 零额外代码 |

## 3. 目标版式

### 3.1 目录布局

```
~/.hapilon/                       # 用户级（全局，所有项目生效）
├── HAPILON.md                    # 对标 CLAUDE.md
└── agents/
    ├── skills/                   # 对标 ~/.claude/skills/
    │   └── <skill-name>/
    │       └── SKILL.md
    └── rules/                    # 对标 ~/.claude/rules/
        ├── git-working-tree.md
        └── coding-philosophy.md

.hapilon/                         # 项目级（仅在当前项目生效）
├── HAPILON.md
└── agents/
    ├── skills/
    └── rules/
```

### 3.2 最终注入效果

```
┌─ System Prompt（发给 LLM 的开场指令）──────────────────────────┐
│ "You are an expert coding assistant..." [Pi 默认或 SYSTEM.md]   │
│                                                                 │
│ <hapilon_instructions>                                          │
│    ~/.hapilon/HAPILON.md 内容                                   │
│    /ancestor/.hapilon/HAPILON.md 内容                           │  ← 祖先在前
│    /ancestor/child/.hapilon/HAPILON.md 内容                     │
│    /cwd/.hapilon/HAPILON.md 内容                                │  ← 深层在后
│ </hapilon_instructions>                                         │
│                                                                 │
│ <hapilon_rules>                                                 │
│    ~/.hapilon/agents/rules/xxx.md                               │
│    .hapilon/agents/rules/yyy.md                                 │
│ </hapilon_rules>                                                │
│                                                                 │
│ <available_skills>              ← Pi 引擎自动生成                │
│    <skill>                                                      │
│      <name>my-skill</name>                                      │
│      <description>...</description>                             │
│      <location>~/.hapilon/agents/skills/my-skill/SKILL.md</loc> │
│    </skill>                                                     │
│    ...                                                          │
│ </available_skills>                                             │
│                                                                 │
│ Current working directory: /path/to/project                     │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 与 Pi 原生注入的关键差异对比

| 项 | Pi 原生识别 | hpl-context 替代 |
|----|-----------|-----------------|
| 上下文文件名 | `AGENTS.md > AGENTS.MD > CLAUDE.md > CLAUDE.MD`（四选一） | `HAPILON.md` 单一名 |
| 多文件策略 | 每目录取第一个命中（同目录不合并） | 所有文件**拼接合并**（用户级→祖先级→项目级） |
| Skills 路径 | `~/.pi/agent/skills/` + `.pi/skills/` + `.agents/skills/` | `~/.hapilon/agents/skills/` + `.hapilon/agents/skills/` |
| Skills 引擎 | Pi 原生（自动） | **复用 Pi 原生引擎**（`resources_discover` 事件） |
| Rules 概念 | Pi 无内置 rules | 新增；对标 Claude Code `.claude/rules/`，全量注入（alwaysApply） |
| 格式容器 | `<project_instructions path="...">` | `<hapilon_instructions>` + `<hapilon_rules>` |

## 4. 实现设计

### 4.1 文件组织

```
src/extensions/hpl-context/
├── index.ts     # 扩展入口：resources_discover + before_agent_start 接线
├── files.ts     # 纯函数：扫描 hapilon 目录体系，收集 HAPILON.md / rules / skills 文件路径和内容
└── format.ts    # 纯函数：格式化为 XML block（<hapilon_instructions>/<hapilon_rules>）
```

### 4.2 files.ts 纯函数接口（TDD 对象）

```typescript
// 单层目录内的文件发现
listFiles(dir: string, pattern: string): string[]
  // pattern = "HAPILON.md" → [路径]
  // pattern = "*.md"     → [rule1.md, rule2.md, ...]

// 向上遍历收集指定文件（祖先在前、深层在后）
collectUpward(startDir: string, home: string, relative: string): string[]
  // relative = "HAPILON.md" → 从 cwd 到根的各层 .hapilon/HAPILON.md
  // relative = "agents/rules" → 各层 .hapilon/agents/rules/ 目录

// 读 HAPILON.md 内容
readHapilonMd(paths: string[]): { path: string; content: string }[]

// 读 rules .md 内容（解析 frontmatter）
readRules(dirPaths: string[]): { path: string; content: string; name: string; alwaysApply: boolean }[]

// 扫描 skills 目录（仅返回路径，内容由 Pi 引擎管理）
discoverSkillPaths(dirs: string[]): string[]
```

### 4.3 format.ts 纯函数接口（TDD 对象）

```typescript
formatHapilonMd(files: { path: string; content: string }[]): string
  // → <hapilon_instructions>\n\n[content]\n</hapilon_instructions>

formatRules(rules: { name: string; content: string }[]): string
  // → <hapilon_rules>\n\n<rule name="xxx">\n[content]\n</rule>\n</hapilon_rules>
  // 仅格式化 alwaysApply: true 的规则
```

### 4.4 index.ts 要点

**resources_discover 事件**（Pi types.d.ts:392）：
```typescript
pi.on("resources_discover", (_event) => {
  return {
    skillPaths: [
      ...scanSkills(join(home, ".hapilon/agents/skills")),
      ...collectUpwardSkills(cwd),
    ]
  };
});
```
返回后 Pi 引擎接管全部 skill 生命周期——不需要我们注册任何 tool 或管理加载。

**before_agent_start 事件**（Pi types.d.ts:367）：
```typescript
pi.on("before_agent_start", (event) => {
  const hapilonBlock = formatHapilonMd(readHapilonMdPaths(...));
  const rulesBlock = formatRules(readAllRules(...));
  return {
    systemPrompt: event.systemPrompt + "\n" + hapilonBlock + "\n" + rulesBlock
  };
});
```
链式覆盖——`event.systemPrompt` 是上一个 handler 产出的结果，我们追加即可。

### 4.5 文件发现顺序（对标 AGENTS.md 的祖先遍历）

`collectUpward(startDir, home)`：
1. 从 startDir 逐级向上（dirname 循环）
2. 每层读 `<dir>/.hapilon/<relative>`，发现记录推入数组
3. 遇文件系统根目录停止
4. 最后反转数组——祖先在前、深层在后（`reverse()`）

用户级 `~/.hapilon/HAPILON.md` 和 `~/.hapilon/agents/` 在遍历外单独处理：
- `~/.hapilon/` 内容排在项目级祖先内容**之前**
- 等价逻辑：`[homeHapilonMd] + collectUpward(cwd, home).reverse()`

### 4.6 渐进式披露确认

Skills 的渐进式披露由 Pi 引擎自动完成。验证点：
- `resources_discover` 返回的 skillPaths 被 Pi 调用 `loadSkillsFromPaths()`
- 每个 SKILL.md 的 frontmatter 被解析（name + description）
- `formatSkillsForPrompt()`（skills.js:257-278）注入 `<available_skills>` XML
- 仅 `disableModelInvocation !== true` 的 skill 出现在 system prompt
- LLM 需要时通过 read tool 按需加载完整 SKILL.md

## 5. CLI 侧改造（TODO-14）

`cli.ts` 当前的 `piArgs` = `injectDefaultArgs(args, config)` 来自 config-io.ts。
改动点：在 `piArgs` 数组末尾始终追加两个 flag：

```typescript
// cli.ts main() 中，piArgs 构建之后
piArgs.push("--no-context-files", "--no-skills");
```

影响面：
- `--no-context-files`：禁用所有 AGENTS.md / CLAUDE.md / AGENTS.MD / CLAUDE.MD 扫描
- `--no-skills`：禁用内置 skills 发现路径（`~/.pi/agent/skills/`、`.pi/skills/`、`.agents/skills/`、包内 skills）
- **不影响**：`--skill` 显式路径、`resources_discover` 事件（扩展返回的 skillPaths）、settings.json 的 `skills` 数组

## 6. 任务拆分

| # | 任务 | 文件 | 验证方式 |
|---|------|------|----------|
| 1 | TODO-14: CLI flag 注入 | `cli.ts` 1 行 | hapilon 启动 → TUI 内 read CLAUDE.md → LLM 不应"知道"内容 |
| 2 | files.ts 纯函数 TDD | `files.ts` + 测试 | 三层覆盖：无 .hapilon 目录 / 单层 / 多级嵌套 |
| 3 | format.ts 纯函数 TDD | `format.ts` + 测试 | 空输入 / 单文件 / 多文件 / 空内容 |
| 4 | index.ts 接线 + tsc 编译 | `index.ts` | tsc 通过 + discoverExtensions 发现新扩展 |
| 5 | Skills 渐进式披露实测 | 手测 | 放一个 skill 在 `.hapilon/agents/skills/` 下，验证 TUI 中 `<available_skills>` 出现且 LLM 能按需加载 |
| 6 | 端到端手测 | 手测 | 完整版式对照 §3.2 |

## 7. 验收标准

- [ ] TODO-14: AGENTS.md / CLAUDE.md 不再注入上下文；`.pi/skills/` skills 不再出现在 `<available_skills>`
- [ ] `~/.hapilon/HAPILON.md` + 多级 `.hapilon/HAPILON.md` 全部注入，祖先在前、深层在后
- [ ] `~/.hapilon/agents/rules/*.md` + `.hapilon/agents/rules/*.md` alwaysApply rules 注入
- [ ] `~/.hapilon/agents/skills/` + `.hapilon/agents/skills/` skills 出现在 `<available_skills>` 中
- [ ] Skills 完整复刻渐进式披露：正文通过 read tool 按需加载（手测确认）
- [ ] files.ts + format.ts 单元测试全过（三层覆盖）
- [ ] hpl-footer / safety-gate / protected-paths 不受影响（全量测试）
