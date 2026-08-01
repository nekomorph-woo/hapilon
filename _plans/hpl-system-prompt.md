# hpl-system-prompt — hapilon 完全接管 Pi System Prompt

## Context

hapilon 当前通过 hpl-context 扩展的 `before_agent_start` 事件向 Pi 的 system prompt **追加** `<hapilon_instructions>` 和 `<hapilon_rules>`。但 Pi 原始 system prompt（"You are an expert coding assistant operating inside pi..."）仍然存在，hapilon 无法完全控制发给 LLM 的 system prompt 内容。

用户希望 hapilon 通过 `before_agent_start` 事件**全量替换** system prompt：第一版照抄 Pi 当前默认内容，用 XML 标签结构化分隔各部分，后续所有定制/优化/识别都由 hapilon 自主控制。

选择 `before_agent_start` 全量替换（而非 `--system-prompt` / customPrompt）的理由：
- `event.systemPromptOptions.toolSnippets` 提供**动态工具描述**，随工具启用/禁用自动适配
- 不依赖 CLI 参数硬编码工具描述
- 一个扩展内完成所有组装，逻辑集中

## 核心原则

1. **照抄第一版 + 立即改名**：第一版不修改 Pi 原始 system prompt 的语义内容，仅用 XML 标签重新组织。但 role 文本中加入 "named Hapilon"（"hapi" 是等价别名）
2. **动态部分从 options 提取**：tools、guidelines 等动态内容从 `event.systemPromptOptions` 获取，不硬编码。自定义工具（hapilon 扩展注册的 tool）自动出现在 `<available_tools>` 中，无需额外代码
3. **Fail Fast on assembly error**：组装出错时记录日志并降级到原始 `event.systemPrompt`，不静默吞错
4. **pi_documentation 适配 hapilon 路径**：hapilon 通过 `PI_CODING_AGENT_DIR=~/.hapilon/agent/` 改变了 Pi 全局路径。文档段中扩展开发指引必须指向 `.hapilon/` 体系而非 `.pi/` 体系

---

## 1. Pi System Prompt 完整内容（hapilon 当前运行时）

以下为 hapilon 使用 `--no-context-files --no-skills`、启用 read/bash/edit/write 四个工具时，`buildSystemPrompt()` 生成的完整 system prompt。

path 占位符说明：
- `<pi-readme-path>` = `getReadmePath()` 返回值（Pi 安装目录下的 README.md）
- `<pi-docs-path>` = `getDocsPath()` 返回值（Pi 安装目录下的 docs/）
- `<pi-examples-path>` = `getExamplesPath()` 返回值（Pi 安装目录下的 examples/）
- `<cwd>` = 当前工作目录

```
You are an expert coding assistant named Hapilon (also called "hapi"), operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed.
- Use edit for precise changes (edits[].oldText must match exactly)
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
- Use write only for new files or complete rewrites.
- Be concise in your responses
- Show file paths clearly when working with files

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: <pi-readme-path>
- Additional docs: <pi-docs-path>
- Examples: <pi-examples-path> (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)

Current working directory: <cwd>
```

### Guidelines 来源映射

| Guideline | 来源 | 触发条件 |
|-----------|------|----------|
| "Use bash for file operations like ls, rg, find" | `system-prompt.ts` 内置 | bash 启用 && grep/find/ls 均未启用 |
| "Use read to examine files instead of cat or sed." | read 工具 `promptGuidelines` | read 启用 |
| "Use edit for precise changes..." | edit 工具 `promptGuidelines` | edit 启用 |
| "When changing multiple separate locations..." | edit 工具 `promptGuidelines` | edit 启用 |
| "Each edits[].oldText is matched against..." | edit 工具 `promptGuidelines` | edit 启用 |
| "Keep edits[].oldText as small as possible..." | edit 工具 `promptGuidelines` | edit 启用 |
| "Use write only for new files or complete rewrites." | write 工具 `promptGuidelines` | write 启用 |
| "Be concise in your responses" | `system-prompt.ts` 内置 | 始终 |
| "Show file paths clearly when working with files" | `system-prompt.ts` 内置 | 始终 |

### 各工具 promptSnippet 与 promptGuidelines (完整)

