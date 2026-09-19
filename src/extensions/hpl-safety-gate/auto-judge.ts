/**
 * auto-judge.ts — Auto 模式模型判定层
 *
 * confirm 级命令在沙箱规则未命中时交给档位模型做三值判定
 * （allow / block / unsure，unsure 与一切失败都回落现有人工路径，不存在 fail-open）。
 *
 * - 模型指代：`tier:<opus|sonnet|haiku>[<index>]` 经 model-tiers-resolved.json 解析
 *   （hpl-model-tiers/resolved.ts 的共享 reader），或直接用 glob/具体 id 对可用模型匹配，不硬编码 id。
 * - 超时 / API 错误 / 输出不合法 → typed error（GateAutoTimeout / GateAutoApiError /
 *   GateAutoInvalidOutput），调用方统一按 unsure 回落。
 * - 判定结果 {verdict, reason} 走 Schema 校验，模型输出属不可信边界。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Data, Effect, Schema } from "effect";
import { agentDir } from "../../config/hapilon-home.js";
import { matchesModelPattern } from "../hpl-model-tiers/index.js";
import { readResolvedTiersEffect } from "../hpl-model-tiers/resolved.js";

// ─── 配置 ────────────────────────────────────────────────────────────

export interface GateAutoConfig {
  enabled: boolean;
  timeoutMs: number;
  model: string;
}

export const GATE_AUTO_DEFAULTS: GateAutoConfig = {
  enabled: false,
  timeoutMs: 10000,
  model: "tier:haiku",
};

/** <HAPILON_HOME>/agent/settings.json 的 gateAuto 键，默认关闭 */
export function gateAutoSettingsPath(): string {
  return join(agentDir(), "settings.json");
}

function boolOr(raw: unknown, fallback: boolean, warn: string): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw === "boolean") return raw;
  console.warn(`[hpl-safety-gate] ${warn}，使用默认值。`);
  return fallback;
}

function positiveIntOr(raw: unknown, fallback: number, warn: string): number {
  if (raw === undefined) return fallback;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  console.warn(`[hpl-safety-gate] ${warn}，使用默认值。`);
  return fallback;
}

export const readGateAutoConfigEffect: Effect.Effect<GateAutoConfig, never> = Effect.try({
  try: () => {
    const path = gateAutoSettingsPath();
    if (!existsSync(path)) return { ...GATE_AUTO_DEFAULTS };
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn(`[hpl-safety-gate] ${path} 顶层必须是对象，gateAuto 使用默认配置。`);
      return { ...GATE_AUTO_DEFAULTS };
    }
    const raw = (parsed as Record<string, unknown>).gateAuto;
    if (raw === undefined) return { ...GATE_AUTO_DEFAULTS };
    if (typeof raw !== "object" || Array.isArray(raw)) {
      console.warn("[hpl-safety-gate] settings.json gateAuto 必须是对象，使用默认配置。");
      return { ...GATE_AUTO_DEFAULTS };
    }
    const g = raw as Record<string, unknown>;
    return {
      enabled: boolOr(g.enabled, GATE_AUTO_DEFAULTS.enabled, "gateAuto.enabled 非布尔值"),
      timeoutMs: positiveIntOr(g.timeoutMs, GATE_AUTO_DEFAULTS.timeoutMs, "gateAuto.timeoutMs 非正数"),
      model: typeof g.model === "string" && g.model.trim() !== ""
        ? g.model.trim()
        : (console.warn("[hpl-safety-gate] gateAuto.model 非字符串，使用默认值。"), GATE_AUTO_DEFAULTS.model),
    };
  },
  catch: (error) => error,
}).pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-safety-gate] gateAuto 配置读取失败，使用默认配置：${String(error)}`);
    return { ...GATE_AUTO_DEFAULTS };
  })),
);

export function readGateAutoConfig(): GateAutoConfig {
  return Effect.runSync(readGateAutoConfigEffect);
}

interface SettingsObject {
  [key: string]: unknown;
}

const isSettingsObject = (value: unknown): value is SettingsObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 读整个 settings.json；解析失败/非对象 → undefined，调用方据此放弃写入（绝不清空用户配置）。 */
function readSettings(path: string): SettingsObject | undefined {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.warn(`[hpl-safety-gate] 无法读取 settings.json，跳过写入：${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (!isSettingsObject(parsed)) {
    console.warn("[hpl-safety-gate] settings.json 不是对象，跳过写入。");
    return undefined;
  }
  return parsed;
}

