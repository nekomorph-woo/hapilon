import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
// ─── CLI arg helpers ─────────────────────────────────────────────────
/** hapilon 自有 flag 注册表 —— pi 不认识、spawn 前必须剥离的参数 */
export const HAPILON_FLAGS = ["--no-safety", "--sandbox", "--no-econ", "--setup-windows"];
export function hasFlag(args, flag) {
    return args.some((a) => a === flag || a.startsWith(flag + "="));
}
/**
 * 剥离 hapilon 自有 flag（含 --flag=value 形式，与 hasFlag 语义对称）。
 *
 * hapilon 是 pi 的薄包装：未知命令/参数原样透传，
 * 但自有 flag 是 hapilon 的启动器语义，pi 不认识——透传会让 pi 直接
 * 报 Unknown option 退出。新增自有 flag 时在此注册一处。
 */
export function stripHapilonFlags(args) {
    return args.filter((a) => !HAPILON_FLAGS.some((f) => a === f || a.startsWith(f + "=")));
}
/**
 * 提取 --team-role / --team-role-prompt-file / --team-tasks 并从参数中剥离。
 * role 身份只随命令行走：pane split --env 注入的变量会永久留在 pane shell
 * 里，之后人工在该 shell 重启会被静默变回角色面板。任务列表路径同理。
 */
export function takeTeamRoleFlags(args) {
    const rest = [];
    let role;
    let promptFile;
    let tasks;
    let dangling;
    const flags = ["--team-role", "--team-role-prompt-file", "--team-tasks"];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const flag = flags.find((f) => arg === f || arg.startsWith(f + "="));
        if (!flag) {
            rest.push(arg);
            continue;
        }
        const target = flag === "--team-role" ? "role" : flag === "--team-tasks" ? "tasks" : "promptFile";
        let value;
        if (arg === flag) {
            value = args[i + 1];
            if (value === undefined) {
                dangling = flag;
                continue;
            }
            i++;
        }
        else {
            value = arg.slice(flag.length + 1);
        }
        if (target === "role")
            role = value;
        else if (target === "tasks")
            tasks = value;
        else
            promptFile = value;
    }
    return { role, promptFile, tasks, dangling, rest };
}