| Tool | promptSnippet | promptGuidelines |
|------|---------------|------------------|
| **read** | `Read file contents` | `["Use read to examine files instead of cat or sed."]` |
| **bash** | `Execute bash commands (ls, grep, find, etc.)` | (无) |
| **edit** | `Make precise file edits with exact text replacement, including multiple disjoint edits in one call` | `["Use edit for precise changes (edits[].oldText must match exactly)", "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls", "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.", "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions."]` |
| **write** | `Create or overwrite files` | `["Use write only for new files or complete rewrites."]` |
| **grep** | `Search file contents for patterns (respects .gitignore)` | (无) |
| **find** | `Find files by glob pattern (respects .gitignore)` | (无) |
| **ls** | `List directory contents` | (无) |

---

## 2. XML 结构化设计

### 顶层结构

```xml
<system_prompt>
  <role>...</role>
  <available_tools>...</available_tools>
  <custom_tools_note>...</custom_tools_note>
  <guidelines>...</guidelines>
  <pi_documentation>...</pi_documentation>
  <hapilon_instructions>...</hapilon_instructions>
  <hapilon_rules>...</hapilon_rules>
  <project_context>...</project_context>
  <available_skills>...</available_skills>
  <environment>...</environment>
</system_prompt>
```

### 各 section 详解

#### `<role>`

包含原 Pi 的角色声明文本。**第一版照抄原文**，后续可定制。

```xml
<role>
You are an expert coding assistant named Hapilon (also called "hapi"), operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.
</role>
```

#### `<available_tools>`

从 `event.systemPromptOptions.toolSnippets` 动态生成。格式与原 Pi 一致（每行 `- name: snippet`）。

```xml
<available_tools>
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files
</available_tools>
```

**动态性**：hpl-system-prompt 不硬编码工具列表。用户启用/禁用工具时，`toolSnippets` 自动反映当前启用的工具集合。

#### `<custom_tools_note>`

照抄原 Pi 的 "In addition to the tools above..." 提示。

```xml
<custom_tools_note>
In addition to the tools above, you may have access to other custom tools depending on the project.
</custom_tools_note>
```

#### `<guidelines>`

组合两个来源：
1. `system-prompt.ts` 内建的 "Use bash for file operations..." (条件性)
2. `event.systemPromptOptions.promptGuidelines` 中来自工具的 guidelines
3. 内建 "Be concise in your responses" 和 "Show file paths clearly when working with files"

```xml
<guidelines>
- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed.
- Use edit for precise changes (edits[].oldText must match exactly)
...
- Be concise in your responses
- Show file paths clearly when working with files
</guidelines>
```

**动态性**：工具级 guidelines 从 `event.systemPromptOptions.promptGuidelines` 获取。内建 guidelines 则模仿 `system-prompt.ts` 的条件逻辑实现。

#### `<pi_documentation>`

**决策**：保留此 section，但内容必须适配 hapilon 的路径体系。

hapilon 通过 `PI_CODING_AGENT_DIR=~/.hapilon/agent/` 将 Pi 的全局配置目录从 `~/.pi/agent/` 改为 `~/.hapilon/agent/`。影响范围：

| Pi 默认路径 | hapilon 实际路径 | 说明 |
|------------|-----------------|------|
| `~/.pi/agent/extensions/` | `~/.hapilon/agent/extensions/` | 全局扩展 |
| `~/.pi/agent/skills/` | `~/.hapilon/agent/skills/` | 全局 Skills |
| `~/.pi/agent/prompts/` | `~/.hapilon/agent/prompts/` | Prompt 模板 |
| `~/.pi/agent/SYSTEM.md` | `~/.hapilon/agent/SYSTEM.md` | 全局 system prompt |
| `~/.pi/agent/settings.json` | `~/.hapilon/agent/settings.json` | 全局设置 |
| `.pi/extensions/` | `.pi/extensions/` | 项目扩展（不变，configDir 机制） |
| `.pi/skills/` | `.pi/skills/` | 项目 Skills（不变） |

**第一版内容**：保留 Pi 文档主题映射（extensions、themes、skills 等主题对应文件），但明确两点：
1. Pi 官方 API 文档位于 Pi 安装目录下（只读参考）
2. 用户开发的扩展应放在 `~/.hapilon/agent/` 路径体系下

