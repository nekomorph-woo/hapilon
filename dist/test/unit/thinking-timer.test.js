/**
 * hpl-thinking-timer timer.ts 单元测试 — 折叠思考标签的耗时：走表、冻结、历史不计时
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { attachThinkingHooks, formatElapsed, } from "../../extensions/hpl-thinking-timer/timer.js";
const style = { fg: (_slot, text) => text, italic: (text) => text };
function makeComp(isStreaming) {
    return { isStreaming, hiddenThinkingLabel: "Thinking...", outputPad: 1 };
}
/** 标签当前文本走 run.lastText（与 tick 的缓存比对同源），不碰 Text 的 private 字段 */
function labelText(comp, runIndex = 0) {
    return comp.__hapiThinkingRuns?.get(runIndex)?.lastText;
}
describe("formatElapsed — 秒与分秒", () => {
    it("正常路径: 不足一分钟显示秒，超过折分钟并补零", () => {
        assert.equal(formatElapsed(0), "0s");
        assert.equal(formatElapsed(59_400), "59s");
        assert.equal(formatElapsed(60_000), "1m00s");
        assert.equal(formatElapsed(125_300), "2m05s");
    });
    it("异常路径: 负值钳到 0", () => {
        assert.equal(formatElapsed(-3), "0s");
    });
});
describe("attachThinkingHooks — 折叠标签计时", () => {
    it("正常路径: 流式期间标签带实时耗时，秒数走表", () => {
        let now = 1_000_000;
        const restore = mock.method(Date, "now", () => now);
        try {
            const { node, tick } = attachThinkingHooks(style);
            const comp = makeComp(true);
            node(comp, 0);
            assert.equal(labelText(comp), "Thinking... 0s");
            now = 1_000_000 + 12_300;
            tick(comp);
            assert.equal(labelText(comp), "Thinking... 12s");
            // 秒数没变不动缓存
            now = 1_000_000 + 12_700;
            tick(comp);
            assert.equal(labelText(comp), "Thinking... 12s");
        }
        finally {
            restore.mock.restore();
        }
    });
    it("正常路径: 消息结束那一刻冻结耗时", () => {
        let now = 2_000_000;
        const restore = mock.method(Date, "now", () => now);
        try {
            const { node, tick } = attachThinkingHooks(style);
            const comp = makeComp(true);
            node(comp, 0);
            now = 2_000_000 + 7_000;
            comp.isStreaming = false;
            node(comp, 0);
            assert.equal(labelText(comp), "Thinking... 7s");
            // 冻结后再 tick 不变
            now = 2_000_000 + 60_000;
            tick(comp);
            assert.equal(labelText(comp), "Thinking... 7s");
            // 重建内容（invalidate / 点击展开再折叠）仍显示冻结值
            node(comp, 0);
            assert.equal(labelText(comp), "Thinking... 7s");
        }
        finally {
            restore.mock.restore();
        }
    });
    it("正常路径: 历史消息（从未流式）只显示原标签不计时", () => {
        const { node, tick } = attachThinkingHooks(style);
        const comp = makeComp(false);
        node(comp, 0);
        assert.equal(labelText(comp), "Thinking...");
        tick(comp);
        assert.equal(labelText(comp), "Thinking...");
    });
    it("正常路径: 多条思考 run 各自计时", () => {
        let now = 3_000_000;
        const restore = mock.method(Date, "now", () => now);
        try {
            const { node, tick } = attachThinkingHooks(style);
            const comp = makeComp(true);
            node(comp, 0);
            now = 3_000_000 + 5_000;
            node(comp, 1);
            // run0 的标签只在重建或 tick 时更新，与真实链路一致
            tick(comp);
            assert.equal(labelText(comp, 0), "Thinking... 5s");
            assert.equal(labelText(comp, 1), "Thinking... 0s");
        }
        finally {
            restore.mock.restore();
        }
    });
});
