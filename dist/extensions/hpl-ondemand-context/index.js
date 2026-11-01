/**
 * hpl-ondemand-context — 子目录 HAPILON.md 按需注入
 *
 * cwd 之下子目录的 .hapilon/HAPILON.md 不进系统提示（always 层只管 cwd
 * 向上链 + 全局层），而是当模型首次 read/edit/write 该子树的文件时，把
 * 沿途层级的 HAPILON.md（浅→深）追加到工具结果尾部。每文件每分支一次；
 * 压缩（session_compact）后重置，文件再被触碰时重新注入。语义对齐
 * Claude Code 的 CLAUDE.md 子目录按需加载。
 *
 * 一次性语义的持久化：注入时 appendEntry 记录到当前分支（不进模型上下
 * 文），session_start 时从 getBranch() 重建——resume / fork 后不重复注入。
 *
 * ponytail: bash cat/head 读文件不触发（无法按命令判定「算一次读」），
 * 模型用 read 工具时自然覆盖。
 */
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { collectDownward } from "../../shared/files.js";
/** 分支记录条目类型；导出供测试对齐 */
export const ENTRY_TYPE = "hapilon-ondemand-loaded";
/** 从分支条目重建已注入集合——session_start 与单测共用 */
export function rebuildLoadedFromBranch(entries) {
    const loaded = new Set();
    for (const entry of entries) {
        if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE)
            continue;
        const paths = entry.data?.paths;
        if (Array.isArray(paths))
            for (const p of paths)
                if (typeof p === "string")
                    loaded.add(p);
    }
    return loaded;
}
const expandTilde = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
/** 找出该路径尚未注入过的按需 HAPILON.md；没有则 undefined（免读盘） */
export function collectPending(rawPath, cwd, loaded) {
    if (typeof rawPath !== "string" || rawPath.length === 0)
        return undefined;
    const pending = collectDownward(cwd, expandTilde(rawPath), "HAPILON.md").filter((p) => !loaded.has(p));
    return pending.length > 0 ? pending : undefined;
}
/** 读取待注入文件；单个失败 warning 跳过——会话中途不因坏文件炸掉工具调用 */
export function readPending(paths) {
    const entries = [];
    for (const path of paths) {
        try {
            entries.push({ path, content: readFileSync(path, "utf8") });
        }
        catch (err) {
            console.warn(`Warning: 跳过按需上下文文件 ${path}:`, err);
        }
    }
    return entries;
}
/** 渲染注入块：源路径相对 cwd，正文掐掉尾部多余换行 */
export function renderContextBlock(entries, cwd) {
    return entries
        .map((e) => `<hapilon-context source="${relative(cwd, e.path)}">\n${e.content.trimEnd()}\n</hapilon-context>`)
        .join("\n");
}
/** tool_result 核心（抽出便于单测）：返回追加上下文后的内容与新注入路径 */
export function handleToolResult(event, cwd, loaded) {
    if (event.isError)
        return undefined;
    if (event.toolName !== "read" && event.toolName !== "edit" && event.toolName !== "write") {
        return undefined;
    }
    const pending = collectPending(event.input.path, cwd, loaded);
    if (!pending)
        return undefined;
    const entries = readPending(pending);
    if (entries.length === 0)
        return undefined;
    const block = renderContextBlock(entries, cwd);
    return {
        content: [...event.content, { type: "text", text: block }],
        // 只登记实际注入了的条目，避免读失败的文件永久跳过
        paths: entries.map((e) => e.path),
    };
}
export default function (pi) {
    let loaded = new Set();
    pi.on("session_start", (_event, ctx) => {
        loaded = rebuildLoadedFromBranch(ctx.sessionManager.getBranch());
    });
    pi.on("session_compact", () => {
        loaded.clear();
    });
    pi.on("tool_result", (event, ctx) => {
        const result = handleToolResult(event, ctx.cwd, loaded);
        if (!result)
            return;
        loaded = new Set([...loaded, ...result.paths]);
        pi.appendEntry(ENTRY_TYPE, { paths: result.paths });
        return { content: result.content };
    });
}
