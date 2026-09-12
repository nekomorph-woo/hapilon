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

  it("调整顺序：选中模型与前一位交换，完成保存，esc 不保存", async () => {
    const commands = new Map<string, { handler: Function }>();
    hplModelTiers({
      registerCommand: (name: string, definition: { handler: Function }) => commands.set(name, definition),
      on: () => {},
    } as never);
    const initial = { sonnet: ["glm-a", "glm-b", "glm-c"], haiku: ["deepseek-chat"] };
    writeFileSync(join(home, "model-tiers.json"), JSON.stringify(initial));

    // 菜单选 Sonnet → 调整顺序 → 选 "2. glm-b"（与 1 交换）→ 完成
    const selections = ["Sonnet", "调整顺序", "2. glm-b", "完成"];
    const seenTitles: string[] = [];
    await commands.get("tiers")!.handler("", {
      cwd: home,
      ui: {
        select: async (title: string, options: string[]) => {
          seenTitles.push(title);
          const next = selections.shift();
          assert.ok(next !== undefined && options.includes(next), `${next} 应在候选项中: ${JSON.stringify(options)}`);
          return next;
        },
        notify: () => {},
      },
      modelRegistry: { getAvailable: () => [] },
    });

    const saved = JSON.parse(readFileSync(join(home, "model-tiers.json"), "utf8"));
    assert.deepEqual(saved.sonnet, ["glm-b", "glm-a", "glm-c"]);
    assert.ok(seenTitles.some((t) => t.includes("越靠前优先级越高")));

    // esc（undefined）：顺序改动不保存
    writeFileSync(join(home, "model-tiers.json"), JSON.stringify(initial));
    const escSelections: Array<string | undefined> = ["Sonnet", "调整顺序", "2. glm-b", undefined];
    await commands.get("tiers")!.handler("", {
      cwd: home,
      ui: {
        select: async (_title: string, options: string[]) => {
          const next = escSelections.shift();
          assert.ok(next === undefined || options.includes(next));
          return next;
        },
        notify: () => {},
      },
      modelRegistry: { getAvailable: () => [] },
    });
    assert.deepEqual(JSON.parse(readFileSync(join(home, "model-tiers.json"), "utf8")).sonnet, ["glm-a", "glm-b", "glm-c"]);
  });
});
