/**
 * Effect-aware coding policy 的纯决策层。
 *
 * 本模块只消费已收集的项目事实，不执行 I/O，也不依赖运行时模块。
 */

export type EffectMode =
  | "disabled"
  | "respect-project"
  | "prefer"
  | "required";

export interface ProjectSignals {
  readonly language: "typescript" | "javascript" | "other";
  readonly effectInstalled: boolean;
  readonly effectImportsFound: boolean;
  readonly packageManager: "npm" | "pnpm" | "yarn" | "bun" | undefined;
  readonly hasAgentsMd: boolean;
  readonly isGreenfield: boolean;
  readonly isScriptTask: boolean;
}

export function decideEffectMode(signals: ProjectSignals): EffectMode {
  if (signals.language !== "typescript") return "disabled";
  if (signals.effectInstalled || signals.effectImportsFound) return "required";
  if (signals.hasAgentsMd) return "respect-project";
  if (signals.isGreenfield) return "prefer";
  return "respect-project";
}
