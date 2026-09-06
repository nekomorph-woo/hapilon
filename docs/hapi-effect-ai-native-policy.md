# hapi Effect AI-native 方案：pi-extension 实施设计（v1）

> 状态：可实施。
> 前置事实：hapi 自身（A 层）已 Effect 化完成——`feat/effect-intro` 全部合并后，
> `src/` 下所有 fs/子进程副作用均已走 Effect 内核（TaggedError 类型化错误、
> never 降级通道、prepareStartupEffect 启动管线）。
> 本文档只设计 B 层：**hapi 作为 coding agent，对目标项目（用户代码库）的 Effect-aware 策略层**。
> 实现载体：hapilon 自有 pi 扩展（hpl-*），不修改 Pi 内核，不写用户全局 Pi 配置。

---

## 0. 核心原则（先立规矩）

### 原则 1：Effect preference ≠ Effect mutation

hapi 偏好 Effect，但**绝不因为自己喜欢 Effect 就改动目标项目**：
- 不主动 `npm install effect`
- 不主动改目标项目的 `package.json` / `tsconfig.json` / `src/*`
- 引入 Effect 属于架构变更，**必须**由 EffectPolicy 判定为 `prefer`/`required` 且用户明确要求时才发生

### 原则 2：policy 是代码，不是 prompt

agent 的架构偏好由**确定性代码先行决策**（`decideEffectMode(signals)` 纯函数），
prompt 只执行决策结果。禁止把「请智能判断是否该用 Effect」交给 LLM——那等同于祝你好运。

### 原则 3：不污染用户全局配置

Effect 策略属于 **hapi runtime policy**，不属于用户全局 Pi 配置。
落地位置是 hapilon 自有扩展，通过 `~/.hapilon/agent/`（或项目级 `.hapilon/`）生效，
**不写 `~/.pi/agent/AGENTS.md`**——那个位置的语义是「用户对全体 agent 的指示」。

### 原则 4：代码即决策，prompt 即执行

```
ProjectInspector（廉价信号收集）
      ↓
EffectPolicy（纯函数决策，Effect-native）
      ↓
mode: disabled / respect-project / prefer / required
      ↓
条件注入（不满足条件 = 不注入 = 不花 token）
```

---

## 1. 架构定位

```
hapi runtime（A 层，已完成 Effect 化）
│
├── src/…                      Effect-native 内部架构
│
└── B 层：Effect-aware coding policy（本文档）
    │
    ├── extensions/hpl-effect-policy/      扩展主体
    │     ├── inspector.ts                 ProjectInspector：信号收集（Effect 化）
    │     ├── policy.ts                    decideEffectMode 纯函数
    │     ├── inject.ts                    prompt 段生成
    │     └── index.ts                     扩展入口
    │
    ├── hpl-system-prompt（已有）           接收 policy 输出，条件拼进 <coding_policy> section
    └── hpl-context（已有）                 （可选）skill 注入通道
```

与 A 层的关系：B 层扩展自身也是 Effect-native（复用 A 层已确立范式）——
inspector 的 fs 扫描走 Effect 内核，policy 决策是纯函数，
两扩展间的数据交接走 Effect 化接口。**hapi 以自身范式开发自身**。

---

## 2. 组件设计

### 2.1 ProjectInspector（`inspector.ts`）

会话启动时一次廉价检查，产出结构化信号。**Effect 化实现**（复用 A 层范式）：

