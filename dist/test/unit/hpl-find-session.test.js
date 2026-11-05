import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanUserText, grepSessions, parseSessionFile, prefilter, scanSessions, listSessionFiles, } from "../../extensions/hpl-find-session/index-core.js";
import { fallbackSummary, parseRankedJson, rankEntries } from "../../extensions/hpl-find-session/rank.js";
function writeSession(root, dir, file, lines) {
    const sub = join(root, dir);
    mkdirSync(sub, { recursive: true });
    const path = join(sub, file);
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return path;
}
function entryFixture(overrides = {}) {
    return {
        path: "/tmp/s.jsonl",
        id: "id-1",
        cwd: "/Volumes/Under_M2/morphiiouo/hapilon",
        name: "",
        created: "2026-11-01T00:00:00.000Z",
        modified: "2026-11-01T01:00:00.000Z",
        messageCount: 5,
        firstUser: "帮我修 tsx 跑法坑",
        lastUser: "谢谢",
        sizeBytes: 100,
        ...overrides,
    };
}
describe("cleanUserText", () => {
    it("去掉 acp 标签与 skill XML 包裹", () => {
        const text = cleanUserText('<skill name="ask">内容</skill>\n<acp tokens="1" type="text">m1</acp>你好');
        assert.equal(text, "内容 你好");
    });
});
describe("parseSessionFile / scanSessions", () => {
    const root = mkdtempSync(join(tmpdir(), "hpl-find-session-"));
    it("解析 header、名字、首末用户消息并跳过空文件", async () => {
        writeSession(root, "dirA", "a.jsonl", [
            { type: "session", id: "aaa", timestamp: "2026-11-01T00:00:00.000Z", cwd: "/proj/x" },
            { type: "session_info", name: "发版脚本" },
            { type: "message", timestamp: "2026-11-01T00:01:00.000Z", message: { role: "system", content: "sys" } },
            { type: "message", timestamp: "2026-11-01T00:02:00.000Z", message: { role: "user", content: "第一个问题" } },
            { type: "message", timestamp: "2026-11-01T00:03:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "回答" }] } },
            { type: "message", timestamp: "2026-11-01T00:04:00.000Z", message: { role: "user", content: "最后一个问题" } },
        ]);
        writeSession(root, "dirA", "empty.jsonl", []);
        const entries = await scanSessions(root);
        assert.equal(entries.length, 1);
        const e = entries[0];
        assert.equal(e.id, "aaa");
        assert.equal(e.name, "发版脚本");
        assert.equal(e.cwd, "/proj/x");
        assert.equal(e.firstUser, "第一个问题");
        assert.equal(e.lastUser, "最后一个问题");
        assert.equal(e.messageCount, 4);
        assert.equal(e.modified, "2026-11-01T00:04:00.000Z");
    });
    it("不存在的目录返回空", () => {
        assert.deepEqual(listSessionFiles(join(root, "nope")), []);
    });
    it("损坏行被跳过不炸", async () => {
        const sub = join(root, "dirB");
        mkdirSync(sub, { recursive: true });
        writeFileSync(join(sub, "broken.jsonl"), '{"type":"session","id":"b"\nnot-json\n');
        const parsed = await parseSessionFile(join(sub, "broken.jsonl"), 10);
        assert.equal(parsed, null);
    });
    after(() => rmSync(root, { recursive: true, force: true }));
});
describe("prefilter", () => {
    const entries = [
        entryFixture({ path: "/1", name: "", firstUser: "修复 tsx 坑" }),
        entryFixture({ path: "/2", name: "发版讨论", firstUser: "怎么打 tag", lastUser: "" }),
    ];
    it("token 命中降序，无命中返回空", () => {
        assert.deepEqual(prefilter(entries, "tsx").map((e) => e.path), ["/1"]);
        assert.deepEqual(prefilter(entries, "不存在词"), []);
        assert.equal(prefilter(entries, "").length, 2);
    });
});
describe("grepSessions", () => {
    const root = mkdtempSync(join(tmpdir(), "hpl-find-session-grep-"));
    writeSession(root, "dirC", "c.jsonl", [
        { type: "session", id: "ccc", timestamp: "2026-11-01T00:00:00.000Z", cwd: "/proj/y" },
        { type: "message", timestamp: "2026-11-01T00:01:00.000Z", message: { role: "user", content: "我们讨论过 release-notes 生成器" } },
    ]);
    it("命中返回片段", async () => {
        const { hits, truncated } = await grepSessions(root, "release-notes");
        assert.equal(truncated, false);
        assert.equal(hits.length, 1);
        assert.ok(hits[0].snippet.includes("release-notes"));
        assert.equal(hits[0].id, "ccc");
    });
    it("无效正则抛错", async () => {
        await assert.rejects(() => grepSessions(root, "(["), /正则无效/);
    });
    after(() => rmSync(root, { recursive: true, force: true }));
});
describe("parseRankedJson", () => {
    it("解析带围栏的 JSON", () => {
        const out = parseRankedJson('```json\n[{"i":0,"s":"修坑会话"}]\n```');
        assert.deepEqual(out, [{ index: 0, summary: "修坑会话" }]);
    });
    it("非 JSON / 缺字段返回空", () => {
        assert.deepEqual(parseRankedJson("我觉得没有相关会话"), []);
        assert.deepEqual(parseRankedJson('[{"s":"无编号"}]'), []);
    });
});
describe("rankEntries", () => {
    const deps = (text) => ({
        available: [{ provider: "p", id: "m" }],
        currentModel: undefined,
        resolvedTiers: { opus: [], sonnet: [], haiku: [{ provider: "p", id: "m" }] },
        complete: async () => (text === null ? Promise.reject(new Error("boom")) : { content: text }),
    });
    const candidates = [entryFixture({ path: "/1" }), entryFixture({ path: "/2", firstUser: "发版脚本问题" })];
    it("按模型顺序重排并带摘要", async () => {
        const { ranked, degraded } = await rankEntries("发版", candidates, deps('[{"i":1,"s":"讨论发版脚本"},{"i":0,"s":"修坑"}]'));
        assert.equal(degraded, false);
        assert.deepEqual(ranked.map((r) => r.entry.path), ["/2", "/1"]);
        assert.equal(ranked[0].summary, "讨论发版脚本");
    });
    it("模型失败降级为原序 + 首条消息摘要", async () => {
        const { ranked, degraded } = await rankEntries("发版", candidates, deps(null));
        assert.equal(degraded, true);
        assert.deepEqual(ranked.map((r) => r.entry.path), ["/1", "/2"]);
        assert.equal(ranked[0].summary, fallbackSummary(candidates[0]));
    });
    it("无候选直接返回空", async () => {
        const { ranked } = await rankEntries("x", [], deps("[]"));
        assert.deepEqual(ranked, []);
    });
});
