/**
 * subagent tier-router
 *
 * 这是 subagent 调度层的纯路由器，不依赖 hpl-model-tiers / hpl-recap
 * extension 的模块状态。解析后的模型清单通过文件共享，避免 pi loader
 * 为每个 extension 创建独立模块实例。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { hapilonHome } from "../config/hapilon-home.js";

export type TierName = "opus" | "sonnet" | "haiku";

export const TIER_NAMES: readonly TierName[] = ["opus", "sonnet", "haiku"];

export interface TierModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

export interface TierRouteRequest {
  /** 派发参数显式指定的档位（最高优先）。 */
  explicitTier?: TierName;
  /** 任务类型（如 review/impl/research/summary/title），查映射表用。 */
  taskType?: string;
  /** 任务描述文本（分类器兜底时用）。 */
  taskPrompt: string;
  /** 当前可用模型清单（从 modelRegistry.getAvailable() 映射）。 */
  available: TierModel[];
}

export interface TierRouteResult {
  tier: TierName;
  model: TierModel;
  /** 决策来源，调试与日志用。 */
  source: "explicit" | "frontmatter-not-here" | "task-type-map" | "classifier" | "fallback";
}

export interface TierRouterContext {
  cwd: string;
  modelRegistry: {
    complete: (
      model: TierModel,
      context: TierCompletionContext,
      options: TierCompletionOptions,
    ) => Promise<unknown>;
  };
}

export interface TierCompletionContext {
  systemPrompt: string;
  messages: Array<{
    role: "user";
    content: string;
    timestamp: number;
  }>;
}

export interface TierCompletionOptions {
  maxTokens: number;
  reasoning: "off";
  signal: AbortSignal;
}

/**
 * 路由内部所有可恢复错误都在边界降为 never；保留 TaggedError 使 Effect
 * 的 try/catch 仍有明确错误类型，调用方无需处理底层 I/O 差异。
 */
export class TierRouterError extends Data.TaggedError("TierRouterError")<{
  message: string;
  cause?: unknown;
}> {}

export type TaskTierMap = Record<string, TierName>;
export type ResolvedTierModels = Record<TierName, TierModel[]>;

const EMPTY_TASK_MAP: TaskTierMap = {};

function emptyResolvedTiers(): ResolvedTierModels {
  return { opus: [], sonnet: [], haiku: [] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTierName(value: unknown): value is TierName {
  return typeof value === "string" && TIER_NAMES.includes(value as TierName);
}

function warn(message: string): void {
  console.warn(`[tier-router] ${message}`);
}

function readTaskTierMapFileEffect(filePath: string): Effect.Effect<TaskTierMap, never> {
  return Effect.try({
    try: () => {
      if (!existsSync(filePath)) {
        warn(`task-tier-map.json 不存在：${filePath}，使用空表。`);
        return { ...EMPTY_TASK_MAP };
      }

      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (!isObject(parsed)) {
        warn(`${filePath} 顶层必须是对象，使用空表。`);
        return { ...EMPTY_TASK_MAP };
      }

      const result: TaskTierMap = {};
      for (const [taskType, tier] of Object.entries(parsed)) {
        if (isTierName(tier)) {
          result[taskType] = tier;
        } else {
          warn(`${filePath} 中 taskType "${taskType}" 的档位非法，跳过该键。`);
        }
      }
      return result;
    },
    catch: (cause) => new TierRouterError({
      message: `读取 ${filePath} 失败`,
      cause,
    }),
  }).pipe(
    Effect.catchAll((error) => Effect.sync(() => {
      warn(`${error.message}：${errorMessage(error.cause)}`);
      return { ...EMPTY_TASK_MAP };
    })),
  );
}

/** 两级任务类型映射：项目级按键覆盖全局级，缺键沿用全局。 */
export const readTaskTierMapEffect = (cwd: string): Effect.Effect<TaskTierMap, never> =>
  Effect.try({
    try: () => hapilonHome(),
    catch: (cause) => new TierRouterError({ message: "解析 HAPILON_HOME 失败", cause }),
  }).pipe(
    Effect.flatMap((home) => Effect.all({
      global: readTaskTierMapFileEffect(join(home, "task-tier-map.json")),
      project: readTaskTierMapFileEffect(join(cwd, ".hapilon", "task-tier-map.json")),
    })),
    Effect.map(({ global, project }) => ({ ...global, ...project })),
    Effect.catchAll((error) => Effect.sync(() => {
      warn(`任务档位映射加载失败，使用空表：${errorMessage(error)}`);
      return { ...EMPTY_TASK_MAP };
    })),
  );

/** 同步文件读取边界，供不在异步调度链中的调用方使用。 */
export function readTaskTierMap(cwd: string): TaskTierMap {
  return Effect.runSync(readTaskTierMapEffect(cwd));
}

function parseResolvedModelList(value: unknown): TierModel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isObject(item) || typeof item.provider !== "string" || typeof item.id !== "string") {
      return [];
    }
    return [{
      provider: item.provider,
      id: item.id,
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      ...(typeof item.reasoning === "boolean" ? { reasoning: item.reasoning } : {}),
    }];
  });
}