```typescript
// src/extensions/hpl-effect-policy/inspector.ts

import { Data, Effect } from "effect";

export class InspectorError extends Data.TaggedError("InspectorError")<{ message: string }> {}

/** 项目信号集（纯数据） */
export interface ProjectSignals {
  readonly language: "typescript" | "javascript" | "other";
  readonly effectInstalled: boolean;        // package.json dependencies/devDependencies 含 effect
  readonly effectImportsFound: boolean;     // src 源码 import 到 effect 包
  readonly packageManager: "npm" | "pnpm" | "yarn" | "bun" | undefined;  // lockfile 判定
  readonly hasAgentsMd: boolean;            // AGENTS.md / CLAUDE.md 存在（架构已有主）
  readonly isGreenfield: boolean;           // 无 src/（或等价源码目录）且无 lockfile
  readonly isScriptTask: boolean;           // 见 2.5
}

/** 信号收集内核（never 通道：任何探测失败降级 false/undefined，policy 不因探测失败而失败） */
export const inspectProjectEffect: Effect.Effect<ProjectSignals, never> = Effect.gen(function* () {
  // 各探测点全部走 A 层已有 Effect 内核（collectUpwardEffect / discoverSkillPathsEffect 同款范式）
  // - readPackageJsonEffect: 读 package.json（不存在/坏 JSON → undefined 降级）
  // - detectEffectImportsEffect: 限定 src/ 两层深度的 import 扫描（失败 → false 降级）
  //   范围控制是硬约束：只扫 package.json 同级或 src/ 下两层，禁止全仓库递归
  ...
});
```

设计约束：
1. **廉价**：只读 `package.json`、`tsconfig.json`、lockfile、AGENTS.md/CLAUDE.md 存在性、
   src 下两层的 import 扫描。禁止全仓库递归扫描（大仓库扫描成本不可控）。
2. **永不失败**：错误通道 `never`——任何探测失败降级为保守值（false/undefined），
   policy 决策不能因为一个探测失败而炸掉会话。
3. **每会话一次**：`before_agent_start` 时机执行，结果缓存复用，不逐轮重扫。
4. 同步薄包装 `inspectProject()` 保留（供其他模块测试/调试）。

### 2.2 EffectPolicy（`policy.ts`）——纯函数决策

```typescript
// src/extensions/hpl-effect-policy/policy.ts
// 纯函数，零副作用，错误处理不适用——这是 policy 的核心价值：决策可测试、可预测

export type EffectMode =
  | "disabled"         // 完全不谈 Effect
  | "respect-project"  // 遵守项目现有架构，不引入 Effect（默认）
  | "prefer"           // 偏好 Effect（新项目可推荐）
  | "required";        // 项目已在用 Effect，必须遵循其 Effect 惯用法

export function decideEffectMode(signals: ProjectSignals): EffectMode {
  // 规则 1：非 TS 项目完全免谈（JS 也不谈——没有类型系统，Effect 的核心价值不成立）
  if (signals.language !== "typescript") return "disabled";

  // 规则 2：项目已在用 Effect → 必须遵循其现有 Effect 惯用法
  if (signals.effectInstalled || signals.effectImportsFound) return "required";

  // 规则 3：项目有明确架构指示（AGENTS.md/CLAUDE.md）→ 遵守原架构
  //   注意顺序：在 greenfield 判定之前——有 AGENTS.md 的"空"仓库不算 greenfield
  if (signals.hasAgentsMd) return "respect-project";

  // 规则 4：全新 TS 项目 → 可推荐 Effect
  if (signals.isGreenfield) return "prefer";

  // 规则 5：默认遵守现状
  return "respect-project";
}
```

规则顺序即优先级：`disabled > required > respect-project(架构指示) > prefer > respect-project(默认)`。

### 2.3 敏感文件覆盖（用户显式裁决）

policy 是代码决策，但用户始终有一票否决/强制权。两级配置，优先级从高到低：

| 层级 | 位置 | 形式 |
|------|------|------|
| 项目级 | `<project>/.hapilon/effect-policy.json` | `{ "mode": "disabled" \| "respect-project" \| "prefer" \| "required" }` |
| 全局级 | `~/.hapilon/effect-policy.json` | 同上 |

```typescript
// 裁决链：用户项目级 > 用户全局级 > decideEffectMode(signals) 自动判定
export const resolveEffectModeEffect: Effect.Effect<EffectMode, never> = Effect.gen(function* () {
  const signals = yield* inspectProjectEffect;
  const automatic = decideEffectMode(signals);
  // ensure 语义（复用 A 层范式）：文件不存在时读不到 → 走自动判定；
  // 存在但 mode 值非法 → warn + 走自动判定（不抛错）
  const userOverride = yield* readPolicyOverrideEffect(projectDir, globalDir);
  return userOverride ?? automatic;
});
```

覆盖文件用 `ensure-extension-configs.ts` 同款范式播种（不存在才写注释骨架或完全不写——
**默认不写**，不制造用户没要求的文件；文档说明即可）。

