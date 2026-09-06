import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import { MODEL_TIERS, setTierModels, type ModelTier, type TierModels } from "./bridge.js";
import { readModelTiersEffect } from "./config.js";

export interface AvailableModel {
  provider: string;
  id: string;
}

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
  const result = { high: [], mid: [], low: [] } as Record<ModelTier, AvailableModel[]>;
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
    defaultModel: matched.high[0],
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

function sameStrings(left: unknown, right: string[]): boolean {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface ApplyModelTiersResult extends TierResolution {
  settingsChanged: boolean;
}

/** 读取配置、校验可用模型，并将 tiers 合并进 Pi 原生 settings。 */
const emptyResult = (): ApplyModelTiersResult => ({
  ...resolveTierModels({ high: [], mid: [], low: [] }, []),
  settingsChanged: false,
});

export const applyModelTiersEffect = (
  cwd: string,
  available: AvailableModel[],
): Effect.Effect<ApplyModelTiersResult, never> => Effect.gen(function* () {
  const tiers = yield* readModelTiersEffect(cwd);
  const settingsPath = yield* Effect.try({
    try: () => join(hapilonHome(), "agent", "settings.json"),
    catch: (error) => error,
  });
  const settings = yield* Effect.try({
    try: () => readSettings(settingsPath),
    catch: (error) => error,
  });
  const baseResult = resolveTierModels(tiers, available, Array.isArray(settings?.enabledModels)
    ? settings.enabledModels.filter((value): value is string => typeof value === "string")
    : undefined);
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
      `[hpl-model-tiers] high=${result.tiers.high.length} mid=${result.tiers.mid.length} low=${result.tiers.low.length}${reloadHint}`,
    );
  });
}
