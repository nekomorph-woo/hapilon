import { readdir, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { Data, Effect, Schema } from "effect";
export class SessionStoreError extends Data.TaggedError("SessionStoreError") {
}
const Header = Schema.Struct({
    type: Schema.Literal("session"),
    id: Schema.String,
    timestamp: Schema.String,
    cwd: Schema.String,
    parentSession: Schema.optional(Schema.String),
});
const Message = Schema.Struct({
    type: Schema.Literal("message"),
    id: Schema.String,
    parentId: Schema.NullOr(Schema.String),
    timestamp: Schema.String,
    message: Schema.Struct({
        role: Schema.String,
        content: Schema.Union(Schema.String, Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }))),
    }),
});
const Entry = Schema.Struct({ type: Schema.String });
const decodeHeader = Schema.decodeUnknownEither(Header);
const decodeMessage = Schema.decodeUnknownEither(Message);
const decodeEntry = Schema.decodeUnknownEither(Entry);
const fail = (message) => new SessionStoreError({ message });
const attempt = (operation) => Effect.tryPromise({
    try: operation,
    catch: (error) => fail(error instanceof Error ? error.message : String(error)),
});
function textOf(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content.flatMap((block) => {
        if (typeof block !== "object" || block === null)
            return [];
        const value = block;
        return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    }).join("\n");
}
function validPage(offset, limit) {
    return Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 100;
}
export class SessionStore {
    root;
    constructor(root) {
        this.root = root;
    }
    confined(path) {
        return Effect.gen(this, function* () {
            if (extname(path) !== ".jsonl")
                return yield* Effect.fail(fail("只允许读取 .jsonl 会话文件"));
            const root = yield* attempt(() => realpath(this.root));
            const resolved = yield* attempt(() => realpath(path));
            const suffix = relative(root, resolved);
            if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix) || suffix.split(sep).length !== 2 || extname(resolved) !== ".jsonl") {
                return yield* Effect.fail(fail("会话路径不在会话根目录内或不是 .jsonl 文件"));
            }
            return resolved;
        });
    }
    list() {
        return Effect.gen(this, function* () {
            const root = yield* attempt(() => realpath(this.root));
            const directories = yield* attempt(() => readdir(root, { withFileTypes: true }));
            const paths = [];
            for (const directory of directories) {
                if (!directory.isDirectory())
                    continue;
                const dir = join(root, directory.name);
                const files = yield* attempt(() => readdir(dir, { withFileTypes: true }));
                for (const file of files) {
                    if (file.isFile() && file.name.endsWith(".jsonl"))
                        paths.push(join(dir, file.name));
                }
            }
            return paths.sort();
        });
    }
    read(path) {
        return Effect.gen(this, function* () {
            const resolved = yield* this.confined(path);
            const content = yield* attempt((signal) => readFile(resolved, { encoding: "utf8", signal }));
            const lines = content.split("\n");
            const first = yield* Effect.try({
                try: () => JSON.parse(lines[0] ?? ""),
                catch: () => fail(`会话头不是有效 JSON：${resolved}`),
            });
            const header = decodeHeader(first);
            if (header._tag === "Left")
                return yield* Effect.fail(fail(`会话头无效：${resolved}`));
            const messages = [];
            let incomplete = false;
            let skipped = 0;
            for (let index = 1; index < lines.length; index++) {
                const line = lines[index];
                if (!line && index === lines.length - 1)
                    continue;
                const parsed = yield* Effect.either(Effect.try({
                    try: () => JSON.parse(line ?? ""),
                    catch: () => fail(`会话第 ${index + 1} 行不是有效 JSON：${resolved}`),
                }));
                if (parsed._tag === "Left") {
                    if (index === lines.length - 1 && !content.endsWith("\n")) {
                        incomplete = true;
                        break;
                    }
                    return yield* Effect.fail(parsed.left);
                }
                const base = decodeEntry(parsed.right);
                if (base._tag === "Left")
                    return yield* Effect.fail(fail(`会话第 ${index + 1} 行无效：${resolved}`));
                if (base.right.type !== "message")
                    continue;
                const entry = decodeMessage(parsed.right);
                if (entry._tag === "Left") {
                    // 真实会话里有 bashExecution 等非文本语义的 message 条目，跳过并计数，不作致命错误
                    skipped++;
                    continue;
                }
                const { id, parentId, timestamp, message } = entry.right;
                messages.push({ line: index + 1, id, parentId, timestamp, role: message.role, text: textOf(message.content) });
            }
            return { path: resolved, header: header.right, messages, incomplete, skipped };
        });
    }
    parent(path) {
        return Effect.gen(this, function* () {
            const session = yield* this.read(path);
            if (!session.header.parentSession)
                return undefined;
            return yield* this.read(session.header.parentSession);
        });
    }
    listPage(cursor = 0, limit = 20) {
        return Effect.gen(this, function* () {
            if (!validPage(cursor, limit))
                return yield* Effect.fail(fail("无效的列表分页参数"));
            const paths = yield* this.list();
            const items = [];
            let failedFiles = 0;
            for (const path of paths.slice(cursor, cursor + limit)) {
                const session = yield* Effect.either(this.read(path));
                if (session._tag === "Left") {
                    failedFiles++;
                    continue;
                }
                items.push({ path: session.right.path, ...session.right.header, incomplete: session.right.incomplete });
            }
            const scanned = Math.min(limit, Math.max(0, paths.length - cursor));
            const next = cursor + scanned;
            return { items, nextCursor: next < paths.length ? next : null, total: paths.length, failedFiles };
        });
    }
    searchPage(keyword, cursor = 0, limit = 20) {
        return Effect.gen(this, function* () {
            if (!keyword || !validPage(cursor, limit))
                return yield* Effect.fail(fail("无效的搜索或分页参数"));
            const paths = yield* this.list();
            const matches = [];
            let incomplete = 0;
            let failedFiles = 0;
            for (const path of paths) {
                const session = yield* Effect.either(this.read(path));
                if (session._tag === "Left") {
                    failedFiles++;
                    continue;
                }
                if (session.right.incomplete)
                    incomplete++;
                for (const message of session.right.messages) {
                    const at = message.text.indexOf(keyword);
                    if (at < 0)
                        continue;
                    matches.push({ sessionId: session.right.header.id, path: session.right.path, line: message.line,
                        messageId: message.id, parentId: message.parentId, timestamp: message.timestamp,
                        role: message.role, snippet: message.text.slice(Math.max(0, at - 80), at + keyword.length + 80) });
                }
            }
            const items = matches.slice(cursor, cursor + limit);
            const next = cursor + items.length;
            return { items, nextCursor: next < matches.length ? next : null, coverage: paths.length, incomplete, failedFiles };
        });
    }
    messagesPage(path, cursor = { message: 0, offset: 0 }, maxChars = 4000) {
        return Effect.gen(this, function* () {
            if (!Number.isSafeInteger(cursor.message) || cursor.message < 0 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 50000) {
                return yield* Effect.fail(fail("无效的消息分页参数"));
            }
            const session = yield* this.read(path);
            if (cursor.message > session.messages.length || (cursor.message === session.messages.length && cursor.offset !== 0)) {
                return yield* Effect.fail(fail("消息游标越界"));
            }
            const message = session.messages[cursor.message];
            if (!message)
                return { item: null, nextCursor: null, incomplete: session.incomplete };
            if (cursor.offset > message.text.length)
                return yield* Effect.fail(fail("消息游标越界"));
            let end = Math.min(message.text.length, cursor.offset + maxChars);
            if (end < message.text.length && end > cursor.offset && /[\uD800-\uDBFF]/.test(message.text[end - 1]))
                end++;
            const nextCursor = end < message.text.length
                ? { message: cursor.message, offset: end }
                : cursor.message + 1 < session.messages.length ? { message: cursor.message + 1, offset: 0 } : null;
            return { item: { ...message, text: message.text.slice(cursor.offset, end), offset: cursor.offset, complete: end === message.text.length }, nextCursor, incomplete: session.incomplete };
        });
    }
}
