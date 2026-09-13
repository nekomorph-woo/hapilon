import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TIMEOUT_SEC,
  WAIT_EXIT,
  runWaitPaneCommand,
  waitForPaneSettle,
  type WaitDeps,
} from "../../extensions/hpl-orchestra/wait-pane.js";
import type { AgentSnapshot } from "../../extensions/hpl-orchestra/herdr.js";

/**
 * 脚本化依赖：snapshot 按序吐状态（超出序列则停在最后一个），now 由 sleepMs 推进，
 * 于是超时判定不依赖真实时间、也不会真的挂住测试。
 */
function scriptedDeps(script: AgentSnapshot[]): WaitDeps & { calls: number } {
  let now = 0;
  const deps = {
    calls: 0,
    snapshot: () => {
      const idx = Math.min(deps.calls, script.length - 1);
      deps.calls++;
      return script[idx]!;
    },
    sleepMs: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
  return deps;
}

const idle = (seq: number | undefined): AgentSnapshot => ({ status: "idle", seq });
const working = (seq: number | undefined): AgentSnapshot => ({ status: "working", seq });

describe("waitForPaneSettle 收敛判据", () => {
  it("派发后真的跑了一轮（working 序号 → idle 序号）→ settled", () => {
    const deps = scriptedDeps([idle(10), working(11), working(11), idle(12)]);
    const result = waitForPaneSettle("w1:p9", {}, deps);
    assert.equal(result.outcome, "settled");
    assert.equal(result.baselineSeq, 10);
    assert.equal(result.seq, 12);
  });

  it("本来就是 idle 且序号不变 → timeout（回归：不能秒回成「干完了」）", () => {
    const deps = scriptedDeps([idle(10)]);
    const result = waitForPaneSettle("w1:p9", { timeoutMs: 5000 }, deps);
    assert.equal(result.outcome, "timeout");
    assert.equal(result.baselineSeq, 10);
    assert.ok(deps.calls > 3, `必须真的轮询等待，实际只查了 ${deps.calls} 次`);
  });

  it("序号变了但仍 working → 继续等，不误判收敛", () => {
    const deps = scriptedDeps([idle(10), working(11)]);
    const result = waitForPaneSettle("w1:p9", { timeoutMs: 5000 }, deps);
    assert.equal(result.outcome, "timeout");
    assert.equal(result.status, "working");
  });

  it("变到 blocked → blocked（等人回答，不当作收敛）", () => {
    const deps = scriptedDeps([idle(10), { status: "blocked", seq: 11 }]);
    const result = waitForPaneSettle("w1:p9", {}, deps);
    assert.equal(result.outcome, "blocked");
  });

  it("派发前就已 blocked（序号不变）→ 不算我们这次的结果，继续等", () => {
    const deps = scriptedDeps([{ status: "blocked", seq: 10 }]);
    const result = waitForPaneSettle("w1:p9", { timeoutMs: 5000 }, deps);
    assert.equal(result.outcome, "timeout");
  });

  it("序号缺失（herdr 未上报）→ 后来出现即视为变化", () => {
    const deps = scriptedDeps([{ status: "unknown", seq: undefined }, idle(5)]);
    const result = waitForPaneSettle("w1:p9", {}, deps);
    assert.equal(result.outcome, "settled");
    assert.equal(result.seq, 5);
  });

  it("done 也算收敛", () => {
    const deps = scriptedDeps([working(1), { status: "done", seq: 2 }]);
    const result = waitForPaneSettle("w1:p9", {}, deps);
    assert.equal(result.outcome, "settled");
  });
});

describe("runWaitPaneCommand 退出码", () => {
  const settleDeps = () => scriptedDeps([idle(1), idle(2)]);

  it("缺 pane id → 用法错误", () => {
    assert.equal(runWaitPaneCommand([], scriptedDeps([idle(1)])), WAIT_EXIT.usage);
  });

  it("收敛 → 0", () => {
    assert.equal(runWaitPaneCommand(["w1:p9"], settleDeps()), WAIT_EXIT.settled);
  });

  it("blocked → 2", () => {
    const deps = scriptedDeps([idle(1), { status: "blocked", seq: 2 }]);
    assert.equal(runWaitPaneCommand(["w1:p9"], deps), WAIT_EXIT.blocked);
  });

  it("超时 → 3", () => {
    const deps = scriptedDeps([idle(7)]);
    assert.equal(runWaitPaneCommand(["w1:p9", "--timeout", "3"], deps), WAIT_EXIT.timeout);
  });

  it("默认超时与 stale 阈值同量级（15 分钟）", () => {
    assert.equal(DEFAULT_TIMEOUT_SEC, 900);
  });
});
