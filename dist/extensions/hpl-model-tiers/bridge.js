export const MODEL_TIERS = ["opus", "sonnet", "haiku"];
const emptyTiers = () => ({ opus: [], sonnet: [], haiku: [] });
let tierModels = emptyTiers();
/** 返回当前会话解析出的 tier pattern；返回副本，避免调用方污染 bridge。 */
export function getTierModels(tier) {
    return [...tierModels[tier]];
}
/** 由 hpl-model-tiers 写入，供后续 hpl-recap 消费。 */
export function setTierModels(next) {
    tierModels = {
        opus: [...next.opus],
        sonnet: [...next.sonnet],
        haiku: [...next.haiku],
    };
}
/** 测试隔离及异常降级用。 */
export function resetTierModels() {
    tierModels = emptyTiers();
}
