/**
 * index-core.ts — 会话索引扫描 / 关键词粗滤 / 正文 grep（纯逻辑，供命令、面板、工具共用）
 *
 * 会话文件格式（实测 pi session-manager）：
 *   首行 {type:"session", id, timestamp, cwd}；session_info 带名字；
 *   message 条目的 message.content 为 string 或 {type:"text"} 块数组。
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Data, Effect, Schema } from "effect";
export const DEFAULT_SCAN_LIMIT = 150;
/** 去掉工具注入的 acp 标签与 skill XML 包裹，只留人说的话。 */
export function cleanUserText(text) {
    return text
        .replace(/\u003cacp[^>]*\u003e[\s\S]*?\u003c\/acp\u003e/g, " ")
        .replace(/\u003c\/?(?:acp[^>]*|skill[^>]*)\u003e/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function extractTextContent(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .filter((block) => typeof block === "object" && block !== null && block.type === "text")
        .map((block) => block.text ?? "")
        .join(" ");
}
/** 解析单个会话文件：header + 名字 + 首末用户消息。解析失败返回 null（视为损坏文件跳过）。 */
export async function parseSessionFile(filePath, sizeBytes) {
    try {
        const rl = createInterface({
            input: createReadStream(filePath, { encoding: "utf-8" }),
            crlfDelay: Infinity,
        });
        let header = null;
        let name = "";
        let messageCount = 0;
        let firstUser = "";
        let lastUser = "";
        let lastModified = "";
        for await (const line of rl) {
            let entry;
            try {
                entry = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (!header) {
                if (entry.type !== "session")
                    return null;
                header = entry;
                continue;
            }
            if (entry.type === "session_info") {
                const v = entry.name;
                name = typeof v === "string" ? v.trim() : "";
            }
            if (entry.type !== "message")
                continue;
            messageCount++;
            if (typeof entry.timestamp === "string")
                lastModified = entry.timestamp;
            const message = entry.message;
            if (!message || message.role !== "user")
                continue;
            const cleaned = cleanUserText(extractTextContent(message.content));
            if (!cleaned)
                continue;
            if (!firstUser)
                firstUser = cleaned;
            lastUser = cleaned;
        }
        if (!header)
            return null;
        return {
            path: filePath,
            id: typeof header.id === "string" ? header.id : "",
            cwd: typeof header.cwd === "string" ? header.cwd : "",
            name,
            created: typeof header.timestamp === "string" ? header.timestamp : "",
            modified: lastModified || (typeof header.timestamp === "string" ? header.timestamp : ""),
            messageCount,
            firstUser,
            lastUser,
            sizeBytes,
        };
    }
    catch {
        return null;
    }
}
/** 列出 sessions 根目录下全部 jsonl（跨目录），按 mtime 降序。 */
export function listSessionFiles(sessionsRoot) {
    const files = [];
    let dirEntries;
    try {
        dirEntries = readdirSync(sessionsRoot, { withFileTypes: true });
    }
    catch {
        return files;
    }
    for (const dir of dirEntries) {
        if (!dir.isDirectory())
            continue;
        const sub = join(sessionsRoot, dir.name);
        let fileEntries = [];
        try {
            fileEntries = readdirSync(sub, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const file of fileEntries) {
            if (!file.isFile() || !file.name.endsWith(".jsonl"))
                continue;
            const full = join(sub, file.name);
            try {
                const stats = statSync(full);
                files.push({ path: full, mtimeMs: stats.mtimeMs, sizeBytes: stats.size });
            }
            catch {
                // 文件在列目录与 stat 之间被删——跳过
            }
        }
    }
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
/** 扫描最近 limit 个会话，产出索引。 */
export async function scanSessions(sessionsRoot, limit = DEFAULT_SCAN_LIMIT) {
    const files = listSessionFiles(sessionsRoot).slice(0, limit);
    const parsed = await Promise.all(files.map((f) => parseSessionFile(f.path, f.sizeBytes)));
    return parsed.filter((e) => e !== null);
}
/**
 * 查询分词：拉丁词按空格/标点切；CJK 连续串取整体（2-4 字）与全部相邻二字组。
 * 不用 Intl.Segmenter 做中文词切（无词典时逐字切不可用），二字组是可覆盖连续匹配的最小可靠单元。
 */
export function tokenizeQuery(query) {
    const lower = query.toLowerCase();
    const terms = new Set();
    for (const latin of lower.match(/[a-z0-9_][a-z0-9_-]*/g) ?? []) {
        if (latin.length >= 2)
            terms.add(latin);
    }
    for (const run of lower.match(/[\u4e00-\u9fff\u3040-\u30ff]+/g) ?? []) {
        if (run.length >= 2 && run.length <= 4)
            terms.add(run);
        for (let i = 0; i + 2 <= run.length; i++)
            terms.add(run.slice(i, i + 2));
    }
    return [...terms];
}
/** 关键词粗滤：每个分词在 名字/cwd/首末消息 命中记 1 分，降序。 */
export function prefilter(entries, query) {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0)
        return entries;
    const scored = entries.map((entry) => {
        const haystack = `${entry.name} ${entry.cwd} ${entry.firstUser} ${entry.lastUser}`.toLowerCase();
        let score = 0;
        for (const token of tokens) {
            if (haystack.includes(token))
                score++;
        }
        return { entry, score };
    });
    return scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((s) => s.entry);
}
// ── 全量消息读取（摘要建索引与证据回读共用） ─────────────────────────
/** 巨大工具结果按此截断；truncated 标记让上层如实记录「已裁剪」，不伪称完整。 */
export const TOOL_RESULT_CHAR_LIMIT = 2000;
export class SessionReadError extends Data.TaggedError("SessionReadError") {
}
// ── Schema 边界：不信任会话文件内容，结构不符的行计入损坏而非静默照单全收 ──
const TextBlockSchema = Schema.Struct({ type: Schema.Literal("text"), text: Schema.optional(Schema.String) });
const ToolCallBlockSchema = Schema.Struct({ type: Schema.Literal("toolCall"), id: Schema.optional(Schema.String) });
// thinking 块允许通过解码（整行才算有效消息），证据提取时由 blocksText 过滤
const ThinkingBlockSchema = Schema.Struct({ type: Schema.Literal("thinking"), text: Schema.optional(Schema.String) });
const ContentSchema = Schema.Union(Schema.String, Schema.Array(Schema.Union(TextBlockSchema, ToolCallBlockSchema, ThinkingBlockSchema)));
const MessageEntrySchema = Schema.Struct({
    type: Schema.Literal("message"),
    id: Schema.optional(Schema.String),
    timestamp: Schema.optional(Schema.String),
    message: Schema.Struct({
        role: Schema.Union(Schema.Literal("user"), Schema.Literal("assistant"), Schema.Literal("toolResult")),
        content: ContentSchema,
        toolCallId: Schema.optional(Schema.String),
    }),
});
const SessionHeaderSchema = Schema.Struct({ type: Schema.Literal("session") });
const decodeMessageEntry = Schema.decodeUnknownEither(MessageEntrySchema);
const decodeSessionHeader = Schema.decodeUnknownEither(SessionHeaderSchema);
function blocksText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .filter((block) => typeof block === "object" && block !== null && block.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
}
function toolCallIdsOf(content) {
    if (!Array.isArray(content))
        return [];
    return content
        .filter((block) => typeof block === "object" && block !== null && block.type === "toolCall" && typeof block.id === "string")
        .map((b) => b.id)
        .filter((id) => id !== undefined);
}
/**
 * 读会话全部 user/assistant 正文与 toolResult（工具结果超长截断并标记）。
 * 类型化错误：io（读权限/不存在等系统层失败）、header（无有效 session 头）、empty。
 * 结构不符的非头行跳过（损坏计数，不冒充「没有会话」）；assistant 的 thinking 块不算证据。
 */
export const readSessionEntriesEffect = (filePath) => Effect.gen(function* () {
    const rl = yield* Effect.try({
        try: () => createInterface({
            input: createReadStream(filePath, { encoding: "utf-8" }),
            crlfDelay: Infinity,
        }),
        catch: (cause) => new SessionReadError({ path: filePath, stage: "io", cause: String(cause) }),
    });
    const lines = yield* Effect.async((resume) => {
        const collected = [];
        rl.on("line", (l) => collected.push(l));
        rl.on("close", () => resume(Effect.succeed(collected)));
        rl.on("error", (err) => resume(Effect.fail(new SessionReadError({ path: filePath, stage: "io", cause: String(err) }))));
    });
    const entries = [];
    let sawHeader = false;
    let line = 0;
    let malformed = 0;
    for (const jsonLine of lines) {
        line++;
        let parsed;
        try {
            parsed = JSON.parse(jsonLine);
        }
        catch {
            if (line === 1) {
                return yield* Effect.fail(new SessionReadError({ path: filePath, stage: "header", cause: "首行非 JSON" }));
            }
            malformed++;
            continue;
        }
        if (!sawHeader) {
            if (decodeSessionHeader(parsed)._tag === "Left") {
                return yield* Effect.fail(new SessionReadError({ path: filePath, stage: "header", cause: "首行不是 session 头" }));
            }
            sawHeader = true;
            continue;
        }
        const decoded = decodeMessageEntry(parsed);
        if (decoded._tag === "Left") {
            malformed++;
            continue;
        }
        const { id, timestamp, message } = decoded.right;
        const { role, content, toolCallId } = message;
        const raw = typeof content === "string" ? content : blocksText(content);
        const text = raw.replace(/\s+/g, " ").trim();
        if (!text && role !== "toolResult")
            continue;
        const truncated = role === "toolResult" && text.length > TOOL_RESULT_CHAR_LIMIT;
        entries.push({
            line,
            id: id ?? "",
            role,
            timestamp: timestamp ?? "",
            text: truncated ? text.slice(0, TOOL_RESULT_CHAR_LIMIT) : text,
            truncated,
            toolCallIds: role === "assistant" ? toolCallIdsOf(content) : [],
            toolCallId: toolCallId ?? "",
        });
    }
    if (!sawHeader) {
        const stage = entries.length === 0 && malformed === 0 ? "empty" : "header";
        return yield* Effect.fail(new SessionReadError({ path: filePath, stage, cause: "无 session 头" }));
    }
    return entries;
});
/** digest 兼容薄包装：typed 错误归一为 null（digest 已按「解析失败跳过」计账）。 */
export async function readSessionEntries(filePath) {
    const exit = await Effect.runPromiseExit(readSessionEntriesEffect(filePath));
    if (exit._tag === "Success")
        return exit.value;
    return null;
}
/** 对最近的会话文件做正文 grep，命中即返回片段。 */
export async function grepSessions(sessionsRoot, pattern, options = {}) {
    const maxFiles = options.maxFiles ?? 60;
    const maxHits = options.maxHits ?? 20;
    let regex;
    try {
        regex = new RegExp(pattern, "i");
    }
    catch (error) {
        throw new Error(`正则无效：${error instanceof Error ? error.message : String(error)}`);
    }
    const files = listSessionFiles(sessionsRoot).slice(0, maxFiles);
    const hits = [];
    for (const file of files) {
        const excerpt = await parseSessionFile(file.path, file.sizeBytes);
        if (!excerpt)
            continue;
        const source = `${excerpt.firstUser}\n${excerpt.lastUser}`;
        if (!regex.test(source))
            continue;
        const index = source.search(regex);
        const start = Math.max(0, index - 40);
        hits.push({
            path: excerpt.path,
            id: excerpt.id,
            name: excerpt.name,
            cwd: excerpt.cwd,
            snippet: source.slice(start, start + 160).replace(/\s+/g, " ").trim(),
        });
        if (hits.length >= maxHits)
            return { hits, truncated: true };
    }
    return { hits, truncated: false };
}
