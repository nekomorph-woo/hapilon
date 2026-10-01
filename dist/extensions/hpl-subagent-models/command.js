import { Effect } from "effect";
import { THINKING_LEVELS, splitThinkingSuffix } from "../hpl-model-tiers/resolved.js";
import { globalSubagentModelsPath, projectSubagentModelsPath, readSubagentLayersEffect, saveSubagentModelsLayerEffect, } from "./config.js";
const OPERATIONS = ["开关扩展", "添加模型", "设置 thinking", "调整顺序", "移除模型", "清空列表"];
/** 概览：两层现状 + 生效层判定 + 检查入口提示。 */
function showOverview(ctx, layers) {
    const fmt = (layer) => layer
        ? layer.models.length > 0
            ? layer.models.map((model, index) => `\n   ${index + 1}. ${model}`).join("")
            : "（空列表）"
        : "（未配置）";
    const effective = layers.project ?? layers.global;
    ctx.ui.notify([
        "Subagent 派发模型列表",
        `扩展开关（生效层）：${effective?.enabled === false ? "关闭" : "开启"}`,
        `全局 ${globalSubagentModelsPath()}：${fmt(layers.global)}`,
        `项目 ${projectSubagentModelsPath(ctx.cwd)}：${fmt(layers.project)}`,
        "规则：项目文件存在即整体替换全局；只兜未显式指定 model 的 Agent/TaskExecute 派发；",
        "条目全部配额紧张（≥90%）时回落父 agent 模型。检查：/agents → Settings 开 showModel，",
        "派发行会显示实际生效的模型与 thinking。",
    ].join("\n"), "info");
}
async function pickTarget(ctx, layers) {
    const choice = await ctx.ui.select("编辑哪一层？（项目文件存在即整体替换全局）", [
        `全局（${layers.global ? `${layers.global.models.length} 条` : "未配置"}）`,
        `项目（${layers.project ? `${layers.project.models.length} 条` : "未配置"}）`,
        "取消",
    ]);
    if (!choice || choice === "取消")
        return undefined;
    if (choice.startsWith("全局")) {
        return {
            label: "全局",
            path: globalSubagentModelsPath(),
            layer: layers.global ? { ...layers.global, models: [...layers.global.models] } : { enabled: true, models: [] },
        };
    }
    if (!layers.project) {
        ctx.ui.notify("将新建项目 .hapilon/subagent-models.json；它存在即整体替换全局（包括空列表）。", "warning");
    }
    return {
        label: "项目",
        path: projectSubagentModelsPath(ctx.cwd),
        layer: layers.project ? { ...layers.project, models: [...layers.project.models] } : { enabled: true, models: [] },
    };
}
async function saveLayer(ctx, target) {
    const saved = await Effect.runPromise(saveSubagentModelsLayerEffect(target.path, target.layer));
    if (saved) {
        ctx.ui.notify(`已保存 ${target.label}（${target.layer.enabled ? "开启" : "关闭"}，${target.layer.models.length} 条）；列表派发时现读，立即生效。`, "info");
    }
    else {
        ctx.ui.notify(`保存 ${target.path} 失败，请检查权限。`, "error");
    }
}
async function toggleEnabled(ctx, target) {
    const choice = await ctx.ui.select(`扩展开关（当前${target.layer.enabled ? "开启" : "关闭"}）`, ["开启", "关闭", "取消"]);
    if (!choice || choice === "取消")
        return;
    target.layer.enabled = choice === "开启";
    await saveLayer(ctx, target);
}
async function addModels(ctx, target) {
    const chosen = new Set(target.layer.models.map((value) => splitThinkingSuffix(value).pattern));
    const available = ctx.modelRegistry.getAvailable()
        .map((model) => `${model.provider}/${model.id}`)
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
        target.layer.models.push(selected);
        available.splice(index, 1);
        changed = true;
    }
    if (changed)
        await saveLayer(ctx, target);
}
async function setThinking(ctx, target) {
    if (target.layer.models.length === 0) {
        ctx.ui.notify("列表为空，先添加模型。", "warning");
        return;
    }
    const selected = await ctx.ui.select("选择要设置 thinking 的条目", [...target.layer.models, "取消"]);
    if (!selected || selected === "取消")
        return;
    const index = target.layer.models.indexOf(selected);
    if (index < 0)
        return;
    const base = splitThinkingSuffix(selected).pattern;
    const level = await ctx.ui.select(`选择 ${base} 的 thinking level`, [...THINKING_LEVELS, "清除"]);
    if (!level)
        return;
    target.layer.models[index] = level === "清除" ? base : `${base}:${level}`;
    await saveLayer(ctx, target);
}
async function reorderModels(ctx, target) {
    const list = [...target.layer.models];
    while (true) {
        const numbered = list.map((value, index) => `${index + 1}. ${value}`);
        const selected = await ctx.ui.select("调整顺序（选择条目与前一位交换，越靠前优先级越高）", [...numbered, "完成"]);
        if (selected === undefined)
            return; // esc：不保存
        if (selected === "完成")
            break;
        const index = numbered.indexOf(selected);
        if (index <= 0)
            continue; // 已是第一位
        [list[index - 1], list[index]] = [list[index], list[index - 1]];
    }
    target.layer.models = list;
    await saveLayer(ctx, target);
}
async function removeModel(ctx, target) {
    if (target.layer.models.length === 0) {
        ctx.ui.notify("列表为空。", "warning");
        return;
    }
    const selected = await ctx.ui.select("选择要移除的条目", [...target.layer.models, "取消"]);
    if (!selected || selected === "取消")
        return;
    target.layer.models = target.layer.models.filter((value) => value !== selected);
    await saveLayer(ctx, target);
}
export async function handleSubagentModelsCommand(ctx) {
    const layers = await Effect.runPromise(readSubagentLayersEffect(ctx.cwd));
    showOverview(ctx, layers);
    const target = await pickTarget(ctx, layers);
    if (!target)
        return;
    const operation = await ctx.ui.select(`操作（${target.label}，当前 ${target.layer.models.length} 条）`, [...OPERATIONS]);
    if (!operation)
        return;
    if (operation === "开关扩展")
        return toggleEnabled(ctx, target);
    if (operation === "添加模型")
        return addModels(ctx, target);
    if (operation === "设置 thinking")
        return setThinking(ctx, target);
    if (operation === "调整顺序")
        return reorderModels(ctx, target);
    if (operation === "移除模型")
        return removeModel(ctx, target);
    target.layer.models = [];
    await saveLayer(ctx, target);
}
