import { fetchJsonEffect } from "./common.js";
import { asRecord, field, firstValue, unknownField } from "../types.js";
export const GLM_QUOTA_ENDPOINT_CN = "https://open.bigmodel.cn/api/monitor/usage/quota";
export const GLM_QUOTA_ENDPOINT_INTL = "https://api.z.ai/api/monitor/usage/quota";
/** 向后兼容的默认 endpoint：GLM 中国区。 */
export const GLM_QUOTA_ENDPOINT = GLM_QUOTA_ENDPOINT_CN;
export function fetchQuotaEffect(auth, endpoint = GLM_QUOTA_ENDPOINT_CN) {
    return fetchJsonEffect(endpoint, auth);
}
export function parseQuotaLines(payload) {
    const root = asRecord(payload);
    const data = asRecord(root?.data) ?? root;
    const quotaObject = asRecord(data?.quota);
    const sources = [data, quotaObject];
    const pick = (keys) => {
        for (const source of sources) {
            const value = firstValue(source, keys);
            if (value !== undefined)
                return value;
        }
        return undefined;
    };
    const fields = [
        field("计划", pick(["planName", "plan_name", "plan", "planType"])),
        field("总额度", pick(["totalQuota", "total_quota", "totalToken", "total_token", "quota", "limit"])),
        field("已使用", pick(["usedQuota", "used_quota", "usedToken", "used_token", "usage", "used"])),
        field("剩余额度", pick(["remainingQuota", "remaining_quota", "remainQuota", "remain_quota", "remainToken", "remain_token", "remaining"])),
        field("续期时间", pick(["renewalTime", "renewal_time", "resetTime", "reset_time", "expireTime", "expire_time"])),
    ];
    return fields.map((item) => item.value === "unknown" ? unknownField(item.label) : item);
}
export const parseGlmQuota = parseQuotaLines;
