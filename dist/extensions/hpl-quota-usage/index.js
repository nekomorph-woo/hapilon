import { Effect } from "effect";
import { showFloatingPane } from "../../shared/floating-pane/index.js";
import { fetchQuotaEffect as fetchDeepSeekQuota, parseQuotaLines as parseDeepSeekQuota, parseSnapshot as parseDeepSeekSnapshot } from "./providers/deepseek.js";
import { fetchQuotaEffect as fetchGlmQuota, parseQuotaLines as parseGlmQuota, parseSnapshot as parseGlmSnapshot, GLM_QUOTA_ENDPOINT_INTL, } from "./providers/glm.js";
import { fetchQuotaEffect as fetchCodexQuota, parseQuotaLines as parseCodexQuota, parseSnapshot as parseCodexSnapshot } from "./providers/codex.js";
import { field } from "./types.js";
import { writeQuotaSnapshot } from "./cache.js";
const SUPPORTED_PROVIDERS = new Set(["deepseek", "zai", "zai-coding-cn", "openai-codex"]);
export function isSupportedProvider(provider) {
    return SUPPORTED_PROVIDERS.has(provider);
}
/** provider id → snapshot 命名空间（glm 系两入口共享同一份） */
function snapshotKey(provider) {
    return provider === "zai" || provider === "zai-coding-cn" ? "glm" : provider;
}
function fetchAndParseSnapshot(provider, auth, now) {
    const key = snapshotKey(provider);
    const run = (effect) => Effect.runPromise(effect).then((payload) => {
        switch (key) {
            case "deepseek":
                return parseDeepSeekSnapshot(payload, now);
            case "glm":
                return parseGlmSnapshot(payload, now);
            default:
                return parseCodexSnapshot(payload, now);
        }
    });
    switch (provider) {
        case "deepseek":
            return run(fetchDeepSeekQuota(auth));
        case "zai-coding-cn":
        case "zai":
            return run(fetchGlmQuota(auth, provider === "zai" ? GLM_QUOTA_ENDPOINT_INTL : undefined));
        case "openai-codex":
            return run(fetchCodexQuota(auth));
        default:
            return Promise.reject(new Error(`Unsupported provider: ${key}`));
    }
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
        // 每次命令顺手刷新缓存，footer 下次 render 就有新数据
        refreshCache(provider, auth);
        const fields = yield* queryQuotaEffect(provider, auth).pipe(Effect.map((rows) => ({ fields: rows })), Effect.catchAll(() => Effect.succeed({
            fields: [field("状态", provider === "openai-codex" ? "查询失败（私有接口可能变更）" : "查询失败，请稍后重试", "error")],
        })));
        return fields;
    });
}
// ─── 后台轮询（footer 数据源）────────────────────────────────────────
// 10 分钟兜底刷新；及时性由 /quota-usage 命令触发的 refreshCache 保证
const POLL_INTERVAL_MS = 10 * 60 * 1000;
let pollTimer;
let lastProvider;
let lastAuth;
let refreshInFlight = false;
export function refreshCache(provider, auth, now = Date.now()) {
    if (refreshInFlight)
        return;
    refreshInFlight = true;
    fetchAndParseSnapshot(provider, auth, now)
        .then((snapshot) => writeQuotaSnapshot({ ...snapshot, provider: snapshotKey(provider) }), () => { })
        .finally(() => {
        refreshInFlight = false;
    });
}
/** session_start 时调用；60s 周期轮询当前 provider。 */
export function ensurePolling(provider, auth) {
    lastProvider = provider;
    lastAuth = auth;
    refreshCache(provider, auth);
    if (pollTimer)
        return;
    pollTimer = setInterval(() => {
        if (lastProvider && lastAuth)
            refreshCache(lastProvider, lastAuth);
    }, POLL_INTERVAL_MS);
    pollTimer.unref?.();
}
export function stopPollingForTest() {
    if (pollTimer)
        clearInterval(pollTimer);
    pollTimer = undefined;
    lastProvider = undefined;
    lastAuth = undefined;
}
function toneFor(fieldValue) {
    return fieldValue.tone ?? "text";
}
export default function hplQuotaUsage(pi) {
    // session_start 启动轮询；model_select 切换 provider 时重定向轮询目标
    const startPollingFor = (ctx) => {
        const model = ctx.model;
        if (!model || !isSupportedProvider(model.provider))
            return;
        void (async () => {
            const auth = await Effect.runPromise(resolveAuthEffect(ctx, model));
            if (auth)
                ensurePolling(model.provider, auth);
        })();
    };
    pi.on("session_start", (_event, ctx) => {
        startPollingFor(ctx);
    });
    pi.on("model_select", (event, ctx) => {
        if (event.previousModel?.provider === event.model.provider)
            return;
        // 换 provider：换掉轮询目标，旧缓存由 footer 的 provider 匹配兜底不再展示
        startPollingFor(ctx);
    });
    pi.registerCommand("quota-usage", {
        description: "Show quota or balance for all configured providers",
        handler: async (_args, ctx) => {
            const currentProvider = ctx.model?.provider ?? "unknown";
            const fields = [
                field("查询时间", new Date().toLocaleString("zh-CN")),
            ];
            // 区块间空行：valueText 会把空串降级为 unknown，故用哨兵值直通渲染
            const SPACER = field("", " ");
            const renderLine = (item) => item.value === SPACER.value && item.label === "" ? "" : item.label ? `  ${item.label}: ${item.value}` : item.value;
            // 全 provider 视图：从模型全集提取 provider，已配置凭证的才查询。
            // getRegisteredProviderIds 只含扩展注册项，会漏原生 provider。
            const providers = Array.from(new Set(ctx.modelRegistry.getAll().map((m) => m.provider)))
                .filter((p) => isSupportedProvider(p))
                .filter((p) => ctx.modelRegistry.getProviderAuthStatus(p).configured);
            const configured = new Map();
            for (const provider of providers) {
                const model = ctx.modelRegistry.getAvailable().find((m) => m.provider === provider)
                    ?? ctx.modelRegistry.getAll().find((m) => m.provider === provider);
                if (!model)
                    continue;
                const auth = await Effect.runPromise(resolveAuthEffect(ctx, model));
                if (auth)
                    configured.set(provider, auth);
            }
            if (configured.size === 0) {
                fields.push(field("状态", "没有已配置凭证的可查询 provider（/login 配置后重试）", "warning"));
            }
            else {
                // 当前 provider 置顶，其余按名称排；并发查询互不阻塞
                const ordered = [...configured.keys()].sort((a, b) => a === currentProvider ? -1 : b === currentProvider ? 1 : a.localeCompare(b));
                await Promise.all(ordered.map(async (provider) => {
                    const result = await Effect.runPromise(queryQuotaEffect(provider, configured.get(provider)).pipe(Effect.map((rows) => ({ rows })), Effect.catchAll(() => Effect.succeed({
                        rows: [field("状态", provider === "openai-codex" ? "查询失败（私有接口可能变更）" : "查询失败，请稍后重试", "error")],
                    }))));
                    // 命令也顺手刷新当前 provider 的 footer 缓存
                    if (provider === currentProvider)
                        refreshCache(provider, configured.get(provider));
                    // 区块间空行分隔；空行不经过 field()（valueText 会把空串降级为 unknown）
                    fields.push(SPACER);
                    fields.push(field("", `▌ ${provider}${provider === currentProvider ? "（当前）" : ""}`));
                    fields.push(...result.rows);
                }));
            }
            await showFloatingPane(ctx, {
                title: "Quota Usage — all providers",
                lines: fields.map(renderLine),
                lineStyles: fields.map(toneFor),
                footer: `${currentProvider} | Esc close`,
                width: "fit-content",
                maxHeight: 80,
            });
        },
    });
}
