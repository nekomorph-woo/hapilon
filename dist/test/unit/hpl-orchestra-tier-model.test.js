import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRoleModel } from "../../extensions/hpl-orchestra/herdr.js";
const model = (provider, id) => ({ provider, id });
const tiers = (overrides = {}) => ({
    opus: [model("zai", "glm-5.3-flash"), model("zai", "glm-5.3")],
    sonnet: [model("deepseek", "deepseek-flash"), model("zai", "glm-5-turbo")],
    haiku: [model("zai", "glm-4.7")],
    ...overrides,
});
function captureWarnings(run) {
    const original = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.map(String).join(" "));
    try {
        return { value: run(), warnings };
    }
    finally {
        console.warn = original;
    }
}
describe("resolveRoleModel", () => {
    it("resolves tier references against the current tier table", () => {
        assert.equal(resolveRoleModel("tier:sonnet[0]", tiers()), "deepseek/deepseek-flash");
        assert.equal(resolveRoleModel("tier:sonnet[1]", tiers()), "zai/glm-5-turbo");
        assert.equal(resolveRoleModel("tier:haiku", tiers()), "zai/glm-4.7");
    });
    it("passes through concrete model names that exist in some tier", () => {
        const { value, warnings } = captureWarnings(() => resolveRoleModel("zai/glm-5-turbo", tiers()));
        assert.equal(value, "zai/glm-5-turbo");
        assert.deepEqual(warnings, []);
    });
    it("falls back and warns when the tier reference is out of range", () => {
        const { value, warnings } = captureWarnings(() => resolveRoleModel("tier:opus[5]", tiers()));
        assert.equal(value, "zai/glm-5.3-flash");
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /tier:opus\[5\] 解析失败/);
        assert.match(warnings[0], /回落 zai\/glm-5\.3-flash/);
    });
    it("falls back and warns when the referenced tier is empty", () => {
        const { value, warnings } = captureWarnings(() => resolveRoleModel("tier:sonnet", tiers({ sonnet: [] })));
        assert.equal(value, "zai/glm-5.3-flash");
        assert.match(warnings[0], /解析失败/);
    });
    it("falls back and warns when a tier reference is malformed", () => {
        const { value, warnings } = captureWarnings(() => resolveRoleModel("tier:gpt[0]", tiers()));
        assert.equal(value, "zai/glm-5.3-flash");
        assert.match(warnings[0], /格式非法/);
    });
    it("falls back and warns when a concrete model is in no tier", () => {
        const { value, warnings } = captureWarnings(() => resolveRoleModel("deepseek/deepseek-v4-flash-vision-exp", tiers()));
        assert.equal(value, "zai/glm-5.3-flash");
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /deepseek\/deepseek-v4-flash-vision-exp 不在任何档位/);
        assert.match(warnings[0], /回落 zai\/glm-5\.3-flash/);
    });
    it("returns undefined without warnings for an absent model", () => {
        for (const spec of [undefined, null, "", "   "]) {
            const { value, warnings } = captureWarnings(() => resolveRoleModel(spec, tiers()));
            assert.equal(value, undefined);
            assert.deepEqual(warnings, []);
        }
    });
    it("returns undefined when every tier is empty", () => {
        const empty = { opus: [], sonnet: [], haiku: [] };
        const { value, warnings } = captureWarnings(() => resolveRoleModel("tier:opus[0]", empty));
        assert.equal(value, undefined);
        assert.match(warnings[0], /回落 pi 默认模型/);
        const concrete = captureWarnings(() => resolveRoleModel("deepseek/deepseek-v4-flash-vision-exp", empty));
        assert.equal(concrete.value, undefined);
        assert.match(concrete.warnings[0], /回落 pi 默认模型/);
    });
});
