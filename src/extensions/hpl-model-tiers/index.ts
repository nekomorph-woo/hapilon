import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import { MODEL_TIERS, setTierModels, type ModelTier, type TierModels } from "./bridge.js";
import { readModelTiersEffect, saveModelTiersEffect } from "./config.js";

export interface AvailableModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
}

export type ResolvedTierModel = Pick<AvailableModel, "provider" | "id" | "name" | "reasoning">;
export type ResolvedTierModels = Record<ModelTier, ResolvedTierModel[]>;

interface SettingsObject {
  [key: string]: unknown;
}

export interface TierResolution {
  tiers: TierModels;
  matched: Record<ModelTier, AvailableModel[]>;
  enabledModels: string[];
  defaultModel?: AvailableModel;
}

const isObject = (value: unknown): value is SettingsObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index++;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[\\^$+{}.[\]()`|]/g, "\\$&");
  }
  return new RegExp(`${source}$`, "i");
}

/** 与 pi 一致处：/ 前缀全名 vs 裸 id、* ** ? 段语义；已知差异：非 glob pattern 是精确匹配（pi 是子串匹配），不支持 [abc] 字符类与 :thinking 后缀。 */
export function matchesModelPattern(pattern: string, model: AvailableModel): boolean {
  const candidate = pattern.includes("/") ? `${model.provider}/${model.id}` : model.id;
  return globRegex(pattern).test(candidate);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function resolveAvailable(tiers: TierModels, available: AvailableModel[]): Record<ModelTier, AvailableModel[]> {
  const result = { opus: [], sonnet: [], haiku: [] } as Record<ModelTier, AvailableModel[]>;
  for (const tier of MODEL_TIERS) {
    const seen = new Set<string>();
    const warned = new Set<string>();
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

export function mergeEnabledModels(existing: string[] | undefined, tiers: TierModels): string[] {
  return unique([...(existing ?? []), ...MODEL_TIERS.flatMap((tier) => tiers[tier])]);
}

export function resolveTierModels(tiers: TierModels, available: AvailableModel[], existingEnabled?: string[]): TierResolution {
  const matched = resolveAvailable(tiers, available);
  return {
    tiers,
    matched,
    enabledModels: mergeEnabledModels(existingEnabled, tiers),
    defaultModel: matched.opus[0],
  };
}

function readSettings(path: string): SettingsObject | undefined {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.warn(`[hpl-model-tiers] 无法读取 settings.json，跳过写入：${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (!isObject(parsed)) {
    console.warn("[hpl-model-tiers] settings.json 不是对象，跳过写入。");
    return undefined;
  }
  return parsed;
}

function writeSettings(path: string, settings: SettingsObject): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

const writeResolvedTiersEffect = (
  home: string,
  matched: Record<ModelTier, AvailableModel[]>,
): Effect.Effect<void, never> => Effect.try({
  try: () => {
    const resolved: ResolvedTierModels = {
      opus: matched.opus.map(({ provider, id, name, reasoning }) => ({ provider, id, name, reasoning })),
      sonnet: matched.sonnet.map(({ provider, id, name, reasoning }) => ({ provider, id, name, reasoning })),
      haiku: matched.haiku.map(({ provider, id, name, reasoning }) => ({ provider, id, name, reasoning })),
    };
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "model-tiers-resolved.json"), JSON.stringify(resolved, null, 2) + "\n", "utf8");
  },
  catch: (error) => error,
}).pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-model-tiers] resolved tiers 写入失败，继续启动：${String(error)}`);
  })),
);

function sameStrings(left: unknown, right: string[]): boolean {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface ApplyModelTiersResult extends TierResolution {
  settingsChanged: boolean;
}

/** 读取配置、校验可用模型，并将 tiers 合并进 Pi 原生 settings。 */
const emptyResult = (): ApplyModelTiersResult => ({
  ...resolveTierModels({ opus: [], sonnet: [], haiku: [] }, []),
  settingsChanged: false,
});

export const applyModelTiersEffect = (
  cwd: string,
  available: AvailableModel[],
): Effect.Effect<ApplyModelTiersResult, never> => Effect.gen(function* () {
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
    ? settings.enabledModels.filter((value): value is string => typeof value === "string")
    : undefined);
  yield* writeResolvedTiersEffect(home, baseResult.matched);
  if (!settings) return { ...baseResult, settingsChanged: false };

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
}).pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-model-tiers] 加载失败，按空档位继续：${String(error)}`);
    return emptyResult();
  })),
);

