/**
 * subagent-models 配置读取。
 *
 * 双层：全局 $HAPILON_HOME/subagent-models.json，项目 <cwd>/.hapilon/subagent-models.json。
 * 项目文件存在即整体替换全局（有序列表做部分合并没有清晰语义）。两层都缺、
 * enabled:false 或列表为空时扩展不介入，派发自然继承父 agent 的模型。
 *
 * 条目格式与 tiers 模型串一致："provider/id[:thinking]"。
 */
import { notify } from "../notify.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import { splitThinkingSuffix } from "../hpl-model-tiers/resolved.js";
const INERT = { enabled: false, entries: [] };
export function globalSubagentModelsPath() {
    return join(hapilonHome(), "subagent-models.json");
}
export function projectSubagentModelsPath(cwd) {
    return join(cwd, ".hapilon", "subagent-models.json");
}
const PREFIX = "[hpl-subagent-models]";
/** 单层文件读取：缺文件返回 undefined（区别于「文件存在但为空」）。 */
const readLayerEffect = (path) => Effect.try({
    try: () => {
        if (!existsSync(path))
            return undefined;
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(path, "utf8"));
        }
        catch (error) {
            notify(`${PREFIX} ${path} 不是合法 JSON，该级忽略：${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            notify(`${PREFIX} ${path} 顶层必须是对象，该级忽略。`);
            return undefined;
        }
        const raw = parsed;
        const enabled = raw["enabled"] === undefined ? true : raw["enabled"] === true;
        if (raw["enabled"] !== undefined && typeof raw["enabled"] !== "boolean") {
            notify(`${PREFIX} ${path} 的 enabled 非布尔值，按 true 处理。`);
        }
        const models = Array.isArray(raw["models"]) && raw["models"].every((m) => typeof m === "string")
            ? raw["models"]
            : (notify(`${PREFIX} ${path} 的 models 非法（需要 string[]），按空列表处理。`), []);
        return { enabled, models };
    },
    catch: (error) => error,
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    notify(`${PREFIX} 读取 ${path} 失败，该级忽略：${String(error)}`);
    return undefined;
})));
/** 条目解析：非法条目告警后跳过，不让一个坏条目拖垮整张列表。 */
export function parseModelEntry(raw, path) {
    const { pattern, thinking } = splitThinkingSuffix(raw.trim());
    const slash = pattern.indexOf("/");
    if (slash <= 0 || slash === pattern.length - 1) {
        notify(`${PREFIX} ${path} 条目 "${raw}" 非法（应为 provider/id[:thinking]），跳过。`);
        return undefined;
    }
    return {
        provider: pattern.slice(0, slash),
        id: pattern.slice(slash + 1),
        ...(thinking !== undefined ? { thinking } : {}),
    };
}
/** 全局 + 项目两层解析；项目文件存在即整体替换全局。 */
export const readSubagentModelsEffect = (cwd) => Effect.gen(function* () {
    const global = yield* readLayerEffect(globalSubagentModelsPath());
    const project = yield* readLayerEffect(projectSubagentModelsPath(cwd));
    const layer = project ?? global;
    if (!layer || !layer.enabled)
        return INERT;
    const path = project ? projectSubagentModelsPath(cwd) : globalSubagentModelsPath();
    const entries = layer.models.flatMap((model) => {
        const entry = parseModelEntry(model, path);
        return entry ? [entry] : [];
    });
    return { enabled: layer.enabled, entries };
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    notify(`${PREFIX} 配置加载失败，扩展不介入：${String(error)}`);
    return INERT;
})));
/** 编辑器用：两层原始内容（缺文件为 undefined）。 */
export const readSubagentLayersEffect = (cwd) => Effect.all({
    global: readLayerEffect(globalSubagentModelsPath()),
    project: readLayerEffect(projectSubagentModelsPath(cwd)),
});
/** 交互编辑器的写回通道；失败只告警，不让命令炸掉会话。 */
export const saveSubagentModelsLayerEffect = (path, layer) => Effect.try({
    try: () => {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, JSON.stringify({ enabled: layer.enabled, models: layer.models }, null, 2) + "\n", "utf8");
        return true;
    },
    catch: (error) => error,
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    notify(`${PREFIX} 保存 ${path} 失败：${String(error)}`);
    return false;
})));
