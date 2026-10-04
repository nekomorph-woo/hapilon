/**
 * hpl-blocked-files 单元测试 — 禁文件匹配 + 输出行过滤 + exclude 注入
 *
 * 测试导出的纯函数与事件处理函数，不依赖 Pi ExtensionAPI mock。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchBlockedReadPath, matchBlockedCommand, matchBlockedPathLine, injectExclude, filterBlockedLines, handleToolCallEvent, handleToolResultEvent, } from "../../extensions/hpl-blocked-files/index.js";
describe("hpl-blocked-files", () => {
    describe("matchBlockedReadPath()", () => {
        it("CLAUDE.md → 命中", () => assert.strictEqual(matchBlockedReadPath("CLAUDE.md"), "CLAUDE.md"));
        it("AGENTS.md → 命中", () => assert.strictEqual(matchBlockedReadPath("AGENTS.md"), "AGENTS.md"));
        it("大小写不敏感（macOS/Windows 文件系统不区分）", () => assert.strictEqual(matchBlockedReadPath("claude.md"), "CLAUDE.md"));
        it("相对/绝对路径取 basename 判断", () => assert.strictEqual(matchBlockedReadPath("docs/nested/CLAUDE.md"), "CLAUDE.md"));
        it("CLAUDE.local.md → 不命中（不在默认名单）", () => assert.strictEqual(matchBlockedReadPath("CLAUDE.local.md"), null));
        it("README.md → 不命中", () => assert.strictEqual(matchBlockedReadPath("README.md"), null));
        it("空路径 → 不命中", () => assert.strictEqual(matchBlockedReadPath(""), null));
    });
    describe("matchBlockedCommand()", () => {
        it("cat CLAUDE.md → 命中", () => assert.strictEqual(matchBlockedCommand("cat CLAUDE.md"), "CLAUDE.md"));
        it("rg foo AGENTS.md → 命中", () => assert.strictEqual(matchBlockedCommand("rg foo AGENTS.md"), "AGENTS.md"));
        it("find . -name CLAUDE.md → 命中", () => assert.strictEqual(matchBlockedCommand("find . -name CLAUDE.md"), "CLAUDE.md"));
        it("./CLAUDE.md → 命中（/ 是非词字符，边界成立）", () => assert.strictEqual(matchBlockedCommand("cat ./CLAUDE.md"), "CLAUDE.md"));
        it("CLAUDEMD → 不命中（无词边界分割）", () => assert.strictEqual(matchBlockedCommand("cat CLAUDEMD"), null));
        it("cat README.md → 不命中", () => assert.strictEqual(matchBlockedCommand("cat README.md"), null));
        it("echo hello → 不命中", () => assert.strictEqual(matchBlockedCommand("echo hello"), null));
    });
    describe("matchBlockedPathLine()", () => {
        it("find 风格路径行 → 命中", () => assert.ok(matchBlockedPathLine("src/nested/CLAUDE.md")));
        it("相对路径行 → 命中", () => assert.ok(matchBlockedPathLine("./AGENTS.md")));
        it("纯文件名行（ls 输出）→ 命中", () => assert.ok(matchBlockedPathLine("CLAUDE.md")));
        it("ls -la 风格行尾 → 命中", () => assert.ok(matchBlockedPathLine("-rw-r--r-- 1 user staff 12 Jan 1 CLAUDE.md")));
        it("rg 命中行 :行号 → 命中", () => assert.ok(matchBlockedPathLine("./CLAUDE.md:12: secret instructions")));
        it("rg 上下文行 -行号 → 命中", () => assert.ok(matchBlockedPathLine("/abs/AGENTS.md-3- context line")));
        it("正文提及（行尾是别的词）→ 保留", () => assert.ok(!matchBlockedPathLine("see CLAUDE.md for details")));
        it("commit message 行 → 保留", () => assert.ok(!matchBlockedPathLine("Update CLAUDE.md in this commit")));
        it("CLAUDE.md: 指令正文行（非 rg 格式）→ 保留", () => assert.ok(!matchBlockedPathLine("CLAUDE.md contains project docs")));
        it("普通内容行 → 保留", () => assert.ok(!matchBlockedPathLine("export const foo = 1")));
    });
    describe("injectExclude()", () => {
        it("undefined → 数组名单", () => {
            const input = { pattern: "x" };
            injectExclude(input);
            assert.deepEqual(input.exclude, ["CLAUDE.md", "AGENTS.md"]);
        });
        it("string → 逗号追加", () => {
            const input = { exclude: "test/" };
            injectExclude(input);
            assert.strictEqual(input.exclude, "test/,CLAUDE.md,AGENTS.md");
        });
        it("array → concat", () => {
            const input = { exclude: ["*.min.js"] };
            injectExclude(input);
            assert.deepEqual(input.exclude, ["*.min.js", "CLAUDE.md", "AGENTS.md"]);
        });
        it("已注入过不重复追加", () => {
            const input = { exclude: ["CLAUDE.md", "AGENTS.md"] };
            injectExclude(input);
            assert.deepEqual(input.exclude, ["CLAUDE.md", "AGENTS.md", "CLAUDE.md", "AGENTS.md"]);
        });
    });
    describe("filterBlockedLines()", () => {
        it("删禁文件行，保留其余，返回删除计数", () => {
            const r = filterBlockedLines("README.md\nsrc/CLAUDE.md\nmain.ts");
            assert.strictEqual(r.removed, 1);
            assert.strictEqual(r.text, "README.md\nmain.ts");
        });
        it("rg 命中行删除", () => {
            const r = filterBlockedLines("./CLAUDE.md:1: do X\nok line");
            assert.strictEqual(r.removed, 1);
            assert.strictEqual(r.text, "ok line");
        });
        it("全部命中 → 空文本", () => {
            const r = filterBlockedLines("CLAUDE.md");
            assert.strictEqual(r.removed, 1);
            assert.strictEqual(r.text, "");
        });
        it("无命中 → 原样返回，removed 为 0", () => {
            const r = filterBlockedLines("a\nb");
            assert.strictEqual(r.removed, 0);
            assert.strictEqual(r.text, "a\nb");
        });
    });
    describe("handleToolCallEvent()", () => {
        it("read CLAUDE.md → block", async () => {
            const r = await handleToolCallEvent({
                type: "tool_call", toolCallId: "t1", toolName: "read",
                input: { path: "CLAUDE.md" },
            });
            assert.ok(r?.block);
            assert.match(r.reason, /CLAUDE\.md/);
        });
        it("read README.md → 放行", async () => {
            const r = await handleToolCallEvent({
                type: "tool_call", toolCallId: "t2", toolName: "read",
                input: { path: "README.md" },
            });
            assert.equal(r, undefined);
        });
        it("bash cat CLAUDE.md → block", async () => {
            const r = await handleToolCallEvent({
                type: "tool_call", toolCallId: "t3", toolName: "bash",
                input: { command: "cat CLAUDE.md" },
            });
            assert.ok(r?.block);
        });
        it("ffgrep → 原地注入 exclude，放行（exclude 字段未传时也注入）", async () => {
            const input = { pattern: "foo", path: "src/" };
            const r = await handleToolCallEvent({
                type: "tool_call", toolCallId: "t4", toolName: "ffgrep", input,
            });
            assert.equal(r, undefined);
            assert.deepEqual(input.exclude, ["CLAUDE.md", "AGENTS.md"]);
        });
        it("read 入参不含 exclude 的工具（ls）→ 不动入参", async () => {
            const input = { path: "." };
            await handleToolCallEvent({
                type: "tool_call", toolCallId: "t5", toolName: "ls", input,
            });
            assert.strictEqual(input.exclude, undefined);
        });
    });
    describe("handleToolResultEvent()", () => {
        it("文本含禁文件路径行 → 过滤后返回", async () => {
            const r = await handleToolResultEvent({
                type: "tool_result", toolCallId: "t6", toolName: "find",
                input: {}, isError: false,
                content: [{ type: "text", text: "src/CLAUDE.md\nsrc/main.ts" }],
            });
            assert.ok(r);
            assert.strictEqual(r.content[0].type, "text");
            assert.strictEqual(r.content[0].text, "src/main.ts");
        });
        it("无命中 → 返回 undefined（不改写）", async () => {
            const r = await handleToolResultEvent({
                type: "tool_result", toolCallId: "t7", toolName: "ls",
                input: {}, isError: false,
                content: [{ type: "text", text: "src\nREADME.md" }],
            });
            assert.equal(r, undefined);
        });
        it("image content 原样保留", async () => {
            const r = await handleToolResultEvent({
                type: "tool_result", toolCallId: "t8", toolName: "bash",
                input: {}, isError: false,
                content: [
                    { type: "text", text: "CLAUDE.md" },
                    { type: "image", data: "abc", mimeType: "image/png" },
                ],
            });
            assert.ok(r);
            assert.strictEqual(r.content.length, 2);
            assert.strictEqual(r.content[1].type, "image");
        });
    });
});