### 2.4 条件注入（`inject.ts`）——分模式 prompt 段

决策产出后，按 mode 生成不同的 system prompt 段。**不满足注入条件的 mode 不产生任何文本**（省 token，防 LLM 发疯）：

| mode | 注入内容 |
|------|----------|
| `disabled` | **什么都不注入**（一个字都不提 Effect） |
| `respect-project` | 短段：「遵守项目现有架构与惯用法；不引入新依赖除非任务要求；不主动迁移既有代码」 |
| `prefer` | respect 段 + 「For new TypeScript architecture, prefer Effect. Before adding Effect: explain the architectural choice; install only as part of the requested implementation」 |
| `required` | 完整段（该段本身就是动态生成的——把扫到的项目事实写进去） |

`required` 模式的动态注入模板（关键：**写的是扫到的项目事实，不是教科书**）：

```
<coding_policy>
This repository uses Effect (detected: {effectVersion}).
Follow its existing Effect idioms:
- Use typed errors: Data.TaggedError, Effect.fail — no bare throw in Effect contexts.
- Use Schema at untrusted boundaries.
- Respect existing services/layers/Context.Tag patterns found in this repo.
- Do not introduce raw Promise/async workflows unless integrating an external API.
- Do not upgrade/downgrade Effect or change its configuration without explicit user request.
</coding_policy>
```

### 2.5 脚本启发式（script heuristic）

「小脚本不强求 Effect」的判定（并入 `inspectProjectEffect` 的 `isScriptTask` 信号）：

| 简单脚本（plain TS acceptable） | 复杂脚本（prefer Effect） |
|---|---|
| one-shot | 并发（多文件/批量 API） |
| < ~100 行 | 重试/速率限制 |
| 少并发 | API 编排 |
| 无资源管理复杂度 | 结构化错误需求 |
| 无持久架构 | config/env 校验、长驻进程 |

实现上是启发式不是精确科学：来源是任务描述 + 会话上下文，在 inspector 中
仅作信号记录（`isScriptTask` 疑似脚本任务），最终由 prefer 模式的 prompt 段措辞
（"for one-shot scripts, plain TS is acceptable"）兜住。**不追求精确分类**——
policy 的粒度是「模式选择」，脚本复杂度的最终判断留给对话本身。

### 2.6 扩展入口（`index.ts`）

```typescript
// src/extensions/hpl-effect-policy/index.ts
// 入口签名与 hook 结构遵循 hpl-* 既有范式（Effect 化完成后 hapilon 自身的扩展写法）

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function hplEffectPolicy(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    // before_agent_start 的返回值可以携带 resources/skill 路径？
    // —— 不确定，实施时验证。备选通道：写入共享状态文件，
    //    由 hpl-system-prompt 的 before_agent_start 桥接读取。
    ...
  }
```

**跨扩展桥接（本方案的对接关键，已验证可行）**：hpl-effect-policy 不自己改 system prompt
——`hpl-system-prompt` 的 before_agent_start 会**全量替换** system prompt（基线行为），
其他扩展写的 prompt 会被抹掉（ponytail 末位教训的镜像）。正确接法：

1. `hpl-effect-policy` 在自己的 `before_agent_start`（或 `session_start`）里跑
   `resolveEffectModeEffect` 并把结果存模块级状态（先例：hpl-econ 的 `setSessionDisabled`
   就是这样被 cli.ts 跨模块调用的）
2. `hpl-system-prompt/assemble.ts` 的 section 拼接处新增一个 builder：
   `buildCodingPolicySection(mode): string | undefined`——mode 为 disabled 时返回 undefined（不拼进 prompt）
3. section 文本本身放 hpl-effect-policy 的 `inject.ts`（policy 的语义归 policy 扩展所有），
   hpl-system-prompt 只负责「如果有人提供了 policy 文本就拼进去」的通用机制——
   实现上：hpl-effect-policy 把生成好的 section 文本存到跨扩展桥接模块
   `src/extensions/hpl-effect-policy/bridge.ts`（模块级导出 get/set），
   hpl-system-prompt 的 assemble 从 bridge 读，读不到就不拼。

