/**
 * hpl-build-ai-flow — 复杂任务十阶段流程驱动
 *
 * 把 GPT 协商的 AI 复杂任务工作流（docs/ai-*.md）收编为状态机驱动的
 * slash 命令：start → dump/explore/frame/define/design/visual/prototype/
 * inspect/scale/freeze，Gate 机械检查 + 人工确认推进。人是最终闸门，
 * 扩展是闸门机械。工作区 .hapilon/ai-flow/<slug>/，单会话设计。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  advanceFlowEffect,
  forceAdvanceEffect,
  freezeFlowEffect,
  gotoStageEffect,
  listFlowsEffect,
  loadFlowEffect,
  openDebts,
  readActiveEffect,
  resolveDebtEffect,
  slugify,
  startFlowEffect,
  type FlowState,
} from "./machine.js";
import { LAST_STAGE, STAGES, stageByIndex } from "./stages.js";
import { buildFreezeNote, buildStagePrompt, buildStartGuide } from "./prompts.js";
import { renderStatus } from "./render.js";
import { buildCompletions } from "./completions.js";
import { appendAuditRecord, auditDecisionLog, AUDIT_MODEL_SPEC, readDecisionLog } from "./decision-audit.js";
import { registerGuard } from "./guard.js";

type Either<E, A> = { _tag: "Left"; left: E } | { _tag: "Right"; right: A };

function runEither<E, T>(effect: Effect.Effect<T, E>): Either<E, T> {
  return Effect.runSync(Effect.either(effect));
}

function activeFlow(cwd: string): { state: FlowState } | { error: string } | { none: true } {
  const active = runEither(readActiveEffect(cwd));
  if (active._tag !== "Right" || !active.right) return { none: true };
  const state = runEither(loadFlowEffect(cwd, active.right));
  if (state._tag === "Left") return { error: state.left.message };
  return { state: state.right };
}

export default function hplBuildAiFlow(pi: ExtensionAPI): void {
  pi.registerCommand("build-ai-flow", {
    description:
      "十阶段复杂任务流程（dump→…→freeze，Gate 管控）。用法：/build-ai-flow start <slug> [目标] | next | status | list | goto <0-9> <原因> | audit",
    getArgumentCompletions: (query: string) => buildCompletions(query, process.cwd()),
    handler: async (args: string, ctx) => {
      const cwd = ctx.cwd ?? process.cwd();
      const trimmed = args.trim();

      // ── start：新建 flow（已存在报错，单会话设计） ──────────────
      const startMatch = trimmed.match(/^start\s+(\S+)(?:\s+(.+))?$/);
      if (startMatch) {
        const slug = slugify(startMatch[1]!);
        const goal = startMatch[2]?.trim() ?? "";
        const created = runEither(startFlowEffect(cwd, slug, startMatch[1]!, goal));
        if (created._tag === "Left") {
          ctx.ui?.notify?.(created.left.message, "error");
          return;
        }
        pi.sendUserMessage(buildStagePrompt({ state: created.right, cwd }));
        ctx.ui?.notify?.(`flow「${slug}」已创建（S0 dump）。产物写 .hapilon/ai-flow/${slug}/，完成后 /build-ai-flow next`, "info");
        return;
      }

      // ── goto：跳前/回退/重开（原因必填） ────────────────────────
      const gotoMatch = trimmed.match(/^goto\s+(\d+)\s+(.+)$/s);
      if (gotoMatch) {
        const target = Number.parseInt(gotoMatch[1]!, 10);
        const reason = gotoMatch[2]!.trim();
        const active = activeFlow(cwd);
        if ("none" in active || "error" in active) {
          ctx.ui?.notify?.("没有活跃 flow。先 /build-ai-flow start <slug> [目标]", "error");
          return;
        }
        const moved = runEither(gotoStageEffect(cwd, active.state.slug, target, reason));
        if (moved._tag === "Left") {
          ctx.ui?.notify?.(moved.left.message, "error");
          return;
        }
        pi.sendUserMessage(buildStagePrompt({ state: moved.right, cwd }));
        const kind = moved.right.history.at(-1)?.kind ?? "goto";
        ctx.ui?.notify?.(`已 ${kind} → S${target} ${stageByIndex(target).slug}（原因已记录）`, "info");
        return;
      }
      if (/^goto\b/.test(trimmed)) {
        ctx.ui?.notify?.(`用法：/build-ai-flow goto <0-${LAST_STAGE}> <原因>（回炉/跳过都要留痕）`, "error");
        return;
      }

      // ── next：Gate 检查 → 推进 / 确认强推 / freeze ──────────────
      if (/^next\b/.test(trimmed) || trimmed === "") {
        const active = activeFlow(cwd);
        if ("none" in active) {
          pi.sendUserMessage(buildStartGuide());
          return;
        }
        if ("error" in active) {
          ctx.ui?.notify?.(active.error, "error");
          return;
        }
        const state = active.state;
        if (state.status === "frozen") {
          ctx.ui?.notify?.(buildFreezeNote(state), "info");
          return;
        }
        const outcome = runEither(advanceFlowEffect(cwd, state.slug));
        if (outcome._tag === "Left") {
          ctx.ui?.notify?.(outcome.left.message, "error");
          return;
        }
        if (outcome.right.kind === "needs-confirm") {
          const gaps = outcome.right.gaps;
          const ok = ctx.ui?.confirm
            ? await ctx.ui.confirm(
                "build-ai-flow",
                `当前阶段 Gate 未过：\n${gaps.map((g) => `· ${g}`).join("\n")}\n\n仍要强推到下一阶段吗？（缺口会记入 history）`,
              )
            : true;
          if (!ok) {
            ctx.ui?.notify?.("未推进。先补齐本阶段产物，再 /build-ai-flow next", "info");
            return;
          }
          const forced = runEither(forceAdvanceEffect(cwd, state.slug, gaps));
          if (forced._tag === "Left") {
            ctx.ui?.notify?.(forced.left.message, "error");
            return;
          }
          if (forced.right.kind === "ready-to-freeze") {
            await maybeAuditThenFreeze(pi, ctx, cwd, forced.right.state, forced.right.gaps);
            return;
          }
          pi.sendUserMessage(buildStagePrompt({ state: forced.right.state, cwd, priorGaps: gaps }));
          ctx.ui?.notify?.("已强推（缺口已记录，prompt 里要求本阶段优先补上）", "warning");
          return;
        }
        if (outcome.right.kind === "ready-to-freeze") {
          await maybeAuditThenFreeze(pi, ctx, cwd, outcome.right.state);
          return;
        }
        if (outcome.right.kind === "frozen") {
          ctx.ui?.notify?.(buildFreezeNote(outcome.right.state), "info");
          return;
        }
        pi.sendUserMessage(buildStagePrompt({ state: outcome.right.state, cwd }));
        return;
      }

      // ── status：ASCII 状态轨 + 详情 ─────────────────────────────
      if (/^status\b/.test(trimmed)) {
        const active = activeFlow(cwd);
        if ("none" in active) {
          pi.sendUserMessage(buildStartGuide());
          return;
        }
        if ("error" in active) {
          ctx.ui?.notify?.(active.error, "error");
          return;
        }
        ctx.ui?.notify?.(renderStatus(cwd, active.state), "info");
        return;
      }

      // ── list：全部 flow ─────────────────────────────────────────
      if (/^list\b/.test(trimmed)) {
        const flows = runEither(listFlowsEffect(cwd));
        if (flows._tag === "Left") {
          ctx.ui?.notify?.(flows.left.message, "error");
          return;
        }
        if (flows.right.length === 0) {
          ctx.ui?.notify?.("没有已存在的 flow。/build-ai-flow start <slug> [目标] 开始", "info");
          return;
        }
        const lines = flows.right.map(
          (f) => `S${f.stage} ${f.status.padEnd(6)} ${f.slug}${f.goal ? " — " + f.goal : ""}（${f.updatedAt.slice(0, 10)}）`,
        );
        ctx.ui?.notify?.(`共 ${flows.right.length} 个 flow：\n${lines.join("\n")}`, "info");
        return;
      }

      // ── debt：Gate 缺口欠账 ───────────────────────────────────
      const debtResolveMatch = trimmed.match(/^debt\s+resolve\s+(G-\d+)\s+(.+)$/s);
      if (debtResolveMatch) {
        const active = activeFlow(cwd);
        if ("none" in active || "error" in active) {
          ctx.ui?.notify?.("没有活跃 flow。先 /build-ai-flow start <slug> [目标]", "error");
          return;
        }
        const resolved = runEither(resolveDebtEffect(cwd, active.state.slug, debtResolveMatch[1]!, debtResolveMatch[2]!));
        if (resolved._tag === "Left") {
          ctx.ui?.notify?.(resolved.left.message, "error");
          return;
        }
        ctx.ui?.notify?.(
          `${debtResolveMatch[1]} 已关闭（说明已记入 history）。剩余未关闭：${openDebts(resolved.right).length}`,
          "info",
        );
        return;
      }
      if (/^debt\b/.test(trimmed)) {
        const active = activeFlow(cwd);
        if ("none" in active || "error" in active) {
          ctx.ui?.notify?.("没有活跃 flow。先 /build-ai-flow start <slug> [目标]", "error");
          return;
        }
        const debts = active.state.debts;
        if (debts.length === 0) {
          ctx.ui?.notify?.("没有 Gate 缺口欠账（无 force 强推记录）", "info");
          return;
        }
        const lines = debts.map((d) => {
          const state = d.resolvedAt
            ? `已关闭：${d.resolution ?? ""}（${d.resolvedAt.slice(0, 10)}）`
            : `未关闭 — 关闭：/build-ai-flow debt resolve ${d.id} <说明>`;
          return `${d.resolvedAt ? "✓" : "●"} ${d.id}（S${d.stage}）：${d.gaps.join("；")}\n   ${state}`;
        });
        ctx.ui?.notify?.(
          `Gate 缺口欠账（${openDebts(active.state).length} 未关闭 / 共 ${debts.length}）：\n${lines.join("\n")}`,
          "info",
        );
        return;
      }

      // ── audit：决策冲突审查 ─────────────────────────────────────
      if (/^audit\b/.test(trimmed)) {
        await runAudit(pi, ctx, cwd);
        return;
      }

      ctx.ui?.notify?.(
        "用法：/build-ai-flow [start <slug> [目标] | next | status | list | goto <0-9> <原因> | audit]",
        "error",
      );
    },
  });

  registerGuard(pi);
}

/** freeze 两阶段提交的后半段：审查与确认在前，用户同意后才提交 frozen（唯一提交点 freezeFlowEffect） */
async function maybeAuditThenFreeze(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  cwd: string,
  state: FlowState,
  forceGaps?: string[],
): Promise<void> {
  const debts = openDebts(state);
  if (debts.length > 0) {
    ctx.ui?.notify?.(
      `注意：仍有 ${debts.length} 个未关闭的 Gate 缺口欠账——\n` +
        debts.map((d) => `· ${d.id}（S${d.stage}）：${d.gaps.join("；")}`).join("\n") +
        "\n冻结不会自动关闭它们；也可先 /build-ai-flow debt resolve 逐项处理。",
      "warning",
    );
  }
  const hasLog = readDecisionLog(cwd, state.slug) !== null;
  if (hasLog && ctx.ui?.confirm) {
    const runIt = await ctx.ui.confirm(
      "build-ai-flow",
      "Gate 已过，可以冻结。冻结前先跑一次决策冲突审查（tier:sonnet 读 decision-log 找矛盾）？",
    );
    if (runIt) {
      const result = await runAudit(pi, ctx, cwd);
      if (result === "failed") {
        ctx.ui?.notify?.("审查失败（不阻塞流程，人是最终闸门）", "warning");
      }
      if (result === "conflicts") {
        const anyway = ctx.ui?.confirm
          ? await ctx.ui.confirm("build-ai-flow", "decision-log 存在冲突（见上方审查结果）。仍要冻结吗？")
          : true;
        if (!anyway) {
          ctx.ui?.notify?.(
            "未冻结：status 保持 active，阶段保持 S9，history 无 freeze 记录。处理冲突（追加新 D 条目）后重新 /build-ai-flow next。",
            "info",
          );
          return;
        }
      }
    }
  }
  const frozen = runEither(freezeFlowEffect(cwd, state.slug, forceGaps));
  if (frozen._tag === "Left") {
    ctx.ui?.notify?.(frozen.left.message, "error");
    return;
  }
  pi.sendUserMessage(buildFreezeNote(frozen.right));
  ctx.ui?.notify?.("flow 已冻结。重放：新会话贴 start-prompt.md", "info");
}

