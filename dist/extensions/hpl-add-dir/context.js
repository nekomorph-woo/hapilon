/**
 * context.ts — hpl-add-dir 目录上下文扫描与注入构建（纯函数）
 *
 * vendor 自 pi-add-dir v1.3.1，按 hapilon 受控上下文设计改造（#29）：
 * 只注入 HAPILON.md（目录根 + .pi/ 子目录），AGENTS.md / CLAUDE.md
 * 不读取、不注入；外部 skills 不注入、不注册。
 */
import * as fs from "node:fs";
import * as path from "node:path";
// ─── 共享辅助函数 ──────────────────────────────────────────────────────
/** 只注入 HAPILON.md——hapilon 受控上下文体系（AGENTS/CLAUDE 由 --no-context-files 关闭） */
const CONTEXT_FILES = ["HAPILON.md"];
// 要扫描的扩展目录，相对于项目根目录
const EXTENSION_DIRS = [".pi/extensions"];
/** 解析输入为绝对路径（相对路径基于 cwd），realpath 失败时回退 resolve */
export function resolveDir(input, cwd) {
    const resolved = path.isAbsolute(input) ? input : path.resolve(cwd, input);
    try {
        return fs.realpathSync(resolved);
    }
    catch {
        return path.resolve(resolved);
    }
}
export function dirExists(dir) {
    try {
        return fs.statSync(dir).isDirectory();
    }
    catch {
        return false;
    }
}
export function fileExists(filePath) {
    try {
        return fs.statSync(filePath).isFile();
    }
    catch {
        return false;
    }
}
export function readFileSafe(filePath) {
    try {
        return fs.readFileSync(filePath, "utf-8");
    }
    catch {
        return null;
    }
}
// ─── 扫描 ─────────────────────────────────────────────────────────────
/**
 * 扫描目录中的 HAPILON.md（根 + .pi/ 子目录）和扩展提示。
 */
export function scanDirContext(dir) {
    const ctx = {
        hapilonMd: null,
        extensionPaths: [],
    };
    // 从根目录和 .pi/ 子目录读取 HAPILON.md
    for (const name of CONTEXT_FILES) {
        const content = readFileSafe(path.join(dir, name));
        if (content)
            ctx.hapilonMd = content;
    }
    for (const name of CONTEXT_FILES) {
        const piContent = readFileSafe(path.join(dir, ".pi", name));
        if (piContent) {
            ctx.hapilonMd = (ctx.hapilonMd ?? "") + "\n\n" + piContent;
        }
    }
    // 发现扩展（仅提示，不自动加载——与 pi-add-dir 原行为一致）
    for (const extDir of EXTENSION_DIRS) {
        const fullExtDir = path.join(dir, extDir);
        if (!dirExists(fullExtDir))
            continue;
        try {
            const entries = fs.readdirSync(fullExtDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith(".ts")) {
                    ctx.extensionPaths.push(path.join(fullExtDir, entry.name));
                }
                else if (entry.isDirectory()) {
                    const indexPath = path.join(fullExtDir, entry.name, "index.ts");
                    if (readFileSafe(indexPath) !== null) {
                        ctx.extensionPaths.push(indexPath);
                    }
                }
            }
        }
        catch {
            // 跳过不可读的目录
        }
    }
    return ctx;
}
// ─── 上下文注入缓存 ──────────────────────────────────────────
let contextCache = null;
/**
 * 使上下文注入缓存失效。
 * 在添加/移除目录时调用，以便下一轮重新扫描。
 */
export function invalidateContextCache() {
    contextCache = null;
}
/**
 * 根据所有已添加目录构建系统提示注入。
 * 按目录列表缓存——仅当目录变化时重新扫描。
 */
export function buildContextInjection(dirs) {
    if (dirs.length === 0)
        return "";
    // 缓存键：排序后的绝对路径
    const cacheKey = dirs.map((d) => d.absolutePath).sort().join("\0");
    if (contextCache && contextCache.dirs === cacheKey) {
        return contextCache.injection;
    }
    const sections = [];
    sections.push("\n\n## External Directories (added via /add-dir)");
    sections.push(`\nThe following ${dirs.length} external director${dirs.length === 1 ? "y is" : "ies are"} included in this session. You can read, edit, and write files in these directories using absolute paths.\n`);
    for (const dir of dirs) {
        const ctx = scanDirContext(dir.absolutePath);
        sections.push(`### 📁 ${dir.label} — \`${dir.absolutePath}\``);
        // HAPILON.md — 唯一注入的上下文文件（hapilon 受控上下文设计）
        if (ctx.hapilonMd) {
            sections.push(`\n#### HAPILON.md (from ${dir.label})\n${ctx.hapilonMd}`);
        }
        // 目录内容摘要
        try {
            const entries = fs.readdirSync(dir.absolutePath, { withFileTypes: true });
            const topLevel = entries
                .filter((e) => !e.name.startsWith(".") || e.name === ".pi" || e.name === ".agents")
                .slice(0, 20)
                .map((e) => `${e.isDirectory() ? "📂" : "📄"} ${e.name}`);
            if (topLevel.length > 0) {
                sections.push(`\n<details><summary>Top-level contents</summary>\n\n${topLevel.join("\n")}\n</details>`);
            }
        }
        catch {
            // 不可读时跳过
        }
    }
    const injection = sections.join("\n");
    contextCache = { dirs: cacheKey, injection };
    return injection;
}
