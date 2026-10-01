/**
 * decision-audit.ts — 决策冲突审查：档位模型一次性调用
 *
 * 模型解析走 hpl-model-tiers 正统件（parseTierReference + readResolvedTiersEffect +
 * matchesModelPattern，与 hpl-orchestra 同构），固定 tier:sonnet 无覆盖配置。
 * 输出属不可信边界：Schema 校验，解析失败按"审查失败"处理，不编造结果，
 * 不阻塞 freeze（审查是建议层，人是最终闸门）。
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Data, Effect, Schema } from "effect";
import { readResolvedTiersEffect, parseTierReference, type ResolvedTierModels } from "../hpl-model-tiers/resolved.js";
import { matchesModelPattern } from "../hpl-model-tiers/index.js";
import { flowDir } from "./machine.js";
import { parseDecisionLog } from "./decision-log.js";

export const AUDIT_MODEL_SPEC = "tier:sonnet";
export const AUDIT_TIMEOUT_MS = 60_000;

// ─── typed errors ────────────────────────────────────────────────────

export class AuditModelUnavailable extends Data.TaggedError("AuditModelUnavailable")<{
  spec: string;
}> {}

export class AuditApiError extends Data.TaggedError("AuditApiError")<{ message: string }> {}

export class AuditInvalidOutput extends Data.TaggedError("AuditInvalidOutput")<{ message: string }> {}

export class AuditTimeout extends Data.TaggedError("AuditTimeout")<{ timeoutMs: number }> {}

// ─── 输入输出 ────────────────────────────────────────────────────────

export interface AuditModelShape {
  provider: string;
  id: string;
}

interface JudgeRequest {
  systemPrompt: string;
  messages: Array<{ role: "user"; content: string; timestamp: number }>;
}

export interface AuditDeps<T extends AuditModelShape> {
  modelSpec?: string;
  timeoutMs?: number;
  decisionLog: string;
  goal: string;
  available: readonly T[];
  complete: (
    model: T,
    request: JudgeRequest,
    options: { signal: AbortSignal; reasoning: "off"; maxTokens: number },
  ) => Promise<unknown>;
}

export interface AuditConflict {
  ids: string[];
  summary: string;
  suggestion: string;
}

export interface AuditResult {
  ok: boolean;
  conflicts: AuditConflict[];
  /** lifecycle 异常（引用不存在/重复取代/未知状态），单独报告不猜测 */
  malformed: string[];
  model: string;
}

const ConflictItem = Schema.Struct({
  ids: Schema.Array(Schema.String),
  summary: Schema.String,
  suggestion: Schema.String,
});
const AuditOutput = Schema.Struct({
  ok: Schema.Boolean,
  conflicts: Schema.Array(ConflictItem),
});

const AUDIT_SYSTEM_PROMPT = `你是决策一致性审查员。输入一份已解析的 decision-log（JSON：entries 条目、events 生命周期事件、activeIds 当前有效编号、malformed 已发现的格式异常）和任务目标。
只找 activeIds 中条目之间的矛盾：互相冲突的拍板、与目标矛盾的范围口径。
被合法 supersede / revoke 的历史条目不算冲突；malformed 由调用方报告，你不用重复检查，但引用它们时要谨慎。
不评价决定好坏，只报告不一致。每处冲突给出涉及的 D 编号、一句话说明、一句修复建议。
没有冲突就输出 ok=true、conflicts 为空。malformed 数组原样透传你看到的输入 malformed（无则空数组）。
ok 必须严格等于 conflicts 是否为空（conflicts.length === 0 → ok=true，否则 ok=false）。
只输出一行 JSON：
{"ok":true|false,"conflicts":[{"ids":["D-001"],"summary":"…","suggestion":"…"}],"malformed":["…"]}`;

/** tier 指代解析：parseTierReference 负责指代，matchesModelPattern 负责 glob/id 兜底 */
export function resolveAuditModel<T extends AuditModelShape>(
  spec: string,
  available: readonly T[],
  resolvedTiers: ResolvedTierModels,
): T | undefined {
  const ref = parseTierReference(spec);
  if (ref) {
    const entry = resolvedTiers[ref.tier][ref.index];
    if (!entry) return undefined;
    return available.find((m) => m.provider === entry.provider && m.id === entry.id);
  }
  return available.find((m) => matchesModelPattern(spec, m));
}

