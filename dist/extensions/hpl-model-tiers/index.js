import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import { readModelTiersEffect, saveModelTiersEffect } from "./config.js";
import { readTierAdaptiveConfig, setTierAdaptiveEnabled, setTierAdaptiveSessionOverride, tierAdaptiveEnabled, planTierSelection } from "./adaptive.js";
import { readAdaptiveProfile, EVIDENCE_WINDOW_DAYS } from "./adaptive-events.js";
import { MIN_TRUSTED_SAMPLES, modelSpec } from "./selector.js";
import { MODEL_TIERS, splitThinkingSuffix, THINKING_LEVELS } from "./resolved.js";
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function globRegex(pattern) {
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
    return new RegExp(`${source}$`, "i");
}
/** 与 pi 一致处：/ 前缀全名 vs 裸 id、* ** ? 段语义；已知差异：非 glob pattern 是精确匹配（pi 是子串匹配），不支持 [abc] 字符类。:thinking 后缀先剥离再匹配（与 pi parseModelPattern 对齐）。 */
export function matchesModelPattern(pattern, model) {
    const bare = splitThinkingSuffix(pattern).pattern;
    const candidate = bare.includes("/") ? `${model.provider}/${model.id}` : model.id;
    return globRegex(bare).test(candidate);
}
function unique(values) {
    return [...new Set(values)];
}
function resolveAvailable(tiers, available) {
    const result = { opus: [], sonnet: [], haiku: [] };
    for (const tier of MODEL_TIERS) {
        const seen = new Set();
        const warned = new Set();
        for (const [group, entry] of tiers[tier].entries()) {
            const { thinking } = splitThinkingSuffix(entry);
            const matches = available.filter((model) => matchesModelPattern(entry, model));
            if (matches.length === 0 && !warned.has(entry)) {
                console.warn(`[hpl-model-tiers] ${tier} pattern 无可用模型匹配，暂保留：${entry}`);
                warned.add(entry);
            }
            for (const model of matches) {
                const key = `${model.provider}/${model.id}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    result[tier].push({ ...model, ...(thinking ? { thinking } : {}), group });
                }
            }
        }
    }
    return result;
}
export function mergeEnabledModels(existing, tiers) {
    return unique([...(existing ?? []), ...MODEL_TIERS.flatMap((tier) => tiers[tier])]);
}
export function resolveTierModels(tiers, available, existingEnabled) {
    const matched = resolveAvailable(tiers, available);
    return {
        tiers,
        matched,
        enabledModels: mergeEnabledModels(existingEnabled, tiers),
        defaultModel: matched.opus[0],
    };
}
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
    if (!isObject(parsed)) {
        console.warn("[hpl-model-tiers] settings.json 不是对象，跳过写入。");
        return undefined;
    }
    return parsed;
}
function writeSettings(path, settings) {
    const parent = dirname(path);
    if (!existsSync(parent))
        mkdirSync(parent, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
}
const writeResolvedTiersEffect = (home, matched) => Effect.try({
    try: () => {
        const resolved = {
            opus: matched.opus.map(({ provider, id, name, reasoning, thinking, group }) => ({ provider, id, name, reasoning, thinking, group })),
            sonnet: matched.sonnet.map(({ provider, id, name, reasoning, thinking, group }) => ({ provider, id, name, reasoning, thinking, group })),
            haiku: matched.haiku.map(({ provider, id, name, reasoning, thinking, group }) => ({ provider, id, name, reasoning, thinking, group })),
        };
        mkdirSync(home, { recursive: true, mode: 0o700 });
        writeFileSync(join(home, "model-tiers-resolved.json"), JSON.stringify(resolved, null, 2) + "\n", "utf8");
    },
    catch: (error) => error,
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-model-tiers] resolved tiers 写入失败，继续启动：${String(error)}`);
})));
function sameStrings(left, right) {
    return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}
