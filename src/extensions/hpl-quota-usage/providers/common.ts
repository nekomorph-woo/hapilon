import { Effect } from "effect";
import type { QuotaAuth } from "../types.js";

const hasHeader = (headers: Record<string, string>, name: string): boolean =>
  Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());

export function buildAuthHeaders(auth: QuotaAuth): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  for (const [key, value] of Object.entries(auth.headers ?? {})) {
    if (typeof value === "string" && value.length > 0) headers[key] = value;
  }
  if (auth.apiKey && !hasHeader(headers, "authorization")) {
    headers.Authorization = `Bearer ${auth.apiKey}`;
  }
  return headers;
}

export function fetchJsonEffect(
  endpoint: string,
  auth: QuotaAuth,
  headers: Record<string, string> = {},
): Effect.Effect<unknown, Error> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: { ...buildAuthHeaders(auth), ...headers },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as unknown;
    },
    catch: (error) => error instanceof Error ? error : new Error(String(error)),
  });
}
