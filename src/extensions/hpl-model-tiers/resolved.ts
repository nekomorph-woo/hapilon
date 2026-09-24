import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";

export const MODEL_TIERS = ["opus", "sonnet", "haiku"] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];
export type TierModels = Record<ModelTier, string[]>;

/** 与 pi 内核 ThinkingLevel 对齐的档位名全集。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export const isThinkingLevel = (value: unknown): value is ThinkingLevelName =>
  typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);

/**
 * 剥离模式串尾部的 :thinking 后缀（与 pi parseModelPattern 同语义：仅当后缀是
 * 合法档位名时剥离；非法后缀视为模式本身的一部分）。返回裸模式与档位。
 */
export function splitThinkingSuffix(pattern: string): { pattern: string; thinking?: ThinkingLevelName } {
  const colon = pattern.lastIndexOf(":");
  if (colon <= 0 || colon === pattern.length - 1) return { pattern };
  const suffix = pattern.slice(colon + 1);
  if (isThinkingLevel(suffix)) {
    return { pattern: pattern.slice(0, colon), thinking: suffix };
  }
  return { pattern };
}

/** 解析后的档位模型条目：recap / safety-gate / orchestra / tier-router 共用的最小形状。 */
export interface ResolvedTierModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  /** 该档位条目显式指定的 thinking level（来自模式串的 :level 后缀）。 */
  thinking?: ThinkingLevelName;
  /**
   * 产生该模型的档位条目序号：一个 glob/模式条目展开出的多个模型共享同一序号。
   * 配置顺序的判据是条目序号，不是展开后的位置——同一条目内的兄弟模型才算“同位”。
   */
  group?: number;
}

export type ResolvedTierModels = Record<ModelTier, ResolvedTierModel[]>;

/** `tier:<name>[<index>]` 模型指代；index 缺省为 0。非法格式返回 undefined。 */
export function parseTierReference(spec: string): { tier: ModelTier; index: number } | undefined {
  const matched = /^tier:(opus|sonnet|haiku)(?:\[(\d+)\])?$/.exec(spec.trim());
  if (!matched) return undefined;
  return { tier: matched[1] as ModelTier, index: matched[2] === undefined ? 0 : Number(matched[2]) };
}

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
      ...(isThinkingLevel(raw.thinking) ? { thinking: raw.thinking } : {}),
      ...(typeof raw.group === "number" && Number.isInteger(raw.group) && raw.group >= 0
        ? { group: raw.group }
        : {}),
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
