import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import hplEcon, { statsLine, setSessionDisabled } from "../../extensions/hpl-econ/index.js";
import { readEconSettings, writeEconSettings, envDisabled, ECON_DEFAULTS } from "../../extensions/hpl-econ/settings.js";
/** 最小 ExtensionAPI mock：记录注册的 tool/command/hook */
function makeMockPi() {
    const tools = new Map();
    const commands = new Map();
    const hooks = new Map();
    return {
        pi: {
            registerTool: (def) => tools.set(def.name, def),
            registerCommand: (name, def) => commands.set(name, def),
            on: (event, handler) => hooks.set(event, handler),
        },
        tools,
        commands,
        hooks,
    };
}
describe("hpl-econ 扩展", () => {
    let agent;
    before(() => {
        agent = mkdtempSync(join(tmpdir(), "hpl-econ-ext-"));
        process.env.HAPILON_HOME = agent; // agentDir() = $HAPILON_HOME/agent
        mkdirSync(join(agent, "agent"), { recursive: true });
    });
    after(() => {
        delete process.env.HAPILON_HOME;
        rmSync(agent, { recursive: true, force: true });
    });
    function bashEvent(text, details) {
        return {
            type: "tool_result",
            toolName: "bash",
            toolCallId: "call-x",
            input: { command: "cat big.log" },
            content: [{ type: "text", text }],
            isError: false,
            details,
        };
    }
    it("默认开启：超阈值 bash 输出被压缩，返回省略提示与保留区", () => {
        const mock = makeMockPi();
        hplEcon(mock.pi);
        const hook = mock.hooks.get("tool_result");
        const lines = Array.from({ length: 3000 }, (_, i) => `log-${i}`).join("\n");
        const result = hook(bashEvent(lines));
        assert.ok(result, "超阈值应返回替换内容");
        const out = result.content[0].text;
        assert.ok(out.includes("log-0\n"), "头 40 行");
        assert.ok(out.includes("lines omitted"));
        assert.ok(out.length < lines.length / 10);
    });
    it("阈值内不压缩，返回 undefined", () => {
        const mock = makeMockPi();
        hplEcon(mock.pi);
        const hook = mock.hooks.get("tool_result");
        assert.equal(hook(bashEvent("small output")), undefined);
    });
    it("非 bash 工具不压缩", () => {
        const mock = makeMockPi();
        hplEcon(mock.pi);
        const hook = mock.hooks.get("tool_result");
        const big = "x".repeat(20000);
        const ev = { ...bashEvent(big), toolName: "read" };
        assert.equal(hook(ev), undefined);
    });
    it("settings enabled=false 时旁路", () => {
        writeEconSettings(join(agent, "agent"), { ...ECON_DEFAULTS, enabled: false });
        const mock = makeMockPi();
        hplEcon(mock.pi);
        const hook = mock.hooks.get("tool_result");
        assert.equal(hook(bashEvent("y".repeat(20000))), undefined, "关闭时原样放行");
        writeEconSettings(join(agent, "agent"), { ...ECON_DEFAULTS }); // 恢复
    });
    it("env HAPILON_ECON_OFF=1 旁路，settings 不受影响", () => {
        process.env.HAPILON_ECON_OFF = "1";
        const mock = makeMockPi();
        hplEcon(mock.pi);
        const hook = mock.hooks.get("tool_result");
        assert.equal(hook(bashEvent("z".repeat(20000))), undefined);
        delete process.env.HAPILON_ECON_OFF;
        assert.equal(envDisabled(), false);
    });
    it("setSessionDisabled(true)（--no-econ 映射）旁路；恢复后重新压缩", () => {
        const mock = makeMockPi();
        hplEcon(mock.pi);
        const hook = mock.hooks.get("tool_result");
        setSessionDisabled(true);
        assert.equal(hook(bashEvent("a".repeat(20000))), undefined);
        setSessionDisabled(false);
        const result = hook(bashEvent("b".repeat(20000)));
        assert.ok(result.content[0].text.includes("lines omitted"));
    });
    it("/econ 会话内切换 Disabled/Enabled 即时生效", async () => {
        // 先归零会话覆盖（前序测试可能留下 override），保证从 settings 默认 enabled=true 起步
        setSessionDisabled(false);
        const mock = makeMockPi();
        hplEcon(mock.pi);
        const hook = mock.hooks.get("tool_result");
        const cmd = mock.commands.get("econ");
        assert.ok(cmd, "/econ 已注册");
        // 清掉 setSessionDisabled 留下的显式覆盖（false = 「启用」覆盖，会挡住首次 toggle 语义）
        // 直接走两轮 toggle 验证：toggle1 → Disabled（旁路），toggle2 → Enabled（恢复）
        // mock ui.select：每次 handler 访问菜单时点一次 Compression 行、下一次调用 Close。
        // visitedPerHandler 每次进入 handler 前重置。
        let visited = false;
        const resetVisit = () => {
            visited = false;
        };
        const ui = {
            select: async (_t, options) => {
                const row = options.find((o) => o.includes("Compression"));
                if (!row)
                    return "Close";
                if (!visited) {
                    visited = true;
                    return row; // 本轮菜单第一次选择 → 点 Compression toggle
                }
                return "Close";
            },
            notify: () => { },
        };
        // 第一次进入：toggle → Disabled → Close
        resetVisit();
        await cmd.handler("", { ui, hasUI: true, mode: "tui" });
        assert.equal(hook(bashEvent("c".repeat(20000))), undefined, "切换后旁路");
        // 第二次进入：toggle → Enabled → Close
        resetVisit();
        await cmd.handler("", { ui, hasUI: true, mode: "tui" });
        const result = hook(bashEvent("d".repeat(20000)));
        assert.ok(result.content[0].text.includes("lines omitted"), "再切换后恢复压缩");
    });
    it("ctx_more 工具：按 ref 与行号取回省略片段", async () => {
        const mock = makeMockPi();
        hplEcon(mock.pi);
        const hook = mock.hooks.get("tool_result");
        const lines = Array.from({ length: 3000 }, (_, i) => `entry-${i}`);
        const compacted = hook(bashEvent(lines.join("\n")));
        const refMatch = compacted.content[0].text.match(/ref: (econ-\d+)/);
        const tool = mock.tools.get("ctx_more");
        const res = (await tool.execute("t1", { ref: refMatch[1], from: 100, to: 104 }));
        assert.match(res.content[0].text, /entry-99/);
        assert.match(res.content[0].text, /entry-103/);
    });
    it("ctx_more：未知 ref 返回 isError", async () => {
        const mock = makeMockPi();
        hplEcon(mock.pi);
        hook_noop: {
            mock.hooks.get("tool_result")(bashEvent("x".repeat(20000)));
        }
        const tool = mock.tools.get("ctx_more");
        const res = (await tool.execute("t1", { ref: "ghost", from: 1, to: 5 }));
        assert.equal(res.isError, true);
    });
    it("压缩全文落盘到 econ-store，内容 = 传给扩展的完整文本", () => {
        const mock = makeMockPi();
        hplEcon(mock.pi);
        const hook = mock.hooks.get("tool_result");
        const lines = Array.from({ length: 3000 }, (_, i) => `disk-${i}`).join("\n");
        hook(bashEvent(lines));
        const store = join(agent, "agent", "econ-store");
        assert.ok(existsSync(store));
        const files = readdirSync(store);
        const logs = files.filter((f) => f.endsWith(".log"));
        const newest = logs
            .map((f) => ({ f, m: statSync(join(store, f)).mtimeMs }))
            .sort((a, b) => b.m - a.m)[0].f;
        assert.equal(readFileSync(join(store, newest), "utf8"), lines);
    });
    it("statsLine 汇报压缩统计", () => {
        const line = statsLine();
        assert.match(line, /hpl-econ: \d+ compactions/);
    });
});
describe("hpl-econ settings 读取", () => {
    it("文件缺失回落组合甲默认", () => {
        const dir = mkdtempSync(join(tmpdir(), "hpl-econ-missing-"));
        const s = readEconSettings(dir);
        assert.deepEqual(s, { enabled: true, threshold: 8192, headLines: 40, tailLines: 20 });
        rmSync(dir, { recursive: true, force: true });
    });
    it("部分字段缺失逐字段回落", () => {
        const dir = mkdtempSync(join(tmpdir(), "hpl-econ-partial-"));
        writeFileSync(join(dir, "econ-config.json"), JSON.stringify({ threshold: 16384 }));
        const s = readEconSettings(dir);
        assert.equal(s.threshold, 16384);
        assert.equal(s.enabled, true);
        assert.equal(s.headLines, 40);
        rmSync(dir, { recursive: true, force: true });
    });
    it("损坏 JSON warn 并全回落（不抛错——配置层宽容，运行层 fail fast 由调用方保证）", () => {
        const dir = mkdtempSync(join(tmpdir(), "hpl-econ-broken-"));
        writeFileSync(join(dir, "econ-config.json"), "{ broken");
        const s = readEconSettings(dir);
        assert.deepEqual(s, ECON_DEFAULTS);
        rmSync(dir, { recursive: true, force: true });
    });
});