```
hpl-effect-policy                          hpl-system-prompt
      │                                          │
 resolveEffectModeEffect                    before_agent_start
（inspector → policy → override）                 │
      │                                          │
 bridge.setPolicySection(text) ──────────→ bridge.getPolicySection()
                                              │
                                    buildCodingPolicySection(text)
                                              │
                                    拼进 XML system prompt（disabled 时不拼）
```

时序保证：两个扩展的 before_agent_start 按注册顺序执行——hpl-effect-policy 在
npm-extensions.ts 的注入清单里排在 hpl-system-prompt 之前（loader 字母序已经保证
hpl-e < hpl-s，实测确认即可），policy 先算、system-prompt 后拼，无竞态。

**桥接注（模块级状态 vs 状态文件）**：两扩展同进程加载，模块级单例状态即桥接
（hpl-econ 先例）。不用状态文件——文件会引入额外的时序与清理问题。
bridge.ts 里对 section 文本做每会话重算（before_agent_start 每次触发都重算 policy），
不做跨会话缓存——policy 决策廉价，缓存引入 staleness 风险不划算。

---

## 3. skill 层（可选增强，二期）

模式决策是「是否谈 Effect」；skill 层是「怎么用好 Effect」。**二期再上**——
一期先把 policy 决策链跑通（inspector → policy → 注入），pattern 库随后补充：

```
skills/effect-typescript/
├── SKILL.md            # 触发条件：mode ∈ {prefer, required} 时的 Effect 编码指南
├── patterns.md         # TaggedError / Layer / Schema / Scope 常用模式
└── examples/           # 从 hapilon 自身代码提取的实例（hapi 以自身开发自身）
```

注入通道走 hapilon 已有的 skills 体系（hpl-context 的 resources_discover →
Pi 原生 loadSkillsFromPaths）。SKILL.md frontmatter 写条件触发描述，
由模型按需读取（渐进式披露），不在 mode=disabled/respect-project 时进入 context。

## 4. 分包归属

B 层代码归属 `src/extensions/hpl-effect-policy/`（扩展维度分包，与 hpl-* 同级）。
不建 `src/policy/` 顶层包——它是扩展语义，不是启动器语义。

若未来 policy 被启动器复用（如 `hapi config effect-policy --set` CLI 子命令），
届时把 `policy.ts`（纯函数）与 `inspector.ts` 提升到 `src/config/` 或 `src/policy/`，
扩展内 re-export。**先扩展内聚，有第二个消费者再提升**。

## 5. 实施切分（每个都是独立可验收批次，走 a→b→c→d 循环）

| 批次 | 内容 | 验收 |
|------|------|------|
| R1 | `policy.ts` 纯函数 + 全分支单测（规则顺序、边界信号组合） | 决策表 100% 覆盖 |
| R2 | `inspector.ts` 信号收集（Effect 内核 + never 降级）+ 测试 | 各信号真/假/探测失败三态测试 |
| R3 | 覆盖配置读取（`readPolicyOverrideEffect`）+ 裁决链 | 项目级>全局级>自动 的优先级测试 |
| R4 | 跨扩展桥接 bridge + hpl-system-prompt 的 buildCodingPolicySection | 四种 mode 的注入/不注入断言 |
| R5 | 扩展入口接线 + npm-extensions/loader 无需改动确认（loader 字母序自动发现） | 端到端：四种 mode 在真实会话的 prompt 差异 |
| R6（二期） | effect-typescript skill（patterns 从 hapilon 自身代码提取） | 渐进披露验证 |

R1-R5 合计约 4 个扩展文件 + hpl-system-prompt 一处 builder + 测试。
R1/R2/R3 是纯函数与 Effect 内核，worker-codex 擅长；R4 的跨扩展桥接是最需要
reviewer 盯的点（时序、让位规则、disabled 不注入）。

## 6. 验收标准

