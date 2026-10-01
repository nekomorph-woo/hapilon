import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import hplSubagentModels from "../../extensions/hpl-subagent-models/index.js";
import { readSubagentModelsEffect } from "../../extensions/hpl-subagent-models/config.js";
import { Effect } from "effect";

describe("hpl-subagent-models /subagent-models 命令", { concurrency: false }, () => {
  let home: string;
  let cwd: string;
  const originalHome = process.env.HAPILON_HOME;

  before(() => {
    home = mkdtempSync(join(tmpdir(), "hapi-subagent-models-cmd-home-"));
    cwd = mkdtempSync(join(tmpdir(), "hapi-subagent-models-cmd-cwd-"));
    process.env.HAPILON_HOME = home;
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HAPILON_HOME;
    else process.env.HAPILON_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const globalPath = () => join(home, "subagent-models.json");
  const projectPath = () => join(cwd, ".hapilon", "subagent-models.json");

  function install() {
    const commands = new Map<string, { handler: Function }>();
    hplSubagentModels({
      registerCommand: (name: string, definition: { handler: Function }) => commands.set(name, definition),
      on: () => {},
    } as never);
    return commands;
  }

  function commandCtx(selections: string[], notices: string[]) {
    return {
      cwd,
      ui: {
        select: async (_title: string, options: string[]) => {
          const next = selections.shift();
          assert.ok(next === undefined || options.includes(next), `${next} 应在候选项中`);
          return next;
        },
        notify: (message: string) => notices.push(message),
      },
      modelRegistry: {
        getAvailable: () => [
          { provider: "openai", id: "gpt-5.2" },
          { provider: "deepseek", id: "deepseek-chat" },
        ],
      },
    } as never;
  }

  it("注册 /subagent-models", () => {
    assert.ok(install().has("subagent-models"));
  });

  it("新建项目层并添加模型，项目文件整体替换全局", async () => {
    writeFileSync(globalPath(), JSON.stringify({ enabled: true, models: ["deepseek/deepseek-chat"] }));
    const commands = install();
    const notices: string[] = [];
    const selections = ["项目（未配置）", "添加模型", "openai/gpt-5.2", "完成"];
    await commands.get("subagent-models")!.handler("", commandCtx(selections, notices));

    assert.ok(existsSync(projectPath()));
    assert.deepEqual(JSON.parse(readFileSync(projectPath(), "utf8")), {
      enabled: true,
      models: ["openai/gpt-5.2"],
    });
    // 运行时读到的是项目层，全局条目不再出现
    const runtime = Effect.runSync(readSubagentModelsEffect(cwd));
    assert.deepEqual(runtime.entries, [{ provider: "openai", id: "gpt-5.2" }]);
    assert.ok(notices.some((message) => message.includes("整体替换全局")));
  });

  it("开关扩展写入 enabled:false 后运行时不介入", async () => {
    mkdirSync(join(cwd, ".hapilon"), { recursive: true });
    writeFileSync(projectPath(), JSON.stringify({ enabled: true, models: ["openai/gpt-5.2"] }));
    const commands = install();
    const selections = ["项目（1 条）", "开关扩展", "关闭"];
    await commands.get("subagent-models")!.handler("", commandCtx(selections, []));

    assert.equal(JSON.parse(readFileSync(projectPath(), "utf8")).enabled, false);
    const runtime = Effect.runSync(readSubagentModelsEffect(cwd));
    assert.deepEqual(runtime, { enabled: false, entries: [] });
  });

  it("设置 thinking 追加 :level 后缀到全局层", async () => {
    rmSync(projectPath(), { force: true });
    writeFileSync(globalPath(), JSON.stringify({ enabled: true, models: ["openai/gpt-5.2"] }));
    const commands = install();
    const selections = ["全局（1 条）", "设置 thinking", "openai/gpt-5.2", "high"];
    await commands.get("subagent-models")!.handler("", commandCtx(selections, []));

    const models = JSON.parse(readFileSync(globalPath(), "utf8")).models;
    assert.deepEqual(models, ["openai/gpt-5.2:high"]);
  });
});
