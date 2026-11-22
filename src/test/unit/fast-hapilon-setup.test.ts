import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { parseRecommendation, recommendTiers, type Candidate } from "../../extensions/hpl-fast-hapilon-setup/recommend.js";

const candidates: Candidate[] = [
  { model: "probe/gpt-6.1", name: "6.1", thinking: ["off", "medium", "high"] },
  { model: "probe/gpt-6.2", name: "6.2", thinking: ["off"] },
];
const first = { model: "probe/gpt-6.1", thinking: "high", reason: "复杂任务" };
const second = { model: "probe/gpt-6.2", thinking: "off", reason: "快速任务" };
const third = { model: "probe/compact", thinking: "off", reason: "日常任务" };
const two = { opus: [first, second], sonnet: [first, second], haiku: [second, first] };
const expanded: Candidate[] = [
  ...candidates,
  { model: third.model, name: "Compact", thinking: ["off"] },
  { model: "mirror/gpt-6.1", name: "6.1", thinking: ["off"] },
];
const three = { opus: [...two.opus, third], sonnet: [...two.sonnet, third], haiku: [...two.haiku, third] };

function assertRejected(output: unknown, available: readonly Candidate[] = candidates) {
  const result = Effect.runSync(Effect.either(parseRecommendation(JSON.stringify(output), available)));
  assert.equal(result._tag, "Left");
}

test("模型不足三种时推荐每个版本，不靠不同思考强度凑数", () => {
  const output = `\`\`\`json\n${JSON.stringify(two)}\n\`\`\``;
  assert.deepEqual(Effect.runSync(parseRecommendation(output, candidates)), two);
  assertRejected({ ...two, opus: [first, { ...first, thinking: "medium" }] });
});

test("至少有三种模型时，每档正好三项、保留顺序，同型号跨供应商不重复", () => {
  assert.deepEqual(Effect.runSync(parseRecommendation(JSON.stringify(three), expanded)), three);
  assertRejected(two, expanded);
  assertRejected({ ...three, opus: [...two.opus, { ...third, model: "mirror/gpt-6.1" }] }, expanded);
});

test("拒绝未知模型、不支持的思考强度或缺少档位", () => {
  assertRejected({ ...two, haiku: [{ ...second, model: "other/fast" }, first] });
  assertRejected({ ...two, haiku: [{ ...second, thinking: "high" }, first] });
  assertRejected({ opus: two.opus, sonnet: two.sonnet });
});

const search = { type: "tool_execution_end", toolName: "web_search", isError: false, result: { details: { totalResults: 1 } } };
const answer = { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(two) }] } };

function withPrintFixture(t: import("node:test").TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "hapi-print-recommendation-"));
  const cli = join(cwd, "print.cjs");
  const previous = process.env.HAPILON_CLI_PATH;
  process.env.HAPILON_CLI_PATH = cli;
  t.after(() => {
    if (previous === undefined) delete process.env.HAPILON_CLI_PATH;
    else process.env.HAPILON_CLI_PATH = previous;
    rmSync(cwd, { recursive: true, force: true });
  });
  return (program: string, signal = new AbortController().signal) => {
    writeFileSync(cli, program);
    return Effect.runPromise(Effect.either(recommendTiers({ cwd, signal, model: { provider: "probe", id: "gpt-6.1" }, candidates })));
  };
}

const emit = (...events: unknown[]) => `process.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join("\n"))});`;

test("PRINT 跳过超过旧上限的中间事件，仍读取最后一行推荐", async (t) => {
  const print = withPrintFixture(t);
  const fixture = `const event = JSON.stringify({type: "message_update", text: "长".repeat(8000)}) + "\\n";
    for (let i = 0; i < 30; i++) process.stdout.write(event);`;
  const result = await print(fixture + emit(search, answer));
  if (result._tag === "Left") assert.fail(result.left.message);
  assert.deepEqual(result.right, two);
});

test("PRINT 必须搜索到资料、正常退出并返回最终推荐", async (t) => {
  const print = withPrintFixture(t);
  for (const program of [
    emit(answer),
    emit({ ...search, isError: true }, answer),
    emit({ ...search, result: { details: { totalResults: 0 } } }, answer),
    emit(search, answer, { ...answer, message: { ...answer.message, stopReason: "error" } }),
    emit(search, answer) + "process.exitCode = 1;",
  ]) {
    assert.equal((await print(program))._tag, "Left");
  }
});

test("PRINT 取消后不返回推荐", async (t) => {
  const print = withPrintFixture(t);
  const abort = new AbortController();
  const result = print(emit(search, answer) + "setInterval(() => {}, 1000);", abort.signal);
  abort.abort();
  const cancelled = await result;
  assert.equal(cancelled._tag, "Left");
  if (cancelled._tag === "Left") assert.match(cancelled.left.message, /已取消/);
});
