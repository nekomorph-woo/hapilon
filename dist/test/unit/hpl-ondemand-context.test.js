/**
 * hpl-ondemand-context 单元测试 — 子目录 HAPILON.md 按需注入
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildLoadedFromBranch, collectPending, readPending, renderContextBlock, handleToolResult, ENTRY_TYPE, } from "../../extensions/hpl-ondemand-context/index.js";
const makeEvent = (overrides) => ({
    type: "tool_result",
    toolCallId: "t1",
    toolName: "read",
    input: { path: "sub/deep/h.ts" },
    content: [{ type: "text", text: "file body" }],
    isError: false,
    ...overrides,
});
describe("rebuildLoadedFromBranch", () => {
    it("正常路径: 从 custom 条目恢复已注入集合", () => {
        const loaded = rebuildLoadedFromBranch([
            { type: "custom", customType: ENTRY_TYPE, data: { paths: ["/a/x.md", "/b/y.md"] } },
            { type: "custom", customType: "other", data: { paths: ["/c/z.md"] } },
            { type: "custom", customType: ENTRY_TYPE, data: { paths: ["/b/y.md"] } },
            { type: "user" },
        ]);
        assert.deepEqual([...loaded].sort(), ["/a/x.md", "/b/y.md"]);
    });
    it("边界条件: data 缺失或 paths 非数组时跳过", () => {
        const loaded = rebuildLoadedFromBranch([
            { type: "custom", customType: ENTRY_TYPE },
            { type: "custom", customType: ENTRY_TYPE, data: { paths: "nope" } },
        ]);
        assert.equal(loaded.size, 0);
    });
});
describe("hpl-ondemand-context — tool_result 核心", () => {
    let root;
    before(() => {
        root = mkdtempSync(join(tmpdir(), "hapilon-ondemand-"));
        for (const layer of ["sub", "sub/deep"]) {
            mkdirSync(join(root, layer, ".hapilon"), { recursive: true });
            writeFileSync(join(root, layer, ".hapilon", "HAPILON.md"), `rule for ${layer}`);
        }
        writeFileSync(join(root, "sub", "deep", "h.ts"), "export {};");
    });
    after(() => { try {
        rmSync(root, { recursive: true, force: true });
    }
    catch { } });
    it("正常路径: 首次 read 注入沿途层并返回新路径", () => {
        const result = handleToolResult(makeEvent({}), root, new Set());
        assert.ok(result);
        assert.equal(result.paths.length, 2);
        const last = result.content[result.content.length - 1];
        assert.equal(last.type, "text");
        assert.match(last.text, /<hapilon-context source="sub\/\.hapilon\/HAPILON\.md">/);
        assert.match(last.text, /rule for sub\/deep/);
    });
    it("去重: 已注入过的文件不再出现在结果里", () => {
        const first = handleToolResult(makeEvent({}), root, new Set());
        assert.ok(first);
        const loaded = new Set(first.paths);
        assert.equal(handleToolResult(makeEvent({}), root, loaded), undefined);
    });
    it("边界条件: 失败的工具调用、非 read/edit/write 工具、无路径都不注入", () => {
        assert.equal(handleToolResult(makeEvent({ isError: true }), root, new Set()), undefined);
        assert.equal(handleToolResult(makeEvent({ toolName: "grep", input: { pattern: "x" } }), root, new Set()), undefined);
        assert.equal(handleToolResult(makeEvent({ input: {} }), root, new Set()), undefined);
    });
    it("边界条件: 文件在 cwd 根层时无可注入层级", () => {
        writeFileSync(join(root, "top.ts"), "export {};");
        assert.equal(handleToolResult(makeEvent({ input: { path: "top.ts" } }), root, new Set()), undefined);
    });
    it("readPending: 读失败的文件跳过，不阻断其余", () => {
        const entries = readPending([
            join(root, "sub", ".hapilon", "HAPILON.md"),
            join(root, "no", "such", "file.md"),
        ]);
        assert.equal(entries.length, 1);
    });
    it("renderContextBlock: 多文件浅→深拼接，源路径相对 cwd", () => {
        const entries = readPending(collectPending("sub/deep/h.ts", root, new Set()));
        const text = renderContextBlock(entries, root);
        const sub = text.indexOf("sub/.hapilon/HAPILON.md");
        const deep = text.indexOf("sub/deep/.hapilon/HAPILON.md");
        assert.ok(sub >= 0 && deep > sub, "浅层在前、深层在后");
    });
});
