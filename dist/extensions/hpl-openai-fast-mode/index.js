import { Effect } from "effect";
import { agentDir } from "../../config/hapilon-home.js";
import { addFastModeServiceTier, matchesFastModeModel, readFastModeSettingsEffect, SERVICE_TIERS, writeFastModeSettingsEffect, } from "./settings.js";
const USAGE = "用法：/fast [on|off] 或 /fast tier <fast|priority|standard|flex>";
function isServiceTier(value) {
    return SERVICE_TIERS.some((tier) => tier === value);
}
function statusText(settings, ctx) {
    const model = ctx.model;
    const matched = matchesFastModeModel(settings, model);
    return [
        `Fast 模式：${settings.enabled ? "开启" : "关闭"}`,
        `当前模型：${model ? `${model.provider}/${model.id}` : "未选择"}`,
        `模型白名单：${matched ? "命中" : "未命中"}`,
        `service_tier：${settings.serviceTier}`,
        `当前请求：${settings.enabled && matched ? "会使用 Fast 模式" : "不会使用 Fast 模式"}`,
    ].join("\n");
}
function saveSettings(settings, agentDirPath, ctx, successMessage) {
    const saved = Effect.runSync(writeFastModeSettingsEffect(agentDirPath, settings));
    ctx.ui.notify(saved ? successMessage : "settings.json 未更新；请检查文件格式和写入权限。", saved ? "info" : "error");
}
export default function hplOpenAiFastMode(pi) {
    const agentDirPath = agentDir();
    pi.registerCommand("fast", {
        description: "Toggle OpenAI Fast mode for eligible GPT models",
        handler: async (args, ctx) => {
            const parts = args.trim().split(/\s+/).filter(Boolean);
            const settings = Effect.runSync(readFastModeSettingsEffect(agentDirPath));
            if (parts.length === 0) {
                ctx.ui.notify(statusText(settings, ctx), "info");
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
        if (!model || (model.provider !== "openai" && model.provider !== "openai-codex"))
            return undefined;
        const settings = Effect.runSync(readFastModeSettingsEffect(agentDirPath));
        // pi 0.87.1 将 fast 回显按 1× 显示；这只影响界面，OpenAI 仍按实际费率计费。
        return addFastModeServiceTier(event.payload, settings, model);
    });
}
export { DEFAULT_FAST_MODE_SETTINGS } from "./settings.js";
