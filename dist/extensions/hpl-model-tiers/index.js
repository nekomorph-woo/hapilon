import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import { MODEL_TIERS, setTierModels } from "./bridge.js";
import { readModelTiersEffect, saveModelTiersEffect } from "./config.js";
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
/** 与 pi 一致处：/ 前缀全名 vs 裸 id、* ** ? 段语义；已知差异：非 glob pattern 是精确匹配（pi 是子串匹配），不支持 [abc] 字符类与 :thinking 后缀。 */
export function matchesModelPattern(pattern, model) {
    const candidate = pattern.includes("/") ? `${model.provider}/${model.id}` : model.id;
    return globRegex(pattern).test(candidate);
}
function unique(values) {
    return [...new Set(values)];
}
function resolveAvailable(tiers, available) {
    const result = { high: [], mid: [], low: [] };
    for (const tier of MODEL_TIERS) {
        const seen = new Set();
        const warned = new Set();
        for (const pattern of tiers[tier]) {
            const matches = available.filter((model) => matchesModelPattern(pattern, model));
            if (matches.length === 0 && !warned.has(pattern)) {
                console.warn(`[hpl-model-tiers] ${tier} pattern 无可用模型匹配，暂保留：${pattern}`);
                warned.add(pattern);
            }
            for (const model of matches) {
                const key = `${model.provider}/${model.id}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    result[tier].push(model);
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
        defaultModel: matched.high[0],
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
            high: matched.high.map(({ provider, id, name, reasoning }) => ({ provider, id, name, reasoning })),
            mid: matched.mid.map(({ provider, id, name, reasoning }) => ({ provider, id, name, reasoning })),
            low: matched.low.map(({ provider, id, name, reasoning }) => ({ provider, id, name, reasoning })),
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
    ...resolveTierModels({ high: [], mid: [], low: [] }, []),
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
        description: "Interactively edit high/mid/low model tiers",
        handler: async (_args, ctx) => {
            await handleTiersCommand(ctx);
        },
    });
    pi.on("session_start", (_event, ctx) => {
        const result = Effect.runSync(Effect.try({
            try: () => ctx.modelRegistry.getAvailable(),
            catch: (error) => error,
        }).pipe(Effect.flatMap((available) => applyModelTiersEffect(ctx.cwd, available)), Effect.catchAll((error) => Effect.sync(() => {
            console.warn(`[hpl-model-tiers] 读取可用模型失败，按空档位继续：${String(error)}`);
            return emptyResult();
        }))));
        setTierModels(result.tiers);
        const reloadHint = result.settingsChanged ? "，已写入 Pi settings；请执行 /reload" : "";
        console.log(`[hpl-model-tiers] high=${result.tiers.high.length} mid=${result.tiers.mid.length} low=${result.tiers.low.length}${reloadHint}`);
    });
}
const TIER_OPERATIONS = ["添加模型", "移除模型", "查看当前", "清空档位"];
function modelOption(model) {
    return `${model.provider}/${model.id}`;
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
    const chosen = new Set(tiers[tier]);
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
async function handleTiersCommand(ctx) {
    const tiers = yieldTiers(ctx.cwd);
    const tier = await ctx.ui.select("选择模型档位", [...MODEL_TIERS]);
    if (!tier || !MODEL_TIERS.includes(tier))
        return;
    const operation = await ctx.ui.select("选择操作", [...TIER_OPERATIONS]);
    if (!operation)
        return;
    const selectedTier = tier;
    if (operation === "查看当前") {
        const values = tiers[selectedTier];
        ctx.ui.notify(`${selectedTier} 当前配置：${values.length > 0 ? values.join(", ") : "（空）"}`, "info");
        return;
    }
    if (operation === "清空档位") {
        tiers[selectedTier] = [];
        await saveEditedTiers(ctx, tiers, selectedTier);
        return;
    }
    if (operation === "添加模型") {
        await addModels(ctx, tiers, selectedTier);
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
