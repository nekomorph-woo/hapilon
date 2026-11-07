import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SessionStore } from "../../extensions/hpl-find-session/session-store.js";
import { formatListMeta, formatSearchHit, verifyResults } from "../../extensions/hpl-find-session/worker.js";
const header = (id, parentSession) => ({ type: "session", id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/project", ...(parentSession ? { parentSession } : {}) });
const message = (id, parentId, role, text) => ({
    type: "message", id, parentId, timestamp: "2026-01-01", message: { role, content: [{ type: "text", text }] },
});
const writeSession = (path, entries) => writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
async function fixture() {
    const base = mkdtempSync(join(tmpdir(), "fsx-worker-"));
    const dir = join(base, "sessions", "project");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "a.jsonl");
    writeSession(path, [header("s-1"), message("m1", null, "user", "关于发版的讨论：三步走"), message("m2", "m1", "assistant", "好的，先出 release notes")]);
    return { base, store: new SessionStore(join(base, "sessions")), path };
}
it("工具输出含完整 id/msg/path/line，足以原样构造结果；snippet 不折叠空白", () => {
    const sessionId = "01a0998c-1234-4abc-9def-567890abcdef";
    const messageId = "dd06b5ac-9876-4fed-8cba-1234567890ab";
    const path = "/sessions/project/a.jsonl";
    const hitLine = formatSearchHit({
        sessionId, path, line: 1255, messageId, parentId: null,
        timestamp: "2026-09-13T13:35:06.319Z", role: "assistant",
        snippet: "两个提交：`c917cd2`（主体修复）、\n`738f717`（引号/转义加固）",
    });
    assert.ok(hitLine.includes(`session=${sessionId}`), "完整 sessionId 必须在输出里");
    assert.ok(!hitLine.includes(`session=${sessionId.slice(0, 8)} `), "不允许只给截短 sessionId");
    assert.ok(hitLine.includes(`msg=${messageId}`), "完整 messageId 必须在输出里");
    assert.ok(hitLine.includes(`${path}:1255`));
    assert.ok(hitLine.includes("\n`738f717`"), "snippet 保留原始换行/空白，quote 才能逐字对上");
    const metaLine = formatListMeta({
        path, id: sessionId, timestamp: "2026-09-13T13:35:06.319Z", cwd: "/p", incomplete: false,
    });
    assert.ok(metaLine.includes(`id=${sessionId}`), "列表行给完整 id");
    assert.ok(metaLine.includes(path));
});
it("核验通过合法结果（quote 与原文一致）", async () => {
    const { base, store, path } = await fixture();
    try {
        const { verified, report } = await Effect.runPromise(verifyResults(store, [{
                sessionId: "s-1", path, summary: "讨论发版流程", reason: "提到发版", evidence: [{ line: 2, messageId: "m1", quote: "关于发版的讨论：三步走" }],
            }]));
        assert.equal(verified.length, 1);
        assert.equal(verified[0]?.evidence[0]?.role, "user");
        assert.ok(report[0]?.startsWith("✓"));
    }
    finally {
        rmSync(base, { recursive: true, force: true });
    }
});
it("quote 空白差异归一化后仍通过，捏造引文被拒绝", async () => {
    const { base, store, path } = await fixture();
    try {
        const spaced = await Effect.runPromise(verifyResults(store, [{
                sessionId: "s-1", path, summary: "s", reason: "r", evidence: [{ line: 2, messageId: "m1", quote: "关于发版的讨论：\n  三步走" }],
            }]));
        assert.equal(spaced.verified.length, 1);
        const forged = await Effect.runPromise(verifyResults(store, [{
                sessionId: "s-1", path, summary: "s", reason: "r", evidence: [{ line: 2, messageId: "m1", quote: "这句话根本不在会话里" }],
            }]));
        assert.equal(forged.verified.length, 0);
        assert.ok(forged.report.join("\n").includes("quote 不在该消息原文中"));
    }
    finally {
        rmSync(base, { recursive: true, force: true });
    }
});
it("sessionId 不符、行号不存在、路径越界、缺字段、空结果都拒绝", async () => {
    const { base, store, path } = await fixture();
    try {
        const wrongId = await Effect.runPromise(verifyResults(store, [{
                sessionId: "s-other", path, summary: "s", reason: "r", evidence: [],
            }]));
        assert.equal(wrongId.verified.length, 0);
        assert.ok(wrongId.report.join("\n").includes("sessionId 不符"));
        const badLine = await Effect.runPromise(verifyResults(store, [{
                sessionId: "s-1", path, summary: "s", reason: "r", evidence: [{ line: 99, messageId: "m1", quote: "x" }],
            }]));
        assert.ok(badLine.report.join("\n").includes("行号不存在"));
        const outside = await Effect.runPromise(verifyResults(store, [{
                sessionId: "s-1", path: join(base, "sessions", "escape.jsonl"), summary: "s", reason: "r", evidence: [],
            }]));
        assert.equal(outside.verified.length, 0);
        const missingField = await Effect.runPromise(verifyResults(store, [{ sessionId: "s-1" }]));
        assert.ok(missingField.report.join("\n").includes("缺少"));
        const empty = await Effect.runPromise(verifyResults(store, []));
        assert.deepEqual(empty.verified, []);
        assert.ok(empty.report[0]?.includes("无匹配"));
    }
    finally {
        rmSync(base, { recursive: true, force: true });
    }
});
