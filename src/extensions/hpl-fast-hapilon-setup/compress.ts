import { Data, Effect } from "effect";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** 一个压缩档位：最大上下文不低于 above 的模型用它（从高往低匹配，匹配不到就不覆盖） */
export interface CompressTier {
  above: number;
  /** 软提醒的触发条件：自上次压缩起上下文增长到这个 token 数 */
  growth: number;
  /** 强制提醒的触发条件：窗口占用达到这个比例 */
  hard: number;
}

export interface CompressPreset {
  label: string;
  tiers: readonly CompressTier[];
}

/**
 * 档位取值来自历史会话（1,276 个）：1M 窗口 97% 的会话不到 250k，而 50k 增长量在 126k
 * （12%）就压缩；glm-5.3-flash 过 100k 后小请求延迟翻倍（3.3s → 6.1s），1M 档取 150k
 * 不再往上。500k 档按 20% 取；272k 及以下维持插件默认，那档 p90 已到窗口 72%。
 * 「紧凑」与插件默认相同，等同清掉这些模型的覆盖。
 */
export const COMPRESS_PRESETS: readonly CompressPreset[] = [
  {
    label: "均衡（推荐）",
    tiers: [
      { above: 1_000_000, growth: 150_000, hard: 0.6 },
      { above: 500_000, growth: 100_000, hard: 0.7 },
    ],
  },
  {
    label: "宽松",
    tiers: [
      { above: 1_000_000, growth: 250_000, hard: 0.7 },
      { above: 500_000, growth: 150_000, hard: 0.75 },
      { above: 300_000, growth: 75_000, hard: 0.8 },
    ],
  },
  { label: "紧凑（插件默认）", tiers: [] },
];

export interface CompressModel {
  provider: string;
  id: string;
  contextWindow: number;
}

type Json = Record<string, unknown>;

const isJsonObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function tierFor(preset: CompressPreset, contextWindow: number): CompressTier | undefined {
  if (contextWindow <= 0) return undefined;
  return preset.tiers.find((tier) => contextWindow >= tier.above);
}

const formatTier = (tier: CompressTier): string => `${tier.growth / 1000}k / ${Math.round(tier.hard * 100)}%`;

/** 菜单里每个预设一行的摘要：按档列出窗口、模型数、增长量 / 硬限 */
export function presetSummary(preset: CompressPreset, models: readonly CompressModel[]): string {
  const rows = preset.tiers.map((tier) => {
    const members = models.filter((model) => tierFor(preset, model.contextWindow) === tier).length;
    return `≥${tier.above / 1000}k×${members}: ${formatTier(tier)}`;
  });
  return rows.length > 0 ? rows.join(" · ") : "全部模型按插件默认";
}

/**
 * 纯函数：按预设改写 acp.json 的内容。每个可用模型按窗口落到一档，写进
 * compress.providers.<provider>.models.<id>；匹配不到档的模型删掉条目（回落默认）。
 * preserveRecentTools 固定加 read：压缩后 45% 的 read 是重读（压缩前 9%），新读的文件
 * 不进近期保护区就会被折掉再读回来。其余键原样保留。
 */
export function withCompressPreset(config: Json, preset: CompressPreset, models: readonly CompressModel[]): Json {
  const compress = isJsonObject(config.compress) ? config.compress : {};
  const existingProviders = compress.providers;
  const providers = isJsonObject(existingProviders) ? { ...existingProviders } : {};
  for (const model of models) {
    const tier = tierFor(preset, model.contextWindow);
    const existingProvider = providers[model.provider];
    const provider = isJsonObject(existingProvider) ? { ...existingProvider } : {};
    const entries = isJsonObject(provider.models) ? { ...provider.models } : {};
    if (tier) entries[model.id] = { nudgeGrowthTokens: tier.growth, maxContextLimit: tier.hard };
    else delete entries[model.id];
    providers[model.provider] = { ...provider, models: entries };
  }
  return {
    ...config,
    preserveRecentTools: ["read"],
    compress: { ...compress, providers },
  };
}

export class CompressConfigError extends Data.TaggedError("CompressConfigError")<{ message: string }> {}

/** 读 → 改写 → 写。文件损坏时报错不动它：这是用户主动触发的写入，不能静默跳过。 */
export const applyCompressPresetEffect = (
  path: string,
  preset: CompressPreset,
  models: readonly CompressModel[],
): Effect.Effect<void, CompressConfigError> =>
  Effect.gen(function* () {
    const current: unknown = yield* Effect.try({
      try: () => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}),
      catch: (cause) => new CompressConfigError({ message: `${path} 不是合法 JSON，未改动：${String(cause)}` }),
    });
    if (!isJsonObject(current)) {
      return yield* Effect.fail(new CompressConfigError({ message: `${path} 顶层不是对象，未改动` }));
    }
    const next = withCompressPreset(current, preset, models);
    yield* Effect.try({
      try: () => writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf8"),
      catch: (cause) => new CompressConfigError({ message: `写入 ${path} 失败：${String(cause)}` }),
    });
  });
