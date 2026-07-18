# TODO 清单

> 当前任务：hapilon 自有上下文体系（HAPILON.md + skills + rules）

---

## [ ] TODO-14：CLI 注入 --no-context-files --no-skills，禁用 Pi 原生上下文识别

### 目标

在 `cli.ts` 默认启动参数中始终注入 `--no-context-files --no-skills`，禁止 Pi 自动加载 AGENTS.md / CLAUDE.md / `.pi/skills/` / `~/.pi/agent/skills/`。扩展自身路径不受影响。

### 实现要点

| 项目 | 内容 |
|------|------|
| 改什么 | `cli.ts` — `piArgs` 数组中追加 `"--no-context-files"` 和 `"--no-skills"` |
| CLI flag 策略 | 这两个 flag 是**始终注入**（非 `--no-safety` 可选），用户无需感知 |
| 兼容性 | `--no-skills` 不阻止 `--skill` 显式路径和 `resources_discover` 事件——hpl-context 扩展的 skills 仍正常加载 |
| 验证方式 | 在 hapilon TUI 内用 read 工具读 `/path/to/project/CLAUDE.md` —— LLM 不应"知道" CLAUDE.md 内容；但读 `.hapilon/HAPILON.md` 的内容应出现在上下文中（TODO-15 完成后） |

### 验收标准

- [ ] hapilon 启动后，AGENTS.md / CLAUDE.md 不再被注入上下文（即使项目根目录存在）
- [ ] `~/.pi/agent/skills/` / `.pi/skills/` 下的 skills 不再出现在 `<available_skills>` 中
- [ ] 不影响 hpl-footer / safety-gate / protected-paths 等其他扩展
- [ ] 全量测试不受影响

---

## [ ] TODO-15：hpl-context 扩展 — HAPILON.md + skills + rules 自有体系

### 目标

新建 `hpl-context` 扩展，替代 Pi 原生上下文识别，建立 hapilon 自己的三层体系：

| 层 | 内容 | 对标 | 注入方式 | 披露策略 |
|----|------|------|----------|----------|
| HAPILON.md | `~/.hapilon/HAPILON.md` + 项目 `.hapilon/HAPILON.md`（祖先遍历） | CLAUDE.md | `<hapilon_instructions>` XML block 追加到 systemPrompt | 全量 |
| Rules | `~/.hapilon/agents/rules/*.md` + `.hapilon/agents/rules/*.md` | `.claude/rules/` | `<hapilon_rules>` XML block 追加 | 全量（对标 alwaysApply） |
| Skills | `~/.hapilon/agents/skills/` + `.hapilon/agents/skills/` | `.claude/skills/` | `resources_discover` 事件返回 skillPaths，Pi 引擎接管 | **渐进式**（Pi 原生机制，自动） |

### 实现要点

| 项目 | 内容 |
|------|------|
| 扩展目录 | `src/extensions/hpl-context/`（index.ts + discover.ts + files.ts） |
| Skills 实现 | `session_start` 事件中返回 `{ skillPaths: [...] }` —— Pi 原生引擎接管后续（SKILL.md 解析、frontmatter 校验、名称去重、渐进式披露），**我们不需要写一行额外代码** |
| Rules 实现 | `before_agent_start` 事件中扫描 rules 目录，`.md` 文件 frontmatter 支持 `alwaysApply: true`（默认）/ `alwaysApply: false`（未来扩展），拼成 `<hapilon_rules>` block 追加到 `event.systemPrompt` |
| HAPILON.md 实现 | 同上，扫描 `~/.hapilon/HAPILON.md` + 从 cwd 向上遍历各层 `.hapilon/HAPILON.md`，拼成 `<hapilon_instructions>` block 追加 |
| 发现逻辑 | `files.ts` 纯函数：向上遍历目录收集 .hapilon/ 下的文件（祖先在前、深层在后）；`discover.ts` 负责格式化 XML block |
| 与 TODO-14 的关系 | 依赖 TODO-14 先关闭旧体系，否则 AGENTS.md 和 HAPILON.md 内容混合注入 |
| 信任模型 | 用户级（`~/.hapilon/`）不受信任限制；项目级（`.hapilon/`）——暂时不设信任门槛（与 Pi 对 AGENTS.md 的策略一致：无信任门槛），后续可加 |

### 验收标准

- [ ] `~/.hapilon/HAPILON.md` + 项目多级 `.hapilon/HAPILON.md` 全部注入上下文，祖先级在前、深层在后
- [ ] `~/.hapilon/agents/rules/*.md` + `.hapilon/agents/rules/*.md` 的 alwaysApply rules 注入上下文
- [ ] `~/.hapilon/agents/skills/` + `.hapilon/agents/skills/` 下的 skills 出现在 `<available_skills>` 中
- [ ] skills 完整复刻渐进式披露：仅 name + description 常驻 system prompt；正文通过 read tool 按需加载
- [ ] AGENTS.md / CLAUDE.md 不再注入（TODO-14 覆盖）
- [ ] files.ts + discover.ts 纯函数单元测试三层覆盖
- [ ] 全量测试不受影响
- [ ] 详细计划：`_plans/hpl-context-system.md`
