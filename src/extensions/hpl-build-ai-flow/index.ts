/**
 * hpl-build-ai-flow — 复杂任务十阶段流程驱动
 *
 * 把 GPT 协商的 AI 复杂任务工作流（docs/ai-*.md）收编为状态机驱动的
 * slash 命令：start → dump/explore/frame/define/design/visual/prototype/
 * inspect/scale/freeze，Gate 机械检查 + 人工确认推进。人是最终闸门，
 * 扩展是闸门机械。工作区 .hapilon/ai-flow/<slug>/，单会话设计。
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  advanceFlowEffect,
  forceAdvanceEffect,
  freezeFlowEffect,
  gotoStageEffect,
  listFlowsEffect,
  loadFlowEffect,
  openDebts,
  coverageDispositionGaps,
  discardGoalProposal,
  readActiveEffect,
  readGoalProposal,
  resolveDebtEffect,
  saveGoalProposal,
  savePendingGoal,
  setCapabilityEffect,
  setGoalEffect,
  startFlowEffect,
  takePendingGoal,
  uniqueSlug,
  type FlowState,
} from "./machine.js";
import { LAST_STAGE, STAGES, stageByIndex } from "./stages.js";
import { buildFreezeNote, buildSlugDistillPrompt, buildStagePrompt, buildStartGuide } from "./prompts.js";
import { renderStatus } from "./render.js";
import { buildCompletions } from "./completions.js";
import { appendAuditRecord, auditDecisionLog, AUDIT_MODEL_SPEC, readDecisionLog } from "./decision-audit.js";
import { registerGuard } from "./guard.js";
import { capabilityStatusLine } from "./capabilities.js";

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
      "十阶段复杂任务流程（dump→…→freeze，Gate 管控）。用法：/build-ai-flow start <目标> | goal（确认模型提案） | next | status | list | goto <0-9> <原因> | cap <能力> <enable|decline> [说明] | audit",
    getArgumentCompletions: (query: string) => buildCompletions(query, process.cwd()),
    handler: async (args: string, ctx) => {
      const cwd = ctx.cwd ?? process.cwd();
      const trimmed = args.trim();

      // ── start：两段式。目标暂存盘上 → 派发提炼任务 → 模型调 create_flow 建 flow（单会话设计） ──
      const startMatch = trimmed.match(/^start(?:\s+([\s\S]+))?$/);
      if (startMatch) {
        const goal = startMatch[1]?.trim() ?? "";
        if (goal === "") {
          ctx.ui?.notify?.("用法：/build-ai-flow start <目标>（目标可多行；slug 由模型通读后提炼）", "error");
          return;
        }
        savePendingGoal(cwd, goal);
        pi.sendUserMessage(buildSlugDistillPrompt(goal));
        ctx.ui?.notify?.("目标已暂存；等模型提炼 slug 并调 create_flow 后自动建 flow 进入 S0", "info");
        return;
      }

      // ── goto：前跳/回跳/重开（原因必填） ────────────────────────
      const gotoMatch = trimmed.match(/^goto\s+(\d+)\s+(.+)$/s);
      if (gotoMatch) {
        const target = Number.parseInt(gotoMatch[1]!, 10);
        const reason = gotoMatch[2]!.trim();
        const active = activeFlow(cwd);
        if ("none" in active || "error" in active) {
          ctx.ui?.notify?.("没有活跃 flow。先 /build-ai-flow start <目标>", "error");
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
        ctx.ui?.notify?.(`用法：/build-ai-flow goto <0-${LAST_STAGE}> <原因>（任意阶段导航，原因留痕）`, "error");
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
          ctx.ui?.notify?.("没有已存在的 flow。/build-ai-flow start <目标> 开始", "info");
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
          ctx.ui?.notify?.("没有活跃 flow。先 /build-ai-flow start <目标>", "error");
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
          ctx.ui?.notify?.("没有活跃 flow。先 /build-ai-flow start <目标>", "error");
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
      // ── goal：两段式拍板。模型调 propose_goal 提案 → 用户裸 goal 命令确认；带参 = 手写直通 ──
      const goalMatch = trimmed.match(/^goal(?:\s+([\s\S]+))?$/);
      if (goalMatch) {
        const active = activeFlow(cwd);
        if ("none" in active || "error" in active) {
          ctx.ui?.notify?.("没有活跃 flow。先 /build-ai-flow start <目标>", "error");
          return;
        }

        // 裸 goal：确认或拒绝待审提案
        if (goalMatch[1] === undefined) {
          const proposal = readGoalProposal(cwd);
          if (proposal === null) {
            ctx.ui?.notify?.(
              active.state.goalStatement !== null
                ? "当前无待审提案。目标已拍板；重拍请让模型调 propose_goal 提新提案，或 goal <定位句> 手写覆盖"
                : "当前无待审提案。让模型调 propose_goal 提交（定位句+验收要点），再来确认",
              "error",
            );
            return;
          }
          if (proposal.slug !== active.state.slug) {
            discardGoalProposal(cwd);
            ctx.ui?.notify?.(`提案属于 flow「${proposal.slug}」与活跃 flow「${active.state.slug}」不符，已丢弃。请重新提案`, "error");
            return;
          }
          const summary = [
            "目标提案（拍板后 S8 盘点与冻结以此为准）：",
            `定位句：${proposal.statement}`,
            ...proposal.acceptance.map((a, i) => `验收${i + 1}：${a}`),
          ].join("\n");
          const approve = ctx.ui?.confirm ? await ctx.ui.confirm("build-ai-flow", summary) : true;
          if (!approve) {
            ctx.ui?.notify?.("未写入，提案保留。改内容让模型重新提案，或 goal decline 丢弃", "info");
            return;
          }
          const set = runEither(setGoalEffect(cwd, proposal.slug, proposal.statement, proposal.acceptance));
          if (set._tag === "Left") {
            ctx.ui?.notify?.(set.left.message, "error");
            return;
          }
          discardGoalProposal(cwd);
          ctx.ui?.notify?.(
            `目标已拍板写入：定位句「${set.right.goalStatement}」，验收要点 ${set.right.acceptance.length} 条（history 已留痕）`,
            "info",
          );
          return;
        }

        const body = goalMatch[1].trim();
        if (body === "decline") {
          discardGoalProposal(cwd);
          ctx.ui?.notify?.("提案已丢弃", "info");
          return;
        }
        const [firstLine, ...rest] = body.split("\n");
        const statement = (firstLine ?? "").trim();
        const acceptance = rest.map((l) => l.replace(/^[-*•\d.\s]+/, "").trim()).filter((l) => l !== "");
        const set = runEither(setGoalEffect(cwd, active.state.slug, statement, acceptance));
        if (set._tag === "Left") {
          ctx.ui?.notify?.(set.left.message, "error");
          return;
        }
        ctx.ui?.notify?.(
          `目标已写入：定位句「${set.right.goalStatement}」，验收要点 ${set.right.acceptance.length} 条。手写路径不经过提案审核，确认内容无误`,
          "info",
        );
        return;
      }

      // ── cap：能力启用/拒绝（只有人能触发；AI 只有推荐权） ────
      const capMatch = trimmed.match(/^cap\s+(\S+)\s+(enable|decline)(?:\s+(.+))?$/s);
      if (capMatch) {
        const active = activeFlow(cwd);
        if ("none" in active || "error" in active) {
          ctx.ui?.notify?.("没有活跃 flow。先 /build-ai-flow start <目标>", "error");
          return;
        }
        const set = runEither(
          setCapabilityEffect(
            cwd,
            active.state.slug,
            capMatch[1]!,
            capMatch[2] === "enable" ? "enabled" : "declined",
            capMatch[3] ?? "",
          ),
        );
        if (set._tag === "Left") {
          ctx.ui?.notify?.(set.left.message, "error");
          return;
        }
        const verb = capMatch[2] === "enable" ? "已启用" : "已拒绝";
        ctx.ui?.notify?.(
          `golden-case ${verb}（当前 S${set.right.stage}，决定已记入 history）。${
            capMatch[2] === "enable"
              ? "后续阶段 prompt 会携带对应指引与 case 上下文。"
              : "后续不再重复推荐；如改变主意可再 cap enable。"
          }`,
          "info",
        );
        return;
      }
      if (/^cap\b/.test(trimmed)) {
        const active = activeFlow(cwd);
        if ("none" in active || "error" in active) {
          ctx.ui?.notify?.("没有活跃 flow。先 /build-ai-flow start <目标>", "error");
          return;
        }
        const line = capabilityStatusLine(active.state);
        ctx.ui?.notify?.(
          `能力状态：${line || "golden-case 未决定（S2/S3 的 prompt 会提示是否值得推荐）"}\n用法：/build-ai-flow cap golden-case enable|decline [说明]`,
          "info",
        );
        return;
      }

      if (/^help\b/.test(trimmed) || trimmed === "?") {
        ctx.ui?.notify?.(buildHelpText(), "info");
        return;
      }

      if (/^audit\b/.test(trimmed)) {
        await runAudit(pi, ctx, cwd);
        return;
      }

      ctx.ui?.notify?.(
        "用法：/build-ai-flow [start <目标> | goal（确认模型提案） | next | status | list | goto <0-9> <原因> | cap <能力> <enable|decline> [说明] | audit | help]",
        "error",
      );
    },
  });

  // create_flow：start 两段式第二段——承接模型提炼的 slug 建 flow，并派发 S0
  pi.registerTool({
    name: "create_flow",
    label: "Create Flow",
    description:
      "提交为 build-ai-flow 提炼的 slug 并创建流程（仅在 /build-ai-flow start 派发的提炼任务中调用）。" +
      "slug 规则：小写英文与数字、连字符分隔（a-b-c），2-5 词，≤48 字符；不合格式会被拒，请重新提炼再提交。",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "提炼的英文 kebab-case slug，如 bd2-beginner-guide" },
      },
      required: ["slug"],
    },
    execute: async (
      _toolCallId: string,
      params: { slug?: unknown },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      toolCtx: ExtensionCommandContext,
    ): Promise<AgentToolResult<unknown>> => {
      const cwd = toolCtx.cwd;
      const goal = takePendingGoal(cwd);
      if (goal === null) {
        throw new Error("没有待创建的 flow。请用户先执行 /build-ai-flow start <目标>");
      }
      const raw = String(params.slug ?? "").trim();
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(raw) || raw.length > 48) {
        savePendingGoal(cwd, goal); // 放回暂存，允许修正后重试
        throw new Error(`slug「${raw}」不合格式：小写英文与数字、连字符分隔（a-b-c），2-5 词且 ≤48 字符。重新提炼后再调 create_flow`);
      }
      const slug = uniqueSlug(cwd, raw);
      const name = slug
        .split("-")
        .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
        .join(" ");
      const created = runEither(startFlowEffect(cwd, slug, name, goal));
      if (created._tag === "Left") {
        throw new Error(created.left.message);
      }
      void pi.sendUserMessage(buildStagePrompt({ state: created.right, cwd }), { deliverAs: "followUp" });
      return {
        content: [{ type: "text" as const, text: `flow「${slug}」已创建（目标已入档），S0 阶段任务已派发，请按 S0 prompt 开始工作` }],
        details: { slug },
      };
    },
  });

  // propose_goal：goal 拍板两段式第一段——模型从讨论中精炼提交提案，人确认才写入
  pi.registerTool({
    name: "propose_goal",
    label: "Propose Goal",
    description:
      "提交 build-ai-flow 的目标提案（定位句 + 验收要点清单），由用户执行 /build-ai-flow goal 确认后才写入。" +
      "在 S2 讨论收敛后（或用户要求重拍目标时）调用；定位句一句话填「给___看，用来判断___，不是用来___」，" +
      "验收要点逐条可判定，覆盖目标全部承诺（含 app 本体/数据管线/AI 推理等全部交付面）。提案后提醒用户确认。",
    parameters: {
      type: "object",
      properties: {
        statement: { type: "string", description: "一句话定位句：给谁看、用来判断什么、不是用来什么" },
        acceptance: {
          type: "array",
          items: { type: "string" },
          description: "验收要点清单，每条可判定；S8 覆盖盘点逐条对照，文本需原样入表",
        },
      },
      required: ["statement", "acceptance"],
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, toolCtx) => {
      const cwd = toolCtx.cwd;
      const active = activeFlow(cwd);
      if ("none" in active || "error" in active) {
        throw new Error("没有活跃 flow，提案无处归属");
      }
      const statement = String(params.statement ?? "").trim();
      const acceptance = (Array.isArray(params.acceptance) ? params.acceptance : [])
        .map((a) => String(a).replace(/^[\s•\-\d.]+/, "").trim())
        .filter((a) => a !== "");
      if (statement === "" || acceptance.length === 0) {
        throw new Error("定位句与至少一条验收要点不能为空；重新提炼后再提交");
      }
      saveGoalProposal(cwd, { slug: active.state.slug, statement, acceptance });
      return {
        content: [
          {
            type: "text" as const,
            text:
              `提案已暂存（flow「${active.state.slug}」）。请在对话里向用户展示定位句与验收要点全文，` +
              `并请用户执行 /build-ai-flow goal 确认（拒绝用 goal decline）；确认前不要把提案当作已拍板目标使用。`,
          },
        ],
        details: { slug: active.state.slug },
      };
    },
  });

  registerGuard(pi);
}

/** help 文案：全流程保姆级指引（派发节奏 + 十站职责 + 工具箱 + 卡住解法） */
function buildHelpText(): string {
  return [
    "【build-ai-flow 全流程指南】",
    "",
    "节奏：任务书派发 → 模型干活（重活委派 subagent）→ 停下等球 → 你拍板 → /build-ai-flow next。",
    "你负责三件事：start 的原始输入、S2/S7 的拍板、每站结束的 next；调查/实现/审查/扩量都是 subagent 的活。",
    "",
    "十站：",
    "S0 dump 倒材料——你把手头材料全给它，它只整理不调查",
    "S1 explore 探事实——重调查默认委派 subagent，你看一眼「推断」有没有混进「事实」",
    "S2 frame 定问题★——指认定位句候选 → 模型 propose_goal 提案 → /build-ai-flow goal 确认拍板（从此盘点与冻结对着验收要点算账）",
    "S3 define 钉口径——术语口径逐条拍板（记 decision-log）；可能提示封金 golden-case",
    "S4 design 设计信息——看阅读顺序/层级/空数据约定，不对就说",
    "S5 visual 视觉定调——挑候选 HTML，大白话反馈",
    "S6 prototype 极端原型——subagent 搭「最肥/最瘦」两样例，你确认页面真的打开看过",
    "S7 inspect 反向验收★——独立 subagent 审产物 + 主会话 computer_use 实测（体验条目 → 逐条驾驶 → 截图交 vision 子代理看图）；阻塞级当场修，Concern 清单你裁决",
    "S8 scale 扩全量——subagent 批量复制；收尾必写「goal 覆盖盘点」表（验收要点逐条三态+去向，这是冻结门票）",
    "S9 freeze 固化——冻结闸门机械查要点缺席/无去向 → 决策冲突审查（建议跑）→ 冻结出 spec.md + start-prompt.md",
    "",
    "工具箱：",
    "status 看进度｜goto <0-9> <原因> 导航到任意阶段（回补/前跳/重做，不是惩罚，随时用）",
    "next 硬推 → 留 G-00x 欠账，冻结前还：debt resolve <id> <说明>｜goal 重拍目标（拒绝提案用 goal decline）",
    "会话断了不丢：磁盘就是状态，新会话 status/goto 续走；冻结后改东西用 goto 解冻",
    "",
    "卡住：",
    "模型等拍板但没列问题 → 让它「把待拍板项列出来」",
    "它称「无未办」你不信 → 让它贴 Concern/Unknown/欠账计数（口径规则要求报数）",
    "发现上游错了 → 模型只有建议权，你执行 goto",
  ].join("\n");
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
  const coverageGaps = coverageDispositionGaps(cwd, state.slug, state.acceptance);
  if (coverageGaps.length > 0) {
    ctx.ui?.notify?.(
      `冻结被拦：scale.md 覆盖盘点中 ${coverageGaps.length} 个未实现/部分项没有去向拍板（需 → 拍板 D-xxx / 用户裁决原话 / 流程后续+拍板记录）：\n` +
        coverageGaps.map((g) => `· ${g}`).join("\n") +
        "\n补齐去向（或把项做完）后重新 /build-ai-flow next。",
      "error",
    );
    return;
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
