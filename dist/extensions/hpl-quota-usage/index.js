import { Effect } from "effect";
import { showFloatingPane } from "../../shared/floating-pane/index.js";
import { fetchQuotaEffect as fetchDeepSeekQuota, parseQuotaLines as parseDeepSeekQuota, parseSnapshot as parseDeepSeekSnapshot } from "./providers/deepseek.js";
import { fetchQuotaEffect as fetchGlmQuota, parseQuotaLines as parseGlmQuota, parseSnapshot as parseGlmSnapshot, GLM_QUOTA_ENDPOINT_INTL, } from "./providers/glm.js";
import { fetchQuotaEffect as fetchCodexQuota, parseQuotaLines as parseCodexQuota, parseSnapshot as parseCodexSnapshot } from "./providers/codex.js";
import { fetchQuotaEffect as fetchXaiQuota, parseQuotaLines as parseXaiQuota, parseSnapshot as parseXaiSnapshot } from "./providers/xai.js";
import { field } from "./types.js";
import { quotaNamespace } from "./snapshot.js";
import { writeQuotaSnapshot } from "./cache.js";
import { appendAdaptiveEvent } from "../hpl-model-tiers/adaptive-events.js";
const SUPPORTED_PROVIDERS = new Set(["deepseek", "zai", "zai-coding-cn", "openai-codex", "xai"]);
export function isSupportedProvider(provider) {
    return SUPPORTED_PROVIDERS.has(provider);
}
function fetchAndParseSnapshot(provider, auth, now) {
    const key = quotaNamespace(provider);
    const run = (effect) => Effect.runPromise(effect).then((payload) => {
        switch (key) {
            case "deepseek":
                return parseDeepSeekSnapshot(payload, now);
            case "glm":
                return parseGlmSnapshot(payload, now);
            case "xai":
                return parseXaiSnapshot(payload, now);
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
        case "xai":
            return run(fetchXaiQuota(auth));
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
        case "xai":
            return fetchXaiQuota(auth).pipe(Effect.map(parseXaiQuota));
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
/** tool ctx 版凭证解析（ExtensionContext 与 CommandContext 同构，仅类型不同） */
function resolveAuthEffectForTool(ctx, model) {
    return resolveAuthEffect(ctx, model);
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
// ─── quota_check 模型侧工具（额度哨兵的数据出口）─────────────────────
/** 窗口水位等级：>=97 HOT（哨兵须行动）；>=90 WARN（提高检查频率）；否则 OK */
export function quotaWindowLevel(percent) {
    if (percent >= 97)
        return "HOT";
    if (percent >= 90)
        return "WARN";
    return "OK";
}
/** 滚动窗口（5h 这类会重置的）vs 长周期窗口（wk/mo，等不起） */
export function isRollingWindow(window) {
    return /h$/.test(window);
}
function remainingText(resetAt, now) {
    if (resetAt === undefined || resetAt <= now)
        return "";
    const minutes = Math.floor((resetAt - now) / 60000);
    const text = minutes < 60
        ? `${minutes}m`
        : minutes < 60 * 48
            ? `${Math.floor(minutes / 60)}h${minutes % 60 > 0 ? ` ${minutes % 60}m` : ""}`
            : `${Math.floor(minutes / 1440)}d`;
    return `（剩 ${text}）`;
}
/** quota_check 的可读输出：逐窗口水位行 + 机器可判的 verdict 行 */
export function formatQuotaCheckText(snapshot, now) {
    const lines = snapshot.windows.map((w) => {
        const level = quotaWindowLevel(w.percent);
        const reset = w.resetAt === undefined ? "" : ` 重置 ${new Date(w.resetAt).toLocaleString("zh-CN", { hour12: false })}`;
        return `${w.window}  ${Math.round(w.percent)}%${reset}${remainingText(w.resetAt, now)}  ${level}`;
    });
    const hot = snapshot.windows.filter((w) => quotaWindowLevel(w.percent) === "HOT");
    const warn = snapshot.windows.filter((w) => quotaWindowLevel(w.percent) === "WARN");
    const parts = [];
    if (hot.length > 0) {
        const rolling = hot.filter((w) => isRollingWindow(w.window)).map((w) => w.window);
        const fixed = hot.filter((w) => !isRollingWindow(w.window)).map((w) => w.window);
        if (rolling.length > 0)
            parts.push(`hot_rolling=${rolling.join(",")}`);
        if (fixed.length > 0)
            parts.push(`hot_fixed=${fixed.join(",")}`);
    }
    if (warn.length > 0)
        parts.push(`warn=${warn.map((w) => w.window).join(",")}`);
    const verdict = parts.length > 0 ? parts.join("; ") : "all_ok";
    return [...lines, `verdict: ${verdict}`].join("\n");
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
    const key = quotaNamespace(provider);
    fetchAndParseSnapshot(provider, auth, now)
        .then((snapshot) => {
        writeQuotaSnapshot({ ...snapshot, provider: key });
        recordLimitFacts(key, snapshot, now);
    }, (error) => {
        // 查询失败是事实：记一次过（同一 provider 每小时一条，避免 10min 轮询刷屏）
        appendAdaptiveEvent({
            kind: "provider_failure",
            ts: new Date(now).toISOString(),
            provider: key,
            detail: error instanceof Error ? error.message : String(error),
        }, `failure:${key}:${new Date(now).toISOString().slice(0, 13)}`);
    })
        .finally(() => {
        refreshInFlight = false;
    });
}
/** 窗口打满（≥90%）记一次事实，按窗口周期去重：配额紧张是历史，不只是当下快照。 */
function recordLimitFacts(provider, snapshot, now) {
    for (const window of snapshot.windows) {
        if (window.percent < 90)
            continue;
        appendAdaptiveEvent({
            kind: "provider_limit",
            ts: new Date(now).toISOString(),
            provider,
            window: window.window,
            percent: window.percent,
            ...(window.resetAt !== undefined ? { resetAt: window.resetAt } : {}),
        }, `limit:${provider}:${window.window}:${window.resetAt ?? ""}`);
    }
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
    // 模型侧额度查询：额度哨兵 skill 的数据出口（判定阈值内置于输出，模型只需按规则行动）
    pi.registerTool({
        name: "quota_check",
        label: "查询额度水位",
        description: "查询当前模型 provider 的 coding plan 额度水位（各窗口已用百分比、重置时间与等级）。"
            + "长任务开工前、批次完成后、或调用连续失败/限流时主动调用；输出含 verdict 行"
            + "（all_ok / warn=... / hot_rolling=... / hot_fixed=...），按额度哨兵技能的规则行动。",
        parameters: {
            type: "object",
            properties: {
                provider: { type: "string", description: "可选：指定 provider（缺省用当前模型）" },
            },
        },
        execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
            const provider = typeof params.provider === "string" && params.provider.trim() !== ""
                ? params.provider.trim()
                : ctx.model?.provider;
            if (!provider)
                return { details: {}, content: [{ type: "text", text: "无法确定 provider（当前无模型，也未传 provider 参数）" }] };
            if (!isSupportedProvider(provider)) {
                return { details: {}, content: [{ type: "text", text: `provider ${provider} 未提供公开用量查询（支持：${[...SUPPORTED_PROVIDERS].join("、")}）` }] };
            }
            const model = ctx.model !== undefined && ctx.model.provider === provider
                ? ctx.model
                : ctx.modelRegistry.getAll().find((m) => m.provider === provider);
            if (!model)
                return { details: {}, content: [{ type: "text", text: `provider ${provider} 在可用模型列表中不存在` }] };
            const auth = await Effect.runPromise(resolveAuthEffectForTool(ctx, model));
            if (!auth)
                return { details: {}, content: [{ type: "text", text: `未找到 ${provider} 的凭证，请先 /login` }] };
            try {
                const snapshot = await fetchAndParseSnapshot(provider, auth, Date.now());
                writeQuotaSnapshot({ ...snapshot, provider: quotaNamespace(provider) });
                return { details: {}, content: [{ type: "text", text: formatQuotaCheckText(snapshot, Date.now()) }] };
            }
            catch (error) {
                return { details: {}, content: [{ type: "text", text: `额度查询失败：${error instanceof Error ? error.message : String(error)}` }] };
            }
        },
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
