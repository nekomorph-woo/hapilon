import { fetchJsonEffect } from "./common.js";
import { asRecord, field, firstValue, unknownField } from "../types.js";
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
    return [
        used === undefined ? unknownField(`${label}已使用`) : field(`${label}已使用`, `${String(used)}%`),
        reset === undefined ? unknownField(`${label}重置时间`) : field(`${label}重置时间`, reset),
        duration === undefined ? unknownField(`${label}窗口秒数`) : field(`${label}窗口秒数`, duration),
    ];
}
export function parseQuotaLines(payload) {
    const root = asRecord(payload);
    const rateLimit = asRecord(root?.rate_limit) ?? asRecord(root?.rateLimit);
    const credits = asRecord(root?.credits);
    const fields = [
        field("计划", firstValue(root, ["plan_type", "planType", "plan"])),
        ...windowFields("主窗口", asRecord(rateLimit?.primary_window) ?? asRecord(rateLimit?.primaryWindow)),
        ...windowFields("次窗口", asRecord(rateLimit?.secondary_window) ?? asRecord(rateLimit?.secondaryWindow)),
        field("额度余额", firstValue(credits, ["balance", "remaining", "credits"])),
        field("无限额度", firstValue(credits, ["unlimited"])),
    ];
    return fields;
}
export const parseCodexQuota = parseQuotaLines;
