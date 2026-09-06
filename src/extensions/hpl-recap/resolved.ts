import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import type { RecapModelShape, ResolvedTierModels } from "./model.js";

const EMPTY_RESOLVED: ResolvedTierModels = { high: [], mid: [], low: [] };

function parseModelList(value: unknown): RecapModelShape[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    if (typeof raw.provider !== "string" || typeof raw.id !== "string") return [];
    return [{
      provider: raw.provider,
      id: raw.id,
      ...(typeof raw.name === "string" ? { name: raw.name } : {}),
      ...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
    }];
  });
}

export const readResolvedTiersEffect: Effect.Effect<ResolvedTierModels, never> = Effect.try({
  try: () => {
    const path = join(hapilonHome(), "model-tiers-resolved.json");
    if (!existsSync(path)) return { ...EMPTY_RESOLVED };
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...EMPTY_RESOLVED };
    const raw = parsed as Record<string, unknown>;
    return {
      high: parseModelList(raw.high),
      mid: parseModelList(raw.mid),
      low: parseModelList(raw.low),
    };
  },
  catch: (error) => error,
}).pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-recap] resolved tiers 读取失败，按空档降级：${String(error)}`);
    return { ...EMPTY_RESOLVED };
  })),
);
