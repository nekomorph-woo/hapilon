/**
 * hpl-find-session — 自然语言找回历史会话
 *
 *   /find-session [描述] — 悬浮面板：本地中文匹配缓存摘要 → 模型相关性选择 → 证据回读 → 热切换
 *   session_list / session_grep / session_resume 工具 — 让模型在对话里直接找会话
 *
 * 查询只读缓存并发布补建请求；只有 leader（owner 身份锁）在后台写索引。
 * 完成事件持久化到共享事件流，各实例轮询去重后经 notify() 通知，不重播启动前历史。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import { readResolvedTiersEffect } from "../hpl-model-tiers/resolved.js";
import { grepSessions, prefilter, scanSessions, listSessionFiles } from "./index-core.js";
import { runIndexerPass } from "./indexer.js";
import { readCompletionEventsSince } from "./coordination.js";
import { createLifecycle } from "./indexer-lifecycle.js";
import { sqliteCoordinationPort } from "./index-lock.js";
import { searchIndexedSessions } from "./query.js";
import { FindSessionPane } from "./pane.js";
import { notify } from "../notify.js";
class EventPollError extends Data.TaggedError("EventPollError") {
}
const OWNER_ID = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const INITIAL_DELAY_MS = 2 * 60_000;
const PASS_INTERVAL_MS = 5 * 60_000;
const EVENT_POLL_MS = 30_000;
const RELEASE_TIMEOUT_MS = 30_000;
function sessionsRoot() {
    return join(hapilonHome(), "agent", "sessions");
}
/** 从 ctx 组装模型依赖（haiku 档优先）。 */
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
function describeStatus(status) {
    if (status.error)
        return `搜索失败：${status.error}`;
    const parts = [status.coverage];
    if (status.expanded) {
        parts.push(status.expandedPartial
            ? "已扩大到全部摘要检索（部分批次失败，可能遗漏）"
            : "本地无命中，已扩大到全部已索引摘要检索");
    }
    if (status.degraded)
        parts.push(`档位回退（${status.modelLabel}）`);
    else if (status.modelLabel)
        parts.push(`排序模型：${status.modelLabel}`);
    if (status.noMatch)
        parts.push("没有找到匹配的会话，换个说法试试");
    if (status.timeOrder)
        parts.push(status.timeOrder === "latest" ? "按最新→最旧时间排序展示" : "按最早→最新时间排序展示");
    if (status.runningUndetermined)
        parts.push("会话是否正在运行无归档证据，无法判断");
    if (status.displayTruncated > 0)
        parts.push(`仅展示证据化前 ${5} 条候选，${status.displayTruncated} 条未展示`);
    if (status.evidenceToolTruncated > 0)
        parts.push(`证据含 ${status.evidenceToolTruncated} 条被截断的工具结果，非完整`);
    if (status.evidenceMissing > 0)
        parts.push(`${status.evidenceMissing} 条摘要无行号引用，证据按关键词定位`);
    return parts.join(" · ");
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
/** 测试接线用：最近一次扩展实例创建的 lifecycle（生产代码不读） */
export const __lifecyclesForTest = [];
export default function hplFindSession(pi) {
    // ── 后台摘要索引器：owner 锁单写者 + 各实例事件轮询 ────────────────
    let passTimer;
    let initialTimer;
    let eventTimer;
    let eventBaselineTs = 0;
    const seenEventIds = new Set();
    let currentCtx;
    const lifecycle = createLifecycle({
        port: sqliteCoordinationPort,
        root: sessionsRoot(),
        owner: OWNER_ID,
        now: Date.now,
        notify,
        requestTimeoutMs: RELEASE_TIMEOUT_MS,
        runPass: (signal) => Effect.gen(function* () {
            const ctx = currentCtx;
            if (!ctx)
                return;
            const root = sessionsRoot();
            const files = listSessionFiles(root);
            // 真实状态（含无模型/单文件失败原因）都由完成事件统一播报，这里不直报
            yield* runIndexerPass(root, files, buildModelDeps(ctx), Date.now(), signal);
        }).pipe(Effect.catchAll((error) => Effect.sync(() => {
            const reason = `${error._tag}: ${String(error.cause)}`;
            notify(`会话索引失败：${reason}`, "warning");
        }))),
    });
    __lifecyclesForTest.push(lifecycle);
    const pollEvents = () => {
        // 事件读取走 typed error 通道：损坏的 latest-event / 权限问题可见，绝不让 setInterval 回调 throw 崩进程
        void Effect.runPromise(Effect.gen(function* () {
            const events = yield* Effect.try({
                try: () => readCompletionEventsSince(sessionsRoot(), eventBaselineTs),
                catch: (cause) => new EventPollError({ cause: cause instanceof Error ? cause.message : String(cause) }),
            });
            for (const event of events) {
                if (seenEventIds.has(event.id))
                    continue;
                seenEventIds.add(event.id);
                const parts = [`后台会话索引：新增 ${event.added}、更新 ${event.updated}、失败 ${event.failed}，剩余 ${event.remaining}，覆盖 ${event.indexedTotal}/${event.totalFiles}`];
                if (event.noModel)
                    parts.push("（无可用模型，本轮未建摘要）");
                if (event.failureCause)
                    parts.push(`原因：${event.failureCause}`);
                notify(parts.join("；"), event.failed > 0 || event.failureCause ? "warning" : "info");
            }
        }).pipe(Effect.catchAll((error) => Effect.sync(() => notify(`读取会话索引事件失败：${error.cause}`, "warning")))));
    };
    // tryRunPass 是 never-fail Effect，无拒绝路径，无需 catch 兜底
    const runPass = () => {
        void Effect.runPromise(lifecycle.tryRunPass);
    };
    pi.on("session_start", (_event, ctx) => {
        currentCtx = ctx;
        // 初次启动只从此刻起读新事件，不重播历史完成事件
        eventBaselineTs = Date.now();
        if (passTimer)
            return;
        initialTimer = setTimeout(() => void runPass(), INITIAL_DELAY_MS);
        initialTimer.unref?.();
        passTimer = setInterval(() => void runPass(), PASS_INTERVAL_MS);
        passTimer.unref?.();
        eventTimer = setInterval(() => {
            pollEvents();
            void Effect.runPromise(lifecycle.pollHandoff);
        }, EVENT_POLL_MS);
        eventTimer.unref?.();
    });
    null;
    pi.on("session_shutdown", () => {
        for (const timer of [initialTimer, passTimer, eventTimer]) {
            if (timer)
                clearInterval(timer);
        }
        initialTimer = passTimer = eventTimer = undefined;
        // 返回 Promise 让 pi await（extensions runner 逐个 await handler）：
        // 取消在途 pass，等它 settle（含最后一次写盘）并释放锁后才放行退出
        return Effect.runPromise(lifecycle.shutdown).catch((error) => {
            notify(`退出收尾失败：${error instanceof Error ? error.message : String(error)}`, "warning");
        });
    });
    const STATE_LABELS = {
        idle: "空闲",
        indexing: "索引中（本实例持有锁）",
        paused: "本实例暂停",
        releaseRequested: "已请求（等待 owner 响应）",
        released: "已释放",
        unresponded: "未响应",
        error: "错误",
    };
    const statusText = () => {
        const state = lifecycle.state();
        const lines = [`状态：${STATE_LABELS[state.kind]}${state.kind === "error" ? `（${state.message}）` : ""}`];
        if (lifecycle.paused())
            lines.push("本实例已暂停竞争，/session-index resume 可恢复。");
        return lines.join("\n");
    };
    const handleSessionIndexAction = (action, ctx) => {
        if (action === "status") {
            const ownerInfo = Effect.runSync(Effect.either(sqliteCoordinationPort.readOwnerInfo(sessionsRoot())));
            const owner = ownerInfo._tag === "Right" ? ownerInfo.right : null;
            const ownerLine = owner
                ? `owner（仅展示，不作互斥依据）：${owner.owner === OWNER_ID ? owner.owner + "（本实例）" : owner.owner}`
                : "owner：无";
            ctx.ui.notify(`${statusText()}\n${ownerLine}`, "info");
            return;
        }
        // release/resume fork 运行，不阻塞 TUI；结果经 notify 播报
        Effect.runFork(action === "release" ? lifecycle.release : lifecycle.resume);
    };
    // ── /session-index 命令：状态、暂停并交还锁、恢复索引 ─────────────
    pi.registerCommand("session-index", {
        description: "Session index control: status, release the lock (pause this instance), resume",
        handler: async (args, ctx) => {
            const first = ((args ?? "").trim().split(/\s+/))[0] ?? "";
            const action = first === "release" || first === "resume" || first === "status" ? first : "status";
            handleSessionIndexAction(action, ctx);
        },
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
            let currentSearch;
            ctx.ui.custom(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (tui, theme, kb, done) => new FindSessionPane(tui, theme, kb, done, {
                onSearch: (query, pane) => {
                    void (async () => {
                        const controller = new AbortController();
                        currentSearch = controller;
                        try {
                            const result = await Effect.runPromise(searchIndexedSessions(query, buildModelDeps(ctx), sessionsRoot(), controller.signal, (phase) => pane.setStatus(phase)));
                            pane.setResults(result.ranked, describeStatus(result.status));
                        }
                        finally {
                            if (currentSearch === controller)
                                currentSearch = undefined;
                        }
                    })().catch((error) => {
                        // typed 查询失败原样透出真实原因，不冒充「无匹配」
                        const tag = error?._tag ?? "";
                        const cause = String(error?.cause ?? "");
                        const reason = error instanceof Error ? error.message : String(error);
                        pane.setResults([], /QueryModelError|SessionReadError/.test(tag) && cause
                            ? `搜索失败：${cause}`
                            : `搜索失败：${reason}`);
                    });
                },
                onPick: (picked) => {
                    void (async () => {
                        // 搜索已取消/中止后不再切会话
                        if (currentSearch?.signal.aborted) {
                            ctx.ui.notify("搜索已取消，未切换会话。", "warning");
                            return;
                        }
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
    // ── session_index 工具：显式动作参数，绝不在检索时自动释放锁 ────────
    pi.registerTool({
        name: "session_index",
        label: "Session index control",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parameters: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["status", "release", "resume"], description: "明确动作：status=查看状态；release=交还锁并暂停本实例索引；resume=恢复索引竞争" },
            },
            required: ["action"],
        },
        description: "Control the background session indexer lock of THIS instance. Only call with action=release " +
            "or resume when the user explicitly asks to pause/resume session indexing; never call release " +
            "as a side effect of searching. status reports current lifecycle state and lock owner (display only).",
        execute: async (_id, params, ctx) => {
            const action = String(params.action ?? "status");
            if (action !== "status" && action !== "release" && action !== "resume") {
                return { content: [{ type: "text", text: `未知动作：${action}，可用 status/release/resume。` }], details: {} };
            }
            handleSessionIndexAction(action, ctx);
            const label = action === "status" ? lifecycle.state().kind : action;
            return { content: [{ type: "text", text: `session_index ${label}：已执行。` }], details: {} };
        },
    });
}
