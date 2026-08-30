/**
 * config.ts — ~/.hapilon/config.json 持久化（pop 段）
 *
 * 读/写 hapilon 统一配置文件的 "pop" 字段。
 * 格式: { "pop": { "include": [...], "exclude": [...], "keys": [...], "maxLines": 5 } }
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { configFilePath } from "../../hapilon-home.js";
import { config, DEFAULT_KEYS, DEFAULT_MAX_LINES } from "./shared.js";
function readRaw() {
    const path = configFilePath();
    if (!existsSync(path))
        return {};
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return {};
    }
}
function writeRaw(data) {
    const path = configFilePath();
    const parent = dirname(path);
    if (!existsSync(parent))
        mkdirSync(parent, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}
/** 从 ~/.hapilon/config.json 加载 pop 配置 */
export function loadPopConfig() {
    const raw = readRaw();
    const pop = (raw.pop ?? {});
    config.include = Array.isArray(pop.include) ? pop.include : [];
    config.exclude = Array.isArray(pop.exclude) ? pop.exclude : [];
    config.keys = Array.isArray(pop.keys) && pop.keys.length ? pop.keys : [...DEFAULT_KEYS];
    const ml = pop.maxLines ?? DEFAULT_MAX_LINES;
    config.maxLines = Number.isInteger(ml) && ml >= 0 ? ml : DEFAULT_MAX_LINES;
}
/** 保存 pop 配置到 ~/.hapilon/config.json（不覆盖其他字段） */
export function savePopConfig() {
    const raw = readRaw();
    raw.pop = {
        include: config.include,
        exclude: config.exclude,
        keys: config.keys,
        maxLines: config.maxLines,
    };
    writeRaw(raw);
}
/**
 * 应用一个配置操作，返回一行结果文本。
 * 与 pi-pop 的 applyPopConfig 相同接口。
 */
export function applyPopConfig(action, pattern) {
    const p = (pattern ?? "").trim();
    const needsPattern = action === "show" || action === "hide" || action === "remove";
    if (needsPattern && !p)
        return `"${action}" needs a pattern`;
    switch (action) {
        case "maxlines": {
            const n = parseInt(p, 10);
            if (Number.isFinite(n) && n >= 0)
                config.maxLines = n;
            savePopConfig();
            return config.maxLines
                ? `collapsed panels capped at ${config.maxLines} lines`
                : "collapsed line cap off";
        }
        case "show":
            if (!config.include.includes(p))
                config.include.push(p);
            break;
        case "hide":
            if (!config.exclude.includes(p))
                config.exclude.push(p);
            break;
        case "remove":
            config.include = config.include.filter((x) => x !== p);
            config.exclude = config.exclude.filter((x) => x !== p);
            break;
        case "reset":
            config.include = [];
            config.exclude = [];
            break;
        case "list":
            return [
                "hapi-pop config",
                `  show:     ${config.include.join(", ") || "none"}`,
                `  hide:     ${config.exclude.join(", ") || "none"}`,
                `  maxLines: ${config.maxLines || "off"}`,
                `  open:     ${config.keys.join(", ")}`,
            ].join("\n");
        default:
            return `unknown action "${action}" (use show, hide, remove, maxlines, list, reset)`;
    }
    savePopConfig();
    if (action === "show")
        return `${p} added to panels`;
    if (action === "hide")
        return `${p} removed from panels`;
    if (action === "remove")
        return `${p} rule removed`;
    return "panel rules reset";
}
