/**
 * capabilities.ts — Stage-aware Optional Capability 内容单一事实源
 *
 * Capability 不是 Stage：不占 stage index、不建第二状态机、不改 S0–S9 顺序。
 * Flow 决定"现在在解决什么认知问题"；Capability 决定"这个阶段是否需要
 * 额外的专业方法帮助"。启用由用户决定（cap 命令），AI 只有推荐权。
 * 当前只有 golden-case（跨阶段生命周期能力）；artifact-assist 是阶段局部
 * 调用（skills 列表承载），不占 persistent state——刻意不对称，不强行统一。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityStatus, FlowState } from "./machine.js";

/** 业务真值能力的 case 根目录（golden-case 技能默认位置；用户搬迁则机械检查静默跳过） */
export const GO_CASE_ROOT = ".hapilon/go-case";

/** 推荐信号：模型据此判断是否值得向用户推荐 golden-case（推荐≠启用） */
const RECOMMEND_CLAUSE = [
  "能力推荐（golden-case，是否提出由你判断）：若本任务命中多数信号——有明确业务结果；正确性无法仅靠编译/单测判断；存在金额、状态、权限、流程、库存、持久化等业务真值；实现可能内部自洽但业务错误；用户能通过业务规则或权威来源确认「什么叫对」；重构/迁移需要保护既有业务行为——则输出一段推荐：为什么适合、会增加什么工作、保护什么风险，并注明启用与否由用户决定（/build-ai-flow cap golden-case enable|decline [说明]）。未决定或未启用，流程照常。",
].join("\n");

/** 已启用状态下各阶段的指引（stage → 行）；未列出的阶段不注入任何能力内容 */
const ENABLED_GUIDANCE: Record<number, string[]> = {
  1: [
    "golden-case（业务真值能力）已启用：探索时可读真实 codebase、API、domain model、persistence、observation surface 与现有 tests，理解 case 所处的系统环境——了解 implementation facts ≠ 从 implementation 输出推导业务真值（「当前代码输出 X」推不出「Expected = X」）。",
  ],
  3: [
    "golden-case 已启用——本阶段主工作点之一：按 golden-case 技能自身流程完成 Draft → View/review → Freeze（封金），产出独立于实现的 frozen business truth（.hapilon/go-case/ 下 cases.yaml + frozen.md）。",
    "Expected 的合法来源只有三种：用户明确确认、权威业务文档、基于已确认规则的机械推导——当前 implementation 的输出永远不是来源。",
    "本轮被选作 Design/Prototype 约束的核心 case 必须完成封金才能安心离开本阶段（Gate 会做封金快照的机械检查）；仍未确定的场景记 Unknown/Proposal，是否带着它们推进由用户在 Gate 处决定（强推转 debt）。",
    "封金由技能自身的 Draft+View 回执与人确认把守；Flow 不复刻其评审机制。",
  ],
  4: [
    "golden-case：frozen cases 是本阶段权威约束——无论采用什么技术方案，已确认业务真值必须成立；Design 不得修改 expected。",
    "发现 Frozen truth 与新证据冲突 → 走上游前提检查：不改 case、不自行 goto，指出失效前提并等用户决定。",
  ],
  5: [
    "golden-case：视觉阶段可把 frozen case 场景作为图示输入（sequence / state / failure path），帮助讲清机制；视觉表达不改变 case truth，case 也不决定视觉形式。",
  ],
  6: [
    "golden-case：本阶段开始 Implementation Observation——样例选择优先能验证高风险 case、能撞击 Design 最大不确定性的 vertical slice；实现出现后按技能自身 Adapter 阶段做 implementation → observation → actual（adapter 写进项目真实测试目录并登记 manifest.json），与 frozen expected 独立比较。",
    "禁止路径：观察到 actual=72 之后「看来 expected 也该是 72」——observed output 永远不回写 expected。",
  ],
  7: [
    "golden-case：本阶段主验证点——运行技能自身完整 verification（report/audit 脚本 + Adapter 回执评审，机制属于技能，Flow 不复刻），并区分两个问题：A. implementation 是否满足 frozen case？B. 这些 case 是否足以证明关键业务行为？A 通过时 B 仍可为 Concern/Fail。",
    "B 失败不得自动改 expected：记 Proposal/Unknown 交用户判断是否补充/修订业务真值（必要时 regression）。结果与证据记入 self-review.md；术语并行不互译（Flow 六轴 Pass/Concern/Fail/Not verified，golden-case PASS/FAIL/UNKNOWN，引用保持原词）。",
  ],
  8: [
    "golden-case：扩量遇同类数据差异 → 沿用现有 frozen cases / pattern 继续扩展；遇真正新业务场景 → 必须先定义真值（new scenario → 确认 → 封金 → 实现 → adapter 验证），禁止 implementation first 再照输出补 case。",
    "新场景若冲击核心定义、已有 business truth 或 Design 假设 → 命中升级规则：立即停止扩量，记 Unknown/Proposal，向用户说明影响并建议回到哪个阶段处理。",
  ],
  9: [
    "golden-case：spec.md / start-prompt.md 记录 case 资产的权威位置与使用规则，不复制内容——启用状态、.hapilon/go-case/ 下各文件（cases.yaml / frozen.md / manifest.json / runs.json）的角色、未关闭的 case 相关事项、后续改业务行为时的重审路径（重新确认 → 新版本封金；adapter 全绿不等于业务对）、重放会话应先读哪些 case 资产。",
  ],
};

