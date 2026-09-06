let policySection;
/** 由 system-prompt 拼装时读取；undefined 表示不注入。 */
export function getPolicySection() {
    return policySection;
}
/** 由 effect-policy 每轮裁决后写入。 */
export function setPolicySection(text) {
    policySection = text;
}
/** 测试隔离用。 */
export function resetPolicySection() {
    policySection = undefined;
}
