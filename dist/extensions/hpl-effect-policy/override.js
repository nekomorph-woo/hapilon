import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import { inspectProjectEffect } from "./inspector.js";
import { decideEffectMode } from "./policy.js";
const MODES = ["disabled", "respect-project", "prefer", "required"];
function isEffectMode(value) {
    return typeof value === "string" && MODES.includes(value);
}
/** 读取单层覆盖；不存在返回 undefined，非法值 warning 后也交由上层继续裁决。 */
const readOverrideFileEffect = (filePath) => Effect.sync(() => {
    let raw;
    try {
        raw = JSON.parse(readFileSync(filePath, "utf8"));
    }
    catch (err) {
        // 不存在是正常态；其余读取/JSON 错误需要让用户知道，但不阻断裁决链。
        if (err?.code === "ENOENT")
            return undefined;
        console.warn(`Warning: 无法读取 Effect policy override（${filePath}）：${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
    const value = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw.mode
        : undefined;
    if (isEffectMode(value))
        return value;
    console.warn(`Warning: Effect policy override 无效（${filePath}）：mode=${JSON.stringify(value)}，跳过该级`);
    return undefined;
});
/** 项目级优先，其次全局级；非法项目级不会阻断全局级。 */
export const readPolicyOverrideEffect = (projectCwd) => Effect.sync(() => {
    try {
        const projectPath = join(projectCwd, ".hapilon", "effect-policy.json");
        const project = Effect.runSync(readOverrideFileEffect(projectPath));
        if (project !== undefined)
            return project;
        // 全局 home 必须复用 A 层单一解析来源，不在此重复展开环境变量或 ~。
        const globalPath = join(hapilonHome(), "effect-policy.json");
        return Effect.runSync(readOverrideFileEffect(globalPath));
    }
    catch (err) {
        console.warn(`Warning: 无法读取 Effect policy override：${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
});
export const resolveEffectModeEffect = (projectCwd) => Effect.gen(function* () {
    const override = yield* readPolicyOverrideEffect(projectCwd);
    if (override !== undefined)
        return override;
    const signals = yield* inspectProjectEffect(projectCwd);
    return decideEffectMode(signals);
});
/** 一次 inspector 扫描同时返回裁决结果与扫描事实，供 prompt 注入使用。 */
export const resolveWithSignalsEffect = (projectCwd) => Effect.gen(function* () {
    const signals = yield* inspectProjectEffect(projectCwd);
    const override = yield* readPolicyOverrideEffect(projectCwd);
    return {
        mode: override ?? decideEffectMode(signals),
        signals,
    };
});
export function readPolicyOverride(projectCwd) {
    return Effect.runSync(readPolicyOverrideEffect(projectCwd));
}
export function resolveEffectMode(projectCwd) {
    return Effect.runSync(resolveEffectModeEffect(projectCwd));
}
