import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import hplModelTiers from "../../extensions/hpl-model-tiers/index.js";
import { setTierAdaptiveSessionOverride } from "../../extensions/hpl-model-tiers/adaptive.js";

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
      registerFlag: () => {},
      getFlag: () => undefined,
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
      registerFlag: () => {},
      getFlag: () => undefined,
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
      registerFlag: () => {},
      getFlag: () => undefined,
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

  it("「设置 thinking」给条目追加后缀、可覆盖、可清除", async () => {
    const commands = new Map<string, { handler: Function }>();
    hplModelTiers({
      registerCommand: (name: string, definition: { handler: Function }) => commands.set(name, definition),
      on: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
    } as never);

    // 追加：选模型 → 选 level
    writeFileSync(join(home, "model-tiers.json"), JSON.stringify({ sonnet: ["glm-a", "glm-b"] }));
    const setSelections = ["Sonnet", "设置 thinking", "glm-a", "high"];
    await commands.get("tiers")!.handler("", {
      cwd: home,
      ui: {
        select: async (_title: string, options: string[]) => {
          const next = setSelections.shift();
          assert.ok(next !== undefined && options.includes(next), `${next} 应在候选项中: ${JSON.stringify(options)}`);
          return next;
        },
        notify: () => {},
      },
      modelRegistry: { getAvailable: () => [] },
    });
    assert.deepEqual(
      JSON.parse(readFileSync(join(home, "model-tiers.json"), "utf8")).sonnet,
      ["glm-a:high", "glm-b"],
    );

    // 覆盖：已带后缀的条目显示原样，重选改 level
    const overrideSelections = ["Sonnet", "设置 thinking", "glm-a:high", "max"];
    await commands.get("tiers")!.handler("", {
      cwd: home,
      ui: {
        select: async (_title: string, options: string[]) => {
          const next = overrideSelections.shift();
          assert.ok(next !== undefined && options.includes(next));
          return next;
        },
        notify: () => {},
      },
      modelRegistry: { getAvailable: () => [] },
    });
    assert.deepEqual(
      JSON.parse(readFileSync(join(home, "model-tiers.json"), "utf8")).sonnet,
      ["glm-a:max", "glm-b"],
    );

    // 清除：选「清除（跟随全局默认）」移除后缀
    const clearSelections = ["Sonnet", "设置 thinking", "glm-a:max", "清除（跟随全局默认）"];
    await commands.get("tiers")!.handler("", {
      cwd: home,
      ui: {
        select: async (_title: string, options: string[]) => {
          const next = clearSelections.shift();
          assert.ok(next !== undefined && options.includes(next));
          return next;
        },
        notify: () => {},
      },
      modelRegistry: { getAvailable: () => [] },
    });
    assert.deepEqual(
      JSON.parse(readFileSync(join(home, "model-tiers.json"), "utf8")).sonnet,
      ["glm-a", "glm-b"],
    );
  });

  it("「设置 thinking」空档位提示不保存", async () => {
    const commands = new Map<string, { handler: Function }>();
    hplModelTiers({
      registerCommand: (name: string, definition: { handler: Function }) => commands.set(name, definition),
      on: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
    } as never);
    writeFileSync(join(home, "model-tiers.json"), JSON.stringify({ sonnet: [] }));
    const notices: string[] = []
    const selections = ["Sonnet", "设置 thinking"];
    await commands.get("tiers")!.handler("", {
      cwd: home,
      ui: {
        select: async (_title: string, options: string[]) => {
          const next = selections.shift();
          assert.ok(next !== undefined && options.includes(next));
          return next;
        },
        notify: (message: string) => notices.push(message),
      },
      modelRegistry: { getAvailable: () => [] },
    });
    assert.ok(notices.some((n) => n.includes("为空")));
  });
});

