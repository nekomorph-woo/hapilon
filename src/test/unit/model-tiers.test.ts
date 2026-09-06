import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  applyModelTiersEffect,
  matchesModelPattern,
  resolveTierModels,
  type AvailableModel,
} from "../../extensions/hpl-model-tiers/index.js";
import { getTierModels, resetTierModels, setTierModels } from "../../extensions/hpl-model-tiers/bridge.js";

const available: AvailableModel[] = [
  { provider: "anthropic", id: "claude-opus-4" },
  { provider: "anthropic", id: "claude-sonnet-4" },
  { provider: "zhipu", id: "glm-4" },
];

describe("hpl-model-tiers 模型解析与 Pi settings 合并", () => {
  let home: string;
  let project: string;
  const originalHome = process.env.HAPILON_HOME;

  before(() => {
    home = mkdtempSync(join(tmpdir(), "hapilon-model-tiers-apply-home-"));
    process.env.HAPILON_HOME = home;
  });

  afterEach(() => {
    rmSync(join(home, "model-tiers.json"), { force: true });
    rmSync(join(home, "agent"), { recursive: true, force: true });
    rmSync(join(project, ".hapilon"), { recursive: true, force: true });
    resetTierModels();
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HAPILON_HOME;
    else process.env.HAPILON_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  before(() => {
    project = mkdtempSync(join(tmpdir(), "hapilon-model-tiers-apply-project-"));
  });

  it("支持裸 modelId 与 provider/modelId glob，并保留零匹配 pattern", () => {
    assert.equal(matchesModelPattern("claude-opus-*", available[0]!), true);
    assert.equal(matchesModelPattern("anthropic/claude-*-4", available[1]!), true);
    assert.equal(matchesModelPattern("anthropic/claude-*", available[2]!), false);

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    let result;
    try {
      result = resolveTierModels({
        high: ["anthropic/claude-opus-*", "future-model-*"],
        mid: ["glm-*"],
        low: [],
      }, available, ["custom/*"]);
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(result.matched.high, [available[0]]);
    assert.deepEqual(result.matched.mid, [available[2]]);
    assert.deepEqual(result.enabledModels, ["custom/*", "anthropic/claude-opus-*", "future-model-*", "glm-*"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /future-model-\*/);
  });

  it("glob 匹配大小写不敏感", () => {
    assert.equal(matchesModelPattern("CLAUDE-OPUS-*", available[0]!), true);
  });

  it("以并集写入 enabledModels，并在 default 双缺失时用 high 首个可用模型兜底", async () => {
    writeFileSync(join(home, "model-tiers.json"), JSON.stringify({
      high: ["anthropic/claude-opus-*"],
      mid: ["glm-*"],
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
  });

  it("同一输入二轮幂等：第二轮不写 settings", async () => {
    writeFileSync(join(home, "model-tiers.json"), JSON.stringify({
      high: ["anthropic/claude-opus-*"],
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
    writeFileSync(join(home, "model-tiers.json"), JSON.stringify({ high: ["claude-opus-*"] }));
    mkdirSync(join(home, "agent"), { recursive: true });
    const settingsPath = join(home, "agent", "settings.json");
    writeFileSync(settingsPath, "{broken-json");

    const result = await Effect.runPromise(applyModelTiersEffect(project, available));
    assert.equal(result.settingsChanged, false);
    assert.equal(readFileSync(settingsPath, "utf8"), "{broken-json");
  });

  it("high 为空时不写 default，且 bridge 返回隔离副本", () => {
    setTierModels({ high: [], mid: ["glm-*"], low: [] });
    const values = getTierModels("mid");
    values.push("mutated");
    assert.deepEqual(getTierModels("mid"), ["glm-*"]);
    assert.deepEqual(getTierModels("high"), []);
  });
});
