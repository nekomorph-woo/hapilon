import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HERDR_AGENT, HERDR_SOURCE, blockMessage, createHerdrReporter, releaseAgentArgs, reportAgentArgs, reporterEnabled, } from "../../extensions/hpl-herdr/report.js";
/** 记录 spawn 调用的假 SpawnFn */
function makeSpawn(result = {}) {
    const calls = [];
    return {
        calls,
        spawn: (file, args) => {
            calls.push({ file, args });
            const status = result.status ?? (result.error ? 1 : 0);
            return { status, error: result.error, stderr: result.stderr };
        },
    };
}
/** 可控时钟：显式推进毫秒，避免测试依赖真实时间 */
const CLOCK_START = 1_700_000_000_000;
function makeClock(start = CLOCK_START) {
    let current = start;
    return {
        now: () => current,
        advance: (ms) => {
            current += ms;
        },
    };
}
function seqs(calls) {
    return calls.map((c) => Number(c.args[c.args.indexOf("--seq") + 1]));
}
const ENV = { herdrEnv: "1", binPath: "/opt/herdr/bin/herdr", paneId: "w1:p7" };
describe("reporterEnabled()", () => {
    it("herdr pane 内且信息齐全才启用", () => {
        assert.equal(reporterEnabled(ENV), true);
    });
    it("缺任一条件即 no-op", () => {
        assert.equal(reporterEnabled({ ...ENV, herdrEnv: undefined }), false);
        assert.equal(reporterEnabled({ ...ENV, herdrEnv: "0" }), false);
        assert.equal(reporterEnabled({ ...ENV, binPath: undefined }), false);
        assert.equal(reporterEnabled({ ...ENV, paneId: undefined }), false);
    });
});
describe("reportAgentArgs()", () => {
    it("基本参数：source/agent/state/seq 齐全", () => {
        assert.deepEqual(reportAgentArgs("w1:p7", "working", 3), [
            "pane", "report-agent", "w1:p7",
            "--source", HERDR_SOURCE,
            "--agent", HERDR_AGENT,
            "--state", "working",
            "--seq", "3",
        ]);
    });
    it("message 与 session 路径附加", () => {
        assert.deepEqual(reportAgentArgs("w1:p7", "blocked", 4, { message: "select: 选哪个", sessionPath: "/x/s.jsonl" }), [
            "pane", "report-agent", "w1:p7",
            "--source", HERDR_SOURCE,
            "--agent", HERDR_AGENT,
            "--state", "blocked",
            "--seq", "4",
            "--message", "select: 选哪个",
            "--agent-session-path", "/x/s.jsonl",
        ]);
    });
    it("release 不带 seq（官方协议无该参数）", () => {
        assert.deepEqual(releaseAgentArgs("w1:p7"), [
            "pane", "release-agent", "w1:p7", "--source", HERDR_SOURCE, "--agent", HERDR_AGENT,
        ]);
    });
});
describe("blockMessage()", () => {
    it("标题优先，否则用 prompt 类型", () => {
        assert.equal(blockMessage({ kind: "confirm", title: "允许写入?" }), "confirm: 允许写入?");
        assert.equal(blockMessage({ kind: "select" }), "select");
        assert.equal(blockMessage({}), "prompt");
    });
});
describe("createHerdrReporter()", () => {
    it("非 herdr 环境严格 no-op（不 spawn）", () => {
        const { spawn, calls } = makeSpawn();
        const reporter = createHerdrReporter({ spawn, env: { ...ENV, herdrEnv: undefined } });
        assert.equal(reporter.enabled, false);
        reporter.report("working");
        reporter.release();
        assert.equal(calls.length, 0);
    });
    it("报告走 HERDR_BIN_PATH，seq 严格递增，release 收尾", () => {
        const { spawn, calls } = makeSpawn();
        const clock = makeClock();
        const reporter = createHerdrReporter({ spawn, env: ENV, now: clock.now });
        reporter.report("idle", { sessionPath: "/s.jsonl" });
        reporter.report("working");
        reporter.report("blocked", { message: "confirm" });
        reporter.report("idle");
        reporter.release();
        assert.equal(calls.length, 5);
        assert.ok(calls.every((c) => c.file === ENV.binPath));
        const reported = seqs(calls.slice(0, 4));
        assert.deepEqual(reported, [CLOCK_START, CLOCK_START + 1, CLOCK_START + 2, CLOCK_START + 3], "同毫秒内仍须严格递增");
        assert.equal(calls[0].args[calls[0].args.indexOf("--state") + 1], "idle");
        assert.equal(calls[3].args[calls[3].args.indexOf("--state") + 1], "idle");
        assert.ok(calls[0].args.includes("--agent-session-path"));
        assert.equal(calls[4].args[1], "release-agent");
    });
    // 回归：herdr 按 (pane, source) 记住已接受的最大 seq，旧实例哑掉后新实例必须立刻大于它，
    // 否则 /new、收编、进程重启后的上报会被静默丢弃（wait-pane 假超时的根因）。
    it("跨实例追加重建后 seq 仍大于上一实例（/new、收编后不断链）", () => {
        const clock = makeClock();
        const first = makeSpawn();
        const firstReporter = createHerdrReporter({ spawn: first.spawn, env: ENV, now: clock.now });
        firstReporter.report("working");
        clock.advance(50);
        firstReporter.report("idle");
        const beforeRestart = seqs(first.calls).at(-1);
        clock.advance(1_000);
        const second = makeSpawn();
        const secondReporter = createHerdrReporter({ spawn: second.spawn, env: ENV, now: clock.now });
        secondReporter.report("idle", { sessionPath: "/new-session.jsonl" });
        assert.ok(seqs(second.calls)[0] > beforeRestart, "新实例首个 seq 必须大于旧实例最后一个");
    });
    it("上报失败告警一次而非静默吞掉", () => {
        const { spawn } = makeSpawn({ error: new Error("herdr 不在 PATH") });
        const errors = [];
        const reporter = createHerdrReporter({ spawn, env: ENV, onError: (m) => errors.push(m) });
        reporter.report("working");
        assert.equal(errors.length, 1);
        assert.ok(errors[0].includes("herdr 不在 PATH"));
    });
    it("herdr 以非 0 退出拒绝上报时要告警（含 stderr 摘要）", () => {
        const { spawn } = makeSpawn({ status: 1, stderr: '{"error":{"code":"pane_not_found"}}\n' });
        const errors = [];
        const reporter = createHerdrReporter({ spawn, env: ENV, onError: (m) => errors.push(m) });
        reporter.report("working");
        assert.equal(errors.length, 1);
        assert.ok(errors[0].includes("pane_not_found"));
    });
});
