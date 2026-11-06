/**
 * hpl-find-session — 自然语言找回历史会话
 *
 *   /find-session [描述] — 悬浮面板：输入描述 → 关键词粗滤 → haiku 档排序摘要 → 选择 → 热切换
 *   session_list / session_grep / session_resume 工具 — 让模型在对话里直接找会话
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import { readResolvedTiersEffect } from "../hpl-model-tiers/resolved.js";
import { grepSessions, listSessionFiles, prefilter, scanSessions } from "./index-core.js";
import { rankEntries } from "./rank.js";
import { acquireLeader, loadIndex, mergeIntoIndex, pendingForIndex, releaseLeader, runIndexerPass, summarizeEntries, } from "./indexer.js";
import { parseSessionFile } from "./index-core.js";
import { FindSessionPane } from "./pane.js";
const PREFILTER_TOP = 20;
function sessionsRoot() {
    return join(hapilonHome(), "agent", "sessions");
}
/** 从 ctx 组装 rankEntries 需要的模型依赖（haiku 档优先）。 */
function buildModelDeps(ctx) {
    const available = ctx.modelRegistry.getAvailable();
    const resolvedTiers = Effect.runSync(Effect.either(readResolvedTiersEffect));
    const tiers = resolvedTiers._tag === "Right" ? resolvedTiers.right : { opus: [], sonnet: [], haiku: [] };
    const currentModel = ctx.model;
    const current = currentModel ? available.find((m) => m.provider === currentModel.provider && m.id === currentModel.id) : undefined;
    return {
        available,
        currentModel: current,
        resolvedTiers: tiers,
        complete: async (model, messages, systemPrompt, signal) => 
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ctx.modelRegistry.complete(model, {
            systemPrompt,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            messages: messages.map((m) => ({ ...m, timestamp: Date.now() })),
        }, { signal }),
    };
}
/** 搜索管线：摘要索引匹配 → 未索引的现场补建 → 模型排序（查询条件化总结）。 */
async function searchSessions(query, deps) {
    const root = sessionsRoot();
    const now = Date.now();
    const files = listSessionFiles(root);
    const fileMtimes = new Map(files.map((f) => [f.path, f.mtimeMs]));
    const index = loadIndex(root);
    // 未索引的安静会话：现场批量补一轮（最近 20 个，一次调用），查询即触发增量
    const missing = pendingForIndex(files, index, now).slice(0, 20);
    if (missing.length > 0) {
        const parsed = (await Promise.all(missing.map((f) => parseSessionFile(f.path, f.sizeBytes)))).filter((e) => e !== null);
        const { records } = await summarizeEntries(parsed, deps);
        if (records.size > 0)
            mergeIntoIndex(root, records, fileMtimes);
        for (const [path, record] of records)
            index.set(path, record);
    }
    // 候选 = 索引记录；排除仍在写入的会话（mtime 未安静）和已删除文件
    const quiet = new Set(pendingForIndexQuietPaths(files, now));
    const all = [...index.values()]
        .filter((r) => fileMtimes.has(r.excerpt.path) && quiet.has(r.excerpt.path))
        .map((r) => r.excerpt)
        .sort((a, b) => b.modified.localeCompare(a.modified));
    const keywordHit = prefilter(all, query);
    // 关键词全空手时退回全量（交给模型判断），否则只送命中集
    const candidates = (keywordHit.length > 0 ? keywordHit : all).slice(0, PREFILTER_TOP);
    if (candidates.length === 0) {
        return { ranked: [], degraded: false, modelLabel: "" };
    }
    return rankEntries(query, candidates, deps);
}
function pendingForIndexQuietPaths(files, now) {
    return files.filter((f) => now - f.mtimeMs >= 10 * 60 * 1000).map((f) => f.path);
}
function shortPath(path) {
    const marker = "sessions/";
    const index = path.lastIndexOf(marker);
    return index >= 0 ? `…/${path.slice(index + marker.length)}` : path;
}
function entryLine(entry) {
    const cwd = entry.cwd.replace(/^\/Users\/[^/]+/, "~");
    const title = entry.name || entry.firstUser.slice(0, 40) || "(未命名)";
    return `${entry.modified.slice(0, 16).replace("T", " ")} ${cwd} 「${title}」 消息${entry.messageCount}条 ${shortPath(entry.path)}`;
}
export default function hplFindSession(pi) {
    // ── 后台摘要索引器：单实例领导者，空闲时增量补建 ──────────────────
    let indexerTimer;
    let indexerFailedOnce = false;
    pi.on("session_start", (_event, ctx) => {
        if (indexerTimer)
            return;
        const runPass = async () => {
            const root = sessionsRoot();
            if (!acquireLeader(root, Date.now()))
                return;
            try {
                const added = await runIndexerPass(root, listSessionFiles(root), buildModelDeps(ctx));
                indexerFailedOnce = false;
                if (added > 0)
                    ctx.ui.notify(`会话索引：新增 ${added} 条摘要`, "info");
            }
            catch (error) {
                // 非关键后台任务：只警告一次，避免持续故障每 5 分钟叨扰
                if (!indexerFailedOnce) {
                    indexerFailedOnce = true;
                    ctx.ui.notify(`会话索引失败：${error instanceof Error ? error.message : String(error)}`, "warning");
                }
            }
            finally {
                releaseLeader(root);
            }
        };
        const initial = setTimeout(() => void runPass(), 2 * 60_000);
        initial.unref?.();
        indexerTimer = setInterval(() => void runPass(), 5 * 60_000);
        indexerTimer.unref?.();
    });
    pi.on("session_shutdown", () => {
        if (indexerTimer) {
            clearInterval(indexerTimer);
            indexerTimer = undefined;
        }
    });
    // ── /find-session 命令 ─────────────────────────────────────────────
    pi.registerCommand("find-session", {
        description: "Search past sessions in natural language and resume one (floating pane)",
        handler: async (args, ctx) => {
            if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
                ctx.ui.notify("/find-session 需要 TUI 环境；非交互场景请用 hapi -r", "warning");
                return;
            }
            const initialQuery = (args ?? "").trim();
            ctx.ui.custom(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (tui, theme, kb, done) => new FindSessionPane(tui, theme, kb, done, {
                onSearch: (query, pane) => {
                    void (async () => {
                        const result = await searchSessions(query, buildModelDeps(ctx));
                        const status = result.degraded && result.modelLabel
                            ? `排序降级（${result.modelLabel}）：按关键词序展示`
                            : result.modelLabel ? `排序模型：${result.modelLabel}` : "";
                        pane.setResults(result.ranked, result.ranked.length === 0 ? "没有找到匹配的会话，换个说法试试" : status);
                    })().catch((error) => {
                        pane.setResults([], `搜索失败：${error instanceof Error ? error.message : String(error)}`);
                    });
                },
                onPick: (picked) => {
                    void (async () => {
                        await ctx.waitForIdle();
                        const result = await ctx.switchSession(picked.entry.path, {
                            withSession: async (next) => {
                                next.ui.notify(`已切换会话：${picked.entry.name || shortPath(picked.entry.path)}`, "info");
                            },
                        });
                        if (result.cancelled)
                            ctx.ui.notify("切换会话被取消。", "warning");
                    })().catch((error) => {
                        ctx.ui.notify(`切换失败：${error instanceof Error ? error.message : String(error)}`, "error");
                    });
                },
            }, initialQuery), {
                overlay: true,
                overlayOptions: { anchor: "center", width: "92%", maxHeight: "80%" },
            });
        },
    });
    // ── session_list 工具 ──────────────────────────────────────────────
    pi.registerTool({
        name: "session_list",
        label: "Find sessions",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parameters: { type: "object", properties: { query: { type: "string" } } },
        description: "List recent hapi sessions (across all directories) with names/first messages, optionally " +
            "keyword-filtered, for finding and resuming a past session. Returns time, cwd, title, " +
            "message count, session file path.",
        execute: async (_id, params) => {
            const args = params;
            const query = typeof args.query === "string" ? args.query : "";
            const all = await scanSessions(sessionsRoot());
            const filtered = query ? prefilter(all, query) : all;
            const shown = filtered.slice(0, 30);
            const text = shown.length === 0
                ? `没有匹配的会话（扫描了最近 ${all.length} 个）。`
                : [
                    `共 ${all.length} 个会话${query ? `，关键词「${query}」命中 ${filtered.length} 个` : ""}，显示前 ${shown.length} 个：`,
                    ...shown.map(entryLine),
                    "用 session_grep 深挖消息正文，用 /find-session 面板或 session_resume 恢复。",
                ].join("\n");
            return { content: [{ type: "text", text }], details: {} };
        },
    });
    // ── session_grep 工具 ──────────────────────────────────────────────
    pi.registerTool({
        name: "session_grep",
        label: "Grep sessions",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
        description: "Grep a regex across the text of recent hapi sessions' user messages. Use when session_list " +
            "titles don't match — the topic was discussed mid-session. Returns matching sessions with snippets.",
        execute: async (_id, params) => {
            const pattern = String(params.pattern ?? "");
            const { hits, truncated } = await grepSessions(sessionsRoot(), pattern);
            const text = hits.length === 0
                ? `没有命中（正则「${pattern}」，扫描最近 60 个会话）。`
                : [
                    `「${pattern}」命中 ${hits.length} 个会话${truncated ? "（已达上限，可能截断）" : ""}：`,
                    ...hits.map((hit) => `${shortPath(hit.path)} 「${hit.name || "(未命名)"}」 …${hit.snippet}`),
                ].join("\n");
            return { content: [{ type: "text", text }], details: {} };
        },
    });
    // ── session_resume 工具 ────────────────────────────────────────────
    pi.registerTool({
        name: "session_resume",
        label: "Resume session",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        description: "Resume a past session by its session file path (from session_list/session_grep). Hot-switches " +
            "the current session; the current session stays on disk and can be switched back to.",
        execute: async (_id, params, ctx) => {
            const path = String(params.path ?? "");
            if (!existsSync(path)) {
                return { content: [{ type: "text", text: `会话文件不存在：${path}` }], details: {} };
            }
            if (ctx.sessionManager.getSessionFile() === path) {
                return { content: [{ type: "text", text: "该会话就是当前会话。" }], details: {} };
            }
            // switchSession 只在命令 ctx 上有；工具 ctx 探测不到时给出指路
            const switchFn = ctx?.switchSession;
            if (typeof switchFn !== "function") {
                return {
                    content: [{
                            type: "text",
                            text: `工具环境无法直接切换会话。请让用户执行：/find-session，或重启时 hapi -r 选择 ${shortPath(path)}`,
                        }],
                    details: {},
                };
            }
            const result = await switchFn(path);
            return {
                content: [{ type: "text", text: result.cancelled ? "切换被取消。" : `已切换到 ${shortPath(path)}` }],
                details: {},
            };
        },
    });
}
