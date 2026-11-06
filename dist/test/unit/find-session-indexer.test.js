import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import { acquireLeader, indexPath, loadIndex, mergeIntoIndex, pendingForIndex, releaseLeader, summarizeEntries, writeIndexAtomic, } from "../../extensions/hpl-find-session/indexer.js";
const NOW = 1_800_000_000_000;
const QUIET = 10 * 60 * 1000;
function excerpt(path, first = "用户首句") {
    return {
        path, id: "id", cwd: "~/p", name: "", created: "2026-11-06T10:00:00Z",
        modified: "2026-11-06T11:00:00Z", messageCount: 3, firstUser: first, lastUser: "末句", sizeBytes: 100,
    };
}
function record(path, mtimeMs, summary = "总结") {
    return { excerpt: excerpt(path), mtimeMs, summary };
}
describe("pendingForIndex", () => {
    it("安静的未索引文件入选，运行中的排除", () => {
        const files = [
            { path: "a", mtimeMs: NOW - 2 * QUIET, sizeBytes: 1 },
            { path: "b", mtimeMs: NOW - QUIET / 2, sizeBytes: 1 },
        ];
        const pending = pendingForIndex(files, new Map(), NOW);
        assert.deepEqual(pending.map((f) => f.path), ["a"]);
    });
    it("mtime 与缓存一致的跳过，变过的重算，按最近优先", () => {
        const files = [
            { path: "old", mtimeMs: NOW - 3 * QUIET, sizeBytes: 1 },
            { path: "changed", mtimeMs: NOW - 2 * QUIET, sizeBytes: 1 },
            { path: "fresh", mtimeMs: NOW - 4 * QUIET, sizeBytes: 1 },
        ];
        const index = new Map([
            ["old", record("old", NOW - 3 * QUIET)],
            ["changed", record("changed", NOW - 5 * QUIET)],
            ["fresh", record("fresh", NOW - 4 * QUIET)],
        ]);
        const pending = pendingForIndex(files, index, NOW);
        assert.deepEqual(pending.map((f) => f.path), ["changed"]);
    });
});
describe("index 读写", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-idx-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    it("写入后可读回，损坏文件返回空表", () => {
        const records = new Map([["a", record("a", 123)]]);
        writeIndexAtomic(dir, records);
        assert.equal(loadIndex(dir).get("a")?.mtimeMs, 123);
        writeFileSync(indexPath(dir), "{broken json");
        assert.equal(loadIndex(dir).size, 0);
    });
    it("mergeIntoIndex 写前重读，不覆盖他人并发写入的记录", () => {
        writeIndexAtomic(dir, new Map([["other", record("other", 1)]]));
        mergeIntoIndex(dir, new Map([["mine", record("mine", 2)]]), new Map([["mine", 2]]));
        const loaded = loadIndex(dir);
        assert.ok(loaded.has("other") && loaded.has("mine"));
    });
});
describe("summarizeEntries", () => {
    const okDeps = (text) => ({
        available: [{ provider: "p", id: "m", name: "M", reasoning: false }],
        currentModel: undefined,
        resolvedTiers: { opus: [], sonnet: [], haiku: [{ provider: "p", id: "m" }] },
        complete: async () => ({ content: [{ type: "text", text }] }),
    });
    it("解析模型 JSON 输出为记录", async () => {
        const out = await summarizeEntries([excerpt("a"), excerpt("b")], okDeps('[{"i":0,"s":"总结甲"},{"i":1,"s":"总结乙"}]'));
        assert.equal(out.records.get("a")?.summary, "总结甲");
        assert.equal(out.records.get("b")?.summary, "总结乙");
        assert.equal(out.skipped.length, 0);
    });
    it("模型输出无效时整批跳过，不写记录", async () => {
        const out = await summarizeEntries([excerpt("a")], okDeps("不是 JSON"));
        assert.equal(out.records.size, 0);
        assert.deepEqual(out.skipped, ["a"]);
    });
    it("无可用模型时全部跳过", async () => {
        const deps = {
            available: [], currentModel: undefined,
            resolvedTiers: { opus: [], sonnet: [], haiku: [] },
            complete: async () => ({}),
        };
        const out = await summarizeEntries([excerpt("a")], deps);
        assert.equal(out.records.size, 0);
    });
});
describe("领导者锁", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-lock-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    it("先到先得，第二个实例抢不到", () => {
        assert.equal(acquireLeader(dir, NOW), true);
        assert.equal(acquireLeader(dir, NOW + 1000), false);
        releaseLeader(dir);
        assert.equal(acquireLeader(dir, NOW), true);
        releaseLeader(dir);
    });
    it("心跳过期后可被接管", () => {
        assert.equal(acquireLeader(dir, NOW), true);
        // 锁内容即心跳时间戳；超过 10 分钟视为崩溃残留
        const later = NOW + 11 * 60 * 1000;
        assert.equal(acquireLeader(dir, later), true);
        releaseLeader(dir);
    });
});
