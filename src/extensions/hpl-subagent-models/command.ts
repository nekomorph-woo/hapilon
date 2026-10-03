/**
 * 模型列表交互编辑命令（/subagent-models 与 /vision-models 共用一套流程）。
 * 结构照 /tiers：概览 → 选目标层 → 单次操作 → 写回。列表派发时现读，
 * 保存即生效，无需 /reload。
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { THINKING_LEVELS, splitThinkingSuffix } from "../hpl-model-tiers/resolved.js";
import type { SubagentModelsLayer } from "./config.js";

const OPERATIONS = ["开关扩展", "添加模型", "设置 thinking", "调整顺序", "移除模型", "清空列表"] as const;

interface EditTarget {
  label: string;
  path: string;
  layer: SubagentModelsLayer;
}

export interface ModelListCommandIo {
  title: string;
  /** 派发接入点说明（概览页尾注，两列表不同） */
  rules: string[];
  globalPath: () => string;
  projectPath: (cwd: string) => string;
  readLayers: (cwd: string) => Effect.Effect<{ global: SubagentModelsLayer | undefined; project: SubagentModelsLayer | undefined }, never>;
  saveLayer: (path: string, layer: SubagentModelsLayer) => Effect.Effect<boolean, never>;
}

/** 概览：两层现状 + 生效层判定 + 检查入口提示。 */
function showOverview(ctx: ExtensionCommandContext, io: ModelListCommandIo, layers: { global?: SubagentModelsLayer; project?: SubagentModelsLayer }): void {
  const fmt = (layer: SubagentModelsLayer | undefined): string =>
    layer
      ? layer.models.length > 0
        ? layer.models.map((model, index) => `\n   ${index + 1}. ${model}`).join("")
        : "（空列表）"
      : "（未配置）";
  const effective = layers.project ?? layers.global;
  ctx.ui.notify([
    io.title,
    `扩展开关（生效层）：${effective?.enabled === false ? "关闭" : "开启"}`,
    `全局 ${io.globalPath()}：${fmt(layers.global)}`,
    `项目 ${io.projectPath(ctx.cwd)}：${fmt(layers.project)}`,
    ...io.rules,
  ].join("\n"), "info");
}

async function pickTarget(
  ctx: ExtensionCommandContext,
  io: ModelListCommandIo,
  layers: { global?: SubagentModelsLayer; project?: SubagentModelsLayer },
): Promise<EditTarget | undefined> {
  const choice = await ctx.ui.select("编辑哪一层？（项目文件存在即整体替换全局）", [
    `全局（${layers.global ? `${layers.global.models.length} 条` : "未配置"}）`,
    `项目（${layers.project ? `${layers.project.models.length} 条` : "未配置"}）`,
    "取消",
  ]);
  if (!choice || choice === "取消") return undefined;
  if (choice.startsWith("全局")) {
    return {
      label: "全局",
      path: io.globalPath(),
      layer: layers.global ? { ...layers.global, models: [...layers.global.models] } : { enabled: true, models: [] },
    };
  }
  if (!layers.project) {
    ctx.ui.notify(`将新建项目 ${io.projectPath(ctx.cwd).split("/").pop()}；它存在即整体替换全局（包括空列表）。`, "warning");
  }
  return {
    label: "项目",
    path: io.projectPath(ctx.cwd),
    layer: layers.project ? { ...layers.project, models: [...layers.project.models] } : { enabled: true, models: [] },
  };
}

async function saveLayer(ctx: ExtensionCommandContext, io: ModelListCommandIo, target: EditTarget): Promise<void> {
  const saved = await Effect.runPromise(io.saveLayer(target.path, target.layer));
  if (saved) {
    ctx.ui.notify(`已保存 ${target.label}（${target.layer.enabled ? "开启" : "关闭"}，${target.layer.models.length} 条）；列表派发时现读，立即生效。`, "info");
  } else {
    ctx.ui.notify(`保存 ${target.path} 失败，请检查权限。`, "error");
  }
}

async function toggleEnabled(ctx: ExtensionCommandContext, io: ModelListCommandIo, target: EditTarget): Promise<void> {
  const choice = await ctx.ui.select(`扩展开关（当前${target.layer.enabled ? "开启" : "关闭"}）`, ["开启", "关闭", "取消"]);
  if (!choice || choice === "取消") return;
  target.layer.enabled = choice === "开启";
  await saveLayer(ctx, io, target);
}

async function addModels(ctx: ExtensionCommandContext, io: ModelListCommandIo, target: EditTarget): Promise<void> {
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
    if (selected === "完成") break;
    const index = available.indexOf(selected);
    if (index < 0) break;
    target.layer.models.push(selected);
    available.splice(index, 1);
    changed = true;
  }
  if (changed) await saveLayer(ctx, io, target);
}

