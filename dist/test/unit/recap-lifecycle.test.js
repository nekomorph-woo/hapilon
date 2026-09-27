import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import hplRecap from "../../extensions/hpl-recap/index.js";
function makeExtension(recapModel = { provider: "fast", id: "flash", name: "Flash", reasoning: false }, texts = ["已完成：当前状态正常；下一步继续验证。"]) {
    const handlers = new Map();
    const widgets = [];
    const completeOptions = [];
    let completeCount = 0;
    let pending = false;
    const model = recapModel;
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
            complete: async (_model, _context, opts) => {
                const text = texts[completeCount] ?? texts.at(-1) ?? "";
                completeCount++;
                completeOptions.push(opts);
                return { content: [{ type: "text", text }] };
            },
        },
        setPending(value) {
            pending = value;
        },
    };
    hplRecap({
        on: ((event, handler) => {
            handlers.set(event, handler);
            return () => handlers.delete(event);
        }),
    });
    return { ctx, handlers, widgets, getCompleteCount: () => completeCount, completeOptions };
}
function fire(test, event, payload = {}) {
    return test.handlers.get(event)?.(payload, test.ctx);
}
function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// 固定 sleep 会与 60ms idle 阈值竞态（timer 早触发一次即多等一轮），故轮询到 widget 落盘。
async function waitForWidget(test) {
    for (let i = 0; i < 200; i++) {
        const content = test.widgets.at(-1)?.content;
        if (content)
            return content;
        await wait(5);
    }
    throw new Error("recap widget 未在 1s 内出现");
}
function untheme(line) {
    return line.replace(/^<muted>/, "").replace(/<\/muted>$/, "");
}
// 去掉头部时间戳/模型标签行，只留正文行。
function widgetBody(test) {
    return (test.widgets.at(-1)?.content ?? []).slice(1).map(untheme);
}
function spyWarn() {
    const original = console.warn;
    const calls = [];
    console.warn = (...args) => { calls.push(args.map(String).join(" ")); };
    return { calls, restore: () => { console.warn = original; } };
}
describe("hpl-recap session 生命周期", () => {
    let home;
    const originalHome = process.env.HAPILON_HOME;
    before(() => {
        home = mkdtempSync(join(tmpdir(), "hapilon-recap-lifecycle-"));
        process.env.HAPILON_HOME = home;
        writeFileSync(join(home, "recap-config.json"), JSON.stringify({ enabled: true, idleMinutes: 0.001, maxContextChars: 8000 }));
        writeFileSync(join(home, "model-tiers-resolved.json"), JSON.stringify({
            opus: [],
            sonnet: [],
            haiku: [{ provider: "fast", id: "flash", name: "Flash", reasoning: false }],
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
        await waitForWidget(test);
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
        await waitForWidget(test);
        assert.equal(test.getCompleteCount(), 1);
        fire(test, "session_shutdown", { reason: "quit" });
    });
    it("非推理 haiku：小预算快路径，不传任何推理开关", async () => {
        const test = makeExtension();
        fire(test, "session_start", { reason: "startup" });
        fire(test, "message_end", { type: "message_end" });
        await waitForWidget(test);
        assert.equal(test.getCompleteCount(), 1);
        const opts = test.completeOptions[0];
        assert.equal(opts?.maxTokens, 256);
        assert.equal("reasoningEffort" in (opts ?? {}), false);
        assert.equal("reasoning" in (opts ?? {}), false, "已废的 reasoning:off 键不得再传");
        fire(test, "session_shutdown", { reason: "quit" });
    });
    it("haiku 档是推理模型（如 glm-4.7）：同样 {maxTokens:256} 且不传任何推理开关", async () => {
        const reasoningModel = { provider: "zai", id: "glm-4.7", name: "GLM", reasoning: true };
        const resolvedPath = join(home, "model-tiers-resolved.json");
        writeFileSync(resolvedPath, JSON.stringify({ opus: [], sonnet: [], haiku: [reasoningModel] }));
        try {
            const test = makeExtension(reasoningModel);
            fire(test, "session_start", { reason: "startup" });
            fire(test, "message_end", { type: "message_end" });
            await waitForWidget(test);
            assert.equal(test.getCompleteCount(), 1);
            const opts = test.completeOptions[0];
            assert.equal(opts?.maxTokens, 256, JSON.stringify(opts));
            assert.equal("reasoningEffort" in (opts ?? {}), false, JSON.stringify(opts));
            assert.equal("reasoning" in (opts ?? {}), false, JSON.stringify(opts));
            fire(test, "session_shutdown", { reason: "quit" });
        }
        finally {
            // 还原给其它用例的默认档位，断言失败也要还原
            writeFileSync(resolvedPath, JSON.stringify({
                opus: [],
                sonnet: [],
                haiku: [{ provider: "fast", id: "flash", name: "Flash", reasoning: false }],
            }));
        }
    });
    it("连续 3 次空正文：预算逐级放大到第 4 次，展示第 4 次正文且不 warn", async () => {
        const test = makeExtension(undefined, ["", "", "", "最后一次拿到的正文。"]);
        const warns = spyWarn();
        try {
            fire(test, "session_start", { reason: "startup" });
            fire(test, "message_end", { type: "message_end" });
            const lines = await waitForWidget(test);
            assert.equal(test.getCompleteCount(), 4);
            assert.deepEqual(test.completeOptions.map((opts) => opts?.maxTokens), [256, 1024, 4096, 4096]);
            assert.ok(lines.some((line) => line.includes("最后一次拿到的正文。")), JSON.stringify(lines));
            assert.equal(lines.some((line) => line.includes("模型未返回有效内容")), false);
            assert.deepEqual(warns.calls, [], "中间某次为空不得 warn");
        }
        finally {
            warns.restore();
            fire(test, "session_shutdown", { reason: "quit" });
        }
    });
    it("4 次全空：failure widget + 恰好一条汇总 warn（含预算序列）", async () => {
        const test = makeExtension(undefined, ["", "", "", ""]);
        const warns = spyWarn();
        try {
            fire(test, "session_start", { reason: "startup" });
            fire(test, "message_end", { type: "message_end" });
            const lines = await waitForWidget(test);
            assert.equal(test.getCompleteCount(), 4);
            assert.deepEqual(test.completeOptions.map((opts) => opts?.maxTokens), [256, 1024, 4096, 4096]);
            assert.ok(lines.some((line) => line.includes("模型未返回有效内容")), JSON.stringify(lines));
            assert.equal(warns.calls.length, 1, JSON.stringify(warns.calls));
            assert.ok(warns.calls[0].includes("256/1024/4096/4096"), warns.calls[0]);
        }
        finally {
            warns.restore();
            fire(test, "session_shutdown", { reason: "quit" });
        }
    });
    it("JSON 正常路径：progress 与 next 分行渲染，标签由渲染侧拼接", async () => {
        const payload = JSON.stringify({ progress: "正在起草金值用例，7 条 case 已写入 cases.yaml。", next: "确认归并词后跑判卷。" });
        const test = makeExtension(undefined, [payload]);
        fire(test, "session_start", { reason: "startup" });
        fire(test, "message_end", { type: "message_end" });
        await waitForWidget(test);
        assert.equal(test.getCompleteCount(), 1, "合法 JSON 不得触发预算放大");
        const body = widgetBody(test);
        assert.deepEqual(body, ["正在起草金值用例，7 条 case 已写入 cases.yaml。", "下一步建议：确认归并词后跑判卷。"]);
        fire(test, "session_shutdown", { reason: "quit" });
    });
    it("JSON 带 ```json 围栏与前后杂文：仍可解析", async () => {
        const payload = "好的，这是摘要：\n```json\n{\"progress\": \"单测全绿，基线确认。\", \"next\": \"开始改截断逻辑。\"}\n```\n以上。";
        const test = makeExtension(undefined, [payload]);
        fire(test, "session_start", { reason: "startup" });
        fire(test, "message_end", { type: "message_end" });
        await waitForWidget(test);
        assert.equal(test.getCompleteCount(), 1);
        const body = widgetBody(test);
        assert.deepEqual(body, ["单测全绿，基线确认。", "下一步建议：开始改截断逻辑。"]);
        fire(test, "session_shutdown", { reason: "quit" });
    });
    it("纯文本兜底：末句作建议段，其余作 progress", async () => {
        const test = makeExtension(undefined, ["单测全绿了。文档也更新完。接下来跑回归。"]);
        fire(test, "session_start", { reason: "startup" });
        fire(test, "message_end", { type: "message_end" });
        await waitForWidget(test);
        assert.equal(test.getCompleteCount(), 1, "纯文本不烧预算重试");
        const body = widgetBody(test);
        assert.deepEqual(body, ["单测全绿了。文档也更新完。", "下一步建议：接下来跑回归。"]);
        fire(test, "session_shutdown", { reason: "quit" });
    });
    it("progress 超 200 字：保头丢尾到 197 字 + 省略号；next 完整不截", async () => {
        const progress = "甲".repeat(250) + "。";
        const next = "乙".repeat(60) + "。";
        const test = makeExtension(undefined, [JSON.stringify({ progress, next })]);
        fire(test, "session_start", { reason: "startup" });
        fire(test, "message_end", { type: "message_end" });
        await waitForWidget(test);
        const body = widgetBody(test);
        assert.equal(body[0].length, 200, `progress 行长度 ${body[0].length}`);
        assert.ok(body[0].endsWith("..."));
        assert.ok(body[0].startsWith("甲".repeat(197)));
        assert.equal(body[1], `下一步建议：${next}`, "建议段一字不动");
        fire(test, "session_shutdown", { reason: "quit" });
    });
    it("多行 progress 在 200 字内：行数不限，全部保留", async () => {
        const progress = Array.from({ length: 12 }, (_, i) => `第${i + 1}行短内容`).join("\n");
        assert.ok(progress.length < 200);
        const test = makeExtension(undefined, [JSON.stringify({ progress, next: "看完继续。" })]);
        fire(test, "session_start", { reason: "startup" });
        fire(test, "message_end", { type: "message_end" });
        await waitForWidget(test);
        const body = widgetBody(test);
        assert.equal(body.length, 13, JSON.stringify(body));
        assert.equal(body.at(-1), "下一步建议：看完继续。");
        assert.equal(body.some((line) => line.includes("...")), false);
        fire(test, "session_shutdown", { reason: "quit" });
    });
    it("单句无句读纯文本超长：整段作 progress 保头切 200", async () => {
        const test = makeExtension(undefined, ["长".repeat(400)]);
        fire(test, "session_start", { reason: "startup" });
        fire(test, "message_end", { type: "message_end" });
        await waitForWidget(test);
        const body = widgetBody(test);
        assert.equal(body.length, 1);
        assert.equal(body[0].length, 200, `字符数 ${body[0].length}`);
        assert.ok(body[0].endsWith("..."));
        fire(test, "session_shutdown", { reason: "quit" });
    });
    it("progress 为空只有 next：仅渲染建议行", async () => {
        const test = makeExtension(undefined, [JSON.stringify({ progress: "", next: "直接跑判卷。" })]);
        fire(test, "session_start", { reason: "startup" });
        fire(test, "message_end", { type: "message_end" });
        await waitForWidget(test);
        const body = widgetBody(test);
        assert.deepEqual(body, ["下一步建议：直接跑判卷。"]);
        fire(test, "session_shutdown", { reason: "quit" });
    });
});
