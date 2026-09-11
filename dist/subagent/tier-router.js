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
export const TIER_NAMES = ["opus", "sonnet", "haiku"];
/**
 * 路由内部所有可恢复错误都在边界降为 never；保留 TaggedError 使 Effect
 * 的 try/catch 仍有明确错误类型，调用方无需处理底层 I/O 差异。
 */
export class TierRouterError extends Data.TaggedError("TierRouterError") {
}
const EMPTY_TASK_MAP = {};
function emptyResolvedTiers() {
    return { opus: [], sonnet: [], haiku: [] };
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isTierName(value) {
    return typeof value === "string" && TIER_NAMES.includes(value);
}
function warn(message) {
    console.warn(`[tier-router] ${message}`);
}
function readTaskTierMapFileEffect(filePath) {
    return Effect.try({
        try: () => {
            if (!existsSync(filePath)) {
                warn(`task-tier-map.json 不存在：${filePath}，使用空表。`);
                return { ...EMPTY_TASK_MAP };
            }
            const parsed = JSON.parse(readFileSync(filePath, "utf8"));
            if (!isObject(parsed)) {
                warn(`${filePath} 顶层必须是对象，使用空表。`);
                return { ...EMPTY_TASK_MAP };
            }
            const result = {};
            for (const [taskType, tier] of Object.entries(parsed)) {
                if (isTierName(tier)) {
                    result[taskType] = tier;
                }
                else {
                    warn(`${filePath} 中 taskType "${taskType}" 的档位非法，跳过该键。`);
                }
            }
            return result;
        },
        catch: (cause) => new TierRouterError({
            message: `读取 ${filePath} 失败`,
            cause,
        }),
    }).pipe(Effect.catchAll((error) => Effect.sync(() => {
        warn(`${error.message}：${errorMessage(error.cause)}`);
        return { ...EMPTY_TASK_MAP };
    })));
}
/** 两级任务类型映射：项目级按键覆盖全局级，缺键沿用全局。 */
export const readTaskTierMapEffect = (cwd) => Effect.try({
    try: () => hapilonHome(),
    catch: (cause) => new TierRouterError({ message: "解析 HAPILON_HOME 失败", cause }),
}).pipe(Effect.flatMap((home) => Effect.all({
    global: readTaskTierMapFileEffect(join(home, "task-tier-map.json")),
    project: readTaskTierMapFileEffect(join(cwd, ".hapilon", "task-tier-map.json")),
})), Effect.map(({ global, project }) => ({ ...global, ...project })), Effect.catchAll((error) => Effect.sync(() => {
    warn(`任务档位映射加载失败，使用空表：${errorMessage(error)}`);
    return { ...EMPTY_TASK_MAP };
})));
/** 同步文件读取边界，供不在异步调度链中的调用方使用。 */
export function readTaskTierMap(cwd) {
    return Effect.runSync(readTaskTierMapEffect(cwd));
}
function parseResolvedModelList(value) {
    if (!Array.isArray(value))
        return [];
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
export const readResolvedTiersEffect = Effect.try({
    try: () => {
        const filePath = join(hapilonHome(), "model-tiers-resolved.json");
        if (!existsSync(filePath))
            return emptyResolvedTiers();
        const parsed = JSON.parse(readFileSync(filePath, "utf8"));
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
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    warn(`${error.message}：${errorMessage(error.cause)}，按空档处理。`);
    return emptyResolvedTiers();
})));
export function readResolvedTiers() {
    return Effect.runSync(readResolvedTiersEffect);
}
function firstAvailable(tier, resolved, available) {
    return resolved[tier].map((reference) => available.find((candidate) => candidate.provider === reference.provider && candidate.id === reference.id)).find((model) => model !== undefined);
}
function fallbackRoute(resolved, available) {
    for (const tier of ["sonnet", "opus", "haiku"]) {
        const model = firstAvailable(tier, resolved, available);
        if (model)
            return { tier, model, source: "fallback" };
    }
    return undefined;
}
function responseText(response) {
    if (typeof response === "string")
        return response;
    if (!isObject(response) || !Array.isArray(response.content))
        return "";
    return response.content.map((part) => {
        if (!isObject(part) || typeof part.text !== "string")
            return "";
        return part.text;
    }).filter(Boolean).join("\n").trim();
}
function classifyResponse(response) {
    const normalized = responseText(response).toLowerCase();
    const match = normalized.match(/\b(haiku|sonnet|opus)\b/);
    return match && isTierName(match[1]) ? match[1] : undefined;
}
const CLASSIFIER_SYSTEM_PROMPT = "判断任务是轻量（摘要/标题/格式化）、常规（实现/调研）、深度（审查/规划/复杂调试）哪类，只回 haiku|sonnet|opus 单词。";
async function completeWithTimeout(ctx, model, taskPrompt) {
    const signal = AbortSignal.timeout(5_000);
    let timer;
    try {
        const call = Promise.resolve().then(() => ctx.modelRegistry.complete(model, {
            systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
            messages: [{ role: "user", content: taskPrompt, timestamp: Date.now() }],
        }, {
            maxTokens: 8,
            reasoning: "off",
            signal,
        }));
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("classifier timeout")), 5_000);
        });
        return await Promise.race([call, timeout]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function classifyTierEffect(ctx, model, taskPrompt) {
    return Effect.tryPromise({
        try: () => completeWithTimeout(ctx, model, taskPrompt),
        catch: (cause) => new TierRouterError({ message: "分类器调用失败", cause }),
    }).pipe(Effect.map(classifyResponse), Effect.catchAll((error) => Effect.sync(() => {
        warn(`分类器失败，进入 fallback：${error.message}：${errorMessage(error.cause)}`);
        return undefined;
    })));
}
function routeTierEffectInternal(request, ctx) {
    return Effect.gen(function* () {
        const resolved = yield* readResolvedTiersEffect;
        if (request.explicitTier) {
            const model = firstAvailable(request.explicitTier, resolved, request.available);
            if (model)
                return { tier: request.explicitTier, model, source: "explicit" };
        }
        const taskMap = yield* readTaskTierMapEffect(ctx.cwd);
        const mappedTier = request.taskType ? taskMap[request.taskType] : undefined;
        if (mappedTier) {
            const model = firstAvailable(mappedTier, resolved, request.available);
            if (model)
                return { tier: mappedTier, model, source: "task-type-map" };
        }
        const classifierModel = firstAvailable("haiku", resolved, request.available);
        if (classifierModel) {
            const classifiedTier = yield* classifyTierEffect(ctx, classifierModel, request.taskPrompt);
            if (classifiedTier) {
                const model = firstAvailable(classifiedTier, resolved, request.available);
                if (model)
                    return { tier: classifiedTier, model, source: "classifier" };
                warn(`分类器返回 ${classifiedTier} 但该档无可用模型，进入 fallback。`);
            }
        }
        return fallbackRoute(resolved, request.available);
    }).pipe(Effect.catchAll((error) => Effect.sync(() => {
        warn(`路由失败，进入 fallback：${errorMessage(error)}`);
        return undefined;
    })));
}
export function routeTierEffect(first, second) {
    const request = "taskPrompt" in first ? first : second;
    const ctx = "modelRegistry" in first ? first : second;
    return routeTierEffectInternal(request, ctx);
}
export const resolveTierRouteEffect = routeTierEffect;
export function routeTier(first, second) {
    return Effect.runPromise(routeTierEffect(first, second));
}
