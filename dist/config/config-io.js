import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configFilePath, configFilePathEffect } from "./hapilon-home.js";
import { Data, Effect } from "effect";
export class ConfigWriteError extends Data.TaggedError("ConfigWriteError") {
}
// ─── Config file I/O ─────────────────────────────────────────────────
export const readHapilonConfigEffect = Effect.sync(() => {
    const path = configFilePath();
    if (!existsSync(path))
        return {};
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            console.warn("Warning: config.json 格式异常，将以空配置处理");
            return {};
        }
        // Validate property types
        const obj = parsed;
        const result = {};
        if (typeof obj.defaultProvider === "string") {
            result.defaultProvider = obj.defaultProvider;
        }
        else if (obj.defaultProvider !== undefined) {
            console.warn("Warning: config.json 中 defaultProvider 不是字符串，已忽略");
        }
        if (typeof obj.defaultModel === "string") {
            result.defaultModel = obj.defaultModel;
        }
        else if (obj.defaultModel !== undefined) {
            console.warn("Warning: config.json 中 defaultModel 不是字符串，已忽略");
        }
        if (typeof obj.safetyNoticeShown === "boolean") {
            result.safetyNoticeShown = obj.safetyNoticeShown;
        }
        else if (obj.safetyNoticeShown !== undefined) {
            console.warn("Warning: config.json 中 safetyNoticeShown 不是布尔值，已忽略");
        }
        return result;
    }
    catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(`Warning: config.json 读取或解析失败 (${detail})，将以空配置处理`);
        return {};
    }
});
export function readHapilonConfig() {
    const result = Effect.runSync(Effect.either(readHapilonConfigEffect));
    if (result._tag === "Left")
        throw new Error(result.left.message);
    return result.right;
}
export const writeHapilonConfigEffect = (config) => Effect.gen(function* () {
    const path = yield* configFilePathEffect.pipe(Effect.mapError((error) => new ConfigWriteError({ message: error.message })));
    yield* Effect.try({
        try: () => {
            const parent = dirname(path);
            if (!existsSync(parent)) {
                mkdirSync(parent, { recursive: true, mode: 0o700 });
            }
            writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
        },
        catch: (err) => {
            const detail = err instanceof Error ? err.message : String(err);
            return new ConfigWriteError({ message: detail });
        },
    });
});
export function writeHapilonConfig(config) {
    const result = Effect.runSync(Effect.either(writeHapilonConfigEffect(config)));
    if (result._tag === "Left") {
        throw new Error(result.left.message);
    }
}
function readJsonObject(path) {
    if (!existsSync(path))
        return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${path} 不是 JSON 对象`);
    }
    return parsed;
}
function migrateLegacyDefaults() {
    const configPath = configFilePath();
    const config = readJsonObject(configPath);
    if (!config)
        return false;
    const legacyProvider = typeof config.defaultProvider === "string" && config.defaultProvider
        ? config.defaultProvider
        : undefined;
    const legacyModel = typeof config.defaultModel === "string" && config.defaultModel
        ? config.defaultModel
        : undefined;
    if (!legacyProvider && !legacyModel)
        return false;
    const settingsPath = join(hapilonAgentDir(), "settings.json");
    const settings = readJsonObject(settingsPath) ?? {};
    let settingsChanged = false;
    if (legacyProvider && typeof settings.defaultProvider !== "string") {
        settings.defaultProvider = legacyProvider;
        settingsChanged = true;
    }
    if (legacyModel && typeof settings.defaultModel !== "string") {
        settings.defaultModel = legacyModel;
        settingsChanged = true;
    }
    if (settingsChanged) {
        const parent = dirname(settingsPath);
        if (!existsSync(parent))
            mkdirSync(parent, { recursive: true, mode: 0o700 });
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    }
    delete config.defaultProvider;
    delete config.defaultModel;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    return true;
}
function hapilonAgentDir() {
    return join(dirname(configFilePath()), "agent");
}
/**
 * 将旧版 hapilon 默认模型迁移到 Pi 原生 settings。
 * 所有文件 I/O 均在 Effect.try 中执行；失败只告警，不阻断启动。
 */
export const migrateLegacyDefaultsEffect = Effect.gen(function* () {
    const result = yield* Effect.try({
        try: migrateLegacyDefaults,
        catch: (error) => error,
    }).pipe(Effect.either);
    if (result._tag === "Left") {
        const detail = result.left instanceof Error ? result.left.message : String(result.left);
        console.warn(`Warning: 迁移旧默认模型配置失败 (${detail})，将继续启动。`);
        return false;
    }
    if (result.right) {
        console.log("已将 hapilon 默认模型配置迁移到 Pi 原生 settings.json。");
    }
    return result.right;
});
// ─── CLI arg helpers ─────────────────────────────────────────────────
/** hapilon 自有 flag 注册表 —— pi 不认识、spawn 前必须剥离的参数 */
export const HAPILON_FLAGS = ["--no-safety", "--sandbox", "--no-econ"];
export function hasFlag(args, flag) {
    return args.some((a) => a === flag || a.startsWith(flag + "="));
}
/**
 * 剥离 hapilon 自有 flag（含 --flag=value 形式，与 hasFlag 语义对称）。
 *
 * hapilon 是 pi 的薄包装：未知命令/参数原样透传（issue #14），
 * 但自有 flag 是 hapilon 的启动器语义，pi 不认识——透传会让 pi 直接
 * 报 Unknown option 退出（#38）。新增自有 flag 时在此注册一处。
 */
export function stripHapilonFlags(args) {
    return args.filter((a) => !HAPILON_FLAGS.some((f) => a === f || a.startsWith(f + "=")));
}