/**
 * 与 hpl-recap/resolved.ts 同源语义：损坏条目忽略，读取失败降为空档；
 * 这里就地实现，避免跨 extension import。
 */
export const readResolvedTiersEffect: Effect.Effect<ResolvedTierModels, never> = Effect.try({
  try: () => {
    const filePath = join(hapilonHome(), "model-tiers-resolved.json");
    if (!existsSync(filePath)) return emptyResolvedTiers();

    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!isObject(parsed)) {
      warn(`${filePath} 顶层非法，按空档处理。`);
      return emptyResolvedTiers();
    }
    return {
      opus: parseResolvedModelList(parsed.opus),
      sonnet: parseResolvedModelList(parsed.sonnet),
      haiku: parseResolvedModelList(parsed.haiku),
    };
  },
  catch: (cause) => new TierRouterError({
    message: "读取 model-tiers-resolved.json 失败",
    cause,
  }),
}).pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    warn(`${error.message}：${errorMessage(error.cause)}，按空档处理。`);
    return emptyResolvedTiers();
  })),
);

export function readResolvedTiers(): ResolvedTierModels {
  return Effect.runSync(readResolvedTiersEffect);
}

function firstAvailable(
  tier: TierName,
  resolved: ResolvedTierModels,
  available: readonly TierModel[],
): TierModel | undefined {
  return resolved[tier].map((reference) =>
    available.find((candidate) => candidate.provider === reference.provider && candidate.id === reference.id),
  ).find((model): model is TierModel => model !== undefined);
}

function fallbackRoute(
  resolved: ResolvedTierModels,
  available: readonly TierModel[],
): TierRouteResult | undefined {
  for (const tier of ["sonnet", "opus", "haiku"] as const) {
    const model = firstAvailable(tier, resolved, available);
    if (model) return { tier, model, source: "fallback" };
  }
  return undefined;
}

function responseText(response: unknown): string {
  if (typeof response === "string") return response;
  if (!isObject(response) || !Array.isArray(response.content)) return "";
  return response.content.map((part) => {
    if (!isObject(part) || typeof part.text !== "string") return "";
    return part.text;
  }).filter(Boolean).join("\n").trim();
}

function classifyResponse(response: unknown): TierName | undefined {
  const normalized = responseText(response).toLowerCase();
  const match = normalized.match(/\b(haiku|sonnet|opus)\b/);
  return match && isTierName(match[1]) ? match[1] : undefined;
}

const CLASSIFIER_SYSTEM_PROMPT =
  "判断任务是轻量（摘要/标题/格式化）、常规（实现/调研）、深度（审查/规划/复杂调试）哪类，只回 haiku|sonnet|opus 单词。";

