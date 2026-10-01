import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { NEW_SESSION_MARKER, newSessionMarkerSeen, screenAwaitingInput } from "../../extensions/hpl-orchestra/agent-state.js";
import { promptOutcomeFromErrorCode } from "../../extensions/hpl-orchestra/herdr.js";
import { paneHeaderLine } from "../../extensions/hpl-orchestra/team-cli.js";
import { confirmCleared, submitClear } from "../../extensions/hpl-orchestra/menu.js";
import { readTeamState, resolveSessionStatePath, setPaneClearPendingEffect, teamsDir, writeTeamStateEffect, } from "../../extensions/hpl-orchestra/state.js";
const ownerPane = "w9:p7";
const workerPane = "w9:p8";
let home;
const originalEnv = { home: process.env.HAPILON_HOME, pane: process.env.HERDR_PANE_ID };
before(() => {
    home = mkdtempSync(join(tmpdir(), "hapilon-team-clear-test-"));
    process.env.HAPILON_HOME = home;
    process.env.HERDR_PANE_ID = ownerPane;
});
after(() => {
    if (originalEnv.home === undefined)
        delete process.env.HAPILON_HOME;
    else
        process.env.HAPILON_HOME = originalEnv.home;
    if (originalEnv.pane === undefined)
        delete process.env.HERDR_PANE_ID;
    else
        process.env.HERDR_PANE_ID = originalEnv.pane;
    rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
    rmSync(teamsDir(), { recursive: true, force: true });
});
/**
 * 记录调用的假 herdr。agent get 的 status / seq **恒定**——这是真机实测行为：
 * `/new` 对 herdr 只是 release + 同值重报，state_change_seq 不动、状态停在 done。
 * 替身若比真机更配合（每次调用都推进 seq），就会把依赖 seq 的错误判据盖过去。
 */