function writeSettings(path: string, settings: SettingsObject): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/**
 * 只改 settings.json 的 `gateAuto.enabled`，gateAuto 其余字段（model/timeoutMs）与
 * settings 其他键一律保留。返回是否落盘成功：失败时调用方仍可只本会话生效。
 */
export const setGateAutoEnabledEffect = (enabled: boolean): Effect.Effect<boolean, never> => Effect.try({
  try: () => {
    const path = gateAutoSettingsPath();
    const settings = readSettings(path);
    if (!settings) return false;
    const gateAuto = isSettingsObject(settings.gateAuto) ? settings.gateAuto : {};
    gateAuto.enabled = enabled;
    settings.gateAuto = gateAuto;
    writeSettings(path, settings);
    return true;
  },
  catch: (error) => error,
}).pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-safety-gate] gateAuto 设置写入失败：${String(error)}`);
    return false;
  })),
);

export function setGateAutoEnabled(enabled: boolean): boolean {
  return Effect.runSync(setGateAutoEnabledEffect(enabled));
}

// ─── typed errors ────────────────────────────────────────────────────

export class GateAutoTimeout extends Data.TaggedError("GateAutoTimeout")<{
  timeoutMs: number;
  command: string;
}> {}

export class GateAutoApiError extends Data.TaggedError("GateAutoApiError")<{
  message: string;
  command: string;
}> {}

export class GateAutoInvalidOutput extends Data.TaggedError("GateAutoInvalidOutput")<{
  message: string;
  command: string;
}> {}

export type GateAutoError = GateAutoTimeout | GateAutoApiError | GateAutoInvalidOutput;

// ─── 判定 ────────────────────────────────────────────────────────────

export type AutoVerdict = "allow" | "block" | "unsure";

export interface AutoJudgement {
  verdict: AutoVerdict;
  reason: string;
  /** 实际使用的判定模型 provider/id（解析失败时缺省） */
  model?: string;
}

const VERDICT_SCHEMA = Schema.Struct({
  verdict: Schema.Literal("allow", "block", "unsure"),
  reason: Schema.String,
});

const decodeVerdict = Schema.decodeUnknownSync(VERDICT_SCHEMA);

/** 结构化模型形状（Model<Api> 可直接赋值）；与 resolved.ts 的 ResolvedTierModel 同源 */
export interface JudgeModelShape {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

export interface JudgeRequest {
  systemPrompt: string;
  messages: Array<{ role: "user"; content: string; timestamp: number }>;
}

export interface AutoJudgeDeps<T extends JudgeModelShape> {
  modelSpec: string;
  timeoutMs: number;
  command: string;
  cwd: string;
  ruleLabel?: string;
  /** 沙箱解析摘要（给模型的目标解析上下文） */
  sandboxSummary?: string;
  available: readonly T[];
  complete: (
    model: T,
    request: JudgeRequest,
    options: { signal: AbortSignal; reasoning: "off"; maxTokens: number },
  ) => Promise<unknown>;
}

const JUDGE_SYSTEM_PROMPT = `你是 hapilon 安全门的命令判定助手，对 bash 命令做三值判定：
- allow：写目标可静态解析且全部位于临时目录或沙箱（/tmp、$TMPDIR、$HAPILON_HOME、plan-task）内；或属于单人仓库的常规工作流（git push、git commit --amend、git checkout/restore 恢复文件等）。
- block：不可逆且作用域越出沙箱与仓库（删根目录/home、格式化磁盘、清空生产数据、强推主干等）。
- unsure：目标无法静态解析、影响面拿不准、或需要人工确认。拿不准时一律 unsure。
只输出一行 JSON：{"verdict":"allow|block|unsure","reason":"不超过 60 字的理由"}`;

/** `tier:<name>[<index>]` 查 resolved 档位表取可用模型；其余按 glob/具体 id 直接匹配 */
export function resolveAutoModel<T extends JudgeModelShape>(
  spec: string,
  available: readonly T[],
  resolvedTiers: Record<"opus" | "sonnet" | "haiku", Array<{ provider: string; id: string }>>,
): T | undefined {
  const wanted = spec.trim();
  const ref = /^tier:(opus|sonnet|haiku)(?:\[(\d+)\])?$/.exec(wanted);
  if (ref) {
    const tier = ref[1] as "opus" | "sonnet" | "haiku";
    const index = ref[2] === undefined ? 0 : Number(ref[2]);
    const entry = resolvedTiers[tier][index];
    if (!entry) return undefined;
    return available.find((m) => m.provider === entry.provider && m.id === entry.id);
  }
  return available.find((m) => matchesModelPattern(wanted, m));
}

/** 从模型响应提取 {verdict, reason}；围栏/前后噪声容忍，解析或校验失败 → InvalidOutput */
export function parseJudgeOutput(raw: unknown, command: string): AutoJudgement {
  let text = "";
  if (raw && typeof raw === "object" && Array.isArray((raw as { content?: unknown }).content)) {
    text = (raw as { content: Array<unknown> }).content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""))
      .filter(Boolean)
      .join("\n");
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced ? fenced[1]! : text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new GateAutoInvalidOutput({ message: `响应不含 JSON：${text.slice(0, 120)}`, command });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    throw new GateAutoInvalidOutput({
      message: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
      command,
    });
  }
  try {
    const verdict = decodeVerdict(parsed);
    return { verdict: verdict.verdict, reason: verdict.reason };
  } catch (error) {
    throw new GateAutoInvalidOutput({
      message: `schema 校验失败：${error instanceof Error ? error.message : String(error)}`,
      command,
    });
  }
}

function buildUserMessage(deps: Pick<AutoJudgeDeps<JudgeModelShape>, "command" | "cwd" | "ruleLabel" | "sandboxSummary">): string {
  const parts = [`命令：\n${deps.command}`, `cwd：${deps.cwd}`];
  if (deps.ruleLabel) parts.push(`命中安全规则：${deps.ruleLabel}`);
  if (deps.sandboxSummary) parts.push(`沙箱解析：${deps.sandboxSummary}`);
  return parts.join("\n\n");
}

/**
 * 模型判定：返回判定结果；超时 / 调用失败 / 输出不合法分别以 typed error 失败，
 * 由调用方按 unsure 回落现有人工路径。
 */
export const judgeCommand = <T extends JudgeModelShape>(
  deps: AutoJudgeDeps<T>,
): Effect.Effect<AutoJudgement, GateAutoError> =>
  Effect.gen(function* () {
    const resolvedTiers = yield* readResolvedTiersEffect;
    const model = resolveAutoModel(deps.modelSpec, deps.available, resolvedTiers);
    if (!model) {
      return yield* new GateAutoApiError({
        message: `判定模型不可用（${deps.modelSpec} 在 resolved 档位/可用列表中无匹配）`,
        command: deps.command,
      });
    }
    const response = yield* Effect.tryPromise({
      try: (signal) => deps.complete(model, {
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserMessage(deps), timestamp: Date.now() }],
      }, {
        signal,
        reasoning: "off",
        maxTokens: 200,
      }),
      catch: (error) => new GateAutoApiError({
        message: error instanceof Error ? error.message : String(error),
        command: deps.command,
      }),
    }).pipe(
      Effect.timeout(deps.timeoutMs),
      Effect.catchTag("TimeoutException", () => new GateAutoTimeout({ timeoutMs: deps.timeoutMs, command: deps.command })),
    );
    // parseJudgeOutput 只会抛 GateAutoInvalidOutput，此处提起为 typed failure（避免成为 defect）
    const parsed = yield* Effect.try({
      try: () => parseJudgeOutput(response, deps.command),
      catch: (error) => error as GateAutoInvalidOutput,
    });
    return { ...parsed, model: `${model.provider}/${model.id}` };
  });