```text
[ ] 非 TS 项目：/suggest-dirs 类任意任务，prompt 中零 Effect 字样
[ ] 已用 Effect 的 TS 项目：required 模式，动态段含项目实际 effect 版本
[ ] 有 AGENTS.md 的普通 TS 项目：respect-project 段，无 Effect 推荐
[ ] 全新 TS 项目：prefer 模式段含「explain before adding」约束
[ ] 覆盖文件 .hapilon/effect-policy.json: disabled → 任何信号都不注入
[ ] 覆盖文件非法 mode → warn + 自动判定兜底
[ ] 用户显式 SYSTEM.md/--system-prompt 时：让位规则优先，policy 段也不注入（与现有让位规则一致）
[ ] 每会话 policy 重算，无跨会话缓存
[ ] B 层扩展自身代码符合 A 层 Effect 范式（TaggedError / 禁裸 throw / either 薄包装）
```

## 7. 反模式清单（code review 时逐条对照）

1. **全局「Always use Effect」prompt**——本方案的死敌。hapi 看到任何 .ts 都撒 Effect
2. **policy 放进 `~/.pi/agent/AGENTS.md`**——污染用户全局配置
3. **LLM 自主决策 mode**——policy 必须是 `decideEffectMode(signals)` 确定性纯函数
4. **全仓库递归 import 扫描**——inspector 只扫两层，大仓库不可接受
5. **跨会话缓存 policy 结果**——决策廉价，staleness 不划算
6. **hpl-effect-policy 自己改 system prompt**——会被 hpl-system-prompt 全量替换抹掉（ponytail 教训镜像）
7. **disabled 模式仍注入任何 Effect 相关文本**——一个字都不该有
8. **默认播种 effect-policy.json 覆盖文件**——不制造用户没要求的文件
9. **把 Effect 教科书塞进 system prompt**——pattern 库走 skill 渐进披露（二期）

## 8. 与 GPT 方案的差异说明（为什么这么落地）

| GPT 方案 | 本文档实施版 | 原因 |
|----------|--------------|------|
| `adapters/pi/` 包 Pi SDK 建 domain/services/layers 分层 | 不做架构重分层；policy 以 hpl-* 扩展落地 | hapi 是 Pi 薄启动器 + 扩展发行层（PRD §5 薄启动器原则），Pi 已经是受控 adapter（锁版本、resolvePiCli 单一来源）；A 层 Effect 化刚完成且行为零变化验证过，架构重分层会推翻刚验收的基线。GPT 的分层是"从零设计 hapi"的思路，hapilon 是既有项目 |
| Effect skill 一期就上 | 二期 | 一期先跑通 policy 决策链；pattern 库的 patterns 从 hapilon 自身代码提取（hapi 以自身开发自身），值得单独一批做细 |
| Project Inspector 单独服务 | inspector 是 hpl-effect-policy 内的模块 | 同上——先扩展内聚，有第二个消费者再提升（§4） |
| "PI_SKIP_VERSION_CHECK" 之类启动器细节 | 不涉及 | 已存在 |
| policy 模式四态 | 四态保留 + 用户覆盖文件两级 | 增加用户一票否决/强制权，policy 不能只听代码的 |
| — | 新增 hpl-system-prompt 让位规则联动 | 用户显式 SYSTEM.md 时 policy 段也不注入——尊重用户显式配置是 hapilon 既有让位哲学 |
| — | 新增反模式清单 + 验收标准 | 给 worker/reviewer 的循环提供硬锚 |

## 9. 工程流程

沿用已验证的多 agent 循环：main claude 切批（R1-R6）→ worker-codex 实现 →
reviewer-claude 审查（对照本文档 + 功能基线）→ func-check 缺失检查 → 收口提交。
每批走完整门禁（build + 800 测试全绿）。文档本身随 R1 提交进 `docs/`，
作为后续批次的审查锚点。

---

## 附：决策规则速查（给 reviewer 的对照表）

| 信号组合 | mode | 注入 |
|----------|------|------|
| language ≠ typescript | disabled | 无 |
| effectInstalled ∨ effectImportsFound | required | 动态段（含版本） |
| hasAgentsMd（无 effect） | respect-project | 短段 |
| isGreenfield（无 AGENTS.md） | prefer | prefer 段 |
| 其余 | respect-project | 短段 |
| 用户覆盖文件 mode=disabled | disabled | 无（最高优先级） |
| 用户覆盖文件非法值 | warn + 自动判定 | — |
| 用户显式 SYSTEM.md | （policy 段不注入） | 无 |
