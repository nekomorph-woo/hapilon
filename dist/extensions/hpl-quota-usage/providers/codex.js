import { fetchJsonEffect } from "./common.js";
import { asRecord, field, firstValue, unknownField, UNKNOWN } from "../types.js";
export const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
function extractAccountId(token) {
    if (!token)
        return undefined;
    try {
        const part = token.split(".")[1];
        if (!part)
            return undefined;
        const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
        const claims = asRecord(payload);
        const auth = asRecord(claims?.["https://api.openai.com/auth"]);
        return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
    }
    catch {
        return undefined;
    }
}
function codexHeaders(auth) {
    const accountHeader = Object.keys(auth.headers ?? {}).find((key) => key.toLowerCase() === "chatgpt-account-id");
    const existingAccountId = accountHeader ? auth.headers?.[accountHeader] ?? undefined : undefined;
    const accountId = existingAccountId || extractAccountId(auth.apiKey);
    return accountId ? { "ChatGPT-Account-Id": accountId } : {};
}
export function fetchQuotaEffect(auth) {
    return fetchJsonEffect(CODEX_USAGE_ENDPOINT, auth, codexHeaders(auth));
}
function windowFields(label, window) {
    const used = firstValue(window, ["used_percent", "usedPercent", "usage_percent", "usagePercent"]);
    const reset = firstValue(window, ["reset_at", "resetAt", "reset_time", "resetTime"]);
    const duration = firstValue(window, ["limit_window_seconds", "limitWindowSeconds", "window_seconds"]);
    const rows = [
        used === undefined ? unknownField(`${label}已使用`) : field(`${label}已使用`, `${String(used)}%`),
        reset === undefined ? unknownField(`${label}重置时间`) : field(`${label}重置时间`, formatResetTime(reset)),
        duration === undefined ? unknownField(`${label}窗口`) : field(`${label}窗口`, formatDuration(duration)),
    ];
    return rows;
}
function formatResetTime(value) {
    const n = typeof value === "string" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0)
        return UNKNOWN;
    const ms = n > 1e12 ? n : n * 1000;
    const date = new Date(ms);
    const pad = (x) => String(x).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function formatDuration(value) {
    const n = typeof value === "string" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0)
        return UNKNOWN;
    if (n % 86400 === 0)
        return `${n / 86400} 天`;
    if (n % 3600 === 0)
        return `${n / 3600} 小时`;
    return `${Math.round(n / 60)} 分钟`;
}
export function parseQuotaLines(payload) {
    const root = asRecord(payload);
    const rateLimit = asRecord(root?.rate_limit) ?? asRecord(root?.rateLimit);
    const credits = asRecord(root?.credits);
    const fields = [
        field("订阅计划", firstValue(root, ["plan_type", "planType", "plan"])),
        ...windowFields("5 小时窗口", asRecord(rateLimit?.primary_window) ?? asRecord(rateLimit?.primaryWindow)),
        ...windowFields("每周窗口", asRecord(rateLimit?.secondary_window) ?? asRecord(rateLimit?.secondaryWindow)),
        field("额度余额", firstValue(credits, ["balance", "remaining", "credits"])),
        field("无限额度", firstValue(credits, ["unlimited"])),
    ];
    const modelUsage = asRecord(root?.model_usage) ?? asRecord(root?.modelUsage);
    if (modelUsage) {
        for (const [model, state] of Object.entries(modelUsage)) {
            const record = asRecord(state);
            if (record?.available === false) {
                fields.push(field(`模型 ${model}`, "当前不可用", "warning"));
            }
        }
    }
    return fields;
}
export const parseCodexQuota = parseQuotaLines;
export function parseSnapshot(payload, now) {
    const root = asRecord(payload);
    const rateLimit = asRecord(root?.rate_limit) ?? asRecord(root?.rateLimit);
    const windows = [];
    const specs = [
        ["5h", asRecord(rateLimit?.primary_window) ?? asRecord(rateLimit?.primaryWindow)],
        ["wk", asRecord(rateLimit?.secondary_window) ?? asRecord(rateLimit?.secondaryWindow)],
    ];
    for (const [tag, window] of specs) {
        const percent = firstValue(window, ["used_percent", "usedPercent", "usage_percent"]);
        if (typeof percent !== "number")
            continue;
        const resetAtRaw = firstValue(window, ["reset_at", "resetAt"]);
        const resetAt = typeof resetAtRaw === "number" && resetAtRaw > 1e12 ? resetAtRaw : typeof resetAtRaw === "number" ? resetAtRaw * 1000 : undefined;
        windows.push({ window: tag, percent, resetAt });
    }
    return { provider: "openai-codex", windows, timestamp: now };
}
