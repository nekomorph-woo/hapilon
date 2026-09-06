import type { EffectMode } from "./policy.js";

let policySection: string | undefined;
let policyMode: EffectMode | undefined;

/** 由 system-prompt 拼装时读取；undefined 表示不注入。 */
export function getPolicySection(): string | undefined {
  return policySection;
}

/** 由 effect-policy 每轮裁决后写入。 */
export function setPolicySection(text: string | undefined, mode?: EffectMode): void {
  policySection = text;
  policyMode = mode;
}

/** hpl-context 查询当前会话 policy mode；未计算或异常时不注入 skill。 */
export function getEffectPolicyMode(): EffectMode | undefined {
  return policyMode;
}

/** 测试隔离用。 */
export function resetPolicySection(): void {
  policySection = undefined;
  policyMode = undefined;
}
