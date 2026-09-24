import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { applyModelTiersEffect, matchesModelPattern, resolveTierModels, } from "../../extensions/hpl-model-tiers/index.js";
import { splitThinkingSuffix } from "../../extensions/hpl-model-tiers/resolved.js";
describe("splitThinkingSuffix", () => {
    it("合法档位名后缀被剥离并返回", () => {
        assert.deepEqual(splitThinkingSuffix("zai/glm-5.3:high"), { pattern: "zai/glm-5.3", thinking: "high" });
        assert.deepEqual(splitThinkingSuffix("glm-*:off"), { pattern: "glm-*", thinking: "off" });
        assert.deepEqual(splitThinkingSuffix("p/i:max"), { pattern: "p/i", thinking: "max" });
    });
    it("非法后缀视为模式本身的一部分（与 pi 同语义）", () => {
        assert.deepEqual(splitThinkingSuffix("zai/glm-5.3:hight"), { pattern: "zai/glm-5.3:hight" });
        // OpenRouter 风格 id 含冒号，但后缀不是档位名 → 不剥离
        assert.deepEqual(splitThinkingSuffix("openai/gpt-4:exacto"), { pattern: "openai/gpt-4:exacto" });
    });
    it("无冒号、首冒号、尾冒号均不剥离", () => {
        assert.deepEqual(splitThinkingSuffix("zai/glm-5.3"), { pattern: "zai/glm-5.3" });
        assert.deepEqual(splitThinkingSuffix(":high"), { pattern: ":high" });
        assert.deepEqual(splitThinkingSuffix("p/i:"), { pattern: "p/i:" });
    });
});
describe(":thinking 后缀贯穿档位解析", () => {
    it("带后缀模式匹配时剥离后缀并附到解析结果上", () => {
        const model = { provider: "zai", id: "glm-5.3" };
        assert.equal(matchesModelPattern("zai/glm-5.3:high", model), true);
        assert.equal(matchesModelPattern("zai/glm-5.3", model), true);
    });
    it("同一模型在不同档位各自持不同 thinking level（核心诉求）", () => {
        const available = [{ provider: "zai", id: "glm-5.3" }];
        const result = resolveTierModels({
            opus: ["zai/glm-5.3:high"],
            sonnet: ["zai/glm-5.3:low"],
            haiku: [],
        }, available);
        assert.deepEqual(result.matched.opus[0], { provider: "zai", id: "glm-5.3", thinking: "high", group: 0 });
        assert.deepEqual(result.matched.sonnet[0], { provider: "zai", id: "glm-5.3", thinking: "low", group: 0 });
    });
    it("同档同模型重复出现时保留首个（含其 level）", () => {
        const available = [{ provider: "zai", id: "glm-5.3" }];
        const result = resolveTierModels({
            opus: ["zai/glm-5.3:high", "zai/glm-5.3:low"],
            sonnet: [],
            haiku: [],
        }, available);
        assert.equal(result.matched.opus.length, 1);
        assert.equal(result.matched.opus[0].thinking, "high");
    });
    it("无后缀条目行为不变，不携带 thinking 字段", () => {
        const result = resolveTierModels({
            opus: ["zai/glm-5.3"],
            sonnet: [],
            haiku: [],
        }, [{ provider: "zai", id: "glm-5.3" }]);
        assert.deepEqual(result.matched.opus[0], { provider: "zai", id: "glm-5.3", group: 0 });
    });
    it("enabledModels 透传原始模式串（后缀随 enabledModels → scopedModels 生效）", () => {
        const result = resolveTierModels({
            opus: ["zai/glm-5.3:high"],
            sonnet: [],
            haiku: [],
        }, [{ provider: "zai", id: "glm-5.3" }]);
        assert.deepEqual(result.enabledModels, ["zai/glm-5.3:high"]);
    });
});
const available = [
    { provider: "anthropic", id: "claude-opus-4" },
    { provider: "anthropic", id: "claude-sonnet-4" },
    { provider: "zhipu", id: "glm-4" },
];
describe("hpl-model-tiers 模型解析与 Pi settings 合并", () => {
    let home;
    let project;
    const originalHome = process.env.HAPILON_HOME;
    before(() => {
        home = mkdtempSync(join(tmpdir(), "hapilon-model-tiers-apply-home-"));
        process.env.HAPILON_HOME = home;
    });
    afterEach(() => {
        rmSync(join(home, "model-tiers.json"), { force: true });
        rmSync(join(home, "model-tiers-resolved.json"), { force: true });
        rmSync(join(home, "agent"), { recursive: true, force: true });
        rmSync(join(project, ".hapilon"), { recursive: true, force: true });
    });
    after(() => {
        if (originalHome === undefined)
            delete process.env.HAPILON_HOME;
        else
            process.env.HAPILON_HOME = originalHome;
        rmSync(home, { recursive: true, force: true });
        rmSync(project, { recursive: true, force: true });
    });
    before(() => {
        project = mkdtempSync(join(tmpdir(), "hapilon-model-tiers-apply-project-"));
    });
    it("支持裸 modelId 与 provider/modelId glob，并保留零匹配 pattern", () => {
        assert.equal(matchesModelPattern("claude-opus-*", available[0]), true);
        assert.equal(matchesModelPattern("anthropic/claude-*-4", available[1]), true);
        assert.equal(matchesModelPattern("anthropic/claude-*", available[2]), false);
        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (...args) => warnings.push(args.map(String).join(" "));
        let result;
        try {
            result = resolveTierModels({
                opus: ["anthropic/claude-opus-*", "future-model-*"],
                sonnet: ["glm-*"],
                haiku: [],
            }, available, ["custom/*"]);
        }
        finally {
            console.warn = originalWarn;
        }
        assert.deepEqual(result.matched.opus, [{ ...available[0], group: 0 }]);
        assert.deepEqual(result.matched.sonnet, [{ ...available[2], group: 0 }]);
        assert.deepEqual(result.enabledModels, ["custom/*", "anthropic/claude-opus-*", "future-model-*", "glm-*"]);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /future-model-\*/);
    });
    it("glob 匹配大小写不敏感", () => {
        assert.equal(matchesModelPattern("CLAUDE-OPUS-*", available[0]), true);
    });
    it("以并集写入 enabledModels，并在 default 双缺失时用 opus 首个可用模型兜底", async () => {
        writeFileSync(join(home, "model-tiers.json"), JSON.stringify({
            opus: ["anthropic/claude-opus-*"],
            sonnet: ["glm-*"],
        }));
        mkdirSync(join(home, "agent"), { recursive: true });
        writeFileSync(join(home, "agent", "settings.json"), JSON.stringify({
            theme: "dark",
            enabledModels: ["custom/*", "glm-*"],
        }));
        const result = await Effect.runPromise(applyModelTiersEffect(project, available));
        assert.equal(result.settingsChanged, true);
        const settings = JSON.parse(readFileSync(join(home, "agent", "settings.json"), "utf8"));
        assert.equal(settings.theme, "dark");
        assert.deepEqual(settings.enabledModels, ["custom/*", "glm-*", "anthropic/claude-opus-*"]);
        assert.equal(settings.defaultProvider, "anthropic");
        assert.equal(settings.defaultModel, "claude-opus-4");
        const resolved = JSON.parse(readFileSync(join(home, "model-tiers-resolved.json"), "utf8"));
        // group = 命中的档位条目序号：同一 glob 条目展开出的模型共享它，选模侧据此在同位间按负载排序
        assert.deepEqual(resolved.opus, [{ provider: "anthropic", id: "claude-opus-4", group: 0 }]);
        assert.deepEqual(resolved.sonnet, [{ provider: "zhipu", id: "glm-4", group: 0 }]);
    });
    it("同一输入二轮幂等：第二轮不写 settings", async () => {
        writeFileSync(join(home, "model-tiers.json"), JSON.stringify({
            opus: ["anthropic/claude-opus-*"],
        }));
        mkdirSync(join(home, "agent"), { recursive: true });
        const settingsPath = join(home, "agent", "settings.json");
        writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
        const first = await Effect.runPromise(applyModelTiersEffect(project, available));
        assert.equal(first.settingsChanged, true);
        const firstContent = readFileSync(settingsPath, "utf8");
        const firstMtime = statSync(settingsPath, { bigint: true }).mtimeNs;
        const second = await Effect.runPromise(applyModelTiersEffect(project, available));
        assert.equal(second.settingsChanged, false);
        assert.equal(readFileSync(settingsPath, "utf8"), firstContent);
        assert.equal(statSync(settingsPath, { bigint: true }).mtimeNs, firstMtime);
    });
    it("损坏 settings.json 时降级且不写入", async () => {
        writeFileSync(join(home, "model-tiers.json"), JSON.stringify({ opus: ["claude-opus-*"] }));
        mkdirSync(join(home, "agent"), { recursive: true });
        const settingsPath = join(home, "agent", "settings.json");
        writeFileSync(settingsPath, "{broken-json");
        const result = await Effect.runPromise(applyModelTiersEffect(project, available));
        assert.equal(result.settingsChanged, false);
        assert.equal(readFileSync(settingsPath, "utf8"), "{broken-json");
    });
});
