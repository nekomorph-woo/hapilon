/**
 * render.ts — status 的 ASCII 状态轨与详情渲染
 *
 * 状态轨一行十段：✓ 已过（! 强推）/ ● 当前 / ○ 未到；frozen 全 ✓ 尾标 [frozen]。
 * 图下附当前状态、Gate 实时检查、历史尾部、建议下一步（由状态推出）。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { STAGES, stageByIndex } from "./stages.js";
import { evaluateGate, flowDir, openDebts, type FlowState } from "./machine.js";
import { capabilityStatusLine } from "./capabilities.js";
import { stageMark } from "./prompts.js";

const LOOPS = [
  { from: 0, to: 3, name: "Sensemaking 搞清楚" },
  { from: 4, to: 6, name: "Productization 做出来" },
  { from: 7, to: 9, name: "Institutionalization 留下来" },
];

function loopOf(stage: number): string {
  return LOOPS.find((l) => stage >= l.from && stage <= l.to)?.name ?? "";
}

function shortHistory(state: FlowState): string {
  const tail = state.history.slice(-4);
  return tail.map((h) => h.kind + (h.from !== undefined ? `(${h.from}→${h.to})` : `(${h.to})`)).join(" → ");
}

/** 强推标记落在被跳过 Gate 的阶段上（history 里 force 的 from） */
function forcedStages(state: FlowState): Set<number> {
  return new Set(state.history.filter((h) => h.kind === "force" && h.from !== undefined).map((h) => h.from!));
}

/** 建议下一步：由状态推出（设计 §4） */
export function nextStepAdvice(cwd: string, state: FlowState): string {
  if (state.status === "frozen") {
    return "已冻结。重放：新会话贴 start-prompt.md；审查：/build-ai-flow audit；重开：goto <0-9> <原因>";
  }
  const def = stageByIndex(state.stage);
  const gate = evaluateGate(cwd, state.slug, state.stage, state.stale, state.capabilities);
  if (gate.passed) return "Gate 已过，可执行 /build-ai-flow next 推进到下一阶段";
  return `完成本阶段产物 ${def.artifacts.join("、")} 后执行 /build-ai-flow next（当前缺口：${gate.failures[0] ?? "—"}）`;
}

export function renderStatus(cwd: string, state: FlowState): string {
  const def = stageByIndex(state.stage);
  const forced = forcedStages(state);
  const rail = STAGES.map((s) => stageMark(s, state, forced)).join(" ");
  const frozenTag = state.status === "frozen" ? "  [frozen]" : "";
  const gate = evaluateGate(cwd, state.slug, state.stage, state.stale);
  const dir = flowDir(cwd, state.slug);
  const artifactsLine = def.artifacts
    .map((a) => `${a} ${existsSync(join(dir, a)) ? "✓" : "✗"}`)
    .join("  ");
  const debts = openDebts(state);
  const debtsLine =
    debts.length > 0
      ? debts.map((d) => `${d.id}(S${d.stage})：${d.gaps[0] ?? ""}`).join("；")
      : "无";

  const lines: string[] = [];
  lines.push(`${rail}${frozenTag}   ${state.stage}/9`);
  lines.push(`循环：${loopOf(state.stage)}`);
  lines.push("");
  lines.push(`任务：${state.name}（${state.slug}）｜状态 ${state.status}`);
  lines.push(`目标：${state.goal || "（未填写）"}`);
  lines.push(`当前阶段：${def.slug}｜${def.zh} —— ${def.coreQuestion}`);
  lines.push(`本阶段产物：${artifactsLine}`);
  lines.push(`Gate 机械检查：${gate.passed ? "已过" : `未过 —— ${gate.failures.join("；")}`}`);
  lines.push(`Gate 语义项（你卡）：${def.gateNote}`);
  lines.push(`Gate 缺口欠账（debt）：${debts.length} 个未关闭${debts.length > 0 ? ` —— ${debtsLine}` : ""}`);
  const capLine = capabilityStatusLine(state);
  if (capLine) lines.push(`能力（capability）：${capLine}`);
  if (state.stale) {
    lines.push(`上游回退（stale）：S${state.stale.from}–S9 产物待基于新上游重新确认（存在 ≠ 当前有效）`);
  }
  lines.push(`历史：${shortHistory(state) || "—"}`);
  lines.push(`建议下一步：${nextStepAdvice(cwd, state)}`);
  return lines.join("\n");
}
