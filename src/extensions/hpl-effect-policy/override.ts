import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import { inspectProjectEffect } from "./inspector.js";
import { decideEffectMode, type EffectMode } from "./policy.js";

const MODES: readonly EffectMode[] = ["disabled", "respect-project", "prefer", "required"];

function isEffectMode(value: unknown): value is EffectMode {
  return typeof value === "string" && MODES.includes(value as EffectMode);
}

/** 读取单层覆盖；不存在返回 undefined，非法值 warning 后也交由上层继续裁决。 */
const readOverrideFileEffect = (filePath: string): Effect.Effect<EffectMode | undefined, never> =>
  Effect.sync(() => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (err) {
      // 不存在是正常态；其余读取/JSON 错误需要让用户知道，但不阻断裁决链。
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      console.warn(`Warning: 无法读取 Effect policy override（${filePath}）：${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }

    const value = raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).mode
      : undefined;
    if (isEffectMode(value)) return value;

    console.warn(`Warning: Effect policy override 无效（${filePath}）：mode=${JSON.stringify(value)}，跳过该级`);
    return undefined;
  });

/** 项目级优先，其次全局级；非法项目级不会阻断全局级。 */
export const readPolicyOverrideEffect = (
  projectCwd: string,
): Effect.Effect<EffectMode | undefined, never> => Effect.sync(() => {
  try {
    const projectPath = join(projectCwd, ".hapilon", "effect-policy.json");
    const project = Effect.runSync(readOverrideFileEffect(projectPath));
    if (project !== undefined) return project;

    // 全局 home 必须复用 A 层单一解析来源，不在此重复展开环境变量或 ~。
    const globalPath = join(hapilonHome(), "effect-policy.json");
    return Effect.runSync(readOverrideFileEffect(globalPath));
  } catch (err) {
    console.warn(`Warning: 无法读取 Effect policy override：${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
});

export const resolveEffectModeEffect = (
  projectCwd: string,
): Effect.Effect<EffectMode, never> => Effect.gen(function* () {
  const override = yield* readPolicyOverrideEffect(projectCwd);
  if (override !== undefined) return override;
  const signals = yield* inspectProjectEffect(projectCwd);
  return decideEffectMode(signals);
});

export function readPolicyOverride(projectCwd: string): EffectMode | undefined {
  return Effect.runSync(readPolicyOverrideEffect(projectCwd));
}

export function resolveEffectMode(projectCwd: string): EffectMode {
  return Effect.runSync(resolveEffectModeEffect(projectCwd));
}
