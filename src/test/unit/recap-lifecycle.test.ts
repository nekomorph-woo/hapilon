import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RecapModelShape } from "../../extensions/hpl-recap/model.js";
import hplRecap from "../../extensions/hpl-recap/index.js";

type Handler = (event: unknown, ctx: any) => unknown;

interface TestContext {
  ctx: any;
  handlers: Map<string, Handler>;
  widgets: Array<{ key: string; content: string[] | undefined }>;
  getCompleteCount(): number;
  completeOptions: Array<Record<string, unknown> | undefined>;
}

function makeExtension(
  recapModel: RecapModelShape = { provider: "fast", id: "flash", name: "Flash", reasoning: false },
  texts: string[] = ["已完成：当前状态正常；下一步继续验证。"],
): TestContext {
  const handlers = new Map<string, Handler>();
  const widgets: Array<{ key: string; content: string[] | undefined }> = [];
  const completeOptions: Array<Record<string, unknown> | undefined> = [];
  let completeCount = 0;
  let pending = false;
  const model = recapModel;
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp/recap-project",
    model,
    ui: {
      theme: { fg: (slot: string, text: string) => `<${slot}>${text}` },
      setWidget: (key: string, content: string[] | undefined) => widgets.push({ key, content }),
    },
    isIdle: () => true,
    hasPendingMessages: () => pending,
    sessionManager: {
      buildContextEntries: () => [{ type: "message", message: { role: "user", content: "刚才完成了工作" } }],
    },
    modelRegistry: {
      getAvailable: () => [model],
      complete: async (_model: unknown, _context: unknown, opts: Record<string, unknown> | undefined) => {
        const text = texts[completeCount] ?? texts.at(-1) ?? "";
        completeCount++;
        completeOptions.push(opts);
        return { content: [{ type: "text", text }] };
      },
    },
    setPending(value: boolean) {
      pending = value;
    },
  };
  hplRecap({
    on: ((event: string, handler: Handler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }) as unknown as ExtensionAPI["on"],
  } as unknown as ExtensionAPI);
  return { ctx, handlers, widgets, getCompleteCount: () => completeCount, completeOptions };
}

