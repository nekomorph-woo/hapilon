/**
 * trust-store.ts — 命令+路径双维度信任存储
 *
 * session 级：内存 Map<toolName, Set<target>>，结束自动清除
 * project 级：持久化到 .hapilon/config.local.json 的 allow 字段
 *
 * 使用：
 *   - confirm 路径 → isTrusted() 检查（session + project）
 *   - block 路径 → isSessionTrusted() 检查（仅 session）
 *
 */
import { readProjectConfig, writeProjectLocalConfig, readProjectLocalConfig } from "./project-config.js";
// ─── Session 级信任（内存）──────────────────────────────────────────
const sessionTrust = new Map();
// ─── Session API ─────────────────────────────────────────────────────
export function addSessionTrust(toolName, target) {
    let set = sessionTrust.get(toolName);
    if (!set) {
        set = new Set();
        sessionTrust.set(toolName, set);
    }
    set.add(target);
}
export function isSessionTrusted(toolName, target) {
    const set = sessionTrust.get(toolName);
    return set?.has(target) ?? false;
}
export function clearSessionTrust() {
    sessionTrust.clear();
}
export function listSessionTrust() {
    const result = [];
    for (const [toolName, set] of sessionTrust) {
        if (set.size > 0) {
            result.push({ toolName, targets: [...set] });
        }
    }
    return result;
}
// ─── Project API ─────────────────────────────────────────────────────
/** 仅读本地 config.local.json 的 allow（不合并团队 config.json） */
function loadLocalAllow(cwd) {
    const local = readProjectLocalConfig(cwd);
    const allow = local.allow;
    if (allow && typeof allow === "object" && !Array.isArray(allow)) {
        return allow;
    }
    return {};
}
/** 读合并后的 allow（用于检查：含团队 config.json + 本地） */
function loadMergedAllow(cwd) {
    const config = readProjectConfig(cwd);
    const allow = config.allow;
    if (allow && typeof allow === "object" && !Array.isArray(allow)) {
        return allow;
    }
    return {};
}
function saveLocalAllow(allow, cwd) {
    try {
        writeProjectLocalConfig({ allow }, cwd);
    }
    catch (err) {
        console.warn("写入项目级信任配置失败:", err instanceof Error ? err.message : String(err));
    }
}
// ─── Project trust 内存缓存（issue #15）──────────────────────────────
// cwd → merged allow 快照。initProjectTrust 加载一次，此后检查走缓存；
// addProjectTrust 同步更新缓存。未 init 的 cwd 仍实时读盘（懒加载不缓存）。
const projectCache = new Map();
/**
 * 初始化项目信任缓存（扩展加载时调用一次）。
 * 此后 isProjectTrusted/listProjectTrust 命中缓存，避免每次检查都 fs I/O。
 */
export function initProjectTrust(cwd) {
    projectCache.set(cwd, loadMergedAllow(cwd));
}
export function addProjectTrust(toolName, target, cwd) {
    const allow = loadLocalAllow(cwd);
    const list = allow[toolName] ?? [];
    if (!list.includes(target)) {
        list.push(target);
    }
    allow[toolName] = list;
    saveLocalAllow(allow, cwd);
    // 同步更新缓存（若该 cwd 已初始化）
    const cached = projectCache.get(cwd);
    if (cached) {
        const cachedList = cached[toolName] ?? [];
        if (!cachedList.includes(target)) {
            cached[toolName] = [...cachedList, target];
        }
    }
}
export function isProjectTrusted(toolName, target, cwd) {
    const allow = projectCache.get(cwd) ?? loadMergedAllow(cwd);
    const list = allow[toolName];
    return list?.includes(target) ?? false;
}
export function listProjectTrust(cwd) {
    const allow = projectCache.get(cwd) ?? loadMergedAllow(cwd);
    return Object.entries(allow).map(([toolName, targets]) => ({ toolName, targets: targets }));
}
/**
 * 添加信任。
 * @param scope "session" — 内存 / "project" — 持久化到 config.local.json
 */
export function addTrust(toolName, target, scope, cwd) {
    if (scope === "session") {
        addSessionTrust(toolName, target);
    }
    else {
        addProjectTrust(toolName, target, cwd);
    }
}
/**
 * 检查是否有信任（confirm 路径用）。
 * 查询顺序：session → project
 */
export function isTrusted(toolName, target, cwd) {
    if (isSessionTrusted(toolName, target))
        return true;
    return isProjectTrusted(toolName, target, cwd);
}
