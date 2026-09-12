import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEffectPolicyMode, resetPolicySection, setPolicySection } from "../../extensions/hpl-effect-policy/bridge.js";
import hplContext, { discoverBuiltInSkillsEffect, resolveHapilonSkillsDirEffect, } from "../../extensions/hpl-context/index.js";
import { Effect } from "effect";
const ORIGINAL_HOME = process.env.HOME;
afterEach(() => {
    resetPolicySection();
    if (ORIGINAL_HOME === undefined)
        delete process.env.HOME;
    else
        process.env.HOME = ORIGINAL_HOME;
});
function resourceHandler() {
    const handlers = [];
    hplContext({
        on: ((_name, handler) => handlers.push(handler)),
    });
    assert.equal(handlers.length, 1);
    return handlers[0];
}
describe("Policy R6 effect-typescript skill", () => {
    it("bridge 暴露四态 mode，未计算时为 undefined", () => {
        assert.equal(getEffectPolicyMode(), undefined);
        for (const mode of ["disabled", "respect-project", "prefer", "required"]) {
            setPolicySection(undefined, mode);
            assert.equal(getEffectPolicyMode(), mode);
        }
    });
    it("仅 prefer/required 收集内置 skill", () => {
        const home = mkdtempSync(join(tmpdir(), "hapilon-r6-home-"));
        const cwd = mkdtempSync(join(tmpdir(), "hapilon-r6-cwd-"));
        process.env.HOME = home;
        try {
            const handler = resourceHandler();
            for (const mode of ["prefer", "required"]) {
                setPolicySection("policy", mode);
                const paths = handler({ cwd }).skillPaths;
                assert.ok(paths.some((path) => path.endsWith("resources/skills/effect-typescript/SKILL.md")));
            }
            for (const mode of ["disabled", "respect-project"]) {
                setPolicySection(undefined, mode);
                assert.ok(!handler({ cwd }).skillPaths.some((path) => path.includes("effect-typescript/SKILL.md")));
            }
            resetPolicySection();
            assert.ok(!handler({ cwd }).skillPaths.some((path) => path.includes("effect-typescript/SKILL.md")));
        }
        finally {
            rmSync(home, { recursive: true, force: true });
            rmSync(cwd, { recursive: true, force: true });
        }
    });
    it("按 skill 粒度应用门槛：通用 skill 无条件收集，Effect skill 仍受 policy 约束", () => {
        const root = mkdtempSync(join(tmpdir(), "hapilon-r6-mixed-skills-"));
        const skillsDir = join(root, "skills");
        mkdirSync(join(skillsDir, "generic-skill"), { recursive: true });
        mkdirSync(join(skillsDir, "effect-typescript"), { recursive: true });
        writeFileSync(join(skillsDir, "generic-skill", "SKILL.md"), "---\nname: generic-skill\ndescription: generic\n---\n");
        writeFileSync(join(skillsDir, "effect-typescript", "SKILL.md"), "---\nname: effect-typescript\ndescription: effect\n---\n");
        try {
            for (const mode of ["disabled", "respect-project"]) {
                setPolicySection(undefined, mode);
                const paths = Effect.runSync(discoverBuiltInSkillsEffect(skillsDir));
                assert.ok(paths.some((path) => path.endsWith("generic-skill/SKILL.md")));
                assert.ok(!paths.some((path) => path.endsWith("effect-typescript/SKILL.md")));
            }
            for (const mode of ["prefer", "required"]) {
                setPolicySection("policy", mode);
                const paths = Effect.runSync(discoverBuiltInSkillsEffect(skillsDir));
                assert.ok(paths.some((path) => path.endsWith("generic-skill/SKILL.md")));
                assert.ok(paths.some((path) => path.endsWith("effect-typescript/SKILL.md")));
            }
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it("从 dist 模块位置向上解析包根，资源缺失时静默跳过", () => {
        const root = mkdtempSync(join(tmpdir(), "hapilon-r6-pkg-"));
        const distModule = join(root, "dist", "extensions", "hpl-context");
        mkdirSync(distModule, { recursive: true });
        writeFileSync(join(root, "package.json"), "{}");
        const resources = join(root, "resources", "skills");
        mkdirSync(resources, { recursive: true });
        try {
            assert.equal(Effect.runSync(resolveHapilonSkillsDirEffect(distModule)), resources);
            rmSync(resources, { recursive: true, force: true });
            assert.equal(Effect.runSync(resolveHapilonSkillsDirEffect(distModule)), null);
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it("SKILL frontmatter、六种模式标题与引用路径均有效", () => {
        const skillPath = join(process.cwd(), "resources", "skills", "effect-typescript", "SKILL.md");
        const content = readFileSync(skillPath, "utf8");
        assert.ok(existsSync(skillPath));
        assert.match(content, /^name: effect-typescript/m);
        assert.match(content, /^description: .+/m);
        for (const title of ["Typed errors", "Never-failing degradation", "Thin synchronous wrappers", "Composition", "Bounded asynchronous work", "Keep pure logic pure"]) {
            assert.match(content, new RegExp(`## \\d+\\. ${title}`));
        }
        const paths = [...content.matchAll(/`(src\/[^`]+\.ts)`/g)].map((match) => match[1]);
        assert.equal(paths.length, 8);
        for (const path of paths)
            assert.ok(existsSync(join(process.cwd(), path)), path);
    });
    it("内置 eli5 skill 自动发现，参数按 Pi 的 User 行语义传入", () => {
        const skillPath = join(process.cwd(), "resources", "skills", "eli5", "SKILL.md");
        const content = readFileSync(skillPath, "utf8");
        const paths = Effect.runSync(discoverBuiltInSkillsEffect());
        assert.ok(paths.includes(skillPath));
        assert.match(content, /^name: eli5/m);
        assert.ok(!content.includes("$ARGUMENTS"), "Pi 不做 $ARGUMENTS 替换，应使用追加的 User 行");
        assert.match(content, /Topic: Use the topic supplied by the user/);
    });
});
