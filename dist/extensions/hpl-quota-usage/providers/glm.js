import { fetchJsonEffect } from "./common.js";
import { asRecord, field, firstValue, unknownField } from "../types.js";
export const GLM_QUOTA_ENDPOINT = "https://open.bigmodel.cn/api/monitor/usage/quota";
export function fetchQuotaEffect(auth) {
    return fetchJsonEffect(GLM_QUOTA_ENDPOINT, auth);
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