describe("hpl-model-tiers /tier-adaptive-mode 命令", { concurrency: false }, () => {
  let home: string;
  const originalHome = process.env.HAPILON_HOME;
  const originalCache = process.env["HAPILON_QUOTA_CACHE"];

  before(() => {
    home = mkdtempSync(join(tmpdir(), "hapilon-tier-adaptive-mode-"));
    process.env.HAPILON_HOME = home;
    // 配额快照默认落在系统 tmpdir：不隔离就会读到本机真实缓存，断言不可复现
    process.env["HAPILON_QUOTA_CACHE"] = join(home, "quota-cache.json");
    writeFileSync(join(home, "model-tiers.json"), JSON.stringify({ sonnet: ["zai/glm-5.3:high"] }));
    writeFileSync(join(home, "model-tiers-resolved.json"), JSON.stringify({
      opus: [],
      sonnet: [{ provider: "zai", id: "glm-5.3", thinking: "high", group: 0 }],
      haiku: [],
    }));
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HAPILON_HOME;
    else process.env.HAPILON_HOME = originalHome;
    if (originalCache === undefined) delete process.env["HAPILON_QUOTA_CACHE"];
    else process.env["HAPILON_QUOTA_CACHE"] = originalCache;
    rmSync(home, { recursive: true, force: true });
  });

  const settingsPath = () => join(home, "agent", "settings.json");

  function register() {
    const commands = new Map<string, { handler: Function }>();
    hplModelTiers({
      registerCommand: (name: string, definition: { handler: Function }) => commands.set(name, definition),
      registerFlag: () => {},
      on: () => {},
    } as never);
    const notices: Array<{ message: string; type?: string }> = [];
    const ctx = {
      cwd: home,
      model: { provider: "anthropic", id: "claude-opus" },
      ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
    } as never;
    return { commands, notices, ctx };
  }

  it("on/off 只改 tierAdaptive.enabled，settings 其它键保留", async () => {
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({ theme: "dark", gateAuto: { enabled: true } }));

    const on = register();
    await on.commands.get("tier-adaptive-mode")!.handler("on", on.ctx);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath(), "utf8")), {
      theme: "dark",
      gateAuto: { enabled: true },
      tierAdaptive: { enabled: true },
    });
    assert.match(on.notices.at(-1)!.message, /已开启（本会话立即生效）/);

    const off = register();
    await off.commands.get("tier-adaptive-mode")!.handler("off", off.ctx);
    assert.equal(JSON.parse(readFileSync(settingsPath(), "utf8")).tierAdaptive.enabled, false);
  });

  it("写盘失败只本会话生效并明确提示", async () => {
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(settingsPath(), "{broken");
    const { commands, notices, ctx } = register();
    await commands.get("tier-adaptive-mode")!.handler("on", ctx);
    assert.equal(readFileSync(settingsPath(), "utf8"), "{broken");
    assert.equal(notices.at(-1)!.type, "warning");
    assert.match(notices.at(-1)!.message, /持久化失败/);
  });

  it("无参数显示状态：持久/实际、样本数、配置顺序、建议顺序与标签", async () => {
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({ tierAdaptive: { enabled: true } }));
    // 清掉前一个用例的本会话覆盖，断言实际生效值确实来自 settings
    setTierAdaptiveSessionOverride(undefined);
    const { commands, notices, ctx } = register();
    await commands.get("tier-adaptive-mode")!.handler("", ctx);
    const message = notices.at(-1)!.message;
    assert.match(message, /settings\.json tierAdaptive\.enabled：开启/);
    assert.match(message, /本会话实际生效：开启/);
    assert.match(message, /可信样本：0 条/);
    assert.match(message, /配置顺序（Sonnet）：zai\/glm-5\.3:high/);
    assert.match(message, /建议顺序：zai\/glm-5\.3:high/);
    assert.match(message, /暂无配额数据 · 观察中/);
    // --tier-adaptive 已删除：状态页不得再声称存在这个 flag
    assert.doesNotMatch(message, /--tier-adaptive/);
  });

  it("非法参数只报用法，不动 settings", async () => {
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({ tierAdaptive: { enabled: true } }));
    const { commands, notices, ctx } = register();
    await commands.get("tier-adaptive-mode")!.handler("yes", ctx);
    assert.equal(notices.at(-1)!.type, "error");
    assert.match(notices.at(-1)!.message, /用法：\/tier-adaptive-mode \[on\|off\]/);
    assert.equal(JSON.parse(readFileSync(settingsPath(), "utf8")).tierAdaptive.enabled, true);
  });
});
