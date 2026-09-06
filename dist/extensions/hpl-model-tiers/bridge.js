export const MODEL_TIERS = ["high", "mid", "low"];
const emptyTiers = () => ({ high: [], mid: [], low: [] });
let tierModels = emptyTiers();
/** 返回当前会话解析出的 tier pattern；返回副本，避免调用方污染 bridge。 */
export function getTierModels(tier) {
    return [...tierModels[tier]];
}
/** 由 hpl-model-tiers 写入，供后续 hpl-recap 消费。 */
export function setTierModels(next) {
    tierModels = {
        high: [...next.high],
        mid: [...next.mid],
        low: [...next.low],
    };
}
/** 测试隔离及异常降级用。 */
export function resetTierModels() {
    tierModels = emptyTiers();
}