```xml
<pi_documentation>
Pi and hapilon documentation (read only when the user asks about developing pi extensions, themes, skills, or TUI components):

API reference (Pi's built-in docs at its installation directory):
- When asked about: extensions (docs/extensions.md), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- Read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)

hapilon-specific paths (where user extensions/skills/rules actually live):
- Global extensions: ~/.hapilon/agent/extensions/  (not ~/.pi/agent/extensions/)
- Global skills: ~/.hapilon/agent/skills/
- Global settings: ~/.hapilon/agent/settings.json
- Project extensions: .pi/extensions/
- Project skills: .pi/skills/
- hapilon context: ~/.hapilon/HAPILON.md, .hapilon/HAPILON.md (ancestor-traversal, auto-injected)
- hapilon rules: ~/.hapilon/agents/rules/*.md, .hapilon/agents/rules/*.md (ancestor-traversal, auto-injected)
</pi_documentation>
```

#### `<hapilon_instructions>`

内容来源：`~/.hapilon/HAPILON.md` + `.hapilon/HAPILON.md` 向上遍历（由 `files.ts` 的 `collectUpward` + `readHapilonMd` 收集）。

```xml
<hapilon_instructions>
...HAPILON.md 内容（XML 转义后）...
</hapilon_instructions>
```

#### `<hapilon_rules>`

内容来源：`~/.hapilon/agents/rules/*.md` + `.hapilon/agents/rules/*.md` 向上遍历（由 `files.ts` 的 `collectUpward` + `readRules` 收集）。

```xml
<hapilon_rules>
<rule name="git-working-tree">
...规则内容（XML 转义后）...
</rule>
<rule name="coding-philosophy">
...规则内容（XML 转义后）...
</rule>
</hapilon_rules>
```

#### `<project_context>`

来源：`event.systemPromptOptions.contextFiles`。

由于 hapilon 使用 `--no-context-files`，此数组在 hapilon 下恒为空。保留此 section 以备将来启用 Pi 原生上下文识别，或 hapilon 自行注入项目上下文。

```xml
<project_context>
<!-- 当前为空；hapilon 使用 --no-context-files -->
</project_context>
```

#### `<available_skills>`

来源：`event.systemPromptOptions.skills`。

由于 hapilon 使用 `--no-skills`，此数组恒为空。Skills 渐进式披露由 Pi 原生引擎通过 `/skill:name` 触发，不需要在 system prompt 中列出。

```xml
<available_skills>
<!-- 当前为空；hapilon 使用 --no-skills -->
</available_skills>
```

#### `<environment>`

```xml
<environment>
Current working directory: <cwd>
</environment>
```

### 完整第一版 XML 示例（含 hapilon 内容占位）

```xml
<system_prompt>
<role>
You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.
</role>

<available_tools>
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files
</available_tools>

<custom_tools_note>
In addition to the tools above, you may have access to other custom tools depending on the project.
</custom_tools_note>

<guidelines>
- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed.
- Use edit for precise changes (edits[].oldText must match exactly)
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
- Use write only for new files or complete rewrites.
- Be concise in your responses
- Show file paths clearly when working with files
</guidelines>

<pi_documentation>
Pi and hapilon documentation (read only when the user asks about developing pi extensions, themes, skills, or TUI components):

API reference (Pi's built-in docs at its installation directory):
- When asked about: extensions (docs/extensions.md), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- Read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)

hapilon-specific paths (where user extensions/skills/rules actually live):
- Global extensions: ~/.hapilon/agent/extensions/  (not ~/.pi/agent/extensions/)
- Global skills: ~/.hapilon/agent/skills/
- Global settings: ~/.hapilon/agent/settings.json
- Project extensions: .pi/extensions/
- Project skills: .pi/skills/
- hapilon context: ~/.hapilon/HAPILON.md, .hapilon/HAPILON.md (ancestor-traversal, auto-injected)
- hapilon rules: ~/.hapilon/agents/rules/*.md, .hapilon/agents/rules/*.md (ancestor-traversal, auto-injected)
</pi_documentation>

<hapilon_instructions>
[~/.hapilon/HAPILON.md + 祖先 .hapilon/HAPILON.md 内容]
</hapilon_instructions>

<hapilon_rules>
<rule name="example-rule">
[规则正文]
</rule>
</hapilon_rules>

<project_context>
</project_context>

<available_skills>
</available_skills>

<environment>
Current working directory: /path/to/project
</environment>
</system_prompt>
```

---

## 3. 实现方案

### 3.1 方案选择：新建 `hpl-system-prompt` 扩展

**推荐方案：新建独立扩展 `hpl-system-prompt`**

