import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";

export const MODEL_TIERS = ["opus", "sonnet", "haiku"] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];
export type TierModels = Record<ModelTier, string[]>;

/** 解析后的档位模型条目：recap / safety-gate / orchestra / tier-router 共用的最小形状。 */
export interface ResolvedTierModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

export type ResolvedTierModels = Record<ModelTier, ResolvedTierModel[]>;

const EMPTY_RESOLVED: ResolvedTierModels = { opus: [], sonnet: [], haiku: [] };

function parseModelList(value: unknown): ResolvedTierModel[] {
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

/** 唯一的 model-tiers-resolved.json 读取实现：损坏条目忽略，读取失败降为空档。 */
export const readResolvedTiersEffect: Effect.Effect<ResolvedTierModels, never> = Effect.try({
  try: () => {
    const path = join(hapilonHome(), "model-tiers-resolved.json");
    if (!existsSync(path)) return { ...EMPTY_RESOLVED };
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...EMPTY_RESOLVED };
    const raw = parsed as Record<string, unknown>;
    const opus = parseModelList(raw.opus);
    const sonnet = parseModelList(raw.sonnet);
    const haiku = parseModelList(raw.haiku);
    return { opus, sonnet, haiku };
  },
  catch: (error) => error,
}).pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-recap] resolved tiers 读取失败，按空档降级：${String(error)}`);
    return { ...EMPTY_RESOLVED };
  })),
);
