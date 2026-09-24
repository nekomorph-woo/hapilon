/**
 * adaptive.ts — tier 自适应选模的运行时装配
 *
 * 开关走 gate-auto 同款模式：settings.json `tierAdaptive.enabled`（读写都不动别的键）
 * + `/tier-adaptive-mode` 的本会话覆盖。候选来自 model-tiers-resolved.json（配置顺序
 * 与 thinking 的唯一权威），配额来自 quota 快照，证据来自事件日志派生的画像。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { agentDir } from "../../config/hapilon-home.js";
import { readQuotaSnapshots } from "../hpl-quota-usage/cache.js";
import { quotaNamespace, snapshotHot } from "../hpl-quota-usage/snapshot.js";
import { readAdaptiveProfile, readAdaptiveProfileEffect, profileView } from "./adaptive-events.js";
import { parseTierReference, readResolvedTiersEffect, splitThinkingSuffix, } from "./resolved.js";
import { learnedThinkingLevel, selectTierModel, } from "./selector.js";
export const TIER_ADAPTIVE_DEFAULTS = { enabled: false };
export function tierAdaptiveSettingsPath() {
    return join(agentDir(), "settings.json");
}
const isSettingsObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
export const readTierAdaptiveConfigEffect = Effect.try({
    try: () => {
        const path = tierAdaptiveSettingsPath();
        if (!existsSync(path))
            return { ...TIER_ADAPTIVE_DEFAULTS };
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (!isSettingsObject(parsed)) {
            console.warn("[hpl-model-tiers] settings.json 顶层必须是对象，tierAdaptive 用默认值。");
            return { ...TIER_ADAPTIVE_DEFAULTS };
        }
        const raw = parsed["tierAdaptive"];
        if (raw === undefined)
            return { ...TIER_ADAPTIVE_DEFAULTS };
        if (!isSettingsObject(raw)) {
            console.warn("[hpl-model-tiers] settings.json tierAdaptive 必须是对象，用默认值。");
            return { ...TIER_ADAPTIVE_DEFAULTS };
        }
        const enabled = raw["enabled"];
        if (enabled === undefined)
            return { ...TIER_ADAPTIVE_DEFAULTS };
        if (typeof enabled !== "boolean") {
            console.warn("[hpl-model-tiers] tierAdaptive.enabled 非布尔值，用默认值。");
            return { ...TIER_ADAPTIVE_DEFAULTS };
        }
        return { enabled };
    },
    catch: (error) => error,
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-model-tiers] tierAdaptive 配置读取失败，用默认值：${String(error)}`);
    return { ...TIER_ADAPTIVE_DEFAULTS };
})));
export function readTierAdaptiveConfig() {
    return Effect.runSync(readTierAdaptiveConfigEffect);
}
let sessionOverride;
/** 命令切换后的本会话生效值（写盘失败也要即时生效）；session_start 清空。 */
export function setTierAdaptiveSessionOverride(enabled) {
    sessionOverride = enabled;
}
/** 本会话实际生效值：本会话切换 > settings。选模与状态展示都只认这一个入口。 */
export function tierAdaptiveEnabled() {
    return sessionOverride ?? readTierAdaptiveConfig().enabled;
}
/** 读整个 settings.json；解析失败/非对象 → undefined，调用方据此放弃写入（绝不清空用户配置）。 */
function readSettings(path) {
    if (!existsSync(path))
        return {};
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    }
    catch (error) {
        console.warn(`[hpl-model-tiers] 无法读取 settings.json，跳过写入：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
    if (!isSettingsObject(parsed)) {
        console.warn("[hpl-model-tiers] settings.json 不是对象，跳过写入。");
        return undefined;
    }
    return parsed;
}
/** 只改 tierAdaptive.enabled，settings 其它键与 tierAdaptive 其它字段一律保留。 */
export const setTierAdaptiveEnabledEffect = (enabled) => Effect.try({
    try: () => {
        const path = tierAdaptiveSettingsPath();
        const settings = readSettings(path);
        if (!settings)
            return false;
        const tierAdaptive = isSettingsObject(settings["tierAdaptive"]) ? settings["tierAdaptive"] : {};
        tierAdaptive["enabled"] = enabled;
        settings["tierAdaptive"] = tierAdaptive;
        const parent = dirname(path);
        if (!existsSync(parent))
            mkdirSync(parent, { recursive: true, mode: 0o700 });
        writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
        return true;
    },
    catch: (error) => error,
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-model-tiers] tierAdaptive 设置写入失败：${String(error)}`);
    return false;
})));
export function setTierAdaptiveEnabled(enabled) {
    return Effect.runSync(setTierAdaptiveEnabledEffect(enabled));
}
/** 候选 = resolved 档位条目（配置顺序权威），entryIndex 用条目序号而非展开位置。 */
export function tierCandidates(resolved) {
    return resolved.map((model, index) => ({
        provider: model.provider,
        id: model.id,
        ...(model.name !== undefined ? { name: model.name } : {}),
        ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
        ...(model.thinking !== undefined ? { thinking: model.thinking } : {}),
        entryIndex: model.group ?? index,
    }));
}
/**
 * 点名解析：`tier:<name>[<index>]` 查档位表（thinking 以档位条目为准，与 roles.model 一致），
 * 具体 `provider/id[:level]` 原样采信（点名即权威，不校验是否在档位里）。
 */
