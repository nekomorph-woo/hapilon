export const MODEL_TIERS = ["high", "mid", "low"] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];
export type TierModels = Record<ModelTier, string[]>;

const emptyTiers = (): TierModels => ({ high: [], mid: [], low: [] });

let tierModels: TierModels = emptyTiers();

/** 返回当前会话解析出的 tier pattern；返回副本，避免调用方污染 bridge。 */
export function getTierModels(tier: ModelTier): string[] {
  return [...tierModels[tier]];
}

/** 由 hpl-model-tiers 写入，供后续 hpl-recap 消费。 */
export function setTierModels(next: TierModels): void {
  tierModels = {
    high: [...next.high],
    mid: [...next.mid],
    low: [...next.low],
  };
}

/** 测试隔离及异常降级用。 */
export function resetTierModels(): void {
  tierModels = emptyTiers();
}
