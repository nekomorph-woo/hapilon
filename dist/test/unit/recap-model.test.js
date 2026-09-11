import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { recapModelLabel, selectRecapModel } from "../../extensions/hpl-recap/model.js";
import { readResolvedTiersEffect } from "../../extensions/hpl-recap/resolved.js";
const haiku = { provider: "fast", id: "flash", name: "Flash", reasoning: false };
const reasoningMid = { provider: "work", id: "think", reasoning: true };
const plainMid = { provider: "work", id: "plain", reasoning: false };
const current = { provider: "current", id: "active", reasoning: true };
const all = [haiku, reasoningMid, plainMid];
const emptyTiers = { opus: [], sonnet: [], haiku: [] };
describe("hpl-recap 模型选择", () => {
    let home;
    const originalHome = process.env.HAPILON_HOME;
    before(() => {
        home = mkdtempSync(join(tmpdir(), "hapilon-recap-resolved-"));
        process.env.HAPILON_HOME = home;
    });
    after(() => {
        if (originalHome === undefined)
            delete process.env.HAPILON_HOME;
        else
            process.env.HAPILON_HOME = originalHome;
        rmSync(home, { recursive: true, force: true });
    });
    it("优先 resolved haiku 档匹配模型", () => {
        const result = selectRecapModel(all, current, { opus: [], sonnet: [reasoningMid], haiku: [haiku] });
        assert.equal(result.model, haiku);
        assert.equal(result.degraded, false);
    });
    it("haiku 无匹配时选 resolved sonnet 非推理模型", () => {
        const result = selectRecapModel([reasoningMid, plainMid], current, {
            opus: [],
            sonnet: [reasoningMid, plainMid],
            haiku: [{ provider: "missing", id: "model" }],
        });
        assert.equal(result.model, plainMid);
        assert.equal(result.degraded, true);
        assert.equal(result.reason, "recap 模型降级：haiku 档无可用模型");
    });
    it("sonnet 也无匹配时降级当前模型，再无当前模型则无结果", () => {
        const fallback = selectRecapModel([], current, emptyTiers);
        assert.equal(fallback.model, current);
        assert.equal(fallback.degraded, true);
        const none = selectRecapModel([], undefined, emptyTiers);
        assert.equal(none.model, undefined);
        assert.match(none.reason ?? "", /当前模型也不可用/);
    });
    it("从 model-tiers-resolved.json 读取解析后的模型清单", () => {
        writeFileSync(join(home, "model-tiers-resolved.json"), JSON.stringify({
            opus: [],
            sonnet: [reasoningMid, plainMid],
            haiku: [haiku],
        }));
        const resolved = Effect.runSync(readResolvedTiersEffect);
        const result = selectRecapModel(all, current, resolved);
        assert.equal(result.model, haiku);
        assert.equal(recapModelLabel(haiku), "Flash");
    });
    it("resolved 文件缺失时按空档走降级链", () => {
        rmSync(join(home, "model-tiers-resolved.json"), { force: true });
        const resolved = Effect.runSync(readResolvedTiersEffect);
        const result = selectRecapModel([], current, resolved);
        assert.equal(result.model, current);
        assert.equal(result.degraded, true);
    });
});
