# 系统提示词迭代优化 — 调研与集成报告（2026-09-17）

> 完整过程产物在 `~/.hapilon-dev/plan-task/2026-09-17-system-prompt-iteration/`
> （模式目录、候选、bench、逐格结果）。本文为沉淀版。

## 背景与方法

hapilon 系统提示（hpl-system-prompt 全量替换 Pi 默认）结构清晰但缺全部工作方法论
（探索先行、调试循环、交付验证、结论先行等）。本次以五份顶级 harness 系统提示
（claude-code / codex / dsh / kimi-code / omp）为参照提炼模式目录，起草 3 个候选
（+ 原提示作基线），在自建 bench 上以 zai/glm-5.3-flash:high 与
deepseek/deepseek-flash 双模型、glm-5.3 评委跑了 2 轮 64 格基准。

## 模式目录要点（六维度最强资产）

| 维度 | 最强来源 | 核心措辞 |
|---|---|---|
| 探索纪律 | omp | Read sections, not snippets；禁止第二套惯例；改共享符号先查全调用点 |
| 调试循环 | omp + dsh | 复现→修因→确认复现消失；失败输出必须先调查 |
| 交付验证 | kimi-code | 以用户将收到的形态验证；exercise real calls, not only imports |
| 沟通风格 | codex+omp | 结论先行；最终回复自包含；Problem/Decision/Check/Next 四段 |
| 范围纪律 | claude-code | 完整交付；例行判断自己拿主意；阻塞式提问高门槛；缩范围是用户的决定 |
| 纠错纪律 | claude-code | 只在影响结论时纠正；无道歉；追问≠纠错信号 |

## 基准结果

| 轮次 | 任务 | 格数 | obj | judge | 结论 |
|---|---|---|---|---|---|
| r1 | 六任务（设计/根因/TDD/重构/问答/聊天） | 48 | ≈100% | 95-99% | 饱和；c2 方向性最佳（glm 99.2% vs baseline 95.4%） |
| r2 | 陷阱任务（范围纪律/症状压制） | 16 | 100% | 19-20/20 | 仍饱和，被测模型能力过剩 |

**核心结论**：当前被测模型档位（glm-5.3-flash:high / deepseek-flash）上提示词不是
瓶颈——64 格全绿，无法也不需要靠基准证明「明显提升」。采纳决策转为准据：
方向性证据 + 零回退风险 + 最低成本。

## 集成内容

`c2-workflow-core` 胜出：新增 `<workflow>` section（+1,345B），四步工作流核心，
位于 `</role_commit_boundary>` 与 `<pi_documentation>` 之间。

- `sections.ts`：`WORKFLOW_TEXT` 常量（提炼自 omp 探索/调试三步、dsh 失败必查、
  kimi-code 交付验证、codex 结论先行）
- `assemble.ts`：`buildWorkflowSection()` + 组装挂点 + metadata 计量
- `hpl-context-viewer`：types/collector 计入 workflow section（/context 可见）
- 测试：`hpl-system-prompt.test.ts` 新增 section 测试 + 全装配 16 标签 + 顺序断言

组装后系统提示 7,730B → 9,075B（+17%）。`npm run build` 通过，
`npm run test:unit` 1091/1091 全绿，无头启动验证正常。

## 最终 WORKFLOW_TEXT

```
Work in this order; skip a step only when it does not apply to the task.

1. Explore before editing. Understand the real flow before changing it: read the entry points and the code you are about to touch, and find every caller before modifying shared code. Reuse patterns that already exist in the codebase — a second convention beside an existing one is a defect. If a tool call fails or a file changed since you read it, re-read before acting.

2. Debug from cause to symptom. When something fails, investigate the failure output before moving on — never build on an unexplained red. Reproduce the bug first, form one hypothesis, verify it with the smallest experiment that could disprove it, then fix the cause. Never suppress the symptom or special-case the failing input unless asked.

3. Verify before calling it done. Exercise the deliverable the way the user will receive it: run the project's build or tests, or the actual command or scenario — not just an import or compile. Never claim completion while tests are red or work is partial. If tests fail, show the output; if something could not be verified, say so plainly.

4. Lead with the conclusion. Open the final reply with the outcome, then the reasoning and evidence needed to assess it — what changed, where (file paths), and how it was verified.
```

## 后续可选

c3-cc-full（范围+纠错纪律，+3.0KB）与 c4-hybrid（+omp 闸门，+3.4KB）留档于
`plan-task/.../candidates/fragments/`，未发现边际收益（当前模型不越界、不滥纠错）；
若未来任务难度升级或模型档位下探，可复用 bench（run.sh/score.sh/report.mjs）
直接重测。bench v3（多步代理任务+对抗性规格）是拉大区分度的前提。
