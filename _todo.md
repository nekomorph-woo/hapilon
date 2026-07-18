# TODO 清单

> 当前任务：hapilon 完全控制 System Prompt

---

## [~] TODO-16：hapilon 完全接管 System Prompt — XML 结构化 + 全量自主控制

### 目标

用 `before_agent_start` 全量替换 Pi 默认 system prompt，改为 hapilon 自有体系：第一版照抄 Pi 当前内容，用 XML 标签明确分隔各部分（参考 Claude Code），后续所有定制/优化/识别都由 hapilon 自主控制。

### 实现要点

| 项目 | 内容 |
|------|------|
| 方案 | `before_agent_start` 全量替换（非 `--system-prompt`），因为能拿到动态 toolSnippets、不依赖硬编码 |
| 扩展位置 | `src/extensions/hpl-system-prompt/`（新扩展）或扩展现有 hpl-context |
| 第一版策略 | 从 `event.systemPromptOptions` 动态组装，内容照抄 Pi 原始默认 prompt，结构改为 XML |
| XML 结构 | 参考 Claude Code 的 `<system_prompt>` / `<tools>` / `<guidelines>` / `<project_context>` 分层 |
| HAPILON.md + Rules | 整合进 hpl-system-prompt，统一由一处管理（替代 hpl-context 的注入逻辑） |
| 工具描述 | 从 `event.systemPromptOptions.toolSnippets` 动态生成，随工具启用/禁用自动适配 |
| 降级策略 | 若 `before_agent_start` 不可用或组装失败，保留 Pi 原始 prompt 作为 fallback |

### 验收标准

- [ ] hapilon 启动后，LLM 收到的 system prompt 完全由 hapilon 构建（不再包含 Pi 原始 "You are an expert coding assistant..."）
- [ ] system prompt 用 XML 标签清晰分隔各部分（`<role>` / `<tools>` / `<guidelines>` / `<hapilon_instructions>` / `<hapilon_rules>`）
- [ ] 工具描述动态生成，与 Pi 默认行为一致（read/bash/edit/write + 自定义工具）
- [ ] HAPILON.md + rules 内容整合进 system prompt（替代现有 hpl-context 的注入）
- [ ] 不影响 hpl-footer / safety-gate / protected-paths 等其他扩展
- [ ] 全量测试不受影响
- [ ] 详细计划：`_plans/hpl-system-prompt.md`
