import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { DEFAULT_STALE_THRESHOLD_MS, DIALOG_MARKERS, resolveAgentState, sampleAgentStateEffect, } from "../../extensions/hpl-orchestra/agent-state.js";
import { handleTeamCommand, resetProbeCache } from "../../extensions/hpl-orchestra/menu.js";
import { resolveSessionStatePath, writeTeamStateEffect, } from "../../extensions/hpl-orchestra/state.js";
/** fixture：ask_user 表单（question-view.ts 底部提示行） */
const ASK_USER_SAMPLE = [
    " Let me pick an option.",
    "",
    "┌──────────────────────────────────────────────────┐",
    "│ Which harness should the retry live in?          │",
    "│                                                  │",
    "│ › Retry inside the Effect layer                  │",
    "│   Retry in the CLI wrapper                       │",
    "│                                                  │",
    "│ ↑↓ navigate · Enter select · Esc back            │",
    "└──────────────────────────────────────────────────┘",
].join("\n");
/** fixture：权限确认弹窗（hpl-protected-paths/confirm.ts 四选项） */
const PERMISSION_SAMPLE = [
    "┌──────────────────────────────────────────────────┐",
    "│ Allow this command to read .env?                 │",
    "│                                                  │",
    "│ › Allow Once                                     │",
    "│   Allow this Session                             │",
    "│   Allow this Project                             │",
    "│   Deny                                           │",
    "└──────────────────────────────────────────────────┘",
].join("\n");
/** fixture：普通输出，无任何弹窗标记 */
const ORDINARY_SAMPLE = [
    "▸ $ npm run test:unit",
    "",
    " ℹ tests 925",
    " ℹ pass 925",
].join("\n");
/** fixture：半帧——只有提示行渲染出来，对话内容还在画；单看会误判等待输入 */
const HALF_FRAME_SAMPLE = " ↑↓ navigate · Enter select · Esc back";
const baseSignals = (overrides = {}) => ({
    paneAlive: true,
    herdrStatus: "working",
    paneSamples: [ORDINARY_SAMPLE, ORDINARY_SAMPLE],
    reportExists: false,
    ...overrides,
});
function makeSpawn(options = {}) {
    const calls = [];
    const statuses = [...(options.statuses ?? [])];
    const reads = [...(options.reads ?? [])];
    const spawn = (bin, args) => {
        calls.push({ bin, args });
        if (args[0] === "pane" && args[1] === "get") {
            if (options.alive === false)
                return { status: 1, stderr: "pane not found" };
            // shell: pane 还在但 pi 已崩（只剩 shell）——herdr 不上报 agent
            return {
                status: 0,
                stdout: JSON.stringify({ result: { pane: options.shell
                            ? { pane_id: args[2] }
                            : { pane_id: args[2], agent: "pi" } } }),
            };
        }
        if (args[0] === "pane" && args[1] === "process-info") {
            return {
                status: 0,
                stdout: JSON.stringify({ result: { process_info: { shell_pid: 100, foreground_processes: [{ argv0: "zsh", pid: 100 }] } } }),
            };
        }
        if (args[0] === "agent" && args[1] === "get") {
            return {
                status: 0,
                stdout: JSON.stringify({ result: { agent: { agent_status: statuses.shift() ?? "idle", pane_id: args[2] } } }),
            };
        }
        if (args[0] === "pane" && args[1] === "read") {
            const next = reads.shift();
            return next === undefined ? { status: 1, stderr: "read failed" } : { status: 0, stdout: next };
        }
        return { status: 0, stdout: "{}" };
    };
    return { spawn, calls };
}
const stateFor = (roles) => ({
    enabled: true,
    since: "2026-09-13T10:00:00.000Z",
    owner: { paneId: "w1:p7" },
    roles,
});
function makeContext(selections = []) {
    const notices = [];
    const ctx = {
        cwd: "/project",
        ui: {
            select: async () => selections.shift(),
            notify: (message, type) => notices.push({ message, type }),
            setStatus: () => { },
        },
    };
    return { ctx: ctx, notices };
}
const originalEnv = {
    home: process.env.HAPILON_HOME,
    herdr: process.env.HERDR_ENV,
    pane: process.env.HERDR_PANE_ID,
    role: process.env.HAPI_ORCH_ROLE,
};
let home;
before(() => {
    home = mkdtempSync(join(tmpdir(), "hapilon-agent-state-test-"));
    process.env.HAPILON_HOME = home;
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p7";
    delete process.env.HAPI_ORCH_ROLE;
});
beforeEach(() => {
    rmSync(resolveSessionStatePath(), { force: true });
    resetProbeCache();
    process.env.HERDR_PANE_ID = "w1:p7";
    delete process.env.HAPI_ORCH_ROLE;
});
after(() => {
    if (originalEnv.home === undefined)
        delete process.env.HAPILON_HOME;
    else
        process.env.HAPILON_HOME = originalEnv.home;
    if (originalEnv.herdr === undefined)
        delete process.env.HERDR_ENV;
    else
        process.env.HERDR_ENV = originalEnv.herdr;
    if (originalEnv.pane === undefined)
        delete process.env.HERDR_PANE_ID;
    else
        process.env.HERDR_PANE_ID = originalEnv.pane;
    if (originalEnv.role === undefined)
        delete process.env.HAPI_ORCH_ROLE;
    else
        process.env.HAPI_ORCH_ROLE = originalEnv.role;
    rmSync(home, { recursive: true, force: true });
});
describe("hpl-orchestra agent state resolution", { concurrency: false }, () => {
    it("pane 不存在即 dead——即使 herdr 报 idle 且回执在", () => {
        assert.equal(resolveAgentState(baseSignals({
            paneAlive: false,
            herdrStatus: "idle",
            reportExists: true,
            expectedReportAgeMs: 0,
        })), "dead");
    });
    it("两次连续采样都命中 ask_user 标记才是 waiting-input", () => {
        assert.equal(resolveAgentState(baseSignals({
            herdrStatus: "working",
            paneSamples: [ASK_USER_SAMPLE, ASK_USER_SAMPLE],
        })), "waiting-input");
    });
    it("权限弹窗标记同样判 waiting-input；herdr blocked 未确认时落 unknown", () => {
        assert.equal(resolveAgentState(baseSignals({
            herdrStatus: "blocked",
            paneSamples: [PERMISSION_SAMPLE, PERMISSION_SAMPLE],
        })), "waiting-input");
        assert.equal(resolveAgentState(baseSignals({
            herdrStatus: "blocked",
            paneSamples: [ORDINARY_SAMPLE, ORDINARY_SAMPLE],
        })), "unknown");
    });
    it("半帧截断不确认 waiting-input（单次采样、两次不一致都守得住）", () => {
        assert.equal(resolveAgentState(baseSignals({
            paneSamples: [HALF_FRAME_SAMPLE, ORDINARY_SAMPLE],
        })), "working");
        assert.equal(resolveAgentState(baseSignals({
            paneSamples: [ORDINARY_SAMPLE, HALF_FRAME_SAMPLE],
        })), "working");
        // 采样失败只剩一次样本
        assert.equal(resolveAgentState(baseSignals({ paneSamples: [HALF_FRAME_SAMPLE] })), "working");
        assert.equal(resolveAgentState(baseSignals({ paneSamples: undefined })), "working");
    });
    it("普通输出不误判弹窗标记（标记表逐条命中检查）", () => {
        for (const marker of DIALOG_MARKERS) {
            assert.equal(ORDINARY_SAMPLE.includes(marker), false, `fixture 必须不含 ${marker}`);
        }
        assert.equal(resolveAgentState(baseSignals()), "working");
    });
    it("done 的唯一凭证是回执文件：herdr idle/done 且回执在", () => {
        assert.equal(resolveAgentState(baseSignals({ herdrStatus: "idle", reportExists: true })), "done");
        assert.equal(resolveAgentState(baseSignals({ herdrStatus: "done", reportExists: true })), "done");
    });
    it("herdr idle/done 且回执缺席 → idle，不再折叠成 working", () => {
        assert.equal(resolveAgentState(baseSignals({ herdrStatus: "idle", reportExists: false })), "idle");
        assert.equal(resolveAgentState(baseSignals({ herdrStatus: "done", reportExists: false })), "idle");
    });
    it("回执在但 pane 仍在 working：working 优先，不误报 done", () => {
        assert.equal(resolveAgentState(baseSignals({ herdrStatus: "working", reportExists: true })), "working");
    });
    it("stale 必须有「在办任务」这个输入：超阈且有在办任务、回执缺席才成立", () => {
        const over = { herdrStatus: "idle", expectedReportAgeMs: DEFAULT_STALE_THRESHOLD_MS };
        assert.equal(resolveAgentState(baseSignals(over)), "stale");
        assert.equal(resolveAgentState(baseSignals({ ...over, expectedReportAgeMs: DEFAULT_STALE_THRESHOLD_MS - 1 })), "idle");
        assert.equal(resolveAgentState(baseSignals({ ...over, staleThresholdMs: 60_000 })), "stale");
        assert.equal(resolveAgentState(baseSignals({ ...over, staleThresholdMs: DEFAULT_STALE_THRESHOLD_MS + 1 })), "idle");
        // 回执在 → done；没有在办任务（无时钟）→ 永不 stale；herdr 不可得时不猜
        assert.equal(resolveAgentState(baseSignals({ ...over, reportExists: true })), "done");
        assert.equal(resolveAgentState(baseSignals({ ...over, expectedReportAgeMs: undefined })), "idle");
        assert.equal(resolveAgentState(baseSignals({ ...over, herdrStatus: undefined })), "unknown");
        assert.equal(resolveAgentState(baseSignals({ ...over, herdrStatus: "blocked" })), "unknown");
    });
    it("working 不被任务记录年龄覆盖：长任务不因记账陈旧变 stale", () => {
        // 任务记录年龄只反映记账新鲜度，不是 pane 活动心跳；herdr 说 working 就是活着
        assert.equal(resolveAgentState(baseSignals({
            herdrStatus: "working",
            expectedReportAgeMs: DEFAULT_STALE_THRESHOLD_MS,
        })), "working");
        assert.equal(resolveAgentState(baseSignals({
            herdrStatus: "working",
            expectedReportAgeMs: DEFAULT_STALE_THRESHOLD_MS * 100,
            staleThresholdMs: 1,
        })), "working");
        // 同条件换成已停的 pane 才是 stale
        assert.equal(resolveAgentState(baseSignals({
            herdrStatus: "idle",
            expectedReportAgeMs: DEFAULT_STALE_THRESHOLD_MS,
        })), "stale");
        // idle 但没有在办任务 → idle，不是 stale
        assert.equal(resolveAgentState(baseSignals({ herdrStatus: "idle", reportExists: false })), "idle");
    });
    it("信号全缺（herdr 不可得 / unknown）保守落 unknown", () => {
        assert.equal(resolveAgentState(baseSignals({ herdrStatus: undefined })), "unknown");
        assert.equal(resolveAgentState(baseSignals({ herdrStatus: "unknown" })), "unknown");
    });
    it("弹窗优先级高于 done/working：对话在时状态是 waiting-input", () => {
        assert.equal(resolveAgentState(baseSignals({
            herdrStatus: "idle",
            reportExists: true,
            paneSamples: [ASK_USER_SAMPLE, ASK_USER_SAMPLE],
        })), "waiting-input");
    });
});
describe("hpl-orchestra agent state sampling", { concurrency: false }, () => {
    it("pane get 失败即 dead，不再读状态与屏文本", () => {
        const { spawn, calls } = makeSpawn({ alive: false });
        assert.equal(Effect.runSync(sampleAgentStateEffect("w1:p8", { spawn })), "dead");
        assert.equal(calls.length, 1);
    });
    it("pane 还在但 pi 崩了（只剩 shell）也判 dead，且不读状态与屏文本", () => {
        const { spawn, calls } = makeSpawn({ shell: true });
        assert.equal(Effect.runSync(sampleAgentStateEffect("w1:p8", { spawn })), "dead");
        assert.equal(calls.some((call) => call.args[1] === "read"), false);
    });
    it("两次屏文本都命中弹窗才 waiting-input，半帧不误判", () => {
        const both = makeSpawn({ reads: [ASK_USER_SAMPLE, ASK_USER_SAMPLE] });
        assert.equal(Effect.runSync(sampleAgentStateEffect("w1:p8", { spawn: both.spawn })), "waiting-input");
        const halfFrame = makeSpawn({ reads: [HALF_FRAME_SAMPLE, ORDINARY_SAMPLE] });
        assert.equal(Effect.runSync(sampleAgentStateEffect("w1:p8", { spawn: halfFrame.spawn })), "idle");
    });
    it("屏文本读失败（采样不全）不判 waiting-input", () => {
        const { spawn } = makeSpawn({ reads: [ASK_USER_SAMPLE] });
        assert.equal(Effect.runSync(sampleAgentStateEffect("w1:p8", { spawn })), "idle");
    });
    it("回执文件存在 + herdr idle → done；文件随后消失回到 idle", () => {
        const report = join(home, "worker-report.md");
        const { spawn } = makeSpawn({ statuses: ["idle", "idle"], reads: [ORDINARY_SAMPLE, ORDINARY_SAMPLE, ORDINARY_SAMPLE, ORDINARY_SAMPLE] });
        writeFileSync(report, "report", "utf8");
        assert.equal(Effect.runSync(sampleAgentStateEffect("w1:p8", { spawn, reportPath: report })), "done");
        rmSync(report, { force: true });
        assert.equal(Effect.runSync(sampleAgentStateEffect("w1:p8", { spawn, reportPath: report })), "idle");
    });
    it("stale 时钟取自持久化的在办任务时间戳，不靠就地累积的内存活动", () => {
        const t0 = 1_000_000;
        const idle = makeSpawn({ statuses: ["idle"], reads: [ORDINARY_SAMPLE, ORDINARY_SAMPLE] });
        // 超阈的在办任务：首次采样即 stale（新进程没有历史观察也能判）
        assert.equal(Effect.runSync(sampleAgentStateEffect("w1:p8", {
            spawn: idle.spawn,
            now: () => t0,
            expectedReportSince: t0 - DEFAULT_STALE_THRESHOLD_MS,
        })), "stale");
        // 刚更新过的在办任务：idle，不是 stale
        const recent = makeSpawn({ statuses: ["idle"], reads: [ORDINARY_SAMPLE, ORDINARY_SAMPLE] });
        assert.equal(Effect.runSync(sampleAgentStateEffect("w1:p8", {
            spawn: recent.spawn,
            now: () => t0,
            expectedReportSince: t0 - 1_000,
        })), "idle");
        // 她的 herdr 报 working：再长的在办任务也不 stale
        const working = makeSpawn({ statuses: ["working"], reads: [ORDINARY_SAMPLE, ORDINARY_SAMPLE] });
        assert.equal(Effect.runSync(sampleAgentStateEffect("w1:p8", {
            spawn: working.spawn,
            now: () => t0,
            expectedReportSince: t0 - DEFAULT_STALE_THRESHOLD_MS * 100,
        })), "working");
    });
});
describe("hpl-orchestra /team 面板状态展示", { concurrency: false }, () => {
    it("查看面板分工按 pane 展示状态", async () => {
        Effect.runSync(writeTeamStateEffect(stateFor([
            { key: "worker", instances: [{ paneId: "w1:p8", model: "anthropic/sonnet" }] },
        ]), resolveSessionStatePath()));
        const { spawn } = makeSpawn({ statuses: ["working"], reads: [ASK_USER_SAMPLE, ASK_USER_SAMPLE] });
        const { ctx, notices } = makeContext();
        await handleTeamCommand({}, "查看面板分工", ctx, spawn);
        assert.match(notices.at(-1)?.message ?? "", /Worker：w1:p8: waiting-input/);
        assert.match(notices.at(-1)?.message ?? "", /主面板：w1:p7（只调度）/);
    });
    it("pane 已死仍列出该实例并标记 dead", async () => {
        Effect.runSync(writeTeamStateEffect(stateFor([
            { key: "worker", instances: [{ paneId: "w1:p8", model: "anthropic/sonnet" }] },
        ]), resolveSessionStatePath()));
        const { spawn } = makeSpawn({ alive: false });
        const { ctx, notices } = makeContext();
        await handleTeamCommand({}, "查看面板分工", ctx, spawn);
        assert.match(notices.at(-1)?.message ?? "", /Worker：w1:p8: dead/);
    });
});
