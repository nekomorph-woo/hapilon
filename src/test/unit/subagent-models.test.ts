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
  let home: string;
  let project: string;
  const originalHome = process.env.HAPILON_HOME;

  before(() => {
    home = mkdtempSync(join(tmpdir(), "hapi-subagent-models-home-"));
    project = mkdtempSync(join(tmpdir(), "hapi-subagent-models-project-"));
    process.env.HAPILON_HOME = home;
  });

  after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HAPILON_HOME;
    else process.env.HAPILON_HOME = originalHome;
  });

  const writeGlobal = (content: string) => writeFileSync(join(home, "subagent-models.json"), content, "utf8");
  const writeProject = (content: string) => {
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

describe("vision-models 列表（与 subagent-models 同一套 IO）", { concurrency: false }, () => {
  let home: string;
  let project: string;
  const originalHome = process.env.HAPILON_HOME;

  before(() => {
    home = mkdtempSync(join(tmpdir(), "hapi-vision-models-home-"));
    project = mkdtempSync(join(tmpdir(), "hapi-vision-models-project-"));
    process.env.HAPILON_HOME = home;
  });

  after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HAPILON_HOME;
    else process.env.HAPILON_HOME = originalHome;
  });

  it("vision-models.json 双层读取，与 subagent 列表互不串台", async () => {
    const { readVisionModelsEffect, readSubagentModelsEffect } = await import(
      "../../extensions/hpl-subagent-models/config.js"
    );
    writeFileSync(join(home, "vision-models.json"), JSON.stringify({ models: ["openai/gpt-5.2-vision"] }), "utf8");
    writeFileSync(join(home, "subagent-models.json"), JSON.stringify({ models: ["zai-coding-cn/glm-4.7"] }), "utf8");
    const vision = Effect.runSync(readVisionModelsEffect(project));
    const subagent = Effect.runSync(readSubagentModelsEffect(project));
    assert.deepEqual(vision.entries, [{ provider: "openai", id: "gpt-5.2-vision" }]);
    assert.deepEqual(subagent.entries, [{ provider: "zai-coding-cn", id: "glm-4.7" }]);
  });

  it("项目层整体替换全局（vision 同规则）", async () => {
    const { readVisionModelsEffect } = await import("../../extensions/hpl-subagent-models/config.js");
    mkdirSync(join(project, ".hapilon"), { recursive: true });
    writeFileSync(
      join(project, ".hapilon", "vision-models.json"),
      JSON.stringify({ models: ["anthropic/claude-sonnet-vision"] }),
      "utf8",
    );
    const vision = Effect.runSync(readVisionModelsEffect(project));
    assert.deepEqual(vision.entries, [{ provider: "anthropic", id: "claude-sonnet-vision" }]);
  });
});

describe("vision 路由分流（Agent 派发按 subagent_type 选列表）", { concurrency: false }, () => {
  let home: string;
  let project: string;
  const originalHome = process.env.HAPILON_HOME;

  before(async () => {
    home = mkdtempSync(join(tmpdir(), "hapi-vision-route-home-"));
    project = mkdtempSync(join(tmpdir(), "hapi-vision-route-project-"));
    process.env.HAPILON_HOME = home;
    writeFileSync(join(home, "vision-models.json"), JSON.stringify({ models: ["openai/gpt-5.2-vision"] }), "utf8");
    writeFileSync(join(home, "subagent-models.json"), JSON.stringify({ models: ["zai-coding-cn/glm-4.7"] }), "utf8");
  });

  after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HAPILON_HOME;
    else process.env.HAPILON_HOME = originalHome;
  });

  it("subagent_type=vision → vision 列表；无类型 → subagent 列表；显式 model 不动", async () => {
    const mod = await import("../../extensions/hpl-subagent-models/index.js");
    const handlers: Array<(event: unknown, ctx: unknown) => Promise<void>> = [];
    const pi = {
      registerCommand: () => {},
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
        if (event === "tool_call") handlers.push(handler);
      },
    } as never;
    mod.default(pi);
    assert.equal(handlers.length, 1);

    const run = async (input: Record<string, unknown>) => {
      const event = { type: "tool_call", toolName: "Agent", toolCallId: "t", input: { ...input } };
      await handlers[0]!(event, { cwd: project });
      return (event.input as { model?: string }).model;
    };

    assert.equal(await run({ prompt: "看图", subagent_type: "vision" }), "openai/gpt-5.2-vision");
    assert.equal(await run({ prompt: "查代码" }), "zai-coding-cn/glm-4.7");
    assert.equal(await run({ prompt: "看图", subagent_type: "vision", model: "x/y" }), "x/y");
  });
});