/** 读取配置、校验可用模型，并将 tiers 合并进 Pi 原生 settings。 */
const emptyResult = () => ({
    ...resolveTierModels({ opus: [], sonnet: [], haiku: [] }, []),
    settingsChanged: false,
});
export const applyModelTiersEffect = (cwd, available) => Effect.gen(function* () {
    const tiers = yield* readModelTiersEffect(cwd);
    const home = yield* Effect.try({
        try: () => hapilonHome(),
        catch: (error) => error,
    });
    const settingsPath = join(home, "agent", "settings.json");
    const settings = yield* Effect.try({
        try: () => readSettings(settingsPath),
        catch: (error) => error,
    });
    const baseResult = resolveTierModels(tiers, available, Array.isArray(settings?.enabledModels)
        ? settings.enabledModels.filter((value) => typeof value === "string")
        : undefined);
    yield* writeResolvedTiersEffect(home, baseResult.matched);
    if (!settings)
        return { ...baseResult, settingsChanged: false };
    const hasTierPatterns = MODEL_TIERS.some((tier) => tiers[tier].length > 0);
    const nextEnabled = baseResult.enabledModels;
    const shouldWriteEnabled = hasTierPatterns && !sameStrings(settings.enabledModels, nextEnabled);
    let settingsChanged = false;
    if (shouldWriteEnabled) {
        settings.enabledModels = nextEnabled;
        settingsChanged = true;
    }
    const hasDefaultProvider = typeof settings.defaultProvider === "string" && settings.defaultProvider.length > 0;
    const hasDefaultModel = typeof settings.defaultModel === "string" && settings.defaultModel.length > 0;
    if (!hasDefaultProvider && !hasDefaultModel && baseResult.defaultModel) {
        settings.defaultProvider = baseResult.defaultModel.provider;
        settings.defaultModel = baseResult.defaultModel.id;
        settingsChanged = true;
    }
    if (settingsChanged) {
        yield* Effect.try({
            try: () => writeSettings(settingsPath, settings),
            catch: (error) => error,
        });
    }
    return { ...baseResult, settingsChanged };
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-model-tiers] 加载失败，按空档位继续：${String(error)}`);
    return emptyResult();
})));
export default function hplModelTiers(pi) {
    pi.registerCommand("tiers", {
        description: "Interactively edit Opus/Sonnet/Haiku model tiers",
        handler: async (_args, ctx) => {
            await handleTiersCommand(ctx);
        },
    });
    pi.registerCommand("tier-adaptive-mode", {
        description: "查看/切换 tier 自适应选模（写入 settings.json 的 tierAdaptive.enabled）",
        handler: async (args, ctx) => {
            handleTierAdaptiveMode(args, ctx);
        },
    });
    pi.on("session_start", (event, ctx) => {
        setTierAdaptiveSessionOverride(undefined);
        const result = Effect.runSync(Effect.try({
            try: () => ctx.modelRegistry.getAvailable(),
            catch: (error) => error,
        }).pipe(Effect.flatMap((available) => applyModelTiersEffect(ctx.cwd, available)), Effect.catchAll((error) => Effect.sync(() => {
            console.warn(`[hpl-model-tiers] 读取可用模型失败，按空档位继续：${String(error)}`);
            return emptyResult();
        }))));
        // resume/fork/reload 时档位照常装配，但汇总行只在新会话打——不重复复述
        if (event.reason !== "startup" && event.reason !== "new")
            return;
        const reloadHint = result.settingsChanged ? "，已写入 Pi settings；请执行 /reload" : "";
        console.log(`[hpl-model-tiers] opus=${result.tiers.opus.length} sonnet=${result.tiers.sonnet.length} haiku=${result.tiers.haiku.length}${reloadHint}`);
    });
}
const TIER_OPERATIONS = ["添加模型", "移除模型", "设置 thinking", "调整顺序", "清空档位"];
/** 自适应选模本轮只服务 Worker pane，状态页也就只看 Worker 的档位（sonnet）。 */
const ADAPTIVE_TIER = "sonnet";
const TIER_ADAPTIVE_MODE_USAGE = "用法：/tier-adaptive-mode [on|off]（不带参数查看状态）";
/**
 * 对齐 /gate-auto-mode：先改本会话生效值，再尝试持久化，写盘失败明确提示。
 * 与 gate-auto 的差别：生效值每次选模都重读 settings，所以写盘成功后其它 pane 下次选模即吃到新值。
 */
function handleTierAdaptiveMode(args, ctx) {
    const arg = args.trim();
    if (arg !== "" && arg !== "on" && arg !== "off") {
        ctx.ui.notify(TIER_ADAPTIVE_MODE_USAGE, "error");
        return;
    }
    if (arg !== "") {
        const enabled = arg === "on";
        setTierAdaptiveSessionOverride(enabled);
        const persisted = setTierAdaptiveEnabled(enabled);
        ctx.ui.notify([
            `tier 自适应选模已${enabled ? "开启" : "关闭"}（本会话立即生效）。`,
            persisted
                ? `已写入 settings.json 的 tierAdaptive.enabled=${enabled}；其它已开 pane 下次选模即生效。`
                : "⚠️ settings.json 写入失败（原文件未动），仅本会话生效，持久化失败。",
        ].join("\n"), persisted ? "info" : "warning");
        return;
    }
    const settings = readTierAdaptiveConfig();
    const plan = planTierSelection({ tier: ADAPTIVE_TIER });
    const profile = readAdaptiveProfile();
    const configOrder = yieldTiers(ctx.cwd)[ADAPTIVE_TIER];
    ctx.ui.notify([
        "Tier 自适应选模（服务对象：Worker pane）",
        `settings.json tierAdaptive.enabled：${settings.enabled ? "开启" : "关闭"}`,
        `本会话实际生效：${tierAdaptiveEnabled() ? "开启" : "关闭"}`,
        `可信样本：${profile.trustedSamples} 条（单个模型满 ${MIN_TRUSTED_SAMPLES} 条才参与路由，超 ${EVIDENCE_WINDOW_DAYS} 天的旧样本不再计入）`,
        `thinking 偏好样本：${profile.thinkingSamples} 条（按 role+model+level 独立累计，满 ${MIN_TRUSTED_SAMPLES} 条且 adaptive 开启才补齐 thinking）`,
        `配置顺序（${TIER_DISPLAY[ADAPTIVE_TIER]}）：${configOrder.join(" > ") || "（空）"}`,
        `建议顺序：${plan.order.map((candidate) => candidate.spec).join(" > ") || "（无候选）"}`,
        ...plan.order.map((candidate) => {
            const assigned = profile.assignments[candidate.key] ?? 0;
            return `  - ${candidate.spec}：${candidate.labels.join(" · ")}${assigned > 0 ? `（自动分配 ${assigned} 次，不计入偏好）` : ""}`;
        }),
        `本轮决策：${plan.reason}`,
        ...plan.warnings.map((warning) => `⚠️ ${warning}`),
    ].join("\n"), "info");
}
/** 档位显示名（内部 key 一律小写）。 */
const TIER_DISPLAY = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
function modelOption(model) {
    return `${model.provider}/${model.id}`;
}
/** 三档现状 + 候选逻辑速览，进入操作菜单前先展示。 */
async function showTiersOverview(ctx, tiers) {
    const current = ctx.model;
    const currentKey = current ? `${current.provider}/${current.id}` : undefined;
    const sections = ["Tiers 候选现状"];
    for (const tier of MODEL_TIERS) {
        const values = tiers[tier];
        const list = values.length > 0
            ? values.map((value) => {
                const star = value === currentKey ? "  ◀ 当前使用" : "";
                return `\n   ${value}${star}`;
            }).join("")
            : "（空）";
        sections.push(`${TIER_DISPLAY[tier]}: ${list}`);
        const suggestion = suggestionLine(tier);
        if (suggestion)
            sections.push(suggestion);
    }
    sections.push(`Tier 自适应选模：${tierAdaptiveEnabled() ? "开启" : "关闭"}（/tier-adaptive-mode 查看详情）`, "条目可带 :thinking 后缀（off…max），该档干活即用该思考深度；清除用 /tiers 的「设置 thinking」。", "消费方：recap 总结用 haiku（缺则 sonnet 非推理 → sonnet → 当前模型）；", "default 兜底取 opus[0]；三档并集进 /model 选择器。");
    ctx.ui.notify(sections.join("\n"), "info");
}
/** 建议顺序只在偏离配置顺序时展示一行——否则概览只是重复用户自己写的数组。 */
function suggestionLine(tier) {
    const plan = planTierSelection({ tier });
    if (plan.order.length === 0)
        return undefined;
    const suggested = plan.order.map((candidate) => candidate.spec).join(" > ");
    const configured = plan.candidates.map(modelSpec).join(" > ");
    if (suggested === configured)
        return undefined;
    const chosen = plan.order[0];
    return `   建议顺序：${suggested}\n     （按${plan.source === "quota" ? "配额" : plan.source === "profile" ? "可信画像" : "负载"}调整；首选 ${chosen.labels.join("·")}）`;
}
async function saveEditedTiers(ctx, tiers, tier) {
    const saved = await Effect.runPromise(saveModelTiersEffect(tiers));
    if (saved) {
        ctx.ui.notify(`已保存 ${tier} 档位；请执行 /reload 使配置生效。`, "info");
    }
    else {
        ctx.ui.notify("保存 model-tiers.json 失败，请检查 HAPILON_HOME 权限。", "error");
    }
}
async function addModels(ctx, tiers, tier) {
    const chosen = new Set(tiers[tier].map((value) => splitThinkingSuffix(value).pattern));
    const available = ctx.modelRegistry.getAvailable()
        .map((model) => modelOption(model))
        .filter((option) => !chosen.has(option));
    if (available.length === 0) {
        ctx.ui.notify("没有可添加的可用模型。", "warning");
        return;
    }
    let changed = false;
    while (available.length > 0) {
        const selected = await ctx.ui.select("添加模型（可连续选择）", [...available, "完成"]);
        if (selected === undefined) {
            ctx.ui.notify("已取消，本次改动未保存", "info");
            return;
        }
        if (selected === "完成")
            break;
        const index = available.indexOf(selected);
        if (index < 0)
            break;
        tiers[tier].push(selected);
        available.splice(index, 1);
        changed = true;
    }
    if (changed)
        await saveEditedTiers(ctx, tiers, tier);
}
/**
 * 为档位条目设置/清除 :thinking 后缀：选模型 → 选档位（含清除）。
 * 后缀是纯文本追加/替换，保存后 /reload 生效；同一模型在不同档位
 * 各自持后缀，互不影响。
 */
async function setModelThinking(ctx, tiers, tier) {
    const configured = [...tiers[tier]];
    if (configured.length === 0) {
        ctx.ui.notify("该档位当前为空，先添加模型。", "warning");
        return;
    }
    const selected = await ctx.ui.select(`选择 ${TIER_DISPLAY[tier]} 中要设置 thinking 的模型`, [...configured, "取消"]);
    if (!selected || selected === "取消")
        return;
    const index = configured.indexOf(selected);
    if (index < 0)
        return;
    const base = splitThinkingSuffix(selected).pattern;
    const level = await ctx.ui.select(`选择 ${base} 的 thinking level`, [...THINKING_LEVELS, "清除（跟随全局默认）"]);
    if (!level)
        return;
    tiers[tier][index] = level.startsWith("清除") ? base : `${base}:${level}`;
    await saveEditedTiers(ctx, tiers, tier);
}
/**
 * 选模型上移排序：每次 select 一个模型即与前一位交换，实时展示当前顺序；
 * 「完成」保存，esc 取消不保存。顺序即优先级——default 兜底取 opus[0]、
 * recap 与 team 的 worker/reviewer 均按档位数组顺序回退。
 */
async function reorderModels(ctx, tiers, tier) {
    const list = [...tiers[tier]];
    while (true) {
        const numbered = list.map((value, index) => `${index + 1}. ${value}`);
        const selected = await ctx.ui.select(`调整 ${TIER_DISPLAY[tier]} 顺序（选择模型与前一位交换，越靠前优先级越高）`, [...numbered, "完成"]);
        if (selected === undefined)
            return; // esc：不保存
        if (selected === "完成")
            break;
        const index = numbered.indexOf(selected);
        if (index <= 0)
            continue; // 已是第一位
        [list[index - 1], list[index]] = [list[index], list[index - 1]];
    }
    tiers[tier] = list;
    await saveEditedTiers(ctx, tiers, tier);
}
async function handleTiersCommand(ctx) {
    const tiers = yieldTiers(ctx.cwd);
    await showTiersOverview(ctx, tiers);
    const tier = await ctx.ui.select("选择模型档位", MODEL_TIERS.map((t) => TIER_DISPLAY[t]));
    if (!tier)
        return;
    const selectedTier = MODEL_TIERS.find((t) => TIER_DISPLAY[t] === tier);
    if (!selectedTier)
        return;
    const operation = await ctx.ui.select(`操作 ${TIER_DISPLAY[selectedTier]}（当前 ${tiers[selectedTier].length} 个模型）`, [...TIER_OPERATIONS]);
    if (!operation)
        return;
    if (operation === "清空档位") {
        tiers[selectedTier] = [];
        await saveEditedTiers(ctx, tiers, selectedTier);
        return;
    }
    if (operation === "添加模型") {
        await addModels(ctx, tiers, selectedTier);
        return;
    }
    if (operation === "调整顺序") {
        await reorderModels(ctx, tiers, selectedTier);
        return;
    }
    if (operation === "设置 thinking") {
        await setModelThinking(ctx, tiers, selectedTier);
        return;
    }
    const configured = [...tiers[selectedTier]];
    if (configured.length === 0) {
        ctx.ui.notify("该档位当前为空。", "warning");
        return;
    }
    const selected = await ctx.ui.select("选择要移除的模型", [...configured, "取消"]);
    if (!selected || selected === "取消")
        return;
    tiers[selectedTier] = configured.filter((value) => value !== selected);
    await saveEditedTiers(ctx, tiers, selectedTier);
}
function yieldTiers(cwd) {
    return Effect.runSync(readModelTiersEffect(cwd));
}
