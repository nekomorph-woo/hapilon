/**
 * renderer.ts 单元测试 — Unicode bar chart + 文本渲染
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderBar, formatTokens, renderContextLines, renderContextText, } from "../../extensions/hpl-context-viewer/renderer.js";
describe("renderBar", () => {
    it("正常路径: 50% 含 used + free", () => {
        const bar = renderBar(50);
        assert.ok(bar.includes("█"), "含 used block");
        assert.ok(bar.includes("░"), "含 free block");
        assert.equal(bar.length, 30);
    });
    it("边界条件: 0% → 全 free", () => {
        assert.equal(renderBar(0), "░".repeat(30));
    });
    it("边界条件: null → 全 free", () => {
        assert.equal(renderBar(null), "░".repeat(30));
    });
    it("边界条件: 100% → 全 used", () => {
        assert.equal(renderBar(100), "█".repeat(30));
    });
});
describe("formatTokens", () => {
    it("正常路径: 小数字", () => {
        assert.equal(formatTokens(500), "500");
    });
    it("正常路径: 1k+", () => {
        assert.equal(formatTokens(1700), "1.7k");
    });
    it("边界条件: null → ?", () => {
        assert.equal(formatTokens(null), "?");
    });
    it("边界条件: 0", () => {
        assert.equal(formatTokens(0), "0");
    });
});
describe("renderContextLines", () => {
    const sample = {
        model: { id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 128000 },
        usage: { tokens: 20000, contextWindow: 128000, percent: 15.6 },
        categories: [
            { label: "System prompt", tokens: 1700, percent: 1.3 },
            { label: "System tools", tokens: 4200, percent: 3.3, items: [{ name: "_read", tokens: 200 }, { name: "_bash", tokens: 300 }] },
            { label: "Skills", tokens: 1500, percent: 1.2, items: [{ name: "my-skill", tokens: 100 }] },
            { label: "Messages", tokens: 3300, percent: 2.6 },
            { label: "Free space", tokens: 117300, percent: 91.6 },
        ],
        estimatedTotal: 10700,
    };
    it("正常路径: 渲染进度条 + 表格", () => {
        const lines = renderContextLines(sample);
        assert.ok(lines.length > 5, "至少 6 行");
        assert.ok(lines.some((l) => l.includes("Estimated usage")), "含 Estimated usage");
        assert.ok(lines.some((l) => l.includes("20.0k / 128.0k")), "含总量统计");
    });
    it("正常路径: 表格包含所有 category", () => {
        const lines = renderContextLines(sample);
        assert.ok(lines.some((l) => l.includes("System prompt")), "System prompt");
        assert.ok(lines.some((l) => l.includes("System tools")), "System tools");
        assert.ok(lines.some((l) => l.includes("Free space")), "Free space");
    });
    it("正常路径: tool 名去除 _ 前缀", () => {
        const lines = renderContextLines(sample);
        assert.ok(lines.some((l) => l.includes("read") && !l.includes("_read")), "read 无 _ 前缀");
        assert.ok(lines.some((l) => l.includes("bash") && !l.includes("_bash")), "bash 无 _ 前缀");
    });
    it("正常路径: 包含 skill details", () => {
        const lines = renderContextLines(sample);
        assert.ok(lines.some((l) => l.includes("my-skill")), "skill name");
    });
});
describe("renderContextText", () => {
    it("正常路径: 返回字符串含换行", () => {
        const s = {
            model: { id: "t", name: "t", contextWindow: 1000 },
            usage: { tokens: 100, contextWindow: 1000, percent: 10 },
            categories: [],
            estimatedTotal: 0,
        };
        const text = renderContextText(s);
        assert.ok(text.includes("\n"));
    });
});
