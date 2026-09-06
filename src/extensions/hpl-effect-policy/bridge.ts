let policySection: string | undefined;

/** 由 system-prompt 拼装时读取；undefined 表示不注入。 */
export function getPolicySection(): string | undefined {
  return policySection;
}

/** 由 effect-policy 每轮裁决后写入。 */
export function setPolicySection(text: string | undefined): void {
  policySection = text;
}

/** 测试隔离用。 */
export function resetPolicySection(): void {
  policySection = undefined;
}
