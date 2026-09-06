import { Effect } from "effect";
import { showFloatingPane } from "../../shared/floating-pane/index.js";
import { fetchQuotaEffect as fetchDeepSeekQuota, parseQuotaLines as parseDeepSeekQuota } from "./providers/deepseek.js";
import { fetchQuotaEffect as fetchGlmQuota, parseQuotaLines as parseGlmQuota, GLM_QUOTA_ENDPOINT_INTL, } from "./providers/glm.js";
import { fetchQuotaEffect as fetchCodexQuota, parseQuotaLines as parseCodexQuota } from "./providers/codex.js";
import { field } from "./types.js";
const SUPPORTED_PROVIDERS = new Set(["deepseek", "zai", "zai-coding-cn", "openai-codex"]);
export function isSupportedProvider(provider) {
    return SUPPORTED_PROVIDERS.has(provider);
}
export function queryQuotaEffect(provider, auth) {
    switch (provider) {
        case "deepseek":
            return fetchDeepSeekQuota(auth).pipe(Effect.map(parseDeepSeekQuota));
        case "zai-coding-cn":
            return fetchGlmQuota(auth).pipe(Effect.map(parseGlmQuota));
        case "zai":
            return fetchGlmQuota(auth, GLM_QUOTA_ENDPOINT_INTL).pipe(Effect.map(parseGlmQuota));
        case "openai-codex":
            return fetchCodexQuota(auth).pipe(Effect.map(parseCodexQuota));
        default:
            return Effect.fail(new Error(`Unsupported provider: ${provider}`));
    }
}
function hasCredential(auth) {
    if (typeof auth.apiKey === "string" && auth.apiKey.trim().length > 0)
        return true;
    return Object.entries(auth.headers ?? {}).some(([key, value]) => key.toLowerCase() === "authorization" && typeof value === "string" && value.trim().length > 0);
}
function resolveAuthEffect(ctx, model) {
    return Effect.tryPromise({
        try: () => ctx.modelRegistry.getApiKeyAndHeaders(model),
        catch: () => undefined,
    }).pipe(Effect.map((result) => result.ok && hasCredential(result) ? {
        apiKey: result.apiKey,
        headers: result.headers,
    } : undefined), Effect.catchAll(() => Effect.succeed(undefined)));
}
export function loadQuotaEffect(ctx, model) {
    const provider = model.provider;
    if (!isSupportedProvider(provider)) {
        return Effect.succeed({ fields: [field("状态", "该 provider 未提供公开用量查询", "warning")] });
    }
    return Effect.gen(function* () {
        const auth = yield* resolveAuthEffect(ctx, model);
        if (!auth)
            return { fields: [field("状态", "未找到该 provider 的凭证，请先 /login", "error")] };
        const fields = yield* queryQuotaEffect(provider, auth).pipe(Effect.map((rows) => ({ fields: rows })), Effect.catchAll(() => Effect.succeed({
            fields: [field("状态", provider === "openai-codex" ? "查询失败（私有接口可能变更）" : "查询失败，请稍后重试", "error")],
        })));
        return fields;
    });
}
function toneFor(fieldValue) {
    return fieldValue.tone ?? "text";
}
export default function hplQuotaUsage(pi) {
    pi.registerCommand("quota-usage", {
        description: "Show quota or balance for the current provider",
        handler: async (_args, ctx) => {
            const model = ctx.model;
            const provider = model?.provider ?? "unknown";
            const fields = [
                field("Provider", provider),
                field("查询时间", new Date().toLocaleString("zh-CN")),
            ];
            if (!model) {
                fields.push(field("状态", "当前没有正在使用的模型", "error"));
            }
            else {
                const result = await Effect.runPromise(loadQuotaEffect(ctx, model));
                fields.push(...result.fields);
            }
            await showFloatingPane(ctx, {
                title: `Quota Usage — ${provider}`,
                lines: fields.map((item) => `  ${item.label}: ${item.value}`),
                lineStyles: fields.map(toneFor),
                footer: `${model?.id ?? "no model"} | Esc close`,
                width: 72,
                maxHeight: 80,
            });
        },
    });
}