function makeSpawn(options = {}) {
    const calls = [];
    const screens = [...(options.screens ?? [])];
    let lastScreen = screens.at(0) ?? "idle prompt, no dialogs";
    const spawn = (_bin, args) => {
        calls.push(args);
        if (args[0] === "agent" && args[1] === "get") {
            return {
                status: 0,
                stdout: JSON.stringify({ result: { agent: {
                            agent_status: options.agentStatus ?? "done",
                            pane_id: args[2],
                            state_change_seq: options.seq ?? 2162,
                        } } }),
            };
        }
        if (args[0] === "agent" && args[1] === "prompt") {
            if (options.promptErrorCode) {
                return { status: 1, stderr: JSON.stringify({ error: { code: options.promptErrorCode } }) };
            }
            return { status: 0, stdout: JSON.stringify({ result: {} }) };
        }
        if (args[0] === "pane" && args[1] === "read") {
            if (screens.length > 0)
                lastScreen = screens.shift();
            return { status: 0, stdout: lastScreen };
        }
        if (args[0] === "pane" && args[1] === "run") {
            return { status: 0, stdout: JSON.stringify({ result: {} }) };
        }
        return { status: 0, stdout: "{}" };
    };
    return { spawn, calls };
}
describe("newSessionMarkerSeen", () => {
    it("视口里没有新会话标记就不算清空证据", () => {
        assert.equal(newSessionMarkerSeen("old screen", "still the old screen"), false);
        assert.equal(newSessionMarkerSeen(undefined, undefined), false);
        assert.equal(newSessionMarkerSeen(`${NEW_SESSION_MARKER}`, "no marker at all"), false);
    });
    it("标记数 0 → 1：新横幅出现，判确认", () => {
        assert.equal(newSessionMarkerSeen("idle prompt", `${NEW_SESSION_MARKER}\nctx 0.0%`), true);
        assert.equal(newSessionMarkerSeen(undefined, `${NEW_SESSION_MARKER}`), true);
    });
    it("标记数不变就不认：屏幕变了不等于新横幅出来了", () => {
        const withMarker = `${NEW_SESSION_MARKER}\nctx 40%`;
        assert.equal(newSessionMarkerSeen(withMarker, withMarker), false);
        // 回归：/new 被当正文提交时这一屏确实变了，但横幅还是旧的那一条
        assert.equal(newSessionMarkerSeen(withMarker, `${NEW_SESSION_MARKER}\nctx 0.0%\n新消息`), false);
        // 「本来就在干净会话起点」的重复清空：1 → 1 退化成提醒（旧上下文本来就是空的）
        assert.equal(newSessionMarkerSeen(`${NEW_SESSION_MARKER}\nctx 0.0%`, `${NEW_SESSION_MARKER}\nctx 0.0%`), false);
    });
    it("标记数增加才算新横幅", () => {
        const two = `${NEW_SESSION_MARKER}\n旧\n${NEW_SESSION_MARKER}\nctx 0.0%`;
        assert.equal(newSessionMarkerSeen(`${NEW_SESSION_MARKER}\nctx 40%`, two), true);
    });
});
describe("screenAwaitingInput", () => {
    it("连续两帧都命中弹窗标记才算等待输入", () => {
        assert.equal(screenAwaitingInput(["Enter select", "Enter select"]), true);
        assert.equal(screenAwaitingInput(["Enter select", "idle prompt"]), false);
        assert.equal(screenAwaitingInput(["Enter select"]), false);
        assert.equal(screenAwaitingInput(undefined), false);
    });
});
describe("promptOutcomeFromErrorCode", () => {
    it("映射 herdr 拒绝码到提交结果", () => {
        assert.equal(promptOutcomeFromErrorCode("agent_blocked"), "blocked");
        assert.equal(promptOutcomeFromErrorCode("agent_not_ready"), "not-ready");
        assert.equal(promptOutcomeFromErrorCode("agent_not_found"), "not-ready");
        assert.equal(promptOutcomeFromErrorCode("agent_prompt_stalled"), "stalled");
        assert.equal(promptOutcomeFromErrorCode("unexpected"), "failed");
        assert.equal(promptOutcomeFromErrorCode(undefined), "failed");
    });
});
describe("submitClear", () => {
    it("agent 级接受时提交成功，不走 pane 级", async () => {
        const { spawn, calls } = makeSpawn();
        assert.equal(await submitClear(workerPane, spawn), "submitted");
        assert.deepEqual(calls[0], ["agent", "prompt", workerPane, "/new"]);
        assert.equal(calls.some((call) => call[0] === "pane" && call[1] === "run"), false);
    });
    it("agent 级 not-ready（hapi 常态）时才走 pane 级主路径", async () => {
        const { spawn, calls } = makeSpawn({ promptErrorCode: "agent_not_ready" });
        assert.equal(await submitClear(workerPane, spawn), "submitted");
        assert.ok(calls.some((call) => call[0] === "pane" && call[1] === "run" && call[3] === "/new"));
    });
    it("pane 级写入前发现交互 UI → 不盲投，报 blocked", async () => {
        const { spawn, calls } = makeSpawn({
            promptErrorCode: "agent_not_ready",
            screens: ["Enter select", "Enter select"],
        });
        assert.equal(await submitClear(workerPane, spawn), "blocked");
        assert.equal(calls.some((call) => call[0] === "pane" && call[1] === "run"), false);
    });
    it("blocked 与 stalled 不回退，如实返回", async () => {
        const blocked = makeSpawn({ promptErrorCode: "agent_blocked" });
        assert.equal(await submitClear(workerPane, blocked.spawn), "blocked");
        assert.equal(blocked.calls.some((call) => call[0] === "pane" && call[1] === "run"), false);
        const stalled = makeSpawn({ promptErrorCode: "agent_prompt_stalled" });
        assert.equal(await submitClear(workerPane, stalled.spawn), "stalled");
    });
});
describe("confirmCleared", () => {
    it("真机语义：status 恒 done、seq 同值重报不前进，靠屏幕标记仍判确认", async () => {
        // 复现评审的现场：清空落地了，但 herdr 那边 agent_status=done、seq 2162 全程不动
        const { spawn } = makeSpawn({ agentStatus: "done", seq: 2162, screens: [`${NEW_SESSION_MARKER}\nctx 0.0%/1m`] });
        assert.deepEqual(await confirmCleared(workerPane, "idle prompt, no dialogs", spawn, { timeoutMs: 1_000, intervalMs: 0 }), {
            confirmed: true,
        });
    });
    it("窗口内没等到标记 → 判未确认", async () => {
        const { spawn } = makeSpawn({ screens: ["idle prompt, no dialogs"] });
        assert.deepEqual(await confirmCleared(workerPane, "idle prompt, no dialogs", spawn, { timeoutMs: 0, intervalMs: 0 }), {
            confirmed: false,
        });
    });
});
describe("paneHeaderLine", () => {
    it("clear? 标记只出现在未确认的 pane 上", () => {
        assert.equal(paneHeaderLine("worker w1:p8", "idle", false, "n/a"), "- worker w1:p8 · idle · report n/a");
        assert.equal(paneHeaderLine("worker w1:p8", "idle", true, "n/a"), "- worker w1:p8 · idle · clear? · report n/a");
    });
});
describe("clearPending 持久状态", () => {
    const stateFor = () => ({
        enabled: true,
        since: "2026-09-19T10:00:00.000Z",
        owner: { paneId: ownerPane },
        roles: [{ key: "worker", instances: [{ paneId: workerPane, model: null }] }],
    });
    it("旧存档无 clearPending 仍可用，标记与解除往返", () => {
        Effect.runSync(writeTeamStateEffect(stateFor(), resolveSessionStatePath()));
        const initial = readTeamState(resolveSessionStatePath());
        assert.equal(initial.roles[0].instances[0].clearPending, undefined);
        assert.equal(Effect.runSync(setPaneClearPendingEffect(workerPane, true)), true);
        const marked = readTeamState(resolveSessionStatePath());
        assert.equal(marked.roles[0].instances[0].clearPending, true);
        assert.equal(Effect.runSync(setPaneClearPendingEffect(workerPane, true)), false, "重复标记不重复写盘");
        assert.equal(Effect.runSync(setPaneClearPendingEffect(workerPane, false)), true);
        const cleared = readTeamState(resolveSessionStatePath());
        assert.equal(cleared.roles[0].instances[0].clearPending, undefined);
        assert.equal(readFileSync(resolveSessionStatePath(), "utf8").includes("clearPending"), false, "解除时删键");
    });
    it("pane 不属于任何团队时标记不落盘，返回 false", () => {
        Effect.runSync(writeTeamStateEffect(stateFor(), resolveSessionStatePath()));
        assert.equal(Effect.runSync(setPaneClearPendingEffect("w9:pZZ", true)), false);
    });
});