export default function hplModelTiers(pi: ExtensionAPI): void {
  pi.registerCommand("tiers", {
    description: "Interactively edit Opus/Sonnet/Haiku model tiers",
    handler: async (_args, ctx) => {
      await handleTiersCommand(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const result = Effect.runSync(Effect.try({
      try: () => ctx.modelRegistry.getAvailable(),
      catch: (error) => error,
    }).pipe(
      Effect.flatMap((available) => applyModelTiersEffect(ctx.cwd, available)),
      Effect.catchAll((error) => Effect.sync(() => {
        console.warn(`[hpl-model-tiers] 读取可用模型失败，按空档位继续：${String(error)}`);
        return emptyResult();
      })),
    ));
    setTierModels(result.tiers);
    const reloadHint = result.settingsChanged ? "，已写入 Pi settings；请执行 /reload" : "";
    console.log(
      `[hpl-model-tiers] opus=${result.tiers.opus.length} sonnet=${result.tiers.sonnet.length} haiku=${result.tiers.haiku.length}${reloadHint}`,
    );
  });
}

const TIER_OPERATIONS = ["添加模型", "移除模型", "清空档位"] as const;

/** 档位显示名（内部 key 一律小写）。 */
const TIER_DISPLAY: Record<ModelTier, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };

function modelOption(model: AvailableModel): string {
  return `${model.provider}/${model.id}`;
}

/** 三档现状 + 候选逻辑速览，进入操作菜单前先展示。 */
async function showTiersOverview(ctx: ExtensionCommandContext, tiers: TierModels): Promise<void> {
  const current = ctx.model;
  const currentKey = current ? `${current.provider}/${current.id}` : undefined;
  const sections: string[] = ["Tiers 候选现状"];
  for (const tier of MODEL_TIERS) {
    const values = tiers[tier];
    const list = values.length > 0
      ? values.map((value) => {
          const star = value === currentKey ? "  ◀ 当前使用" : "";
          return `\n   ${value}${star}`;
        }).join("")
      : "（空）";
    sections.push(`${TIER_DISPLAY[tier]}: ${list}`);
  }
  sections.push(
    "消费方：recap 总结用 haiku（缺则 sonnet 非推理 → sonnet → 当前模型）；",
    "default 兜底取 opus[0]；三档并集进 /model 选择器。",
  );
  ctx.ui.notify(sections.join("\n"), "info");
}

async function saveEditedTiers(ctx: ExtensionCommandContext, tiers: TierModels, tier: ModelTier): Promise<void> {
  const saved = await Effect.runPromise(saveModelTiersEffect(tiers));
  if (saved) {
    ctx.ui.notify(`已保存 ${tier} 档位；请执行 /reload 使配置生效。`, "info");
  } else {
    ctx.ui.notify("保存 model-tiers.json 失败，请检查 HAPILON_HOME 权限。", "error");
  }
}

async function addModels(
  ctx: ExtensionCommandContext,
  tiers: TierModels,
  tier: ModelTier,
): Promise<void> {
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
    if (selected === "完成") break;
    const index = available.indexOf(selected);
    if (index < 0) break;
    tiers[tier].push(selected);
    available.splice(index, 1);
    changed = true;
  }
  if (changed) await saveEditedTiers(ctx, tiers, tier);
}

async function handleTiersCommand(ctx: ExtensionCommandContext): Promise<void> {
  const tiers = yieldTiers(ctx.cwd);
  await showTiersOverview(ctx, tiers);
  const tier = await ctx.ui.select("选择模型档位", MODEL_TIERS.map((t) => TIER_DISPLAY[t]));
  if (!tier) return;
  const selectedTier = MODEL_TIERS.find((t) => TIER_DISPLAY[t] === tier);
  if (!selectedTier) return;
  const operation = await ctx.ui.select(`操作 ${TIER_DISPLAY[selectedTier]}（当前 ${tiers[selectedTier].length} 个模型）`, [...TIER_OPERATIONS]);
  if (!operation) return;

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
  if (!selected || selected === "取消") return;
  tiers[selectedTier] = configured.filter((value) => value !== selected);
  await saveEditedTiers(ctx, tiers, selectedTier);
}

function yieldTiers(cwd: string): TierModels {
  return Effect.runSync(readModelTiersEffect(cwd));
}
