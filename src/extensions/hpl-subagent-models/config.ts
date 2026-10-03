/**
 * 模型列表配置读取（subagent-models 与 vision-models 共用一套 IO）。
 *
 * 双层：全局 $HAPILON_HOME/<name>.json，项目 <cwd>/.hapilon/<name>.json。
 * 项目文件存在即整体替换全局（有序列表做部分合并没有清晰语义）。两层都缺、
 * enabled:false 或列表为空时扩展不介入。
 *
 * 条目格式与 tiers 模型串一致："provider/id[:thinking]"。
 */
import { notify } from "../notify.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import { splitThinkingSuffix, type ThinkingLevelName } from "../hpl-model-tiers/resolved.js";

export interface SubagentModelEntry {
  provider: string;
  id: string;
  thinking?: ThinkingLevelName;
}

export interface SubagentModelsConfig {
  enabled: boolean;
  entries: SubagentModelEntry[];
}

const INERT: SubagentModelsConfig = { enabled: false, entries: [] };

export interface SubagentModelsLayer {
  enabled: boolean;
  models: string[];
}

/** 单层文件读取：缺文件返回 undefined（区别于「文件存在但为空」）。 */
const readLayerEffect = (
  path: string,
  prefix: string,
): Effect.Effect<SubagentModelsLayer | undefined, never> =>
  Effect.try({
    try: () => {
      if (!existsSync(path)) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, "utf-8"));
      } catch (error) {
        notify(`${prefix} ${path} 不是合法 JSON，该级忽略：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        notify(`${prefix} ${path} 顶层必须是对象，该级忽略。`);
        return undefined;
      }
      const raw = parsed as Record<string, unknown>;
      const enabled = raw["enabled"] === undefined ? true : raw["enabled"] === true;
      if (raw["enabled"] !== undefined && typeof raw["enabled"] !== "boolean") {
        notify(`${prefix} ${path} 的 enabled 非布尔值，按 true 处理。`);
      }
      const models = Array.isArray(raw["models"]) && raw["models"].every((m) => typeof m === "string")
        ? (raw["models"] as string[])
        : (notify(`${prefix} ${path} 的 models 非法（需要 string[]），按空列表处理。`), []);
      return { enabled, models };
    },
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        notify(`${prefix} 读取 ${path} 失败，该级忽略：${String(error)}`);
        return undefined;
      }),
    ),
  );

/** 条目解析：非法条目告警后跳过，不让一个坏条目拖垮整张列表。 */
export function parseModelEntry(raw: string, path: string): SubagentModelEntry | undefined {
  return parseModelEntryFor(raw, path, "[hpl-subagent-models]");
}

function parseModelEntryFor(raw: string, path: string, prefix: string): SubagentModelEntry | undefined {
  const { pattern, thinking } = splitThinkingSuffix(raw.trim());
  const slash = pattern.indexOf("/");
  if (slash <= 0 || slash === pattern.length - 1) {
    notify(`${prefix} ${path} 条目 "${raw}" 非法（应为 provider/id[:thinking]），跳过。`);
    return undefined;
  }
  return {
    provider: pattern.slice(0, slash),
    id: pattern.slice(slash + 1),
    ...(thinking !== undefined ? { thinking } : {}),
  };
}

/** 一张模型列表的完整 IO（路径 + 读 + 写），subagent 与 vision 各实例化一份。 */
function makeModelListIo(listName: string, prefix: string) {
  const globalPath = (): string => join(hapilonHome(), `${listName}.json`);
  const projectPath = (cwd: string): string => join(cwd, ".hapilon", `${listName}.json`);

  const readModelsEffect = (cwd: string): Effect.Effect<SubagentModelsConfig, never> =>
    Effect.gen(function* () {
      const global = yield* readLayerEffect(globalPath(), prefix);
      const project = yield* readLayerEffect(projectPath(cwd), prefix);
      const layer = project ?? global;
      if (!layer || !layer.enabled) return INERT;
      const path = project ? projectPath(cwd) : globalPath();
      const entries = layer.models.flatMap((model) => {
        const entry = parseModelEntryFor(model, path, prefix);
        return entry ? [entry] : [];
      });
      return { enabled: layer.enabled, entries };
    });

  const readLayersEffect = (
    cwd: string,
  ): Effect.Effect<{ global: SubagentModelsLayer | undefined; project: SubagentModelsLayer | undefined }, never> =>
    Effect.all({
      global: readLayerEffect(globalPath(), prefix),
      project: readLayerEffect(projectPath(cwd), prefix),
    });

  /** 交互编辑器的写回通道；失败只告警，不让命令炸掉会话。 */
  const saveLayerEffect = (
    path: string,
    layer: SubagentModelsLayer,
  ): Effect.Effect<boolean, never> =>
    Effect.try({
      try: () => {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, JSON.stringify({ enabled: layer.enabled, models: layer.models }, null, 2) + "\n", "utf8");
        return true;
      },
      catch: (error) => error,
    }).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          notify(`${prefix} 保存 ${path} 失败：${String(error)}`);
          return false;
        }),
      ),
    );

  return { globalPath, projectPath, readModelsEffect, readLayersEffect, saveLayerEffect };
}

export const subagentModelListIo = makeModelListIo("subagent-models", "[hpl-subagent-models]");
export const visionModelListIo = makeModelListIo("vision-models", "[hpl-vision-models]");

// subagent-models 兼容导出（原有调用方与测试不动）
export const globalSubagentModelsPath = subagentModelListIo.globalPath;
export const projectSubagentModelsPath = subagentModelListIo.projectPath;
export const readSubagentModelsEffect = subagentModelListIo.readModelsEffect;
export const readSubagentLayersEffect = subagentModelListIo.readLayersEffect;
export const saveSubagentModelsLayerEffect = subagentModelListIo.saveLayerEffect;

// vision-models：多模态模型列表（vision 子代理派发用）
export const globalVisionModelsPath = visionModelListIo.globalPath;
export const projectVisionModelsPath = visionModelListIo.projectPath;
export const readVisionModelsEffect = visionModelListIo.readModelsEffect;
export const readVisionLayersEffect = visionModelListIo.readLayersEffect;
export const saveVisionModelsLayerEffect = visionModelListIo.saveLayerEffect;