理由：
- 单一职责：system prompt 的完整组装。hpl-context 保留 `resources_discover`（Skills 渐进式披露），移除其 `before_agent_start` handler
- 逻辑集中：所有组装逻辑在一个 handler 内完成
- 清晰的测试边界

**替代方案（不推荐）：合并到 hpl-context**

- 优点：少一个扩展文件
- 缺点：混合 `resources_discover`（Skills）和 `before_agent_start`（prompt组装）两个不同关注点，职责不清晰

### 3.2 架构关系图

```
hapilon CLI (cli.ts)
│ 注入 --no-context-files --no-skills
│ 加载扩展: hpl-context + hpl-system-prompt + ...
│
├─ hpl-context (保留)
│  └─ resources_discover → skillPaths (Skills 渐进式披露)
│
├─ hpl-system-prompt (新增)
│  └─ before_agent_start → 全量替换 systemPrompt
│     ├─ 从 event.systemPromptOptions 提取 tools/guidelines/cwd
│     ├─ 收集 HAPILON.md + rules (复用 files.ts / 直接 import)
│     └─ 组装 XML → return { systemPrompt: xml }
│
└─ hpl-safety-gate / protected-paths / hpl-footer (不变)
```

### 3.3 `before_agent_start` handler 组装逻辑

```typescript
pi.on("before_agent_start", (event) => {
  const opts = event.systemPromptOptions;
  const userHome = process.env.HOME;

  try {
    // 1. 组装 role section（第一版硬编码，后续从配置读取）
    const role = buildRoleSection();

    // 2. 组装 tools section（动态，从 options 提取）
    const tools = buildToolsSection(opts.toolSnippets, opts.selectedTools);

    // 3. 组装 guidelines section（动态 + 内建）
    const guidelines = buildGuidelinesSection(opts.promptGuidelines, opts.selectedTools);

    // 4. 收集 hapilon 上下文（复用 hpl-context 的文件发现逻辑）
    const hapilonInstructions = userHome ? buildHapilonInstructions(userHome) : "";
    const hapilonRules = userHome ? buildHapilonRules(userHome) : "";

    // 5. 组装 context section（可能为空）
    const projectContext = buildContextSection(opts.contextFiles);

    // 6. 组装 skills section（可能为空）
    const skills = buildSkillsSection(opts.skills);

    // 7. 组装 environment section
    const env = buildEnvironmentSection(opts.cwd);

    // 8. 拼接完整 XML
    const systemPrompt = wrapSystemPrompt([
      role,
      tools,
      buildCustomToolsNote(),
      guidelines,
      buildPiDocSection(),
      hapilonInstructions,
      hapilonRules,
      projectContext,
      skills,
      env,
    ]);

    return { systemPrompt };
  } catch (err) {
    // 降级：组装失败时使用原始 systemPrompt
    console.error("[hpl-system-prompt] Assembly failed, falling back to original:", err);
    return {}; // 返回空对象 = 不替换，使用 Pi 原始 prompt
  }
});
```

### 3.4 文件组织

```
src/extensions/hpl-system-prompt/
├── index.ts          # 扩展入口：pi.on("before_agent_start", ...)
├── assemble.ts       # XML 各 section 的 builder 函数（纯函数，可测试）
├── sections.ts       # 硬编码文本常量（role, pi_documentation, 内建 guidelines）
└── xml.ts            # xmlEscape() + wrapSystemPrompt() 工具函数
```

**职责拆分**：
- `index.ts`：生命周期绑定、错误处理/降级、依赖注入
- `assemble.ts`：从 options 和文件系统构建各 XML section，核心逻辑
- `sections.ts`：第一版硬编码的文本常量，后续可迁移到配置文件
- `xml.ts`：XML 转义和包装函数

### 3.5 代码复用策略

hpl-context 的 `files.ts` 中的 `collectUpward`、`readHapilonMd`、`readRules` 函数需要被 hpl-system-prompt 复用。

**方案**：将 `files.ts` 和 `format.ts` 提取为共享模块，两个扩展都 import。

具体提取路径：

```
src/shared/           # 新建共享目录
├── files.ts          # 从 hpl-context/files.ts 移动过来
└── format.ts         # xmlEscape() 从 hpl-context/format.ts 移动过来

src/extensions/hpl-context/
├── index.ts          # 改为 import from "../../shared/files.js"
└── (删除 files.ts, format.ts)

src/extensions/hpl-system-prompt/
├── index.ts          # import from "../../shared/files.js"
├── assemble.ts
├── sections.ts
└── xml.ts            # import from "../../shared/format.js" 的 xmlEscape
```