async function completeWithTimeout(
  ctx: TierRouterContext,
  model: TierModel,
  taskPrompt: string,
): Promise<unknown> {
  const signal = AbortSignal.timeout(5_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = Promise.resolve().then(() => ctx.modelRegistry.complete(model, {
      systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: taskPrompt, timestamp: Date.now() }],
    }, {
      maxTokens: 8,
      reasoning: "off",
      signal,
    }));
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("classifier timeout")), 5_000);
    });
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function classifyTierEffect(
  ctx: TierRouterContext,
  model: TierModel,
  taskPrompt: string,
): Effect.Effect<TierName | undefined, never> {
  return Effect.tryPromise({
    try: () => completeWithTimeout(ctx, model, taskPrompt),
    catch: (cause) => new TierRouterError({ message: "分类器调用失败", cause }),
  }).pipe(
    Effect.map(classifyResponse),
    Effect.catchAll((error) => Effect.sync(() => {
      warn(`分类器失败，进入 fallback：${error.message}：${errorMessage(error.cause)}`);
      return undefined;
    })),
  );
}

function routeTierEffectInternal(
  request: TierRouteRequest,
  ctx: TierRouterContext,
): Effect.Effect<TierRouteResult | undefined, never> {
  return Effect.gen(function* () {
    const resolved = yield* readResolvedTiersEffect;

    if (request.explicitTier) {
      const model = firstAvailable(request.explicitTier, resolved, request.available);
      if (model) return { tier: request.explicitTier, model, source: "explicit" as const };
    }

    const taskMap = yield* readTaskTierMapEffect(ctx.cwd);
    const mappedTier = request.taskType ? taskMap[request.taskType] : undefined;
    if (mappedTier) {
      const model = firstAvailable(mappedTier, resolved, request.available);
      if (model) return { tier: mappedTier, model, source: "task-type-map" as const };
    }

    const classifierModel = firstAvailable("haiku", resolved, request.available);
    if (classifierModel) {
      const classifiedTier = yield* classifyTierEffect(ctx, classifierModel, request.taskPrompt);
      if (classifiedTier) {
        const model = firstAvailable(classifiedTier, resolved, request.available);
        if (model) return { tier: classifiedTier, model, source: "classifier" as const };
        warn(`分类器返回 ${classifiedTier} 但该档无可用模型，进入 fallback。`);
      }
    }

    return fallbackRoute(resolved, request.available);
  }).pipe(
    Effect.catchAll((error) => Effect.sync(() => {
      warn(`路由失败，进入 fallback：${errorMessage(error)}`);
      return undefined;
    })),
  );
}

/**
 * 主路由 Effect。两种参数顺序都保留，便于调用方按 request-first 或
 * context-first 风格接入；实现内部统一为 request-first。
 */
export function routeTierEffect(
  request: TierRouteRequest,
  ctx: TierRouterContext,
): Effect.Effect<TierRouteResult | undefined, never>;
export function routeTierEffect(
  ctx: TierRouterContext,
  request: TierRouteRequest,
): Effect.Effect<TierRouteResult | undefined, never>;
export function routeTierEffect(
  first: TierRouteRequest | TierRouterContext,
  second: TierRouteRequest | TierRouterContext,
): Effect.Effect<TierRouteResult | undefined, never> {
  const request = "taskPrompt" in first ? first : second as TierRouteRequest;
  const ctx = "modelRegistry" in first ? first : second as TierRouterContext;
  return routeTierEffectInternal(request, ctx);
}

export const resolveTierRouteEffect = routeTierEffect;

/** Promise 边界供异步 subagent 调度器使用。 */
export function routeTier(
  request: TierRouteRequest,
  ctx: TierRouterContext,
): Promise<TierRouteResult | undefined>;
export function routeTier(
  ctx: TierRouterContext,
  request: TierRouteRequest,
): Promise<TierRouteResult | undefined>;
export function routeTier(
  first: TierRouteRequest | TierRouterContext,
  second: TierRouteRequest | TierRouterContext,
): Promise<TierRouteResult | undefined> {
  return Effect.runPromise(routeTierEffect(first as never, second as never));
}
