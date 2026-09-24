/**
 * 纯模型选择器：优先级、配额语义、负载同位、显式覆盖、画像门槛与 thinking 透传。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MIN_TRUSTED_SAMPLES, candidateLabels, learnedThinkingLevel, selectTierModel, thinkingLabel, } from "../../extensions/hpl-model-tiers/selector.js";
const cand = (provider, id, extra = {}) => ({
    provider,
    id,
    entryIndex: extra.entryIndex ?? 0,
    ...(extra.thinking ? { thinking: extra.thinking } : {}),
});
const evidence = (overrides = {}) => ({
    trustedSamples: 0,
    explicitPicks: 0,
    switchPicks: 0,
    completedTasks: 0,
    approvals: 0,
    fixRounds: 0,
    rejects: 0,
    roles: {},
    switchRoles: {},
    thinkingLevels: {},
    ...overrides,
});
const profile = (models, roleLeaders = {}) => ({ models, roleLeaders });
/** 三个 sonnet 候选：同一模型名空间，只有 entryIndex 区分配置顺序 */
const trio = () => [
    cand("zai", "glm-5.3", { entryIndex: 0 }),
    cand("deepseek", "deepseek-flash", { entryIndex: 1 }),
    cand("openai-codex", "gpt-5", { entryIndex: 2 }),
];
describe("selectTierModel 配额", () => {
    it("hot provider 顺延到后面，选择仍在非 hot 里按配置顺序", () => {
        const decision = selectTierModel({
            role: "worker",
            candidates: trio(),
            quotas: { zai: "hot", "deepseek": "ok", "openai-codex": "ok" },
            adaptiveEnabled: false,
        });
        assert.equal(decision.spec, "deepseek/deepseek-flash");
        assert.equal(decision.source, "quota");
        assert.deepEqual(decision.order.map((entry) => entry.key), [
            "deepseek/deepseek-flash",
            "openai-codex/gpt-5",
            "zai/glm-5.3",
        ]);
        assert.deepEqual(decision.warnings, []);
    });
    it("未知配额中性：不惩罚也不优先，按配置顺序取首位", () => {
        const decision = selectTierModel({
            role: "worker",
            candidates: trio(),
            quotas: { "deepseek": "ok" },
            adaptiveEnabled: false,
        });
        assert.equal(decision.spec, "zai/glm-5.3");
        assert.equal(decision.source, "config");
        assert.equal(decision.order[0].quota, "unknown");
    });
    it("全部候选 hot 仍给选择并告警", () => {
        const decision = selectTierModel({
            role: "worker",
            candidates: trio(),
            quotas: { zai: "hot", "deepseek": "hot", "openai-codex": "hot" },
            adaptiveEnabled: false,
        });
        assert.equal(decision.spec, "zai/glm-5.3");
        assert.equal(decision.warnings.length, 1);
        assert.match(decision.warnings[0], /全部候选 provider 配额紧张/);
    });
    it("空候选返回 none，不制造 spec", () => {
        const decision = selectTierModel({ role: "worker", candidates: [], adaptiveEnabled: false });
        assert.equal(decision.spec, undefined);
        assert.equal(decision.source, "none");
    });
});
describe("selectTierModel 负载与配置顺序", () => {
    it("同一条目展开的兄弟模型之间，负载少的优先", () => {
        const decision = selectTierModel({
            role: "worker",
            candidates: [cand("zai", "glm-5.3", { entryIndex: 0 }), cand("zai", "glm-4.7", { entryIndex: 0 })],
            quotas: { zai: "ok" },
            load: { "zai/glm-5.3": 2, "zai/glm-4.7": 0 },
            adaptiveEnabled: false,
        });
        assert.equal(decision.spec, "zai/glm-4.7");
        assert.equal(decision.source, "load");
    });
    it("不同配置条目的候选之间，配置顺序优先于负载", () => {
        const decision = selectTierModel({
            role: "worker",
            candidates: [cand("zai", "glm-5.3", { entryIndex: 0 }), cand("zai", "glm-4.7", { entryIndex: 1 })],
            quotas: { zai: "ok" },
            load: { "zai/glm-5.3": 3, "zai/glm-4.7": 0 },
            adaptiveEnabled: false,
        });
        assert.equal(decision.spec, "zai/glm-5.3");
        assert.equal(decision.source, "config");
    });
});
describe("selectTierModel 显式点名与 thinking", () => {
    it("显式点名压过配额与画像，配额紧张只告警", () => {
        const decision = selectTierModel({
            role: "worker",
            candidates: trio(),
            quotas: { zai: "hot" },
            adaptiveEnabled: true,
            profile: profile({ "deepseek/deepseek-flash": evidence({ trustedSamples: 9, explicitPicks: 9, roles: { worker: 9 } }) }),
            explicit: { spec: "zai/glm-5.3:high", provider: "zai", id: "glm-5.3", thinking: "high" },
        });
        assert.equal(decision.spec, "zai/glm-5.3:high");
        assert.equal(decision.source, "explicit");
        assert.equal(decision.warnings.length, 1);
        assert.match(decision.warnings[0], /显式点名/);
    });
    it("显式点名不在候选表里也照样胜出", () => {
        const decision = selectTierModel({
            role: "worker",
            candidates: trio(),
            adaptiveEnabled: false,
            explicit: { spec: "anthropic/claude-opus-5", provider: "anthropic", id: "claude-opus-5" },
        });
        assert.equal(decision.spec, "anthropic/claude-opus-5");
        assert.deepEqual(decision.warnings, []);
    });
    it("候选项的 thinking 后缀透传进 spec", () => {
        const decision = selectTierModel({
            role: "worker",
            candidates: [cand("zai", "glm-5.3", { thinking: "high" })],
            adaptiveEnabled: false,
        });
        assert.equal(decision.spec, "zai/glm-5.3:high");
    });
});
describe("selectTierModel 可信画像", () => {
    const preferred = profile({
        "deepseek/deepseek-flash": evidence({ trustedSamples: 6, explicitPicks: 6, roles: { worker: 6 } }),
    }, { worker: "deepseek/deepseek-flash" });
    it("adaptive 关闭：证据只展示不参与排序", () => {
        const decision = selectTierModel({
            role: "worker",
            candidates: trio(),
            adaptiveEnabled: false,
            profile: preferred,
        });
        assert.equal(decision.spec, "zai/glm-5.3");
        assert.equal(decision.source, "config");
    });
    it("adaptive 开启且达门槛：常点名的模型提升", () => {
        const decision = selectTierModel({
            role: "worker",
            candidates: trio(),
            adaptiveEnabled: true,
            profile: preferred,
        });
        assert.equal(decision.spec, "deepseek/deepseek-flash");
        assert.equal(decision.source, "profile");
        assert.ok(decision.order[0].labels.includes("用户常点名"));
        assert.ok(decision.order[0].labels.includes("常用 Worker"));
    });
    it("样本不足门槛：标观察中且不提升", () => {
        const thin = profile({
            "deepseek/deepseek-flash": evidence({
                trustedSamples: MIN_TRUSTED_SAMPLES - 1,
                explicitPicks: MIN_TRUSTED_SAMPLES - 1,
                roles: { worker: MIN_TRUSTED_SAMPLES - 1 },
            }),
        }, {});
        const decision = selectTierModel({
            role: "worker",
            candidates: trio(),
            adaptiveEnabled: true,
            profile: thin,
        });
        assert.equal(decision.spec, "zai/glm-5.3");
        assert.equal(decision.source, "config");
        const thinEntry = decision.order.find((entry) => entry.key === "deepseek/deepseek-flash");
        assert.deepEqual(thinEntry.labels, ["暂无配额数据", "观察中"]);
        assert.equal(thinEntry.profileRank, 0);
    });
    it("一键返修的模型被降级到同配额桶末尾", () => {
        const demoted = profile({
            "zai/glm-5.3": evidence({ trustedSamples: 6, fixRounds: 6, roles: { worker: 6 } }),
        });
        const decision = selectTierModel({
            role: "worker",
            candidates: [cand("zai", "glm-5.3", { entryIndex: 0 }), cand("deepseek", "deepseek-flash", { entryIndex: 1 })],
            adaptiveEnabled: true,
            profile: demoted,
        });
        assert.equal(decision.spec, "deepseek/deepseek-flash");
        assert.equal(decision.source, "profile");
        assert.ok(decision.order.at(-1).labels.includes("常需返修"));
    });
    it("配额优先于画像：hot 的首选不会因画像被拉回来", () => {
        const decision = selectTierModel({
            role: "worker",
            candidates: trio(),
            quotas: { "deepseek": "hot" },
            adaptiveEnabled: true,
            profile: preferred,
        });
        assert.equal(decision.spec, "zai/glm-5.3");
    });
});
describe("candidateLabels", () => {
    it("一次通过按审批率而非绝对次数", () => {
        const labels = candidateLabels(evidence({ trustedSamples: 6, approvals: 6, roles: { worker: 1 } }), "ok", profile({}), "worker", "zai/glm-5.3");
        assert.deepEqual(labels, ["配额充足", "一次通过"]);
    });
    it("配额三态各有一词", () => {
        const none = candidateLabels(undefined, "unknown", undefined, "worker", "zai/glm-5.3");
        assert.deepEqual(none, ["暂无配额数据", "观察中"]);
        assert.equal(candidateLabels(undefined, "hot", undefined, "worker", "zai/glm-5.3")[0], "配额紧张");
        assert.equal(candidateLabels(undefined, "ok", undefined, "worker", "zai/glm-5.3")[0], "配额充足");
    });
});
describe("画像证据：主动切模", () => {
    it("切模达门槛提升目标模型，标签与点名分开表述", () => {
        const decision = selectTierModel({
            role: "worker",
            candidates: trio(),
            adaptiveEnabled: true,
            profile: profile({
                "openai-codex/gpt-5": evidence({ trustedSamples: 5, switchPicks: 5, switchRoles: { worker: 5 } }),
            }),
        });
        assert.equal(decision.spec, "openai-codex/gpt-5");
        assert.equal(decision.source, "profile");
        const chosen = decision.order[0];
        assert.ok(chosen.labels.includes("用户常切换至此"));
        assert.equal(chosen.labels.includes("用户常点名"), false);
    });
    it("切模样本不足 5 条保持观察中，不参与排序", () => {
        const decision = selectTierModel({
            role: "worker",
            candidates: trio(),
            adaptiveEnabled: true,
            profile: profile({
                "openai-codex/gpt-5": evidence({ trustedSamples: 4, switchPicks: 4, switchRoles: { worker: 4 } }),
            }),
        });
        assert.equal(decision.spec, "zai/glm-5.3");
        const target = decision.order.find((candidate) => candidate.key === "openai-codex/gpt-5");
        assert.equal(target.profileRank, 0);
        assert.ok(target.labels.includes("观察中"));
    });
});
describe("thinking 偏好标签", () => {
    const withThinking = (levels) => profile({ "zai/glm-5.3": evidence({ thinkingLevels: levels }) });
    it("4 条未达门槛：显示「thinking 观察中」而不出具体 level", () => {
        const labels = candidateLabels(evidence({ thinkingLevels: { high: { worker: 4 } } }), "ok", withThinking({ high: { worker: 4 } }), "worker", "zai/glm-5.3");
        assert.deepEqual(labels, ["配额充足", "观察中", "thinking 观察中"]);
    });
    it("5 条达门槛：显示固定文案「Worker 常用 thinking high」", () => {
        const labels = candidateLabels(evidence({ thinkingLevels: { high: { worker: 5 } } }), "ok", withThinking({ high: { worker: 5 } }), "worker", "zai/glm-5.3");
        assert.deepEqual(labels, ["配额充足", "观察中", "Worker 常用 thinking high"]);
    });
    it("同一模型多个 level 都达门槛：取样本多的那个", () => {
        const evidenceWithLevels = evidence({ thinkingLevels: { high: { worker: 5 }, low: { worker: 7 } } });
        assert.equal(learnedThinkingLevel("worker", evidenceWithLevels), "low");
    });
    it("thinking 样本按角色隔离：别的角色的样本不算数", () => {
        const thin = evidence({ thinkingLevels: { high: { reviewer: 9 } } });
        assert.equal(learnedThinkingLevel("worker", thin), undefined);
        assert.equal(learnedThinkingLevel("reviewer", thin), "high");
        // 该角色没样本就不出 thinking 标签（模型轴已另有「观察中」）
        assert.equal(thinkingLabel("worker", thin), undefined);
    });
    it("没有任何 thinking 样本就不加标签", () => {
        assert.equal(thinkingLabel("worker", undefined), undefined);
        assert.equal(thinkingLabel("worker", evidence()), undefined);
    });
});
