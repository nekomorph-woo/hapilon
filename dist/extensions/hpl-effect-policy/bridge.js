let policySection;
let policyMode;
/** 由 system-prompt 拼装时读取；undefined 表示不注入。 */
export function getPolicySection() {
    return policySection;
}
/** 由 effect-policy 每轮裁决后写入。 */
export function setPolicySection(text, mode) {
    policySection = text;
    policyMode = mode;
}
/** hpl-context 查询当前会话 policy mode；未计算或异常时不注入 skill。 */
export function getEffectPolicyMode() {
    return policyMode;
}
/** 测试隔离用。 */
export function resetPolicySection() {
    policySection = undefined;
    policyMode = undefined;
}
