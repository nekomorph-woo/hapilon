import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import { MODEL_TIERS, type ModelTier, type TierModels } from "./bridge.js";

export type PartialTierModels = Partial<Record<ModelTier, string[]>>;

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function warnInvalid(path: string, tier: string, value: unknown): void {
  console.warn(
    `[hpl-model-tiers] ${path} 中 ${tier} 无效（需要 string[]，收到 ${JSON.stringify(value)}），该档按空处理。`,
  );
}

/** 读取单层文件；缺档不出现在返回值中，便于项目级按档位替换全局级。 */
export const readTierConfigFileEffect = (
  path: string,
): Effect.Effect<PartialTierModels, never> => Effect.try({
  try: () => {
  if (!existsSync(path)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.warn(
      `[hpl-model-tiers] 无法读取 ${path}，该级忽略：${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.warn(`[hpl-model-tiers] ${path} 顶层必须是对象，该级忽略。`);
    return {};
  }

  const raw = parsed as Record<string, unknown>;
  const result: PartialTierModels = {};
  for (const tier of MODEL_TIERS) {
    if (!hasOwn(raw, tier)) continue;
    const value = raw[tier];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      warnInvalid(path, tier, value);
      result[tier] = [];
      continue;
    }
    result[tier] = value as string[];
  }
  return result;
  },
  catch: (error) => error,
}).pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    console.warn(
      `[hpl-model-tiers] 读取 ${path} 失败，该级忽略：${String(error)}`,
    );
    return {};
  })),
);

/** 项目级按档位替换全局级；项目文件缺少某档时沿用全局该档。 */
export function mergeTierConfigs(global: PartialTierModels, project: PartialTierModels): TierModels {
  return {
    high: [...(project.high ?? global.high ?? [])],
    mid: [...(project.mid ?? global.mid ?? [])],
    low: [...(project.low ?? global.low ?? [])],
  };
}

export const readModelTiersEffect = (cwd: string): Effect.Effect<TierModels, never> =>
  Effect.try({
    try: () => hapilonHome(),
    catch: (error) => error,
  }).pipe(
    Effect.flatMap((base) =>
      Effect.all({
        global: readTierConfigFileEffect(join(base, "model-tiers.json")),
        project: readTierConfigFileEffect(join(cwd, ".hapilon", "model-tiers.json")),
      }).pipe(Effect.map(({ global, project }) => mergeTierConfigs(global, project))),
    ),
    Effect.catchAll((error) => Effect.sync(() => {
      console.warn(`[hpl-model-tiers] 配置加载失败，按空档位继续：${String(error)}`);
      return { high: [], mid: [], low: [] } as TierModels;
    })),
  );

export function readModelTiers(cwd: string): TierModels {
  return Effect.runSync(readModelTiersEffect(cwd));
}
