/**
 * worker.ts — 找回会话 RPC 子进程专用扩展
 *
 * 由父扩展经 `pi --mode rpc --no-session -ne -e <本文件>` 拉起：只注册 5 个
 * 只读会话工具（列/搜原文/分页读/追父会话/发布结果），没有任何 shell、写入、
 * 联网能力；会话根目录由 HAPI_FIND_SESSION_ROOT 指定并经 SessionStore 限制。
 * find_session_result 是模型向父进程发布结构化结果的唯一通道：execute 内做
 * 代码核验（id 与证据逐条对原文），只有全部通过的条目进入 details 载荷，
 * 父进程从 tool_execution_end 事件里取走，绝不经模型转述。
 */
import { Effect } from "effect";
import { SessionStore } from "./session-store.js";
export const SESSION_ROOT_ENV = "HAPI_FIND_SESSION_ROOT";
export const RESULT_TOOL = "find_session_result";
const PARENT_PREVIEW_CHARS = 2000;
const resultOf = (effect) => Effect.runPromise(Effect.map(effect, (text) => ({ content: [{ type: "text", text }], details: {} })))
    .catch((error) => {
    // 工具失败进错误通道（pi 标记 isError），不静默给模型空结果
    throw error instanceof Error ? error : new Error(String(error));
});
const shortTime = (timestamp) => timestamp.slice(0, 16).replace("T", " ");
// 工具输出的行格式：id 一律完整给出，模型要靠它们原样填进 find_session_result，
// 截短 id 会让核验必然失败。
export const formatListMeta = (item) => `- id=${item.id} ${shortTime(item.timestamp)} ${item.cwd} ${item.path}${item.incomplete ? "（尾部不完整）" : ""}`;
export const formatSearchHit = (hit) => `- session=${hit.sessionId} ${hit.path}:${hit.line} msg=${hit.messageId} [${hit.role}] ${shortTime(hit.timestamp)} …${hit.snippet}…`;
/** 结果条目的形状核验：缺字段或证据格式不对直接判废，错误写进报告。 */
function shapeOf(raw) {
    if (typeof raw !== "object" || raw === null)
        return { ok: false, why: "条目不是对象" };
    const value = raw;
    for (const key of ["sessionId", "path", "summary", "reason"]) {
        if (typeof value[key] !== "string" || value[key].trim() === "")
            return { ok: false, why: `缺少 ${key}` };
    }
    if (!Array.isArray(value.evidence))
        return { ok: false, why: "缺少 evidence 数组" };
    const evidence = [];
    for (const item of value.evidence) {
        if (typeof item !== "object" || item === null)
            return { ok: false, why: "证据条目不是对象" };
        const item_ = item;
        if (typeof item_.messageId !== "string" || typeof item_.quote !== "string"
            || !Number.isInteger(item_.line) || item_.line < 1) {
            return { ok: false, why: "证据需要 line(正整数)/messageId/quote" };
        }
        evidence.push({
            line: item_.line,
            messageId: item_.messageId,
            quote: item_.quote,
            ...(typeof item_.role === "string" ? { role: item_.role } : {}),
            ...(typeof item_.timestamp === "string" ? { timestamp: item_.timestamp } : {}),
        });
    }
    return {
        ok: true,
        value: {
            sessionId: value.sessionId,
            path: value.path,
            summary: value.summary,
            reason: value.reason,
            evidence,
        },
    };
}
/** 空白归一化：比对时忽略所有空白差异，内容字符仍须逐字对上 */
const collapse = (text) => text.replace(/\s+/g, "");
/**
 * 逐条核验 id 与证据：会话必须在根目录内、头 id 与 sessionId 一致、
 * 每条证据的行号/消息 id 存在且 quote 逐字出现在该消息原文里
 * （空白差异归一化后比对，内容不一致仍拒绝）。
 */
