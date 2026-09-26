import { Effect } from "effect";
import { fetchJsonEffect } from "./common.js";
import { asRecord, field, unknownField, type QuotaAuth, type QuotaField } from "../types.js";
import type { QuotaSnapshot } from "../snapshot.js";

export const XAI_BILLING_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

export function fetchQuotaEffect(auth: QuotaAuth): Effect.Effect<unknown, Error> {
  return fetchJsonEffect(XAI_BILLING_ENDPOINT, auth);
}

function usagePercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function periodEnd(config: Record<string, unknown> | undefined, currentPeriod: Record<string, unknown> | undefined): unknown {
  return config?.billingPeriodEnd ?? currentPeriod?.end;
}

function formatPeriodEnd(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}

function periodWindow(currentPeriod: Record<string, unknown> | undefined): string {
  return currentPeriod?.type === "USAGE_PERIOD_TYPE_MONTHLY" ? "mo" : "wk";
}

export function parseQuotaLines(payload: unknown): QuotaField[] {
  const root = asRecord(payload);
  const config = asRecord(root?.config);
  const currentPeriod = asRecord(config?.currentPeriod);
  const percent = usagePercent(config?.creditUsagePercent);
  const end = formatPeriodEnd(periodEnd(config, currentPeriod));
  const fields: QuotaField[] = [
    percent === undefined
      ? unknownField("周用量")
      : field("周用量", `${percent}%`, percent >= 90 ? "warning" : undefined),
    end === undefined ? unknownField("周期结束") : field("周期结束", end),
  ];

  const products = Array.isArray(config?.productUsage) ? config.productUsage : [];
  if (products.length === 0) fields.push(unknownField("产品用量"));
  for (const item of products) {
    const product = asRecord(item);
    const label = `${typeof product?.product === "string" ? product.product : "unknown"} 用量`;
    const productPercent = usagePercent(product?.usagePercent);
    fields.push(productPercent === undefined
      ? unknownField(label)
      : field(label, `${productPercent}%`));
  }

  const prepaidBalance = asRecord(config?.prepaidBalance);
  if (prepaidBalance?.val !== undefined && prepaidBalance.val !== null) {
    fields.push(field("预付余额", prepaidBalance.val));
  }
  return fields;
}

export function parseSnapshot(payload: unknown, now: number): QuotaSnapshot {
  const root = asRecord(payload);
  const config = asRecord(root?.config);
  const currentPeriod = asRecord(config?.currentPeriod);
  const percent = usagePercent(config?.creditUsagePercent);
  if (percent === undefined) return { provider: "xai", windows: [], timestamp: now };

  const end = periodEnd(config, currentPeriod);
  const resetAt = typeof end === "string" ? Date.parse(end) : NaN;
  return {
    provider: "xai",
    windows: [{
      window: periodWindow(currentPeriod),
      percent,
      resetAt: Number.isNaN(resetAt) ? undefined : resetAt,
    }],
    timestamp: now,
  };
}