/** 执行审查；返回 "conflicts" | "clean" | "failed" */
async function runAudit(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  cwd: string,
): Promise<"conflicts" | "clean" | "failed"> {
  const active = activeFlow(cwd);
  if ("none" in active || "error" in active) {
    ctx.ui?.notify?.("没有活跃 flow。先 /build-ai-flow start", "error");
    return "failed";
  }
  const state = active.state;
  const log = readDecisionLog(cwd, state.slug);
  if (log === null) {
    ctx.ui?.notify?.("decision-log.md 不存在（S3 define 之后才有可审查的拍板）", "error");
    return "failed";
  }
  const registry = ctx.modelRegistry;
  ctx.ui?.notify?.(`决策冲突审查中（${AUDIT_MODEL_SPEC}，最长 60s）…`, "info");
  const result = await Effect.runPromise(
    Effect.either(
      auditDecisionLog({
        decisionLog: log,
        goal: state.goal,
        available: registry.getAvailable(),
        complete: (model, request, options) => registry.complete(model, request, options),
      }),
    ),
  );
  if (result._tag === "Left") {
    ctx.ui?.notify?.(`审查失败（${result.left._tag}: ${"message" in result.left ? result.left.message : ""}）——不阻塞流程，人是最终闸门`, "warning");
    return "failed";
  }
  const audit = result.right;
  if (audit.malformed.length > 0) {
    ctx.ui?.notify?.(`decision-log lifecycle 异常（不猜测，请人工修复格式）：\n${audit.malformed.map((m) => `· ${m}`).join("\n")}`, "warning");
  }
  if (audit.ok || audit.conflicts.length === 0) {
    ctx.ui?.notify?.(`审查通过（${audit.model}）：无决策冲突${audit.malformed.length > 0 ? "（但有 lifecycle 异常，见上）" : ""}`, "info");
    appendAuditRecord(cwd, state.slug, `审查通过（${audit.model}）：无决策冲突`);
    return "clean";
  }
  const lines = audit.conflicts.map((c, i) => `${i + 1}. ${c.ids.join(" ↔ ")}：${c.summary}\n   建议：${c.suggestion}`);
  ctx.ui?.notify?.(`查出 ${audit.conflicts.length} 处决策冲突（${audit.model}）：\n${lines.join("\n")}\n\n处理方式：追加新 D 条目（推翻旧口径用 supersedes 事件行），不改旧条目`, "warning");
  appendAuditRecord(cwd, state.slug, `查出冲突（${audit.model}）：\n${lines.join("\n")}`);
  return "conflicts";
}
