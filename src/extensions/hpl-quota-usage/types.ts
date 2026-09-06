import type { ProviderHeaders } from "@earendil-works/pi-ai";

export type QuotaTone = "text" | "warning" | "error";

export interface QuotaField {
  label: string;
  value: string;
  tone?: QuotaTone;
}

export interface QuotaAuth {
  apiKey?: string;
  headers?: ProviderHeaders;
}

export interface QuotaResult {
  fields: QuotaField[];
}

export const UNKNOWN = "unknown";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function valueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return UNKNOWN;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return UNKNOWN;
}

export function field(label: string, value: unknown, tone?: QuotaTone): QuotaField {
  const text = valueText(value);
  return { label, value: text, ...(tone ? { tone } : {}) };
}

export function unknownField(label: string): QuotaField {
  return field(label, UNKNOWN, "warning");
}

export function firstValue(record: Record<string, unknown> | undefined, keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}
