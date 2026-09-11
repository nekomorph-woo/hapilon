import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import { MODEL_TIERS } from "./bridge.js";
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function warnInvalid(path, tier, value) {
    console.warn(`[hpl-model-tiers] ${path} 中 ${tier} 无效（需要 string[]，收到 ${JSON.stringify(value)}），该档按空处理。`);
}
/** 读取单层文件；缺档不出现在返回值中，便于项目级按档位替换全局级。 */
export const readTierConfigFileEffect = (path) => Effect.try({
    try: () => {
        if (!existsSync(path))
            return {};
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(path, "utf8"));
        }
        catch (error) {
            console.warn(`[hpl-model-tiers] 无法读取 ${path}，该级忽略：${error instanceof Error ? error.message : String(error)}`);
            return {};
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            console.warn(`[hpl-model-tiers] ${path} 顶层必须是对象，该级忽略。`);
            return {};
        }
        const raw = parsed;
        const result = {};
        for (const tier of MODEL_TIERS) {
            if (!hasOwn(raw, tier))
                continue;
            const value = raw[tier];
            if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
                warnInvalid(path, tier, value);
                result[tier] = [];
                continue;
            }
            result[tier] = value;
        }
        return result;
    },
    catch: (error) => error,
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-model-tiers] 读取 ${path} 失败，该级忽略：${String(error)}`);
    return {};
})));
/** 项目级按档位替换全局级；项目文件缺少某档时沿用全局该档。 */
export function mergeTierConfigs(global, project) {
    return {
        opus: [...(project.opus ?? global.opus ?? [])],
        sonnet: [...(project.sonnet ?? global.sonnet ?? [])],
        haiku: [...(project.haiku ?? global.haiku ?? [])],
    };
}
export const readModelTiersEffect = (cwd) => Effect.try({
    try: () => hapilonHome(),
    catch: (error) => error,
}).pipe(Effect.flatMap((base) => Effect.all({
    global: readTierConfigFileEffect(join(base, "model-tiers.json")),
    project: readTierConfigFileEffect(join(cwd, ".hapilon", "model-tiers.json")),
}).pipe(Effect.map(({ global, project }) => mergeTierConfigs(global, project)))), Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-model-tiers] 配置加载失败，按空档位继续：${String(error)}`);
    return { opus: [], sonnet: [], haiku: [] };
})));
export function readModelTiers(cwd) {
    return Effect.runSync(readModelTiersEffect(cwd));
}
/** 交互编辑器的全局写回通道；失败只 warning，不让命令炸掉会话。 */
export const saveModelTiersEffect = (tiers) => Effect.try({
    try: () => {
        const home = hapilonHome();
        mkdirSync(home, { recursive: true, mode: 0o700 });
        writeFileSync(join(home, "model-tiers.json"), JSON.stringify(tiers, null, 2) + "\n", "utf8");
        return true;
    },
    catch: (error) => error,
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-model-tiers] 保存 model-tiers.json 失败：${String(error)}`);
    return false;
})));
