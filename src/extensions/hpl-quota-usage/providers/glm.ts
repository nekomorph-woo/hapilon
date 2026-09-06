import { Effect } from "effect";
import { fetchJsonEffect } from "./common.js";
import { asRecord, field, unknownField, type QuotaAuth, type QuotaField } from "../types.js";
import type { QuotaSnapshot, QuotaWindowSnapshot } from "../snapshot.js";

// GLM Coding Plan 官方用量端点（zai-org/zai-coding-plugins query-usage.mjs 同源），
// 国内（open.bigmodel.cn）与国际（api.z.ai）路径一致。
export const GLM_QUOTA_ENDPOINT_CN = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
export const GLM_QUOTA_ENDPOINT_INTL = "https://api.z.ai/api/monitor/usage/quota/limit";
/** 向后兼容的默认 endpoint：GLM 中国区。 */
export const GLM_QUOTA_ENDPOINT = GLM_QUOTA_ENDPOINT_CN;

export function fetchQuotaEffect(
  auth: QuotaAuth,
  endpoint = GLM_QUOTA_ENDPOINT_CN,
): Effect.Effect<unknown, Error> {
  return fetchJsonEffect(endpoint, auth);
}

function resetTimeText(value: unknown): string | undefined {
  const ms = typeof value === "string" ? Number(value) : value;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return undefined;
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function limitLabel(limit: Record<string, unknown>, ordinal: number): string {
  if (limit.type === "TIME_LIMIT") return "MCP 工具月用量";
  if (limit.type === "TOKENS_LIMIT" && limit.unit === 3) {
    return `Token 用量（${typeof limit.number === "number" ? limit.number : "?"} 小时窗口）`;
  }
  return `Token 用量（周窗口）`;
}

export function parseQuotaLines(payload: unknown): QuotaField[] {
  const root = asRecord(payload);
  const code = root?.code;
  if (code !== undefined && code !== 200) {
    const msg = typeof root?.msg === "string" ? `：${root.msg.slice(0, 80)}` : "";
    return [field("状态", `接口返回 code ${String(code)}${msg}`, "error")];
  }

  const data = asRecord(root?.data) ?? root;
  const limits = Array.isArray(data?.limits) ? data.limits : [];

  const rows: QuotaField[] = [];
  let unnamedTokens = 0;
  for (const entry of limits) {
    const limit = asRecord(entry);
    if (!limit) continue;
    if (limit.type === "TIME_LIMIT") {
      rows.push(mcpRow(limit));
      continue;
    }

    const percentage = typeof limit.percentage === "number" ? limit.percentage : undefined;
    const parts = [`已用 ${percentage !== undefined ? `${percentage}%` : "unknown"}`];
    const hours = typeof limit.number === "number" && limit.unit === 3 ? limit.number : undefined;
    if (hours !== undefined) parts.push(`每 ${hours} 小时重置`);
    const reset = resetTimeText(limit.nextResetTime);
    if (reset) parts.push(`重置于 ${reset}`);

    rows.push(field(limitLabel(limit, unnamedTokens), parts.join(" · "),
      percentage !== undefined && percentage >= 90 ? "warning" : undefined,
    ));
  }

  if (rows.length === 0) {
    return [unknownField("限额数据")];
  }
  return rows;
}

function mcpRow(limit: Record<string, unknown>): QuotaField {
  const percentage = typeof limit.percentage === "number" ? limit.percentage : undefined;
  const usage = typeof limit.usage === "number" ? limit.usage : undefined;
  const current = limit.currentValue !== undefined ? String(limit.currentValue) : undefined;
  const parts: string[] = [
    percentage !== undefined ? `已用 ${percentage}%` : "已用 unknown",
    current !== undefined && usage !== undefined ? `${current}/${usage} 次调用` : current !== undefined ? `已调用 ${current} 次` : "",
  ].filter(Boolean);
  const reset = resetTimeText(limit.nextResetTime);
  if (reset) parts.push(`重置于 ${reset}`);
  const details = Array.isArray(limit.usageDetails) ? limit.usageDetails : [];
  const top = details
    .map(asRecord)
    .filter((d): d is Record<string, unknown> => d !== undefined)
    .sort((a, b) => (typeof b.usage === "number" ? b.usage : 0) - (typeof a.usage === "number" ? a.usage : 0))
    .slice(0, 3)
    .map((d) => `${String(d.modelCode ?? "?")} ${d.usage ?? "?"}`);
  if (top.length > 0) parts.push(`Top: ${top.join(" / ")}`);
  return field("MCP 工具月用量", parts.join(" · "), percentage !== undefined && percentage >= 90 ? "warning" : undefined);
}

export const parseGlmQuota = parseQuotaLines;

/** unit: 3=小时窗（number=小时数）、6=周窗（官方 7-day cycle）；TIME_LIMIT=MCP 月用量 */
function windowTag(limit: Record<string, unknown>): string | undefined {
  if (limit.type === "TIME_LIMIT") return undefined;
  if (limit.type === "TOKENS_LIMIT" && limit.unit === 3) {
    return typeof limit.number === "number" ? `${limit.number}h` : "5h";
  }
  if (limit.type === "TOKENS_LIMIT") return "wk";
  return undefined;
}

export function parseSnapshot(payload: unknown, now: number): QuotaSnapshot {
  const root = asRecord(payload);
  const data = asRecord(root?.data) ?? root;
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const windows: QuotaWindowSnapshot[] = [];
  for (const entry of limits) {
    const limit = asRecord(entry);
    const tag = limit ? windowTag(limit) : undefined;
    if (!limit || tag === undefined || typeof limit.percentage !== "number") continue;
    const resetAt = typeof limit.nextResetTime === "number" ? limit.nextResetTime : undefined;
    windows.push({ window: tag, percent: limit.percentage, resetAt });
  }
  return { provider: "glm", windows, timestamp: now };
}
