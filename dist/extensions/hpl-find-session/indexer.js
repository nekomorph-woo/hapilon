/**
 * indexer.ts — 会话摘要索引：后台预建（查询快路径的数据源）。
 *
 * 单写者：锁由调用方（indexer-lifecycle.ts）在 pass 最外层持有，本模块不管锁；
 * 查询侧只读缓存并发布补建请求，只有锁持有者写 index.json（整份读改 + 原子改名）。摘要来自 digest.ts 的完整分段总结，
 * 缓存版本 v2；旧 v1 缓存（首末消息 80 字摘要）直接作废重建。
 * 防抖：文件 mtime 安静 10 分钟才自动建索引；建索引前后 stat 一致才记当前 mtime。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Effect } from "effect";
import { selectRecapModel, recapModelLabel } from "../hpl-recap/model.js";
import { parseSessionFile } from "./index-core.js";
import { buildSessionDigest, DigestFileError } from "./digest.js";
import { appendCompletionEvent, consumeRebuildRequests, nextEventId, requestRebuild, } from "./coordination.js";
const QUIET_MS = 10 * 60 * 1000;
export const INDEX_VERSION = 2;
export function indexPath(sessionsRoot) {
    return join(sessionsRoot, "index.json");
}
/** 读索引；缺文件、损坏或旧版本（v1）都返回空表——旧缓存整体重建。 */
export function loadIndex(sessionsRoot) {
    const out = new Map();
    const file = indexPath(sessionsRoot);
    if (!existsSync(file))
        return out;
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (parsed?.version !== INDEX_VERSION)
            return out;
        if (parsed.records && typeof parsed.records === "object") {
            for (const [path, record] of Object.entries(parsed.records)) {
                if (record && record.excerpt && typeof record.summary === "string")
                    out.set(path, record);
            }
        }
    }
    catch {
        // 损坏的索引当不存在：后台索引器下一轮会用正确数据覆盖
    }
    return out;
}
export function writeIndexAtomic(sessionsRoot, records) {
    const file = indexPath(sessionsRoot);
    const tmp = join(dirname(file), `.${basename(file)}.tmp`);
    const payload = { version: INDEX_VERSION, records: Object.fromEntries(records) };
    writeFileSync(tmp, JSON.stringify(payload));
    renameSync(tmp, file);
}
/**
 * 从「当前文件清单 + 已有索引」挑出需要建索引的文件：
 * 已安静 QUIET_MS 且（无缓存或 mtime 变过），按最近优先。
 * extraPaths（查询侧补建请求）不受安静门限制，但仍要 stat 稳定才入账。
 */
export function pendingForIndex(files, index, now, extraPaths = []) {
    const byPath = new Map(files.map((f) => [f.path, f]));
    const out = new Map();
    for (const f of files) {
        if (now - f.mtimeMs < QUIET_MS)
            continue;
        const cached = index.get(f.path);
        if (!cached || cached.mtimeMs !== f.mtimeMs)
            out.set(f.path, f);
    }
    for (const p of extraPaths) {
        const f = byPath.get(p);
        if (!f)
            continue;
        const cached = index.get(f.path);
        if (!cached || cached.mtimeMs !== f.mtimeMs)
            out.set(f.path, f);
    }
    return [...out.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}
/** 单写者合并：只应由锁持有者调用；写前重读防覆盖他人记录。 */
export function mergeIntoIndex(sessionsRoot, fresh) {
    if (fresh.size === 0)
        return;
    const index = loadIndex(sessionsRoot);
    for (const [path, record] of fresh)
        index.set(path, record);
    writeIndexAtomic(sessionsRoot, index);
}
/** 一轮索引的 Effect：选模型 → 逐文件 digest → 合并写回 → 追加完成事件。锁由调用方持有。 */
export const runIndexerPass = (sessionsRoot, files, deps, now, signal) => Effect.gen(function* () {
    const requested = consumeRebuildRequests(sessionsRoot);
    const index = loadIndex(sessionsRoot);
    const pending = pendingForIndex(files, index, now, requested);
    const choice = selectRecapModel(deps.available, deps.currentModel, deps.resolvedTiers);
    const stats = {
        id: nextEventId(),
        ts: now,
        scanned: pending.length,
        added: 0,
        updated: 0,
        failed: 0,
        remaining: 0,
        indexedTotal: 0,
        totalFiles: files.length,
        modelLabel: choice.model ? recapModelLabel(choice.model) : "",
        tierDegraded: choice.model !== undefined && choice.degraded,
        noModel: !choice.model,
    };
    if (!choice.model || pending.length === 0) {
        stats.remaining = Math.max(0, pending.length);
        stats.indexedTotal = index.size;
        appendCompletionEvent(sessionsRoot, stats);
        return stats;
    }
    const model = choice.model;
    let firstError;
    for (const file of pending) {
        if (signal?.aborted)
            break;
        const hadCached = index.has(file.path);
        const excerpt = yield* Effect.tryPromise({
            try: () => parseSessionFile(file.path, file.sizeBytes),
            catch: (cause) => new DigestFileError({ path: file.path, stage: "read", cause: String(cause) }),
        });
        if (!excerpt) {
            stats.failed++;
            firstError ??= new DigestFileError({ path: file.path, stage: "read", cause: "会话文件解析失败" });
            continue;
        }
        const outcome = yield* buildSessionDigest(file.path, file.sizeBytes, sessionsRoot, deps, model, signal).pipe(
        // 单文件失败计入 failed 继续下一文件；真实原因留给 failureCause
        Effect.catchAll((error) => {
            stats.failed++;
            firstError ??= error;
            return Effect.succeed(null);
        }));
        if (outcome === null)
            continue;
        // 摘要期间文件稳定（digest 内部已校验），记当前 mtime
        const record = { excerpt, mtimeMs: file.mtimeMs, summary: outcome.summary };
        index.set(file.path, record);
        mergeIntoIndex(sessionsRoot, new Map([[file.path, record]]));
        if (hadCached)
            stats.updated++;
        else
            stats.added++;
    }
    if (firstError) {
        stats.failureCause = `${firstError._tag}: ${"cause" in firstError ? String(firstError.cause) : ""}`;
    }
    const fresh = loadIndex(sessionsRoot);
    stats.indexedTotal = fresh.size;
    const stillStale = pendingForIndex(files, fresh, Date.now(), requested).length;
    stats.remaining = signal?.aborted ? stillStale + (pending.length - stats.added - stats.updated - stats.failed) : stillStale;
    appendCompletionEvent(sessionsRoot, stats);
    return stats;
});
export { requestRebuild };
