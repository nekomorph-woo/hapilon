import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPolicySectionText } from "../../extensions/hpl-effect-policy/inject.js";
import { getPolicySection, resetPolicySection, setPolicySection } from "../../extensions/hpl-effect-policy/bridge.js";
import hplEffectPolicy from "../../extensions/hpl-effect-policy/index.js";
import { assembleSystemPrompt } from "../../extensions/hpl-system-prompt/assemble.js";
const signals = {
    language: "typescript",
    effectInstalled: false,
    effectImportsFound: false,
    packageManager: undefined,
    hasAgentsMd: false,
    isGreenfield: false,
    isScriptTask: false,
};
function assemble() {
    return assembleSystemPrompt({
        toolSnippets: {},
        cwd: "/tmp/project",
        hapilonMd: [],
        hapilonRules: [],
    });
}
afterEach(() => resetPolicySection());
describe("Effect policy R4 注入与桥接", () => {
    it("按四态生成分模式文本", () => {
        assert.equal(buildPolicySectionText("disabled", signals), undefined);
        const respect = buildPolicySectionText("respect-project", signals);
        assert.match(respect ?? "", /Follow this project's existing architecture/);
        assert.match(respect ?? "", /^<coding_policy>[\s\S]*<\/coding_policy>$/);
        const prefer = buildPolicySectionText("prefer", signals);
        assert.match(prefer ?? "", /prefer the Effect ecosystem/);
        assert.match(prefer ?? "", /one-shot scripts, plain TypeScript is acceptable/);
        const required = buildPolicySectionText("required", signals);
        assert.match(required ?? "", /This repository uses Effect/);
        assert.match(required ?? "", /no bare throw/);
        assert.match(required ?? "", /^<coding_policy>[\s\S]*<\/coding_policy>$/);
    });
    it("bridge 支持 set/get/reset 与 undefined 清除", () => {
        assert.equal(getPolicySection(), undefined);
        setPolicySection("<coding_policy>test</coding_policy>");
        assert.equal(getPolicySection(), "<coding_policy>test</coding_policy>");
        setPolicySection(undefined);
        assert.equal(getPolicySection(), undefined);
        setPolicySection("stale");
        resetPolicySection();
        assert.equal(getPolicySection(), undefined);
    });
    it("assemble 只在 bridge 有值时拼接 coding policy", () => {
        setPolicySection("<coding_policy>bridge policy</coding_policy>");
        const withPolicy = assemble();
        assert.match(withPolicy, /bridge policy/);
        assert.ok(withPolicy.indexOf("<custom_tools_note>") < withPolicy.indexOf("bridge policy"));
        assert.ok(withPolicy.indexOf("bridge policy") < withPolicy.indexOf("<guidelines>"));
        resetPolicySection();
        assert.doesNotMatch(assemble(), /coding_policy/);
    });
    it("effect-policy hook 计算后写入 bridge，customPrompt 让位并清除旧值", () => {
        const root = mkdtempSync(join(tmpdir(), "hapilon-policy-r4-"));
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "package.json"), JSON.stringify({ name: "plain-ts" }));
        writeFileSync(join(root, "tsconfig.json"), "{}");
        const handlers = [];
        hplEffectPolicy({ on: ((_name, handler) => handlers.push(handler)) });
        try {
            assert.equal(handlers.length, 1);
            handlers[0]({ systemPromptOptions: { cwd: root } });
            assert.match(getPolicySection() ?? "", /coding_policy/);
            assert.match(assemble(), /coding_policy/);
            handlers[0]({ systemPromptOptions: { cwd: root, customPrompt: "user prompt" } });
            assert.equal(getPolicySection(), undefined);
            assert.doesNotMatch(assemble(), /coding_policy/);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it("disabled 项目不残留旧 policy 状态", () => {
        setPolicySection("stale");
        const root = mkdtempSync(join(tmpdir(), "hapilon-policy-r4-js-"));
        writeFileSync(join(root, "package.json"), JSON.stringify({ name: "plain-js" }));
        const handlers = [];
        hplEffectPolicy({ on: ((_name, handler) => handlers.push(handler)) });
        try {
            handlers[0]({ systemPromptOptions: { cwd: root } });
            assert.equal(getPolicySection(), undefined);
            assert.doesNotMatch(assemble(), /coding_policy/);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it("hook 异常时清空 bridge 并降级为不注入", () => {
        setPolicySection("stale");
        const handlers = [];
        hplEffectPolicy({ on: ((_name, handler) => handlers.push(handler)) });
        assert.doesNotThrow(() => handlers[0]({ systemPromptOptions: undefined }));
        assert.equal(getPolicySection(), undefined);
    });
});