/** 从模型响应提取 JSON（围栏/前后噪声容忍），Schema 校验失败 → AuditInvalidOutput */
export function parseAuditOutput(raw: unknown): { ok: boolean; conflicts: AuditConflict[]; malformed: string[] } {
  let text = "";
  if (raw && typeof raw === "object" && Array.isArray((raw as { content?: unknown }).content)) {
    text = (raw as { content: Array<unknown> }).content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "")
      .filter(Boolean)
      .join("\n");
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced ? fenced[1]! : text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new AuditInvalidOutput({ message: `响应不含 JSON：${text.slice(0, 120)}` });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    throw new AuditInvalidOutput({ message: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` });
  }
  const decoded = Schema.decodeUnknownSync(AuditOutput)(parsed);
  // malformed 字段：缺失视为空（模型确认无异常）；存在但非字符串数组 → 显式失败，不静默吞
  const rawMalformed = (parsed as { malformed?: unknown }).malformed;
  if (rawMalformed !== undefined && (!Array.isArray(rawMalformed) || rawMalformed.some((m) => typeof m !== "string"))) {
    throw new AuditInvalidOutput({ message: "malformed 字段存在但不是字符串数组" });
  }
  return {
    // 机器不变量在代码层强制：ok 完全由 conflicts 推导，不依赖模型自觉维持一致
    ok: decoded.conflicts.length === 0,
    conflicts: decoded.conflicts.map((c) => ({ ids: [...c.ids], summary: c.summary, suggestion: c.suggestion })),
    malformed: Array.isArray(rawMalformed) ? (rawMalformed as string[]) : [],
  };
}

export type AuditError = AuditModelUnavailable | AuditApiError | AuditInvalidOutput | AuditTimeout;

export const auditDecisionLog = <T extends AuditModelShape>(deps: AuditDeps<T>): Effect.Effect<AuditResult, AuditError> =>
  Effect.gen(function* () {
    const resolvedTiers = yield* readResolvedTiersEffect;
    const model = resolveAuditModel(deps.modelSpec ?? AUDIT_MODEL_SPEC, deps.available, resolvedTiers);
    if (!model) {
      return yield* new AuditModelUnavailable({ spec: deps.modelSpec ?? AUDIT_MODEL_SPEC });
    }
    const parsedLog = parseDecisionLog(deps.decisionLog);
    const userContent = [
      `任务目标：${deps.goal || "（未填写）"}`,
      "",
      "已解析的 decision-log：",
      JSON.stringify(parsedLog, null, 2),
    ].join("\n");

    const response = yield* Effect.tryPromise({
      try: (signal) =>
        deps.complete(
          model,
          { systemPrompt: AUDIT_SYSTEM_PROMPT, messages: [{ role: "user", content: userContent, timestamp: Date.now() }] },
          { signal, reasoning: "off", maxTokens: 2000 },
        ),
      catch: (error) => new AuditApiError({ message: error instanceof Error ? error.message : String(error) }),
    }).pipe(
      Effect.timeout(deps.timeoutMs ?? AUDIT_TIMEOUT_MS),
      Effect.catchTag("TimeoutException", () => new AuditTimeout({ timeoutMs: deps.timeoutMs ?? AUDIT_TIMEOUT_MS })),
    );
    const parsed = yield* Effect.try({
      try: () => parseAuditOutput(response),
      catch: (error) => error as AuditInvalidOutput,
    });
    return { ...parsed, model: `${model.provider}/${model.id}` };
  });

/** 审查结果追加写入工作区 decision-audit.md（带日期），供 Freeze 引用 */
export function appendAuditRecord(cwd: string, slug: string, record: string): void {
  const path = join(flowDir(cwd, slug), "decision-audit.md");
  appendFileSync(path, `\n\n## ${new Date().toISOString().slice(0, 10)}\n\n${record}\n`, "utf-8");
}

export function readDecisionLog(cwd: string, slug: string): string | null {
  const path = join(flowDir(cwd, slug), "decision-log.md");
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}