async function setThinking(ctx: ExtensionCommandContext, io: ModelListCommandIo, target: EditTarget): Promise<void> {
  if (target.layer.models.length === 0) {
    ctx.ui.notify("列表为空，先添加模型。", "warning");
    return;
  }
  const selected = await ctx.ui.select("选择要设置 thinking 的条目", [...target.layer.models, "取消"]);
  if (!selected || selected === "取消") return;
  const index = target.layer.models.indexOf(selected);
  if (index < 0) return;
  const base = splitThinkingSuffix(selected).pattern;
  const level = await ctx.ui.select(`选择 ${base} 的 thinking level`, [...THINKING_LEVELS, "清除"]);
  if (!level) return;
  target.layer.models[index] = level === "清除" ? base : `${base}:${level}`;
  await saveLayer(ctx, io, target);
}

async function reorderModels(ctx: ExtensionCommandContext, io: ModelListCommandIo, target: EditTarget): Promise<void> {
  const list = [...target.layer.models];
  while (true) {
    const numbered = list.map((value, index) => `${index + 1}. ${value}`);
    const selected = await ctx.ui.select("调整顺序（选择条目与前一位交换，越靠前优先级越高）", [...numbered, "完成"]);
    if (selected === undefined) return; // esc：不保存
    if (selected === "完成") break;
    const index = numbered.indexOf(selected);
    if (index <= 0) continue; // 已是第一位
    [list[index - 1], list[index]] = [list[index], list[index - 1]];
  }
  target.layer.models = list;
  await saveLayer(ctx, io, target);
}

async function removeModel(ctx: ExtensionCommandContext, io: ModelListCommandIo, target: EditTarget): Promise<void> {
  if (target.layer.models.length === 0) {
    ctx.ui.notify("列表为空。", "warning");
    return;
  }
  const selected = await ctx.ui.select("选择要移除的条目", [...target.layer.models, "取消"]);
  if (!selected || selected === "取消") return;
  target.layer.models = target.layer.models.filter((value) => value !== selected);
  await saveLayer(ctx, io, target);
}

async function runEditor(ctx: ExtensionCommandContext, io: ModelListCommandIo): Promise<void> {
  const layers = await Effect.runPromise(io.readLayers(ctx.cwd));
  showOverview(ctx, io, layers);
  const target = await pickTarget(ctx, io, layers);
  if (!target) return;
  const operation = await ctx.ui.select(`操作（${target.label}，当前 ${target.layer.models.length} 条）`, [...OPERATIONS]);
  if (!operation) return;

  if (operation === "开关扩展") return toggleEnabled(ctx, io, target);
  if (operation === "添加模型") return addModels(ctx, io, target);
  if (operation === "设置 thinking") return setThinking(ctx, io, target);
  if (operation === "调整顺序") return reorderModels(ctx, io, target);
  if (operation === "移除模型") return removeModel(ctx, io, target);
  target.layer.models = [];
  await saveLayer(ctx, io, target);
}

// ── 两个具体命令 ──────────────────────────────────────────────────

import {
  globalSubagentModelsPath,
  globalVisionModelsPath,
  projectSubagentModelsPath,
  projectVisionModelsPath,
  readSubagentLayersEffect,
  readVisionLayersEffect,
  saveSubagentModelsLayerEffect,
  saveVisionModelsLayerEffect,
} from "./config.js";

const subagentIo: ModelListCommandIo = {
  title: "Subagent 派发模型列表",
  rules: [
    "规则：项目文件存在即整体替换全局；只兜未显式指定 model 的 Agent/TaskExecute 派发；",
    "条目全部配额紧张（≥90%）时回落父 agent 模型。检查：/agents → Settings 开 showModel，",
    "派发行会显示实际生效的模型与 thinking。",
  ],
  globalPath: globalSubagentModelsPath,
  projectPath: projectSubagentModelsPath,
  readLayers: readSubagentLayersEffect,
  saveLayer: saveSubagentModelsLayerEffect,
};

const visionIo: ModelListCommandIo = {
  title: "Vision 子代理模型列表（多模态）",
  rules: [
    "规则：项目文件存在即整体替换全局；只改 subagent_type=vision 的 Agent 派发；",
    "列表未配置时 vision 派发回落父 agent 模型（可能不支持图像，会告警）。",
    "用途：图像/截图分析不进主模型上下文，主会话保持文本强模型。",
  ],
  globalPath: globalVisionModelsPath,
  projectPath: projectVisionModelsPath,
  readLayers: readVisionLayersEffect,
  saveLayer: saveVisionModelsLayerEffect,
};

export async function handleSubagentModelsCommand(ctx: ExtensionCommandContext): Promise<void> {
  await runEditor(ctx, subagentIo);
}

export async function handleVisionModelsCommand(ctx: ExtensionCommandContext): Promise<void> {
  await runEditor(ctx, visionIo);
}
