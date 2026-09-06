/**
 * Effect-aware coding policy 的纯决策层。
 *
 * 本模块只消费已收集的项目事实，不执行 I/O，也不依赖运行时模块。
 */
export function decideEffectMode(signals) {
    if (signals.language !== "typescript")
        return "disabled";
    if (signals.effectInstalled || signals.effectImportsFound)
        return "required";
    if (signals.hasHapilonMd)
        return "respect-project";
    if (signals.isGreenfield)
        return "prefer";
    return "respect-project";
}
