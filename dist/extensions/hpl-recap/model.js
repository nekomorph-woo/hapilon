/**
 * 从 hpl-model-tiers 复制的无状态 glob 语义；两处实现需同步维护。
 * 这里保留给 recap 的模型/配置测试与后续动态 pattern 使用，不依赖另一扩展实例。
 */
export function matchesModelPattern(pattern, model) {
    let source = "^";
    for (let index = 0; index < pattern.length; index++) {
        const char = pattern[index];
        if (char === "*" && pattern[index + 1] === "*") {
            source += ".*";
            index++;
        }
        else if (char === "*")
            source += "[^/]*";
        else if (char === "?")
            source += "[^/]";
        else
            source += char.replace(/[\\^$+{}.[\]()`|]/g, "\\$&");
    }
    const candidate = pattern.includes("/") ? `${model.provider}/${model.id}` : model.id;
    return new RegExp(`${source}$`, "i").test(candidate);
}
function firstResolved(refs, available) {
    for (const ref of refs) {
        const model = available.find((candidate) => candidate.provider === ref.provider && candidate.id === ref.id);
        if (model)
            return model;
    }
    return undefined;
}
function resolvedMidCandidates(refs, available) {
    return refs.flatMap((ref) => {
        const model = available.find((candidate) => candidate.provider === ref.provider && candidate.id === ref.id);
        return model ? [{ model, reasoning: model.reasoning ?? ref.reasoning }] : [];
    });
}
/** resolved 文件中的 low → mid 非推理 → mid 任意 → 当前模型；从不修改当前 session model。 */
export function selectRecapModel(available, currentModel, resolvedTiers) {
    const low = firstResolved(resolvedTiers.low, available);
    if (low)
        return { model: low, degraded: false };
    const midMatches = resolvedMidCandidates(resolvedTiers.mid, available);
    const mid = midMatches.find((candidate) => candidate.reasoning === false)?.model ?? midMatches[0]?.model;
    if (mid) {
        return { model: mid, degraded: true, reason: "recap 模型降级：low 档无可用模型" };
    }
    if (currentModel) {
        return {
            model: currentModel,
            degraded: true,
            reason: "recap 模型降级：low 档无可用模型",
        };
    }
    return {
        degraded: true,
        reason: "recap 模型降级：low 档无可用模型；当前模型也不可用",
    };
}
export function recapModelLabel(model) {
    return model.name?.trim() || `${model.provider}/${model.id}`;
}