export function resolveExplicitModel(spec, resolved) {
    const wanted = spec.trim();
    if (!wanted)
        return {};
    const reference = parseTierReference(wanted);
    if (reference) {
        const entry = resolved[reference.tier][reference.index];
        if (!entry) {
            return {
                warning: `点名 ${wanted} 解析失败（${reference.tier} 档共 ${resolved[reference.tier].length} 个模型），回退自动选择`,
            };
        }
        return {
            model: {
                spec: entry.thinking ? `${entry.provider}/${entry.id}:${entry.thinking}` : `${entry.provider}/${entry.id}`,
                provider: entry.provider,
                id: entry.id,
                ...(entry.thinking !== undefined ? { thinking: entry.thinking } : {}),
            },
        };
    }
    const { pattern, thinking } = splitThinkingSuffix(wanted);
    const slash = pattern.indexOf("/");
    if (slash <= 0 || slash === pattern.length - 1) {
        return { warning: `点名 ${wanted} 不是合法模型（应为 tier:<档>[<位>] 或 provider/id[:level]），回退自动选择` };
    }
    return {
        model: {
            spec: thinking ? `${pattern}:${thinking}` : pattern,
            provider: pattern.slice(0, slash),
            id: pattern.slice(slash + 1),
            ...(thinking !== undefined ? { thinking } : {}),
        },
    };
}
/** provider 的配额状态：缺快照即 unknown（中性）；余额型 provider 不凭金额降级。 */
function quotaClasses(snapshots) {
    return new Map(snapshots.map((snapshot) => [snapshot.provider, snapshotHot(snapshot) ? "hot" : "ok"]));
}
export const planTierSelectionEffect = (request) => Effect.gen(function* () {
    const now = request.now ?? Date.now();
    const role = request.role ?? "worker";
    const adaptiveEnabled = tierAdaptiveEnabled();
    const resolved = yield* readResolvedTiersEffect;
    const candidates = tierCandidates(resolved[request.tier]);
    const explicit = request.explicitSpec ? resolveExplicitModel(request.explicitSpec, resolved) : {};
    const warnings = explicit.warning ? [explicit.warning] : [];
    const snapshots = yield* Effect.sync(() => readQuotaSnapshots(now));
    const byNamespace = quotaClasses(snapshots);
    const providers = new Set(candidates.map((candidate) => candidate.provider));
    if (explicit.model)
        providers.add(explicit.model.provider);
    const quotas = {};
    for (const provider of providers) {
        quotas[provider] = byNamespace.get(quotaNamespace(provider)) ?? "unknown";
    }
    const profile = yield* readAdaptiveProfileEffect(new Date(now).toISOString());
    const decision = selectTierModel({
        role,
        candidates,
        quotas,
        ...(request.load ? { load: request.load } : {}),
        profile: profileView(profile),
        adaptiveEnabled,
        ...(explicit.model ? { explicit: explicit.model } : {}),
    });
    const spec = applyLearnedThinking(decision.spec, role, profile, adaptiveEnabled);
    return {
        tier: request.tier,
        adaptiveEnabled,
        ...(spec !== undefined ? { spec } : {}),
        source: decision.source,
        reason: decision.reason,
        warnings: [...warnings, ...decision.warnings],
        candidates,
        order: decision.order,
    };
});
export function planTierSelection(request) {
    return Effect.runSync(planTierSelectionEffect(request));
}
/**
 * 学习到的 thinking 偏好只补齐没有 thinking 后缀的模型串：
 * 显式 /team:open 的 :level 与档位条目的 :level 已经在 spec 里，splitThinkingSuffix
 * 判到后缀就直接透传，永不覆盖用户配置；adaptive 关闭时不应用。
 */
function applyLearnedThinking(spec, role, profile, adaptiveEnabled) {
    if (!spec)
        return spec;
    const { pattern, thinking } = splitThinkingSuffix(spec);
    if (thinking || !adaptiveEnabled)
        return spec;
    const level = learnedThinkingLevel(role, profile.models[pattern]);
    return level ? `${pattern}:${level}` : spec;
}
/** 非 Worker 角色路径的补齐入口：自己读画像与开关，逻辑同 planTierSelection。 */
export function fillLearnedThinking(spec, role) {
    return applyLearnedThinking(spec, role, readAdaptiveProfile(), tierAdaptiveEnabled());
}
