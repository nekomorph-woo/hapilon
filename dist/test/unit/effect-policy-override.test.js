import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { resolveEffectMode, resolveEffectModeEffect, } from "../../extensions/hpl-effect-policy/override.js";
let globalHome;
const originalHome = process.env.HAPILON_HOME;
before(() => {
    globalHome = mkdtempSync(join(tmpdir(), "hpl-effect-policy-global-"));
    process.env.HAPILON_HOME = globalHome;
});
after(() => {
    if (originalHome === undefined)
        delete process.env.HAPILON_HOME;
    else
        process.env.HAPILON_HOME = originalHome;
    rmSync(globalHome, { recursive: true, force: true });
});
function project() {
    return mkdtempSync(join(tmpdir(), "hpl-effect-policy-project-"));
}
function writeProject(dir, value) {
    mkdirSync(join(dir, ".hapilon"), { recursive: true });
    writeFileSync(join(dir, ".hapilon", "effect-policy.json"), value);
}
function writeGlobal(value) {
    writeFileSync(join(globalHome, "effect-policy.json"), value);
}
function clean(dir) {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(globalHome, "effect-policy.json"), { force: true });
}
describe("Effect policy override 裁决链", () => {
    it("两级都无覆盖时走自动判定", () => {
        const dir = project();
        mkdirSync(join(dir, "src"));
        writeFileSync(join(dir, "tsconfig.json"), "{}");
        writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { effect: "^3.22.1" } }));
        writeFileSync(join(dir, "src", "main.ts"), 'import { Effect } from "effect";');
        assert.equal(resolveEffectMode(dir), "required");
        clean(dir);
    });
    it("项目级 disabled 是最高优先级一票否决", () => {
        const dir = project();
        writeProject(dir, JSON.stringify({ mode: "disabled" }));
        assert.equal(resolveEffectMode(dir), "disabled");
        clean(dir);
    });
    it("仅全局级 prefer 生效", () => {
        const dir = project();
        writeGlobal(JSON.stringify({ mode: "prefer" }));
        assert.equal(resolveEffectMode(dir), "prefer");
        clean(dir);
    });
    it("项目级覆盖胜过全局级", () => {
        const dir = project();
        writeProject(dir, JSON.stringify({ mode: "required" }));
        writeGlobal(JSON.stringify({ mode: "prefer" }));
        assert.equal(resolveEffectMode(dir), "required");
        clean(dir);
    });
    it("项目级非法值 warning 后继续使用全局级", () => {
        const dir = project();
        writeProject(dir, JSON.stringify({ mode: "always-effect" }));
        writeGlobal(JSON.stringify({ mode: "prefer" }));
        assert.equal(resolveEffectMode(dir), "prefer");
        clean(dir);
    });
    it("项目级非法且全局无覆盖时回到自动判定", () => {
        const dir = project();
        writeFileSync(join(dir, "package.json"), "{}");
        writeFileSync(join(dir, "tsconfig.json"), "{}");
        writeFileSync(join(dir, "package-lock.json"), "{}");
        writeProject(dir, JSON.stringify({ mode: "bad" }));
        assert.equal(resolveEffectMode(dir), "respect-project");
        clean(dir);
    });
    it("项目级坏 JSON warning 后继续裁决", () => {
        const dir = project();
        writeProject(dir, "{broken");
        writeGlobal(JSON.stringify({ mode: "required" }));
        assert.equal(resolveEffectMode(dir), "required");
        clean(dir);
    });
    it("mode 缺失 warning 后跳过该级", () => {
        const dir = project();
        writeProject(dir, JSON.stringify({ foo: 1 }));
        writeGlobal(JSON.stringify({ mode: "prefer" }));
        assert.equal(resolveEffectMode(dir), "prefer");
        clean(dir);
    });
    it("合法 JSON 数组按非法覆盖处理并继续", () => {
        const dir = project();
        writeProject(dir, JSON.stringify(["disabled"]));
        writeGlobal(JSON.stringify({ mode: "prefer" }));
        assert.equal(resolveEffectMode(dir), "prefer");
        clean(dir);
    });
    it("disabled 覆盖在 Effect 已安装时仍一票否决", () => {
        const dir = project();
        mkdirSync(join(dir, "src"));
        writeFileSync(join(dir, "tsconfig.json"), "{}");
        writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { effect: "^3.22.1" } }));
        writeProject(dir, JSON.stringify({ mode: "disabled" }));
        assert.equal(resolveEffectMode(dir), "disabled");
        clean(dir);
    });
    it("warning 文案包含覆盖文件路径", () => {
        const dir = project();
        writeFileSync(join(dir, "package.json"), "{}");
        writeFileSync(join(dir, "tsconfig.json"), "{}");
        writeFileSync(join(dir, "package-lock.json"), "{}");
        const policyPath = join(dir, ".hapilon", "effect-policy.json");
        writeProject(dir, JSON.stringify({ mode: "invalid" }));
        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (...args) => warnings.push(args.map(String).join(" "));
        try {
            assert.equal(Effect.runSync(resolveEffectModeEffect(dir)), "respect-project");
        }
        finally {
            console.warn = originalWarn;
            clean(dir);
        }
        assert.ok(warnings.some((warning) => warning.includes(policyPath)));
    });
});