function fire(test: TestContext, event: string, payload: unknown = {}): unknown {
  return test.handlers.get(event)?.(payload, test.ctx);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 固定 sleep 会与 60ms idle 阈值竞态（timer 早触发一次即多等一轮），故轮询到 widget 落盘。
async function waitForWidget(test: TestContext): Promise<string[]> {
  for (let i = 0; i < 200; i++) {
    const content = test.widgets.at(-1)?.content;
    if (content) return content;
    await wait(5);
  }
  throw new Error("recap widget 未在 1s 内出现");
}

function untheme(line: string): string {
  return line.replace(/^<muted>/, "").replace(/<\/muted>$/, "");
}

// 去掉头部时间戳/模型标签行，只留正文行。
function widgetBody(test: TestContext): string[] {
  return (test.widgets.at(-1)?.content ?? []).slice(1).map(untheme);
}

function spyWarn(): { calls: string[]; restore: () => void } {
  const original = console.warn;
  const calls: string[] = [];
  console.warn = (...args: unknown[]) => { calls.push(args.map(String).join(" ")); };
  return { calls, restore: () => { console.warn = original; } };
}

describe("hpl-recap session 生命周期", () => {
  let home: string;
  const originalHome = process.env.HAPILON_HOME;

  before(() => {
    home = mkdtempSync(join(tmpdir(), "hapilon-recap-lifecycle-"));
    process.env.HAPILON_HOME = home;
    writeFileSync(join(home, "recap-config.json"), JSON.stringify({ enabled: true, idleMinutes: 0.001, maxContextChars: 8000 }));
    writeFileSync(join(home, "model-tiers-resolved.json"), JSON.stringify({
      opus: [],
      sonnet: [],
      haiku: [{ provider: "fast", id: "flash", name: "Flash", reasoning: false }],
    }));
  });

  afterEach(() => {
    // 每个用例的扩展都应在自身结尾 shutdown；这里仅清理文件状态。
  });

  after(() => {
    if (originalHome === undefined) delete process.env.HAPILON_HOME;
    else process.env.HAPILON_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("session_start 到期经过双重 idle 判定后 setWidget，shutdown 后 timer 不再执行", async () => {
    const test = makeExtension();
    fire(test, "session_start", { reason: "startup" });
    test.ctx.setPending(true);
    await wait(90);
    assert.equal(test.getCompleteCount(), 0, "有 pending message 时不应调用 complete");

    test.ctx.setPending(false);
    fire(test, "message_end", { type: "message_end" });
    await waitForWidget(test);
    assert.equal(test.getCompleteCount(), 1);
    assert.ok(test.widgets.some((item) => item.key === "hpl-recap" && Array.isArray(item.content)));

    const widgetCountBeforeInput = test.widgets.length;
    const inputResult = fire(test, "input", { type: "input", text: "新问题", source: "interactive" });
    assert.equal(inputResult, undefined, "input handler 不拦截用户输入");
    assert.equal(test.widgets.length, widgetCountBeforeInput + 1);
    assert.equal(test.widgets.at(-1)?.content, undefined, "新输入清除旧 recap widget");

    fire(test, "session_shutdown", { reason: "quit" });
    const countAfterShutdown = test.getCompleteCount();
    assert.equal(test.widgets.at(-1)?.content, undefined);
    await wait(90);
    assert.equal(test.getCompleteCount(), countAfterShutdown);
  });

  it("二次 session_start 前后状态干净，旧 timer 不穿透新 session", async () => {
    const test = makeExtension();
    fire(test, "session_start", { reason: "startup" });
    fire(test, "session_shutdown", { reason: "reload" });
    fire(test, "session_start", { reason: "reload" });
    await waitForWidget(test);
    assert.equal(test.getCompleteCount(), 1);
    fire(test, "session_shutdown", { reason: "quit" });
  });

  it("非推理 haiku：小预算快路径，不传任何推理开关", async () => {
    const test = makeExtension();
    fire(test, "session_start", { reason: "startup" });
    fire(test, "message_end", { type: "message_end" });
    await waitForWidget(test);
    assert.equal(test.getCompleteCount(), 1);
    const opts = test.completeOptions[0];
    assert.equal(opts?.maxTokens, 256);
    assert.equal("reasoningEffort" in (opts ?? {}), false);
    assert.equal("reasoning" in (opts ?? {}), false, "已废的 reasoning:off 键不得再传");
    fire(test, "session_shutdown", { reason: "quit" });
  });

  it("haiku 档是推理模型（如 glm-4.7）：同样 {maxTokens:256} 且不传任何推理开关", async () => {
    const reasoningModel: RecapModelShape = { provider: "zai", id: "glm-4.7", name: "GLM", reasoning: true };
    const resolvedPath = join(home, "model-tiers-resolved.json");
    writeFileSync(resolvedPath, JSON.stringify({ opus: [], sonnet: [], haiku: [reasoningModel] }));
    try {
      const test = makeExtension(reasoningModel);
      fire(test, "session_start", { reason: "startup" });
      fire(test, "message_end", { type: "message_end" });
      await waitForWidget(test);
      assert.equal(test.getCompleteCount(), 1);
      const opts = test.completeOptions[0];
      assert.equal(opts?.maxTokens, 256, JSON.stringify(opts));
      assert.equal("reasoningEffort" in (opts ?? {}), false, JSON.stringify(opts));
      assert.equal("reasoning" in (opts ?? {}), false, JSON.stringify(opts));
      fire(test, "session_shutdown", { reason: "quit" });
    } finally {
      // 还原给其它用例的默认档位，断言失败也要还原
      writeFileSync(resolvedPath, JSON.stringify({
        opus: [],
        sonnet: [],
        haiku: [{ provider: "fast", id: "flash", name: "Flash", reasoning: false }],
      }));
    }
  });

  it("连续 3 次空正文：预算逐级放大到第 4 次，展示第 4 次正文且不 warn", async () => {
    const test = makeExtension(undefined, ["", "", "", "最后一次拿到的正文。"]);
    const warns = spyWarn();
    try {
      fire(test, "session_start", { reason: "startup" });
      fire(test, "message_end", { type: "message_end" });
      const lines = await waitForWidget(test);
      assert.equal(test.getCompleteCount(), 4);
      assert.deepEqual(test.completeOptions.map((opts) => opts?.maxTokens), [256, 1024, 4096, 4096]);
      assert.ok(lines.some((line) => line.includes("最后一次拿到的正文。")), JSON.stringify(lines));
      assert.equal(lines.some((line) => line.includes("模型未返回有效内容")), false);
      assert.deepEqual(warns.calls, [], "中间某次为空不得 warn");
    } finally {
      warns.restore();
      fire(test, "session_shutdown", { reason: "quit" });
    }
  });

  it("4 次全空：failure widget + 恰好一条汇总 warn（含预算序列）", async () => {
    const test = makeExtension(undefined, ["", "", "", ""]);
    const warns = spyWarn();
    try {
      fire(test, "session_start", { reason: "startup" });
      fire(test, "message_end", { type: "message_end" });
      const lines = await waitForWidget(test);
      assert.equal(test.getCompleteCount(), 4);
      assert.deepEqual(test.completeOptions.map((opts) => opts?.maxTokens), [256, 1024, 4096, 4096]);
      assert.ok(lines.some((line) => line.includes("模型未返回有效内容")), JSON.stringify(lines));
      assert.equal(warns.calls.length, 1, JSON.stringify(warns.calls));
      assert.ok(warns.calls[0].includes("256/1024/4096/4096"), warns.calls[0]);
    } finally {
      warns.restore();
      fire(test, "session_shutdown", { reason: "quit" });
    }
  });

  it("超长多行正文：按 3 行硬截断并追加标记", async () => {
    const source = Array.from({ length: 12 }, (_, i) => `第${i + 1}行短内容`).join("\n");
    const test = makeExtension(undefined, [source]);
    fire(test, "session_start", { reason: "startup" });
    fire(test, "message_end", { type: "message_end" });
    await waitForWidget(test);
    const bodyLines = widgetBody(test);
    assert.equal(bodyLines.length, 3, JSON.stringify(bodyLines));
    assert.equal(
      bodyLines.join("\n").replace("…（已截断）", ""),
      Array.from({ length: 3 }, (_, i) => `第${i + 1}行短内容`).join("\n"),
    );
    fire(test, "session_shutdown", { reason: "quit" });
  });

  it("单行超长正文：按 160 字符硬截断并追加标记", async () => {
    const test = makeExtension(undefined, ["长".repeat(400)]);
    fire(test, "session_start", { reason: "startup" });
    fire(test, "message_end", { type: "message_end" });
    await waitForWidget(test);
    const bodyLines = widgetBody(test);
    assert.equal(bodyLines.length, 1);
    const body = bodyLines[0].replace("…（已截断）", "");
    assert.equal(bodyLines[0].includes("…（已截断）"), true);
    assert.equal(body.length, 160, `字符数 ${body.length}`);
    fire(test, "session_shutdown", { reason: "quit" });
  });

  it("恰在边界内（3 行 / 160 字符）：不截断、不加标记", async () => {
    const exact = ["长".repeat(80), "长".repeat(79)].join("\n");
    assert.equal(exact.length, 160);
    const test = makeExtension(undefined, [exact]);
    fire(test, "session_start", { reason: "startup" });
    fire(test, "message_end", { type: "message_end" });
    await waitForWidget(test);
    const bodyLines = widgetBody(test);
    assert.equal(bodyLines.length, 2, JSON.stringify(bodyLines));
    assert.equal(bodyLines.join("\n"), exact);
    assert.equal(bodyLines.some((line) => line.includes("…（已截断）")), false);
    fire(test, "session_shutdown", { reason: "quit" });
  });
});
