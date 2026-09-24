/**
 * cache.ts — 限额快照的文件通道（quota-cache）
 *
 * pi loader 每扩展独立 jiti 实例，跨扩展模块状态不共享（R2 教训），
 * 轮询结果写 JSON 文件，hpl-footer / hpl-model-tiers 等各自读取。
 * 文件按 provider 分键（v2），各 provider 独立 timestamp/TTL——单次查询失败
 * 或某个 provider 过期都不影响其它 provider 的快照。
 * 文件位置可由 HAPILON_QUOTA_CACHE 覆盖（测试注入）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { asRecord } from "./types.js";
import { quotaNamespace } from "./snapshot.js";
const MAX_AGE_MS = 15 * 60 * 1000;
export function quotaCachePath() {
    return process.env["HAPILON_QUOTA_CACHE"] ?? join(tmpdir(), "hapilon-quota-cache.json");
}
function isSnapshot(value) {
    const record = asRecord(value);
    return record !== undefined
        && typeof record["provider"] === "string"
        && Array.isArray(record["windows"]);
}
/**
 * 读文件为 provider 映射：v2 直读，v1（顶层即单个快照）按 provider 收进映射。
 * 损坏/结构不符一律当空——坏文件不能让选模或 footer 炸掉。
 */
function readSnapshotMap(path) {
    if (!existsSync(path))
        return {};
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return {};
    }
    if (isSnapshot(parsed))
        return { [parsed.provider]: parsed };
    const providers = asRecord(asRecord(parsed)?.["providers"]);
    if (!providers)
        return {};
    const result = {};
    for (const [key, value] of Object.entries(providers)) {
        if (isSnapshot(value))
            result[key] = value;
    }
    return result;
}
function isStale(snapshot, now) {
    return !Number.isFinite(snapshot.timestamp) || now - snapshot.timestamp > MAX_AGE_MS;
}
/** 未过期的快照（按 provider 命名空间分键）；过期条目不出现在返回值中，也不影响其它 provider。 */
export function readQuotaSnapshots(now = Date.now()) {
    return Object.values(readSnapshotMap(quotaCachePath())).filter((snapshot) => !isStale(snapshot, now));
}
/** 单个 provider 的快照；缺快照与已过期对消费方同义：无数据。 */
export function readQuotaSnapshotFor(provider, now = Date.now()) {
    const snapshot = readSnapshotMap(quotaCachePath())[quotaNamespace(provider)];
    return snapshot && !isStale(snapshot, now) ? snapshot : undefined;
}
/**
 * 合并写入：只替换本 provider 的条目，其它 provider 现有快照原样保留。
 * 读-改-写 + tmp/rename 原子替换——同时刻多个 pane 写不同 provider 时最坏丢一次
 * 并发更新，下一轮轮询（≤10min）自愈；半截 JSON 则永远不会被读到。
 */
export function writeQuotaSnapshot(snapshot) {
    try {
        const path = quotaCachePath();
        const now = Date.now();
        const providers = {};
        for (const [key, value] of Object.entries(readSnapshotMap(path))) {
            if (!isStale(value, now))
                providers[key] = value;
        }
        providers[snapshot.provider] = snapshot;
        const file = { version: 2, providers };
        const parent = dirname(path);
        if (!existsSync(parent))
            mkdirSync(parent, { recursive: true, mode: 0o700 });
        const tmpPath = `${path}.tmp`;
        writeFileSync(tmpPath, JSON.stringify(file), { encoding: "utf8", mode: 0o600 });
        renameSync(tmpPath, path);
    }
    catch {
        // 缓存写失败不影响主流程
    }
}
