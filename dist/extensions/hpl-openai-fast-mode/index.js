import { Effect } from "effect";
import { agentDir } from "../../config/hapilon-home.js";
import { argumentCompletions } from "../../shared/argument-completion.js";
import { runMenuLoop } from "../../shared/menu-loop.js";
import { pickFromList } from "../../shared/list-picker.js";
import { addFastModeModel, addFastModeServiceTier, matchesFastModeModel, readFastModeSettingsEffect, removeFastModeModel, SERVICE_TIERS, toggleFastModeModel, writeFastModeSettingsEffect, } from "./settings.js";
const USAGE = "用法：/fast（打开菜单）、/fast on|off 或 /fast tier <fast|priority|standard|flex>";
const ARGUMENT_COMPLETIONS = [
    { value: "on", label: "on" },
    { value: "off", label: "off" },
    ...SERVICE_TIERS.map((tier) => ({ value: `tier ${tier}`, label: `tier ${tier}` })),
];
const ADD_MODEL = "添加其他模型";
const ADD_PATTERN = "按模式添加（glob）";
const REMOVE_MODEL = "移除白名单条目";
function isServiceTier(value) {
    return SERVICE_TIERS.some((tier) => tier === value);
}
function isOpenAiProvider(provider) {
    return provider === "openai" || provider === "openai-codex";
}
function modelName(model) {
    return `${model.provider}/${model.id}`;
}
function settingsAt(agentDirPath) {
    return Effect.runSync(readFastModeSettingsEffect(agentDirPath));
}
function saveSettings(settings, agentDirPath, ctx, successMessage) {
    const saved = Effect.runSync(writeFastModeSettingsEffect(agentDirPath, settings));
    ctx.ui.notify(saved ? successMessage : "settings.json 未更新；请检查文件格式和写入权限。", saved ? "info" : "error");
}
async function openFastModeMenu(agentDirPath, ctx) {
    // 常驻菜单：每轮现读 settings，改完一项标签即时刷新，可连续调整
    await runMenuLoop(ctx, {
        title: "Fast 模式",
        build: () => {
            const settings = settingsAt(agentDirPath);
            const model = ctx.model;
            const modelAllowed = model && isOpenAiProvider(model.provider);
            const modelMatched = matchesFastModeModel(settings, model);
            const modelLabel = model ? modelName(model) : "未选择";
            const items = [];
            if (modelAllowed && model) {
                items.push({
                    label: `${modelMatched ? "移除" : "添加"}当前模型：${modelLabel}`,
                    run: () => {
                        const result = toggleFastModeModel(settingsAt(agentDirPath), model);
                        saveSettings(result.settings, agentDirPath, ctx, result.removedPatterns.length > 0
                            ? `已移除匹配当前模型的白名单条目：${result.removedPatterns.join("、")}`
                            : `已将 ${modelName(model)} 加入白名单。`);
                    },
                });
            }
            items.push({
                label: "添加模型",
                run: async () => {
                    const candidates = ctx.modelRegistry.getAvailable()
                        .filter((candidate) => isOpenAiProvider(candidate.provider))
                        .map(modelName);
                    if (candidates.length === 0) {
                        ctx.ui.notify("没有可添加的 OpenAI 系模型。", "warning");
                        return;
                    }
                    const selectedModel = await pickFromList(ctx, "添加 OpenAI 系模型", candidates);
                    if (!selectedModel)
                        return;
                    const candidate = ctx.modelRegistry
                        .getAvailable()
                        .find((item) => modelName(item) === selectedModel);
                    if (!candidate) {
                        ctx.ui.notify("所选模型不在可用列表中。", "error");
                        return;
                    }
                    saveSettings(addFastModeModel(settingsAt(agentDirPath), candidate), agentDirPath, ctx, `已将 ${selectedModel} 加入白名单。`);
                },
            }, {
                label: "添加白名单模式（glob）",
                run: async () => {
                    const pattern = (await ctx.ui.input("输入白名单模式（glob）", "gpt* 或 openai-codex/gpt*"))?.trim();
                    if (!pattern)
                        return;
                    const latest = settingsAt(agentDirPath);
                    saveSettings({ ...latest, models: [...latest.models, pattern] }, agentDirPath, ctx, `已将模式 ${pattern} 加入白名单。`);
                },
            }, {
                label: `移除白名单条目（${settings.models.length}）`,
                run: async () => {
                    if (settings.models.length === 0) {
                        ctx.ui.notify("模型白名单为空。", "info");
                        return;
                    }
                    const selectedPattern = await ctx.ui.select("移除白名单条目", [...settings.models]);
                    if (!selectedPattern)
                        return;
                    if (!settings.models.includes(selectedPattern)) {
                        ctx.ui.notify("所选条目不在白名单中。", "error");
                        return;
                    }
                    saveSettings(removeFastModeModel(settingsAt(agentDirPath), selectedPattern), agentDirPath, ctx, `已从白名单移除 ${selectedPattern}。`);
                },
            }, {
                label: `选择 service_tier（当前：${settings.serviceTier}）`,
                run: async () => {
                    const serviceTier = await ctx.ui.select("选择 service_tier", [...SERVICE_TIERS]);
                    if (!serviceTier)
                        return;
                    if (!isServiceTier(serviceTier)) {
                        ctx.ui.notify("所选 service_tier 无效。", "error");
                        return;
                    }
                    saveSettings({ ...settingsAt(agentDirPath), serviceTier }, agentDirPath, ctx, `service_tier 已设为 ${serviceTier}。`);
                },
            }, {
                label: `全局 Fast 开关（当前：${settings.enabled ? "开启" : "关闭"}）`,
                run: () => {
                    const latest = settingsAt(agentDirPath);
                    const enabled = !latest.enabled;
                    saveSettings({ ...latest, enabled }, agentDirPath, ctx, `Fast 全局开关已${enabled ? "开启" : "关闭"}。`);
                },
            });
            return items;
        },
    });
}
export default function hplOpenAiFastMode(pi) {
    const agentDirPath = agentDir();
    pi.registerCommand("fast", {
        description: "Configure Fast mode and its model allowlist",
        getArgumentCompletions: (query) => argumentCompletions(ARGUMENT_COMPLETIONS, query),
        handler: async (args, ctx) => {
            const parts = args.trim().split(/\s+/).filter(Boolean);
            const settings = settingsAt(agentDirPath);
            if (parts.length === 0) {
                await openFastModeMenu(agentDirPath, ctx);
                return;
            }
            if (parts.length === 1 && (parts[0] === "on" || parts[0] === "off")) {
                const enabled = parts[0] === "on";
                saveSettings({ ...settings, enabled }, agentDirPath, ctx, `Fast 模式已${enabled ? "开启" : "关闭"}；设置已保存到 settings.json。`);
                return;
            }
            if (parts.length === 2 && parts[0] === "tier" && isServiceTier(parts[1])) {
                saveSettings({ ...settings, serviceTier: parts[1] }, agentDirPath, ctx, `service_tier 已设为 ${parts[1]}；设置已保存到 settings.json。`);
                return;
            }
            ctx.ui.notify(USAGE, "error");
        },
    });
    pi.on("before_provider_request", (event, ctx) => {
        const model = ctx.model;
        if (!model || !isOpenAiProvider(model.provider))
            return undefined;
        const settings = settingsAt(agentDirPath);
        // pi 0.87.1 将 fast 回显按 1× 显示；这只影响界面，OpenAI 仍按实际费率计费。
        return addFastModeServiceTier(event.payload, settings, model);
    });
}
export { DEFAULT_FAST_MODE_SETTINGS } from "./settings.js";
