import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import hplModelTiers from "../../extensions/hpl-model-tiers/index.js";

describe("hpl-model-tiers /tiers 命令", { concurrency: false }, () => {
  let home: string;
  const originalHome = process.env.HAPILON_HOME;

  before(() => {
    home = mkdtempSync(join(tmpdir(), "hapilon-model-tiers-command-"));
    process.env.HAPILON_HOME = home;
    writeFileSync(join(home, "model-tiers.json"), JSON.stringify({ sonnet: ["glm-*"], haiku: ["deepseek-chat"] }));
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HAPILON_HOME;
    else process.env.HAPILON_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("注册 /tiers，并通过单选循环添加模型且保留其它档位", async () => {
    const commands = new Map<string, { handler: Function }>();
    hplModelTiers({
      registerCommand: (name: string, definition: { handler: Function }) => commands.set(name, definition),
      on: () => {},
    } as never);
    assert.ok(commands.has("tiers"));

    const selections = ["Opus", "添加模型", "anthropic/claude-opus-4", "完成"];
    const notices: string[] = [];
    await commands.get("tiers")!.handler("", {
      cwd: mkdtempSync(join(tmpdir(), "hapilon-model-tiers-command-cwd-")),
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
          { provider: "anthropic", id: "claude-opus-4" },
          { provider: "zhipu", id: "glm-4" },
        ],
      },
    });

    const saved = JSON.parse(readFileSync(join(home, "model-tiers.json"), "utf8"));
    assert.deepEqual(saved, {
      opus: ["anthropic/claude-opus-4"],
      sonnet: ["glm-*"],
      haiku: ["deepseek-chat"],
    });
    assert.match(notices.at(-1)!, /\/reload/);

    // 同一用例顺序验证 Esc：避免测试之间共享 HAPILON_HOME 造成环境变量竞态。
    const initial = JSON.stringify({ sonnet: ["glm-*"], haiku: ["deepseek-chat"] });
    writeFileSync(join(home, "model-tiers.json"), initial);
    const before = readFileSync(join(home, "model-tiers.json"), "utf8");
    const cancelCommands = new Map<string, { handler: Function }>();
    hplModelTiers({
      registerCommand: (name: string, definition: { handler: Function }) => cancelCommands.set(name, definition),
      on: () => {},
    } as never);

    const cancelSelections: Array<string | undefined> = ["Opus", "添加模型", "anthropic/claude-opus-4", undefined];
    const cancelNotices: string[] = [];
    await cancelCommands.get("tiers")!.handler("", {
      cwd: home,
      ui: {
        select: async (_title: string, options: string[]) => {
          const next = cancelSelections.shift();
          assert.ok(next === undefined || options.includes(next), `${next} 应在候选项中`);
          return next;
        },
        notify: (message: string) => cancelNotices.push(message),
      },
      modelRegistry: {
        getAvailable: () => [
          { provider: "anthropic", id: "claude-opus-4" },
          { provider: "zhipu", id: "glm-4" },
        ],
      },
    });

    assert.equal(readFileSync(join(home, "model-tiers.json"), "utf8"), before);
    assert.ok(cancelNotices.some((message) => message.includes("已取消，本次改动未保存")));
  });
});