export function verifyResults(store, raw) {
    return Effect.gen(function* () {
        const report = [];
        const verified = [];
        const items = Array.isArray(raw) ? raw : [];
        if (items.length === 0) {
            return { verified, report: ["results 为空：按无匹配发布。"] };
        }
        for (const [index, item] of items.entries()) {
            const label = `#${index + 1}`;
            const shape = shapeOf(item);
            if (!shape.ok) {
                report.push(`✗ ${label} ${shape.why}`);
                continue;
            }
            const candidate = shape.value;
            const session = yield* Effect.either(store.read(candidate.path));
            if (session._tag === "Left") {
                report.push(`✗ ${label} ${candidate.path}：${session.left.message}`);
                continue;
            }
            if (session.right.header.id !== candidate.sessionId) {
                report.push(`✗ ${label} sessionId 不符：文件头是 ${session.right.header.id}`);
                continue;
            }
            const byLine = new Map(session.right.messages.map((message) => [message.line, message]));
            const kept = [];
            let evidenceFailed = false;
            for (const [evidenceIndex, evidence] of candidate.evidence.entries()) {
                const message = byLine.get(evidence.line);
                const why = !message ? "行号不存在"
                    : message.id !== evidence.messageId ? "messageId 与该行不符"
                        : !message.text.includes(evidence.quote) && !collapse(message.text).includes(collapse(evidence.quote)) ? "quote 不在该消息原文中"
                            : undefined;
                if (why) {
                    report.push(`✗ ${label} 证据 ${evidenceIndex + 1} ${why}（line=${evidence.line}）`);
                    evidenceFailed = true;
                    break;
                }
                kept.push({ ...evidence, role: message.role, timestamp: message.timestamp });
            }
            if (evidenceFailed)
                continue;
            verified.push({ ...candidate, evidence: kept });
            report.push(`✓ ${label} ${candidate.sessionId} ${candidate.path}（${kept.length} 条证据通过）`);
        }
        return { verified, report };
    });
}
export default function findSessionWorker(pi) {
    const root = process.env[SESSION_ROOT_ENV];
    if (!root) {
        throw new Error(`${SESSION_ROOT_ENV} 未设置：本扩展只能由 hpl-find-session 父扩展在 RPC 子进程里加载`);
    }
    const store = new SessionStore(root);
    // get_commands 可见的自检标记：父进程用它确认 worker 已加载（工具注册同一工厂内完成）
    pi.registerCommand("fsx-selfcheck", {
        description: "find-session worker self-check marker",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (_args, ctx) => {
            ctx?.ui?.notify?.(`find-session worker 已加载，会话根目录：${root}`, "info");
        },
    });
    // ── session_list：分页列出会话文件元数据 ──────────────────────────
    pi.registerTool({
        name: "session_list",
        label: "List sessions",
        description: "List stored hapi session files (all directories) with id, time, cwd, file path. " +
            "Paginated; use session_search to find content and session_read to page through a file.",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parameters: {
            type: "object",
            properties: {
                cursor: { type: "integer", description: "分页起点（上一页返回的 nextCursor），首查省略" },
                limit: { type: "integer", description: "每页条数，默认 20，上限 100" },
            },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (_id, params) => resultOf(Effect.gen(function* () {
            const page = yield* store.listPage(params?.cursor ?? 0, params?.limit ?? 20);
            if (page.items.length === 0)
                return `没有会话（共 ${page.total} 个）。`;
            const lines = [
                `共 ${page.total} 个会话，本页 ${page.items.length} 条：`,
                ...page.items.map(formatListMeta),
            ];
            lines.push(page.nextCursor === null
                ? "已是最后一页。"
                : `下一页 cursor=${page.nextCursor}。`);
            return lines.join("\n");
        })),
    });
    // ── session_search：关键词搜全部会话消息原文（字面子串，非正则）────
    pi.registerTool({
        name: "session_search",
        label: "Search sessions",
        description: "Search a literal keyword across all stored sessions' message text. Returns hits with " +
            "sessionId, file path, line number, role, time and a snippet. Use short distinctive words; " +
            "retry with different words when nothing matches.",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parameters: {
            type: "object",
            properties: {
                keyword: { type: "string", description: "字面关键词（不是正则）" },
                cursor: { type: "integer", description: "分页起点（上一页返回的 nextCursor），首查省略" },
                limit: { type: "integer", description: "每页条数，默认 20，上限 100" },
            },
            required: ["keyword"],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (_id, params) => resultOf(Effect.gen(function* () {
            const page = yield* store.searchPage(String(params?.keyword ?? ""), params?.cursor ?? 0, params?.limit ?? 20);
            if (page.items.length === 0) {
                const failedNote = page.failedFiles > 0 ? `，${page.failedFiles} 个文件无法读取已跳过` : "";
                return `「${params?.keyword}」没有命中（扫描 ${page.coverage} 个会话${page.incomplete > 0 ? `，${page.incomplete} 个尾部不完整` : ""}${failedNote}）。换个更短或更具体的词重试。`;
            }
            const lines = [
                `「${params?.keyword}」本页展示 ${page.items.length} 条命中：`,
                ...page.items.map(formatSearchHit),
            ];
            lines.push(page.nextCursor === null
                ? "没有更多命中。"
                : `下一页 cursor=${page.nextCursor}。`);
            return lines.join("\n");
        })),
    });
    // ── session_read：分页读单条会话原文 ──────────────────────────────
    pi.registerTool({
        name: "session_read",
        label: "Read session",
        description: "Read one session file page by page, raw message text. Pass the path from session_list/" +
            "session_search. Cursor {message,offset} from the previous page continues where it stopped. " +
            "Quote text exactly from this output when publishing evidence.",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "会话文件绝对路径" },
                cursor: {
                    type: "object",
                    properties: { message: { type: "integer" }, offset: { type: "integer" } },
                    description: "续读位置；首查省略（从头读）",
                },
                maxChars: { type: "integer", description: "本页最大字符数，默认 4000，上限 50000" },
            },
            required: ["path"],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (_id, params) => resultOf(Effect.gen(function* () {
            const cursor = {
                message: params?.cursor?.message ?? 0,
                offset: params?.cursor?.offset ?? 0,
            };
            const page = yield* store.messagesPage(String(params?.path ?? ""), cursor, params?.maxChars ?? 4000);
            if (!page.item)
                return "该会话没有更多消息。";
            const lines = [
                `[${page.item.role}] ${shortTime(page.item.timestamp)} line=${page.item.line} msg=${page.item.id}`,
                page.item.text,
                "",
                page.nextCursor === null
                    ? "已到会话末尾。"
                    : `续读 cursor=${JSON.stringify(page.nextCursor)}。`,
            ];
            return lines.join("\n");
        })),
    });
    // ── session_parent：追溯父会话（用于定位讨论源头，不一刀切排除）────
    pi.registerTool({
        name: "session_parent",
        label: "Session parent",
        description: "Read the parent session of a session (lineage tracing). Returns the parent's metadata and " +
            "a preview; page the full parent with session_read on the returned path.",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parameters: {
            type: "object",
            properties: { path: { type: "string", description: "会话文件绝对路径" } },
            required: ["path"],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (_id, params) => resultOf(Effect.gen(function* () {
            const parent = yield* store.parent(String(params?.path ?? ""));
            if (!parent)
                return "该会话没有父会话。";
            const preview = yield* store.messagesPage(parent.path, { message: 0, offset: 0 }, PARENT_PREVIEW_CHARS);
            const header = [
                `父会话：${parent.path}`,
                `id=${parent.header.id} ${shortTime(parent.header.timestamp)} cwd=${parent.header.cwd}`,
                `消息 ${parent.messages.length} 条（可用 session_read 续读该路径）`,
            ];
            return preview.item
                ? [...header, "", `[${preview.item.role}] line=${preview.item.line}`, preview.item.text].join("\n")
                : header.join("\n");
        })),
    });
    // ── find_session_result：发布结构化结果（唯一通道，代码核验后供选择）─
    pi.registerTool({
        name: RESULT_TOOL,
        label: "Publish results",
        description: "Publish the final structured search results to the user's panel. Call once when done: " +
            "each result needs sessionId, path, summary, reason, and verbatim evidence quotes from " +
            "session_read output. Publish an empty results array when nothing matched. Evidence that " +
            "fails verification is rejected and reported back.",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parameters: {
            type: "object",
            properties: {
                results: {
                    type: "array",
                    description: "匹配结果，可多条；无匹配时给空数组",
                    items: {
                        type: "object",
                        properties: {
                            sessionId: { type: "string", description: "会话文件头里的 id（原样）" },
                            path: { type: "string", description: "会话文件绝对路径" },
                            summary: { type: "string", description: "该会话相关内容的总结，1-3 句" },
                            reason: { type: "string", description: "为什么匹配用户的描述" },
                            evidence: {
                                type: "array",
                                description: "证据位置；quote 必须逐字来自对应消息原文",
                                items: {
                                    type: "object",
                                    properties: {
                                        line: { type: "integer", description: "会话文件行号（session_search/session_read 输出里的 line）" },
                                        messageId: { type: "string", description: "该行消息 id" },
                                        quote: { type: "string", description: "逐字引文" },
                                    },
                                    required: ["line", "messageId", "quote"],
                                },
                            },
                        },
                        required: ["sessionId", "path", "summary", "reason", "evidence"],
                    },
                },
            },
            required: ["results"],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (_id, params) => {
            // verifyResults 含文件 IO（tryPromise），必须走 runPromise，不能 runSync
            const { verified, report } = await Effect.runPromise(verifyResults(store, params?.results));
            return {
                content: [{
                        type: "text",
                        text: verified.length === 0
                            ? ["发布结果：没有通过核验的条目（不会展示给用户）。", ...report].join("\n")
                            : [`已发布 ${verified.length} 条结果。`, ...report].join("\n"),
                    }],
                // 父进程从这里取走结构化结果；未通过核验的条目不进入载荷
                details: { findSessionResults: verified },
            };
        },
    });
}
