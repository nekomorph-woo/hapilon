import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import hplRecap from "../../extensions/hpl-recap/index.js";
function makeExtension() {
    const handlers = new Map();
    const widgets = [];
    let completeCount = 0;
    let pending = false;
    const model = { provider: "fast", id: "flash", name: "Flash", reasoning: false };
    const ctx = {
        mode: "tui",
        hasUI: true,
        cwd: "/tmp/recap-project",
        model,
        ui: {
            theme: { fg: (slot, text) => `<${slot}>${text}` },
            setWidget: (key, content) => widgets.push({ key, content }),
        },
        isIdle: () => true,
        hasPendingMessages: () => pending,
        sessionManager: {
            buildContextEntries: () => [{ type: "message", message: { role: "user", content: "刚才完成了工作" } }],
        },
        modelRegistry: {
            getAvailable: () => [model],
            complete: async () => {
                completeCount++;
                return { content: [{ type: "text", text: "已完成：当前状态正常；下一步继续验证。" }] };
            },
        },
        setPending(value) {
            pending = value;
        },
    };
    hplRecap({
        on: ((event, handler) => handlers.set(event, handler)),
    });
    return { ctx, handlers, widgets, getCompleteCount: () => completeCount };
}
function fire(test, event, payload = {}) {
    return test.handlers.get(event)?.(payload, test.ctx);
}
function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
describe("hpl-recap session 生命周期", () => {
    let home;
    const originalHome = process.env.HAPILON_HOME;
    before(() => {
        home = mkdtempSync(join(tmpdir(), "hapilon-recap-lifecycle-"));
        process.env.HAPILON_HOME = home;
        writeFileSync(join(home, "recap-config.json"), JSON.stringify({ enabled: true, idleMinutes: 0.001, maxContextChars: 8000 }));
        writeFileSync(join(home, "model-tiers-resolved.json"), JSON.stringify({
            high: [],
            mid: [],
            low: [{ provider: "fast", id: "flash", name: "Flash", reasoning: false }],
        }));
    });
    afterEach(() => {
        // 每个用例的扩展都应在自身结尾 shutdown；这里仅清理文件状态。
    });
    after(() => {
        if (originalHome === undefined)
            delete process.env.HAPILON_HOME;
        else
            process.env.HAPILON_HOME = originalHome;
        rmSync(home, { recursive: true, force: true });
    });
    it("session_start 到期经过双重 idle 判定后 setWidget，shutdown 后 timer 不再执行", async () => {
        const test = makeExtension();
        fire(test, "session_start", { reason: "startup" });
        test.ctx.setPending(true);
        await wait(90);
        assert.equal(test.getCompleteCount(), 0, "有 pending message 时不应调用 complete");
        test.ctx.setPending(false);
        fire(test, "message_end", { type: "message_end" });
        await wait(100);
        assert.equal(test.getCompleteCount(), 1);
        assert.ok(test.widgets.some((item) => item.key === "hpl-recap" && Array.isArray(item.content)));
        const widgetCountBeforeInput = test.widgets.length;
        const inputResult = fire(test, "input", { type: "input", text: "新问题", source: "interactive" });
        assert.equal(inputResult, undefined, "input handler 不拦截用户输入");
        assert.equal(test.widgets.length, widgetCountBeforeInput + 1);
        assert.equal(test.widgets.at(-1)?.content, undefined, "新输入清除旧 recap widget");
        fire(test, "session_shutdown", { reason: "quit" });
        const countAfterShutdown = test.getCompleteCount();
        assert.equal(test.widgets.at(-1)?.content, undefined);
        await wait(90);
        assert.equal(test.getCompleteCount(), countAfterShutdown);
    });
    it("二次 session_start 前后状态干净，旧 timer 不穿透新 session", async () => {
        const test = makeExtension();
        fire(test, "session_start", { reason: "startup" });
        fire(test, "session_shutdown", { reason: "reload" });
        fire(test, "session_start", { reason: "reload" });
        await wait(100);
        assert.equal(test.getCompleteCount(), 1);
        fire(test, "session_shutdown", { reason: "quit" });
    });
});
