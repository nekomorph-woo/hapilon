import assert from "node:assert/strict";
import { test } from "node:test";
import { formatToolElapsed, ToolTimeLine } from "../../extensions/hpl-message-time/tool-time.js";
const style = (text) => `<dim>${text}</dim>`;
const text = (line) => line.render(40).map((l) => l.trim()).filter((l) => l !== "");
/** 可变的工具组件替身：按 pi 的状态机推进（流式参数 → 执行中 → 完成） */
function makeComp(init = {}) {
    return { executionStarted: false, isPartial: true, outputPad: 1, ...init };
}
test("formatToolElapsed：10 秒内一位小数，之后整秒与分秒", () => {
    assert.equal(formatToolElapsed(230), "0.2s");
    assert.equal(formatToolElapsed(9_400), "9.4s");
    assert.equal(formatToolElapsed(45_300), "45s");
    assert.equal(formatToolElapsed(125_000), "2m05s");
});
test("执行前保持空行；开跑后显示开始时刻，耗时随时间走", async () => {
    const t0 = new Date(2026, 9, 24, 12, 0, 0).getTime();
    const origNow = Date.now;
    let now = t0;
    Date.now = () => now;
    try {
        const comp = makeComp();
        const line = new ToolTimeLine(comp, style);
        assert.deepEqual(text(line), []);
        comp.executionStarted = true;
        assert.deepEqual(text(line), ["<dim>12:00:00 · 0.0s</dim>"]);
        now += 2_100;
        assert.deepEqual(text(line), ["<dim>12:00:00 · 2.1s</dim>"]);
        Object.assign(comp, { isPartial: false, result: { durationMs: 2_300, timestamp: now } });
        assert.deepEqual(text(line), ["<dim>12:00:00 · 2.3s</dim>"]);
        now += 60_000;
        assert.deepEqual(text(line), ["<dim>12:00:00 · 2.3s</dim>"], "完成后耗时冻结");
    }
    finally {
        Date.now = origNow;
    }
});
test("回放历史工具：开始时刻 = 结束时刻 - 耗时", async () => {
    const end = new Date(2026, 9, 24, 23, 59, 58).getTime();
    const comp = makeComp({ isPartial: false, result: { durationMs: 3_000, timestamp: end } });
    assert.deepEqual(text(new ToolTimeLine(comp, style)), ["<dim>23:59:55 · 3.0s</dim>"]);
});
test("被中止的工具没有耗时就只显示开始时刻；历史里连时刻都没有就保持空行", () => {
    const origNow = Date.now;
    Date.now = () => new Date(2026, 9, 24, 12, 0, 0).getTime();
    try {
        const aborted = makeComp({ executionStarted: true, isPartial: false, result: {} });
        assert.deepEqual(text(new ToolTimeLine(aborted, style)), ["<dim>12:00:00</dim>"]);
    }
    finally {
        Date.now = origNow;
    }
    const stale = makeComp({ isPartial: false, result: {} });
    assert.deepEqual(text(new ToolTimeLine(stale, style)), []);
});
