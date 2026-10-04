import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { modelSpec, pickTierModel, rewriteTierModelArg } from "../../cli/tier-model-arg.js";
const TIERS = {
    opus: [{ provider: "zai", id: "glm-5.3", group: 0 }],
    sonnet: [
        { provider: "deepseek", id: "deepseek-flash", group: 0 },
        { provider: "zai", id: "glm-5-turbo", thinking: "high", group: 1 },
    ],
    haiku: [],
};
describe("tier-model-arg", () => {
    it("modelSpec 带 thinking 后缀", () => {
        assert.equal(modelSpec(TIERS.sonnet[0]), "deepseek/deepseek-flash");
        assert.equal(modelSpec(TIERS.sonnet[1]), "zai/glm-5-turbo:high");
    });
    it("pickTierModel 越界索引绕回，空档 undefined", () => {
        assert.deepEqual(pickTierModel(TIERS, "sonnet", 0), TIERS.sonnet[0]);
        assert.deepEqual(pickTierModel(TIERS, "sonnet", 1), TIERS.sonnet[1]);
        assert.deepEqual(pickTierModel(TIERS, "sonnet", 2), TIERS.sonnet[0]);
        assert.deepEqual(pickTierModel(TIERS, "sonnet", 99), TIERS.sonnet[1]);
        assert.equal(pickTierModel(TIERS, "haiku", 0), undefined);
    });
    it("tier: 指代原位替换为具体模型串", () => {
        const result = rewriteTierModelArg(["-p", "任务", "--model", "tier:sonnet[1]"], (tier, index) => pickTierModel(TIERS, tier, index));
        assert.equal(result.error, undefined);
        assert.deepEqual(result.args, ["-p", "任务", "--model", "zai/glm-5-turbo:high"]);
        assert.deepEqual(result.resolved, { original: "tier:sonnet[1]", spec: "zai/glm-5-turbo:high" });
    });
    it("整档为空返回 error 而非透传", () => {
        const result = rewriteTierModelArg(["--model", "tier:haiku"], (tier, index) => pickTierModel(TIERS, tier, index));
        assert.match(result.error, /tier:haiku 无法解析/);
    });
    it("无指代、具体 id、缺参数值时原样通过", () => {
        const passthrough = ["--model", "zai/glm-5.3", "--model"];
        const result = rewriteTierModelArg(passthrough, () => undefined);
        assert.deepEqual(result.args, passthrough);
        assert.equal(result.resolved, undefined);
        assert.equal(result.error, undefined);
    });
});