**替代方案**：hpl-system-prompt 直接 import hpl-context 的 `files.js` 和 `format.js`。优点是不需要新建 shared 目录；缺点是跨扩展 import 耦合度略高。

**建议**：使用共享目录方案。`files.ts` 和 `format.ts` 本质上是通用工具函数，不应与 hpl-context 扩展绑定。hpl-context 保留 `resources_discover` handler 和 `discoverSkillPaths` 函数（该函数不通用，保留在 hpl-context 内）。

### 3.6 降级 / Fallback 策略

三层降级：

| 级别 | 场景 | 行为 |
|------|------|------|
| L0 | 正常 | 全量替换为 XML 结构化 system prompt |
| L1 | hapilon 上下文收集失败（文件读取错误等） | 跳过出错的 section，其余 section 正常组装 |
| L2 | 整体组装异常（未预期的运行时错误） | `catch` 后返回 `{}`，Pi 使用原始 `event.systemPrompt`；console.error 记录错误 |

**不静默吞错**：L1 级别对单个文件读取失败使用 console.warn 记录（与当前 hpl-context 行为一致）。L2 级别的异常必定 console.error 记录。

### 3.7 与现有 hpl-context 的关系

| 方面 | hpl-context (修改后) | hpl-system-prompt (新增) |
|------|---------------------|--------------------------|
| `resources_discover` | 保留（Skills 渐进式披露） | 不处理 |
| `before_agent_start` | **删除** | 全量替换 system prompt |
| 文件发现 | 使用 `discoverSkillPaths`（保留在 hpl-context 内） | 使用共享的 `collectUpward` / `readHapilonMd` / `readRules` |

hpl-context 的 `before_agent_start` handler 删除后，它不再修改 system prompt。Skills 渐进式披露由 `resources_discover` 独立处理。

### 3.8 硬编码文本的处理

`sections.ts` 中的文本常量：

```typescript
// 第一版：照抄 Pi 源码 + 立即改名 "named Hapilon"
export const ROLE_TEXT = `You are an expert coding assistant named Hapilon (also called "hapi"), operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.`;

export const CUSTOM_TOOLS_NOTE = `In addition to the tools above, you may have access to other custom tools depending on the project.`;

// pi_documentation 区分两部分：API 参考（Pi 安装目录）+ hapilon 实际路径
export const PI_DOC_SECTION = `Pi and hapilon documentation (read only when the user asks about developing pi extensions, themes, skills, or TUI components):

API reference (Pi's built-in docs at its installation directory):
- When asked about: extensions (docs/extensions.md), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- Read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)

