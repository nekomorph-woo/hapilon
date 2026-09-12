/**
 * hpl-add-dir 集成——注入经 bridge 进入全量组装后的 prompt
 *
 * 历史缺陷：hpl-add-dir 的 before_agent_start 直接返回
 * event.systemPrompt + 注入，但字母序在后的 hpl-system-prompt 是全量替换，
 * 注入被抹掉——widget/命令显示已添加目录，模型上下文里却没有（静默失效）。
 *
 * 修复：hpl-add-dir 写 bridge，hpl-system-prompt 组装时读取（模式同
 * hpl-effect-policy）。本测试按生产字母序（hpl-add-dir → hpl-system-prompt）
 * 加载两个真实扩展，经 session_start 的 add-dir:state entry 重建目录状态
 * （/resume 同款路径），断言最终 prompt 含 <external_directories>。
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionRuntime, discoverAndLoadExtensions, ExtensionRunner, } from "@earendil-works/pi-coding-agent";
const CWD = process.cwd();
const stub = (() => ({}));
/** hpl handler 消费的 systemPromptOptions（cwd 为必填字段） */
const promptOpts = {
    cwd: CWD,
    toolSnippets: { read: "Read files", bash: "Run commands", edit: "Edit files", write: "Write files" },
};
const tmpDirs = [];
function makeTmpDirWithHapilonMd() {
    const dir = mkdtempSync(join(tmpdir(), "hpl-add-dir-e2e-"));
    writeFileSync(join(dir, "HAPILON.md"), "外部目录端到端约定");
    tmpDirs.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});
describe("hpl-add-dir 注入经 bridge 进入最终 prompt（生产字母序链路）", () => {
    it("hpl-add-dir 先于 hpl-system-prompt 执行时注入不被全量替换抹掉", async () => {
        const dir = makeTmpDirWithHapilonMd();
        const runtime = createExtensionRuntime();
        // 与生产 discoverExtensions() 字母序一致：hpl-add-dir 在前
        const { extensions } = await discoverAndLoadExtensions(["./dist/extensions/hpl-add-dir/index.js", "./dist/extensions/hpl-system-prompt/index.js"], CWD, "./nonexistent-agent-dir");
        assert.equal(extensions.length, 2, "两个扩展加载成功");
        // session_start 重建状态：sessionManager stub 返回 add-dir:state entry
        const sessionManager = {
            getBranch: () => [
                {
                    type: "custom",
                    customType: "add-dir:state",
                    data: { dirs: [{ absolutePath: dir, label: "ext-proj", addedAt: 0 }] },
                },
            ],
        };
        const runner = new ExtensionRunner(extensions, runtime, CWD, sessionManager, stub);
        await runner.emit({ type: "session_start" });
        const result = await runner.emitBeforeAgentStart("hello", undefined, "PI-BASE-PROMPT", promptOpts);
        assert.ok(result?.systemPrompt, "返回了修改后的 prompt");
        const prompt = result.systemPrompt;
        assert.ok(prompt.startsWith("<system_prompt>"), "是 hpl 全量组装的 XML prompt");
        assert.ok(prompt.includes("<external_directories>"), "含外部目录 section");
        assert.ok(prompt.includes("ext-proj"), "含目录标签");
        assert.ok(prompt.includes("外部目录端到端约定"), "含 HAPILON.md 内容");
    });
    it("无目录时不产生 external_directories section", async () => {
        const runtime = createExtensionRuntime();
        const { extensions } = await discoverAndLoadExtensions(["./dist/extensions/hpl-add-dir/index.js", "./dist/extensions/hpl-system-prompt/index.js"], CWD, "./nonexistent-agent-dir");
        const sessionManager = { getBranch: () => [] };
        const runner = new ExtensionRunner(extensions, runtime, CWD, sessionManager, stub);
        await runner.emit({ type: "session_start" });
        const result = await runner.emitBeforeAgentStart("hello", undefined, "PI-BASE-PROMPT", promptOpts);
        assert.ok(result?.systemPrompt);
        assert.ok(!result.systemPrompt.includes("<external_directories>"));
    });
});
