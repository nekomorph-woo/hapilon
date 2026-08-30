import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldCompress, compressOutput, } from "../../extensions/hpl-econ/compress.js";
describe("hpl-econ/compress", () => {
    let store;
    before(() => {
        store = mkdtempSync(join(tmpdir(), "hpl-econ-compress-"));
    });
    after(() => {
        rmSync(store, { recursive: true, force: true });
    });
    const params = (over = {}) => ({
        threshold: 8192,
        headLines: 40,
        tailLines: 20,
        storeDir: store,
        ...over,
    });
    describe("shouldCompress()", () => {
        it("输出小于阈值时不压缩", () => {
            assert.equal(shouldCompress("x".repeat(8192), params()), false, "等于阈值不压");
        });
        it("输出超过阈值时压缩", () => {
            assert.equal(shouldCompress("x".repeat(8193), params()), true);
        });
    });
    describe("compressOutput()", () => {
        it("超阈值输出：头 N 行 + 省略提示 + 尾 M 行", () => {
            const lines = [];
            for (let i = 0; i < 3000; i++)
                lines.push(`line-${i}`);
            const full = lines.join("\n");
            const result = compressOutput(full, "bash-1", params());
            const out = result.text;
            assert.ok(out.startsWith("line-0\n"), "保留头 40 行的第一行");
            assert.ok(out.includes("line-39\n"), "头 40 行的最后一行");
            assert.ok(out.includes("line-2999"), "尾 20 行的最后一行");
            assert.ok(out.includes("line-2980"), "尾 20 行的第一行");
            assert.ok(!out.includes("line-1000\n"), "中段被省略");
            assert.ok(out.includes("[... 2940 lines omitted"), "省略提示含省略行数");
        });
        it("省略提示含全文落盘路径", () => {
            const full = "x".repeat(10000);
            const result = compressOutput(full, "bash-2", params());
            assert.ok(result.text.includes(store), "提示含 store 路径");
            assert.ok(existsSync(result.fullOutputPath), "全文已落盘");
            assert.equal(readFileSync(result.fullOutputPath, "utf8"), full, "落盘内容 = 原文");
        });
        it("省略提示含内核 fullOutputPath（双层截断处理，#52 警告段）", () => {
            const kernelPath = "/tmp/pi-bash-abc123.log";
            const full = "y".repeat(10000);
            const result = compressOutput(full, "bash-3", params(), kernelPath);
            assert.ok(result.text.includes(kernelPath), "提示含内核落盘路径——>50KB 输出首段靠它找回");
        });
        it(">50KB 场景：提示含「头部已被系统裁剪」如实告知", () => {
            // 内核 truncateTail 后传给扩展的文本不带原文头部——由调用方传 kernelTruncated 标志
            const full = "z".repeat(10000);
            const result = compressOutput(full, "bash-4", params(), undefined, true);
            assert.ok(result.text.includes("trimmed by the system"), "kernelTruncated 时提示说明头部可能不完整");
        });
        it("省略提示给出 ctx_more 取回指引", () => {
            const full = "w".repeat(10000);
            const result = compressOutput(full, "bash-5", params());
            assert.ok(result.text.includes("ctx_more"), "提示含 ctx_more 工具名");
            assert.ok(result.text.includes("bash-5"), "提示含本条 ref");
        });
        it("压缩后体积显著小于原文", () => {
            const lines = [];
            for (let i = 0; i < 20000; i++)
                lines.push(`log entry number ${i} with some padding text`);
            const full = lines.join("\n");
            const result = compressOutput(full, "bash-6", params());
            assert.ok(result.text.length < full.length / 10, "压缩后 < 原文 10%");
        });
        it("返回结构含统计字段（供 JSONL 记录）", () => {
            const lines = [];
            for (let i = 0; i < 3000; i++)
                lines.push(`entry-${i}`);
            const full = lines.join("\n");
            const result = compressOutput(full, "bash-7", params());
            assert.equal(result.originalChars, full.length);
            assert.equal(result.text.length, result.compactChars);
            assert.ok(result.omittedLines > 0, "多行输入省略行数 > 0");
        });
    });
});
