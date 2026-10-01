import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { parseModelEntry, readSubagentModelsEffect } from "../../extensions/hpl-subagent-models/config.js";
import { pickSubagentModel } from "../../extensions/hpl-subagent-models/selector.js";
describe("hpl-subagent-models selector", { concurrency: false }, () => {
    const a = { provider: "openai", id: "gpt-5.2" };
    const b = { provider: "zai-coding-cn", id: "glm-4.7" };
    const c = { provider: "deepseek", id: "deepseek-chat" };
    it("配置顺序首位可用即选", () => {
        assert.deepEqual(pickSubagentModel([a, b], new Set()), { kind: "entry", entry: a });
    });
    it("首位 provider 配额紧张时顺延", () => {
        assert.deepEqual(pickSubagentModel([a, b], new Set(["openai"])), { kind: "entry", entry: b });
    });
    it("glm 系入口按命名空间共享配额判定", () => {
        assert.deepEqual(pickSubagentModel([b], new Set(["glm"])), { kind: "all-hot" });
    });
    it("全部紧张不硬选", () => {
        assert.deepEqual(pickSubagentModel([a, c], new Set(["openai", "deepseek"])), { kind: "all-hot" });
    });
    it("空列表无候选", () => {
        assert.deepEqual(pickSubagentModel([], new Set()), { kind: "none" });
    });
});
describe("hpl-subagent-models config", { concurrency: false }, () => {
    let home;
    let project;
    const originalHome = process.env.HAPILON_HOME;
    before(() => {
        home = mkdtempSync(join(tmpdir(), "hapi-subagent-models-home-"));
        project = mkdtempSync(join(tmpdir(), "hapi-subagent-models-project-"));
        process.env.HAPILON_HOME = home;
    });
    after(() => {
        rmSync(home, { recursive: true, force: true });
        rmSync(project, { recursive: true, force: true });
        if (originalHome === undefined)
            delete process.env.HAPILON_HOME;
        else
            process.env.HAPILON_HOME = originalHome;
    });
    const writeGlobal = (content) => writeFileSync(join(home, "subagent-models.json"), content, "utf8");
    const writeProject = (content) => {
        mkdirSync(join(project, ".hapilon"), { recursive: true });
        writeFileSync(join(project, ".hapilon", "subagent-models.json"), content, "utf8");
    };
    const read = () => Effect.runSync(readSubagentModelsEffect(project));
    it("两层都缺时扩展不介入", () => {
        assert.deepEqual(read(), { enabled: false, entries: [] });
    });
    it("解析 provider/id 与 :thinking 后缀", () => {
        writeGlobal(JSON.stringify({ enabled: true, models: ["openai/gpt-5.2:high", "zai-coding-cn/glm-4.7"] }));
        assert.deepEqual(read(), {
            enabled: true,
            entries: [
                { provider: "openai", id: "gpt-5.2", thinking: "high" },
                { provider: "zai-coding-cn", id: "glm-4.7" },
            ],
        });
    });
    it("项目文件整体替换全局", () => {
        writeGlobal(JSON.stringify({ models: ["openai/gpt-5.2"] }));
        writeProject(JSON.stringify({ models: ["deepseek/deepseek-chat"] }));
        assert.deepEqual(read(), {
            enabled: true,
            entries: [{ provider: "deepseek", id: "deepseek-chat" }],
        });
    });
    it("enabled:false 时不介入", () => {
        writeProject(JSON.stringify({ enabled: false, models: ["openai/gpt-5.2"] }));
        assert.deepEqual(read(), { enabled: false, entries: [] });
    });
    it("坏 JSON 该级忽略：全局坏且项目缺则不介入", () => {
        writeProject("{broken");
        rmSync(join(project, ".hapilon", "subagent-models.json"));
        writeGlobal("{broken");
        assert.deepEqual(read(), { enabled: false, entries: [] });
    });
    it("非法条目跳过，不拖垮整张列表", () => {
        writeGlobal(JSON.stringify({ models: ["no-slash", "openai/gpt-5.2"] }));
        const result = read();
        assert.deepEqual(result.entries, [{ provider: "openai", id: "gpt-5.2" }]);
    });
    it("parseModelEntry 拒绝缺 provider 或缺 id 的条目", () => {
        assert.equal(parseModelEntry("justname", "x"), undefined);
        assert.equal(parseModelEntry("provider/", "x"), undefined);
        assert.equal(parseModelEntry("/id", "x"), undefined);
    });
});
