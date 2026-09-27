import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Data, Effect, Schema } from "effect";
import { matchesModelPattern, type AvailableModel } from "../hpl-model-tiers/index.js";

export const SERVICE_TIERS = ["fast", "priority", "standard", "flex"] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];

export interface FastModeSettings {
  enabled: boolean;
  serviceTier: ServiceTier;
  models: string[];
}

export const DEFAULT_FAST_MODE_SETTINGS: FastModeSettings = {
  enabled: false,
  serviceTier: "fast",
  models: [],
};

const SettingsSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const FastModeSettingsSchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  serviceTier: Schema.optional(Schema.Literal(...SERVICE_TIERS)),
  models: Schema.optional(Schema.Array(Schema.String)),
});
const decodeSettings = Schema.decodeUnknownSync(SettingsSchema);
const decodeFastModeSettings = Schema.decodeUnknownSync(FastModeSettingsSchema);

export class FastModeSettingsError extends Data.TaggedError("FastModeSettingsError")<{
  message: string;
}> {}

function settingsPath(agentDirPath: string): string {
  return join(agentDirPath, "settings.json");
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return decodeSettings(JSON.parse(readFileSync(path, "utf8")));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const readFastModeSettingsEffect = (
  agentDirPath: string,
): Effect.Effect<FastModeSettings, never> => Effect.try({
  try: () => {
    const stored = readSettings(settingsPath(agentDirPath)).hplFastMode;
    const overrides = stored === undefined ? {} : decodeFastModeSettings(stored);
    return {
      enabled: overrides.enabled ?? DEFAULT_FAST_MODE_SETTINGS.enabled,
      serviceTier: overrides.serviceTier ?? DEFAULT_FAST_MODE_SETTINGS.serviceTier,
      models: [...(overrides.models ?? DEFAULT_FAST_MODE_SETTINGS.models)],
    };
  },
  catch: (error) => new FastModeSettingsError({ message: errorMessage(error) }),
}).pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-openai-fast-mode] settings.json 读取失败，Fast 模式关闭：${error.message}`);
    return { ...DEFAULT_FAST_MODE_SETTINGS, models: [...DEFAULT_FAST_MODE_SETTINGS.models] };
  })),
);

export const writeFastModeSettingsEffect = (
  agentDirPath: string,
  settings: FastModeSettings,
): Effect.Effect<boolean, never> => Effect.try({
  try: () => {
    const path = settingsPath(agentDirPath);
    const current = readSettings(path);
    mkdirSync(agentDirPath, { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify({ ...current, hplFastMode: settings }, null, 2)}\n`, "utf8");
    return true;
  },
  catch: (error) => new FastModeSettingsError({ message: errorMessage(error) }),
}).pipe(
  Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-openai-fast-mode] settings.json 写入失败：${error.message}`);
    return false;
  })),
);

export function matchesFastModeModel(
  settings: FastModeSettings,
  model: Pick<AvailableModel, "provider" | "id"> | undefined,
): boolean {
  return (model?.provider === "openai" || model?.provider === "openai-codex")
    && settings.models.some((pattern) => matchesModelPattern(pattern, model));
}

export function fastModeApplies(
  settings: FastModeSettings,
  model: Pick<AvailableModel, "provider" | "id"> | undefined,
): boolean {
  return settings.enabled && matchesFastModeModel(settings, model);
}

export function addFastModeModel(
  settings: FastModeSettings,
  model: Pick<AvailableModel, "provider" | "id">,
): FastModeSettings {
  const entry = `${model.provider}/${model.id}`;
  return settings.models.includes(entry)
    ? settings
    : { ...settings, models: [...settings.models, entry] };
}

export function toggleFastModeModel(
  settings: FastModeSettings,
  model: Pick<AvailableModel, "provider" | "id">,
): { settings: FastModeSettings; removedPatterns: string[] } {
  const removedPatterns = settings.models.filter((pattern) => matchesModelPattern(pattern, model));
  return removedPatterns.length > 0
    ? {
      settings: { ...settings, models: settings.models.filter((pattern) => !removedPatterns.includes(pattern)) },
      removedPatterns,
    }
    : { settings: addFastModeModel(settings, model), removedPatterns };
}

export function removeFastModeModel(settings: FastModeSettings, pattern: string): FastModeSettings {
  return { ...settings, models: settings.models.filter((entry) => entry !== pattern) };
}

const RequestBodySchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });

export function addFastModeServiceTier(
  payload: unknown,
  settings: FastModeSettings,
  model: Pick<AvailableModel, "provider" | "id"> | undefined,
): unknown | undefined {
  if (!fastModeApplies(settings, model) || !Schema.is(RequestBodySchema)(payload)) return undefined;
  const serviceTier = model?.provider === "openai-codex" && settings.serviceTier === "fast"
    ? "priority"
    : settings.serviceTier;
  return { ...payload, service_tier: serviceTier };
}