hapilon-specific paths (where user extensions/skills/rules actually live):
- Global extensions: ~/.hapilon/agent/extensions/  (not ~/.pi/agent/extensions/)
- Global skills: ~/.hapilon/agent/skills/
- Global settings: ~/.hapilon/agent/settings.json
- Project extensions: .pi/extensions/
- Project skills: .pi/skills/
- hapilon context: ~/.hapilon/HAPILON.md, .hapilon/HAPILON.md (ancestor-traversal, auto-injected)
- hapilon rules: ~/.hapilon/agents/rules/*.md, .hapilon/agents/rules/*.md (ancestor-traversal, auto-injected)`;

// 内建 guidelines（条件性的）
export const BUILTIN_GUIDELINES = {
  bashOnlyFileOps: "Use bash for file operations like ls, rg, find",
  beConcise: "Be concise in your responses",
  showFilePaths: "Show file paths clearly when working with files",
};
```

**后续演进**：
- 第 2 版可从 `~/.hapilon/config.json` 或 `.hapilon/system-prompt/` 加载自定义 role 文本
- 第 3 版可让用户通过 HAPILON.md 追加自定义 guidelines
- 第 N 版可支持 per-project system prompt 覆盖

### 3.9 XML 转义

复用 `xmlEscape()` 函数（当前位于 `hpl-context/format.ts:9-11`）：

```typescript
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
```

应用场景：
- `<hapilon_instructions>` 内容体（用户编写的 HAPILON.md 可能包含 `<` `>` `&`）
- `<hapilon_rules>` 中每条 rule 的正文
- `<rule name="...">` 的 name 属性值（规则文件名，通常不含特殊字符但防御性转义）

---

## 4. 文件与变更清单

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/extensions/hpl-system-prompt/index.ts` | 扩展入口：注册 `before_agent_start` handler、错误降级 |
| `src/extensions/hpl-system-prompt/assemble.ts` | 各 XML section 的 builder 函数（纯函数） |
| `src/extensions/hpl-system-prompt/sections.ts` | 第一版硬编码文本常量（role, pi_doc, 内建 guidelines） |
| `src/extensions/hpl-system-prompt/xml.ts` | `xmlEscape()` + `wrapSystemPrompt()` 工具函数 |
| `src/shared/files.ts` | 从 `hpl-context/files.ts` 提取的文件发现函数（共享） |
| `src/shared/format.ts` | 从 `hpl-context/format.ts` 提取的 `xmlEscape()` 函数（共享） |
| `src/test/unit/hpl-system-prompt.test.ts` | 单元测试：XML assembly 逻辑、escape、降级路径 |

### 修改文件

| 文件 | 变更内容 |
|------|----------|
| `src/cli.ts` | 无需修改（`--no-context-files --no-skills` 已注入） |
| `src/extensions/hpl-context/index.ts` | 删除 `before_agent_start` handler，保留 `resources_discover` handler；import 路径改为 `../../shared/files.js` 和 `../../shared/format.js` |
| `src/extensions/hpl-context/files.ts` | 移动 `collectUpward`/`readHapilonMd`/`readRules`/`splitFrontmatter`/`listFiles` 到 `src/shared/files.ts`；保留 `discoverSkillPaths` |
| `src/extensions/hpl-context/format.ts` | 移动 `xmlEscape` 到 `src/shared/format.ts`；保留 `formatHapilonMd`/`formatRules`（仍由 hpl-context 的旧代码使用，直到确认可删除） |
| `src/test/unit/hapilon-home.test.ts` | 更新相关 import path |

### 删除文件

| 文件 | 原因 |
|------|------|
| 无 | 第一版不改动 hpl-context 的旧 format.ts 函数，保留作为降级路径 |

> 注：`files.ts` 和 `format.ts` 的原文件可保留为 re-export 代理，避免破坏其他可能的 import。第二步再清理。

---

## 5. 实现步骤

### Step 1: 提取共享模块
- 创建 `src/shared/files.ts`，移动 `collectUpward`、`readHapilonMd`、`readRules`、`splitFrontmatter`、`listFiles`
- 创建 `src/shared/format.ts`，移动 `xmlEscape`
- 更新 `hpl-context/index.ts` 的 import 路径
- verify: `npx tsc --noEmit` 零错误 + 现有单元测试通过

### Step 2: 创建 sections.ts（硬编码文本常量）
- 定义 `ROLE_TEXT`、`CUSTOM_TOOLS_NOTE`、`PI_DOC_SECTION`、`BUILTIN_GUIDELINES`
- verify: `npx tsc --noEmit`

### Step 3: 创建 xml.ts（工具函数）
- 实现 `xmlEscape(s)` 和 `wrapSystemPrompt(sections: string[]): string`
- verify: 单元测试覆盖转义边界（空字符串、纯文本、含 `<>&"` 的文本）

### Step 4: 创建 assemble.ts（XML builder 函数）
- `buildRoleSection()` — 直接返回 sections.ts 常量
- `buildToolsSection(toolSnippets, selectedTools)` — 动态
- `buildGuidelinesSection(promptGuidelines, selectedTools)` — 组合内建 + 工具 guidelines，去重
- `buildHapilonInstructions(userHome)` — 调用 shared/files.ts
- `buildHapilonRules(userHome)` — 调用 shared/files.ts
- `buildContextSection(contextFiles)` — 遍历 contextFiles
- `buildSkillsSection(skills)` — 遍历 skills
- `buildEnvironmentSection(cwd)` — 直接拼接
- verify: 单元测试每个 builder 函数的输入输出

### Step 5: 创建 index.ts（扩展入口）
- 实现 `before_agent_start` handler
- 实现 try/catch 降级逻辑
- 注册扩展
- verify: 集成测试确认 system prompt 被替换

### Step 6: 修改 hpl-context
- 删除 `before_agent_start` handler
- 保留 `resources_discover` handler
- verify: Skills 渐进式披露仍然正常工作

### Step 7: 端到端测试
- 编译后启动 hapilon，验证 system prompt 内容
- 验证降级路径（故意制造文件读取错误）
- verify: 见验收标准

---

## 6. 关键风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Pi 更新后 role 文本或 guidelines 逻辑变化 | hapilon 的硬编码文本与 Pi 实际行为不一致 | **已决策**：编写语义等价性测试（见 §6.1）。用相同 options 调 hapilon 的 `assemble.ts` 和 Pi 的 `buildSystemPrompt()`，验证 role/tools/guidelines/cwd 段语义一致。Pi 升级 → 测试失败 → 知道要更新 |
| `event.systemPromptOptions` 的字段在 Pi 未来版本中变更 | `before_agent_start` handler 收到不兼容的 options | 使用 TypeScript 的类型检查（`BuildSystemPromptOptions` 来自 Pi SDK），版本升级时编译报错 |
| hapilon 用 `--no-context-files --no-skills` 后 contextFiles/skills 为空，若将来去掉这些 flag 则 XML 内容剧变 | system prompt 突然变长，可能影响 LLM 行为 | 保留 project_context 和 available_skills section 占位，无论是否为空都输出 section（内容为空时显示注释） |
| 文件发现函数移动后编译路径变化 | import 错误 | Step 1 后立即 `npx tsc --noEmit` + 运行已有测试 |
| Pi 文档路径硬编码 | Pi 安装路径在不同环境不同 | **已决策**：pi_documentation 分为两部分——API 参考指向 Pi 安装目录（只读），用户扩展开发路径指向 `~/.hapilon/agent/` 体系（hapilon 实际路径）。不写死绝对路径 |

### 6.1 语义等价性测试

**目的**：Pi 升级后自动检测 role/guidelines/tools 的语义变化。

**设计**：

```typescript
// test/unit/hpl-system-prompt.test.ts

describe("system prompt 语义等价", () => {
  it("hapilon 生成的 prompt 与 Pi 默认 prompt 语义一致", () => {
    // 构造与 Pi 默认行为一致的 options
    const opts = {
      selectedTools: ["read", "bash", "edit", "write"],
      toolSnippets: {
        read: "Read file contents",
        bash: "Execute bash commands (ls, grep, find, etc.)",
        edit: "Make precise file edits...",
        write: "Create or overwrite files",
      },
      promptGuidelines: [/* Pi 默认 guidelines */],
      cwd: "/test/project",
    };

    const hapilonPrompt = assembleSystemPrompt(opts, /* userHome */ "/home/test");
    const piPrompt = buildSystemPrompt({ ...opts, /* Pi 需要的额外字段 */ });

    // 非字符级对比，验证语义等价
    assert.ok(hapilonPrompt.includes('named Hapilon (also called "hapi")'), "role 存在且含 hapilon 标识 + hapi 别名");
    assert.equal(
      extractTools(hapilonPrompt).sort().join(","),
      extractTools(piPrompt).sort().join(","),
      "tools 列表一致",
    );
    // ... guidelines 条数、cwd 等
  });
});
```

**测试失败时的行为**：Pi 升级后测试失败 → 开发者检查差异 → 决定是更新 sections.ts 还是调整测试。**不会静默通过。**

---

## 7. 验收标准

- [ ] `hpl-system-prompt` 扩展成功注册，`before_agent_start` handler 在每次 agent turn 前触发
- [ ] 生成的 XML system prompt 包含所有 9 个 section（role, available_tools, custom_tools_note, guidelines, pi_documentation, hapilon_instructions, hapilon_rules, project_context, available_skills, environment）
- [ ] `<available_tools>` 内容与当前启用的工具集合一致（从 `event.systemPromptOptions.toolSnippets` 动态生成）
- [ ] `<hapilon_instructions>` 包含从 `~/.hapilon/HAPILON.md` 和祖先 `.hapilon/HAPILON.md` 收集的内容
- [ ] `<hapilon_rules>` 包含从 `~/.hapilon/agents/rules/` 和祖先 `.hapilon/agents/rules/` 收集的规则
- [ ] HAPILON.md 和 rules 内容经过 XML 转义，不会破坏 XML 结构
- [ ] 组装过程中任何一个 section 构建失败时，降级使用 Pi 原始 `event.systemPrompt`，并 console.error 记录错误
- [ ] hpl-context 的 `resources_discover` (Skills 渐进式披露) 仍然正常工作
- [ ] 现有单元测试全部通过（`npm test`）
- [ ] `npx tsc --noEmit` 零错误
