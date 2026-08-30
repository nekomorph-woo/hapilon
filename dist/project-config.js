/**
 * project-config.ts — 项目级 .hapilon/ 配置 I/O
 *
 * 三级合并链：
 *   .hapilon/config.local.json > .hapilon/config.json > ~/.hapilon/config.json
 *        (个人本地覆盖)            (团队共享)              (用户全局基线)
 *
 * 用法：
 *   import { readProjectConfig, writeProjectLocalConfig } from "./project-config.js";
 *   const config = readProjectConfig();  // 自动检测当前项目
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readHapilonConfig } from "./config-io.js";
// ─── Path helpers ────────────────────────────────────────────────────
export function projectHapilonDir(cwd) {
    return join(cwd ?? process.cwd(), ".hapilon");
}
function projectConfigPath(cwd) {
    return join(projectHapilonDir(cwd), "config.json");
}
function projectLocalConfigPath(cwd) {
    return join(projectHapilonDir(cwd), "config.local.json");
}
function readJSON(path) {
    if (!existsSync(path))
        return null;
    try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            return null;
        return parsed;
    }
    catch (err) {
        console.warn(`Warning: 读取 ${path} 失败:`, err instanceof Error ? err.message : String(err));
        return null;
    }
}
// ─── Deep merge (shallow — config fields are flat) ──────────────────
function mergeConfig(base, override) {
    const result = { ...base };
    for (const key of Object.keys(override)) {
        if (override[key] !== undefined && override[key] !== null) {
            result[key] = override[key];
        }
    }
    return result;
}
/**
 * 读取项目级 config.local.json（不含合并，纯本地配置）。
 */
export function readProjectLocalConfig(cwd) {
    return readJSON(projectLocalConfigPath(cwd)) ?? {};
}
// ─── Core API ────────────────────────────────────────────────────────
/**
 * 读取项目级合并配置。
 *
 * 优先级：project config.local.json > project config.json > user config.json
 */
export function readProjectConfig(cwd) {
    // L1: user-level baseline
    const userConfig = readHapilonConfig();
    // L2: project config.json
    const sharedPath = projectConfigPath(cwd);
    const sharedJson = readJSON(sharedPath);
    // L3: project config.local.json
    const localPath = projectLocalConfigPath(cwd);
    const localJson = readJSON(localPath);
    let result = { ...userConfig };
    if (sharedJson)
        result = mergeConfig(result, sharedJson);
    if (localJson)
        result = mergeConfig(result, localJson);
    return result;
}
/**
 * 更新项目级 config.local.json 的指定字段，保留已有其他字段。
 */
export function writeProjectLocalConfig(partial, cwd) {
    try {
        const hapDir = projectHapilonDir(cwd);
        if (!existsSync(hapDir)) {
            mkdirSync(hapDir, { recursive: true, mode: 0o700 });
        }
        const path = projectLocalConfigPath(cwd);
        const existing = readJSON(path) ?? {};
        const merged = mergeConfig(existing, partial);
        writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
    }
    catch (err) {
        console.warn("写入项目级配置失败:", err instanceof Error ? err.message : String(err));
    }
}