/**
 * 能力上下文分层（设计 §16，对应用户 spec 的 context tier 表）：
 * S3 草案参考 / S4 封金权威 / S5 需要时参考 / S6 封金权威+adapter 映射 /
 * S7 封金+运行结果权威 / S8 封金权威 / S9 位置状态参考。
 * 路径相对项目根；文件不存在时降级不列（与主线上下文同规则）。
 */
const CONTEXT_TIERS: Record<number, { authoritative: string[]; relevant: string[] }> = {
  3: { authoritative: [], relevant: ["cases.yaml"] },
  4: { authoritative: ["frozen.md"], relevant: ["cases.yaml"] },
  5: { authoritative: [], relevant: ["cases.yaml"] },
  6: { authoritative: ["frozen.md"], relevant: ["manifest.json", "runs.json"] },
  7: { authoritative: ["frozen.md", "runs.json"], relevant: ["manifest.json"] },
  8: { authoritative: ["frozen.md"], relevant: [] },
  9: { authoritative: [], relevant: ["frozen.md", "manifest.json"] },
};

function goCaseExists(cwd: string, file: string): boolean {
  return existsSync(join(cwd, GO_CASE_ROOT, file));
}

/**
 * 组装本阶段能力区块（推荐条款 / 已启用指引 + 能力上下文）。
 * 机械防骚扰：未决定 → 仅 S2/S3 出现推荐条款；已拒绝 → 全程静默；
 * 已启用 → 按阶段注入指引与上下文。返回空数组 = 本阶段无能力内容。
 */
export function capabilityBlock(cwd: string, state: FlowState): string[] {
  const cap = state.capabilities["golden-case"];
  if (!cap) {
    return state.stage === 2 || state.stage === 3 ? [...RECOMMEND_CLAUSE.split("\n"), ""] : [];
  }
  if (cap.status === "declined") return [];

  const lines: string[] = [];
  for (const g of ENABLED_GUIDANCE[state.stage] ?? []) lines.push(g);
  const tiers = CONTEXT_TIERS[state.stage];
  if (tiers) {
    const auth = tiers.authoritative.filter((f) => goCaseExists(cwd, f));
    const rel = tiers.relevant.filter((f) => goCaseExists(cwd, f));
    if (auth.length > 0) lines.push(`能力上下文（golden-case·必读）：${auth.map((f) => `${GO_CASE_ROOT}/${f}`).join("、")}`);
    if (rel.length > 0) lines.push(`能力上下文（golden-case·需要时参考）：${rel.map((f) => `${GO_CASE_ROOT}/${f}`).join("、")}`);
  }
  return lines.length > 0 ? [...lines, ""] : [];
}

/** status / freeze note 用的能力状态行 */
export function capabilityStatusLine(state: FlowState): string {
  const cap = state.capabilities["golden-case"];
  if (!cap) return "";
  if (cap.status === "enabled") {
    return `golden-case 已启用（S${cap.enabledAtStage ?? "?"} 起${cap.reason ? "：" + cap.reason : ""}）`;
  }
  return `golden-case 已拒绝${cap.reason ? "：" + cap.reason : ""}（不再重复推荐）`;
}

export type { CapabilityStatus };
