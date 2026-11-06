import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import { Effect, Exit, Cause, Option } from "effect";
import {
  indexPath,
  loadIndex,
  mergeIntoIndex,
  pendingForIndex,
  runIndexerPass,
  writeIndexAtomic,
  INDEX_VERSION,
  type IndexRecord,
} from "../../extensions/hpl-find-session/indexer.js";
import {
  appendCompletionEvent,
  readCompletionEventsSince,
  nextEventId,
  requestRebuild,
  consumeRebuildRequests,
} from "../../extensions/hpl-find-session/coordination.js";
import { buildSessionDigest, segmentEntries } from "../../extensions/hpl-find-session/digest.js";
import { readSessionEntries, type SessionExcerpt } from "../../extensions/hpl-find-session/index-core.js";
import type { ModelDeps } from "../../extensions/hpl-find-session/rank.js";

const NOW = 1_800_000_000_000;
const QUIET = 10 * 60 * 1000;
const MODEL = { provider: "p", id: "m", name: "M" };

function excerpt(path: string, first = "用户首句"): SessionExcerpt {
  return {
    path, id: "id", cwd: "~/p", name: "", created: "2026-11-06T10:00:00Z",
    modified: "2026-11-06T11:00:00Z", messageCount: 3, firstUser: first, lastUser: "末句", sizeBytes: 100,
  };
}

function record(path: string, mtimeMs: number, summary = "总结"): IndexRecord {
  return { excerpt: excerpt(path), mtimeMs, summary };
}

/** 模型依赖：systemPrompt 区分分段/合并调用，按 scripted 返回文本。 */
function jsonlDeps(scripted: (systemPrompt: string, userPrompt: string) => string): ModelDeps {
  return {
    available: [MODEL],
    currentModel: undefined,
    resolvedTiers: { opus: [], sonnet: [], haiku: [{ provider: "p", id: "m" }] },
    complete: async (_model, messages, systemPrompt) => ({
      content: scripted(systemPrompt, messages.map((m) => m.content).join("\n")),
    }),
  };
}

const SEGMENT_MARKER = "连续一段消息";

/** 断言 Effect 失败并返回类型化错误。 */
async function expectFailure(effect: Effect.Effect<unknown, unknown>, check: (error: { _tag?: string; cause?: unknown }) => boolean): Promise<void> {
  const exit = await Effect.runPromiseExit(effect);
  assert.ok(Exit.isFailure(exit), "期望失败但成功了");
  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause)) as { _tag?: string; cause?: unknown } | undefined;
  assert.ok(failure && check(failure), `失败类型不符：${JSON.stringify(failure)}`);
}

function writeSession(dir: string, file: string, lines: Array<Record<string, unknown>>): string {
  const path = join(dir, file);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

function sessionFixture(messages: Array<{ role: string; text: string }>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [
    { type: "session", id: "s1", timestamp: "2026-11-06T10:00:00.000Z", cwd: "/p" },
  ];
  messages.forEach((m, i) => {
    out.push({
      type: "message",
      id: `msg${i}`,
      timestamp: `2026-11-06T10:0${i % 10}:00.000Z`,
      message: {
        role: m.role,
        content: m.role === "toolResult" ? [{ type: "text", text: m.text }] : m.text,
      },
    });
  });
  return out;
}

function longMessages(count: number): Array<{ role: string; text: string }> {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    text: `消息${i}：${"内容".repeat(400)}`,
  }));
}

describe("readSessionEntries：全量消息与证据定位", () => {
  const dir = mkdtempSync(join(tmpdir(), "fs-read-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("读取全部 user/assistant/toolResult，带行号/id/截断标记，不只首末", async () => {
    const path = writeSession(dir, "a.jsonl", sessionFixture([
      { role: "user", text: "第一个问题" },
      { role: "assistant", text: "中间回答" },
      { role: "user", text: "第二个问题" },
      { role: "toolResult", text: "x".repeat(3000) },
      { role: "user", text: "最后一个问题" },
    ]));
    const entries = await readSessionEntries(path);
    assert.ok(entries);
    assert.equal(entries.length, 5);
    assert.ok(entries.some((e) => e.text === "中间回答"), "中段消息在场");
    assert.ok(entries.every((e) => e.line > 0 && e.id.startsWith("msg")));
    const tool = entries.find((e) => e.role === "toolResult")!;
    assert.equal(tool.truncated, true);
    assert.equal(tool.text.length, 2000);
  });

  it("assistant thinking 块被排除，正文 text 保留", async () => {
    const path = join(dir, "b.jsonl");
    writeFileSync(path, [
      JSON.stringify({ type: "session", id: "s2", timestamp: "2026-11-06T10:00:00.000Z", cwd: "/p" }),
      JSON.stringify({ type: "message", id: "m0", timestamp: "2026-11-06T10:01:00.000Z", message: { role: "assistant", content: [{ type: "thinking", text: "内部草稿" }, { type: "text", text: "正式回答" }] } }),
    ].join("\n") + "\n");
    const entries = await readSessionEntries(path);
    assert.ok(entries);
    assert.equal(entries.length, 1);
    assert.ok(entries[0]!.text.includes("正式回答"));
    assert.ok(!entries[0]!.text.includes("内部草稿"));
  });
});

describe("segmentEntries：长会话有界分段", () => {
  it("按字符预算顺序切段，覆盖全部消息", () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      line: i + 2, id: `m${i}`, role: "user" as const, timestamp: "", text: "字".repeat(2000), truncated: false, toolCallIds: [] as string[], toolCallId: "",
    }));
    const segments = segmentEntries(entries);
    assert.ok(segments.length >= 5);
    assert.deepEqual(segments.flat(), entries);
  });
});

describe("buildSessionDigest：分段总结、逐批保存、续建、文件变化", () => {
  const dir = mkdtempSync(join(tmpdir(), "fs-digest-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("长会话分段调用模型再合并；进度逐段落盘；二次构建全走缓存", async () => {
    const path = writeSession(dir, "big.jsonl", sessionFixture(longMessages(20)));
    const stats = statSync(path);
    let segments = 0;
    const deps = jsonlDeps((system) => {
      if (system.includes(SEGMENT_MARKER)) { segments++; return `段${segments}小结`; }
      return "最终摘要：主题修坑；结论已交付；未解决无；证据见行12";
    });
    const outcome = await Effect.runPromise(buildSessionDigest(path, stats.size, dir, deps, MODEL));
    assert.ok(outcome.segments >= 3);
    assert.ok(outcome.summary.startsWith("最终摘要"));
    const progressDir = join(dir, ".digest-progress");
    const progress = JSON.parse(readFileSync(join(progressDir, readdirSync(progressDir)[0]!), "utf8"));
    assert.equal(progress.segmentSummaries.length, outcome.segments);
    assert.ok(progress.digest);
    // 二次构建：命中缓存，不再调用模型
    const callsAfterFirst = segments;
    const again = await Effect.runPromise(buildSessionDigest(path, stats.size, dir, deps, MODEL));
    assert.equal(again.summary, outcome.summary);
    assert.equal(segments, callsAfterFirst);
  });

  it("崩溃续建：中断前已保存段不重算，续建只调剩余段 + 合并", async () => {
    const path = writeSession(dir, "resume.jsonl", sessionFixture(longMessages(20)));
    const stats = statSync(path);
    const totalSegments = segmentEntries((await readSessionEntries(path))!).length;
    let calls = 0;
    const failingDeps = jsonlDeps((system) => {
      if (system.includes(SEGMENT_MARKER)) {
        calls++;
        if (calls === 2) throw new Error("模型调用中断");
        return `段${calls}小结`;
      }
      return "合并摘要";
    });
    const first = buildSessionDigest(path, stats.size, dir, failingDeps, MODEL);
    await expectFailure(first, (error) => error._tag === "DigestModelError" && String(error.cause).includes("模型调用中断"));
    const progressDir = join(dir, ".digest-progress");
    const saved = JSON.parse(readFileSync(
      join(progressDir, readdirSync(progressDir).find((f) => readFileSync(join(progressDir, f), "utf8").includes("resume.jsonl"))!),
      "utf8"));
    const savedSegments = saved.segmentSummaries.length;
    assert.equal(savedSegments, 1, "第 2 段失败前已保存第 1 段");
    // 续建：只调剩余段
    let resumeCalls = 0;
    const resumeDeps = jsonlDeps((system) => {
      if (system.includes(SEGMENT_MARKER)) { resumeCalls++; return `续建段${resumeCalls}`; }
      return "续建合并摘要";
    });
    const done = await Effect.runPromise(buildSessionDigest(path, stats.size, dir, resumeDeps, MODEL));
    assert.equal(done.summary, "续建合并摘要");
    assert.equal(resumeCalls, totalSegments - savedSegments);
  });

  it("建索引期间文件被修改：报 DigestFileError，不留进度", async () => {
    const path = writeSession(dir, "moving.jsonl", sessionFixture([{ role: "user", text: "问题" }]));
    const stats = statSync(path);
    const deps = jsonlDeps(() => "摘要");
    // 先启动 Effect（读文件是异步的），再在摘要期间改 mtime，模拟建索引时文件被写
    const exit = Effect.runPromiseExit(buildSessionDigest(path, stats.size, dir, deps, MODEL));
    utimesSync(path, new Date(stats.mtimeMs + 5000), new Date(stats.mtimeMs + 5000));
    const result = await exit;
    assert.ok(Exit.isFailure(result), "期望失败但成功了");
    const failure = Option.getOrUndefined(Cause.failureOption(result.cause)) as { _tag?: string } | undefined;
    assert.equal(failure?._tag, "DigestFileError");
  });
});

describe("pendingForIndex 与补建请求", () => {
  it("安静门 + 请求路径不受安静门限制", () => {
    const files = [
      { path: "quiet-stale", mtimeMs: NOW - 2 * QUIET, sizeBytes: 1 },
      { path: "active", mtimeMs: NOW - QUIET / 2, sizeBytes: 1 },
    ];
    const pending = pendingForIndex(files, new Map(), NOW, ["active"]);
    assert.deepEqual(pending.map((f) => f.path).sort(), ["active", "quiet-stale"]);
    const index = new Map([["active", record("active", NOW - QUIET / 2)]]);
    assert.deepEqual(pendingForIndex(files, index, NOW, ["active"]).map((f) => f.path), ["quiet-stale"]);
  });

  it("v1 旧缓存直接作废重建", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-v1-"));
    try {
      writeFileSync(indexPath(dir), JSON.stringify({ version: 1, records: { a: { excerpt: excerpt("a"), mtimeMs: 1, summary: "旧80字" } } }));
      assert.equal(loadIndex(dir).size, 0);
      assert.equal(INDEX_VERSION, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mergeIntoIndex 写前重读，不覆盖他人并发写入", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-merge-"));
    try {
      writeIndexAtomic(dir, new Map([["other", record("other", 1)]]));
      mergeIntoIndex(dir, new Map([["mine", record("mine", 2)]]));
      const loaded = loadIndex(dir);
      assert.ok(loaded.has("other") && loaded.has("mine"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requestRebuild 消费后队列清空", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-req-"));
    try {
      requestRebuild(dir, ["/a", "/b", "/a"]);
      assert.deepEqual(consumeRebuildRequests(dir).sort(), ["/a", "/b"]);
      assert.deepEqual(consumeRebuildRequests(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("完成事件：单条最新、baseline 过滤、id 去重", () => {
  const dir = mkdtempSync(join(tmpdir(), "fs-events-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("只保留单条最新事件；baseline 之后才可读；id 供去重", () => {
    appendCompletionEvent(dir, { id: nextEventId(), ts: 100, scanned: 1, added: 1, updated: 0, failed: 0, remaining: 0, indexedTotal: 1, totalFiles: 1 });
    appendCompletionEvent(dir, { id: nextEventId(), ts: 200, scanned: 2, added: 1, updated: 1, failed: 0, remaining: 0, indexedTotal: 2, totalFiles: 2 });
    // 单条最新：旧事件被覆盖，只剩 ts=200 这条
    const latest = readCompletionEventsSince(dir, 0);
    assert.equal(latest.length, 1);
    assert.equal(latest[0]!.ts, 200);
    assert.equal(latest[0]!.scanned, 2);
    // baseline 在最新事件之后：不可读（初次启动不重播）
    assert.deepEqual(readCompletionEventsSince(dir, 200), []);
    assert.equal(latest.every((e) => typeof e.id === "string" && e.id.length > 0), true);
  });
});

describe("runIndexerPass：digest 驱动 + 事件统计", () => {
  const dir = mkdtempSync(join(tmpdir(), "fs-pass-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("建索引写缓存并追加完成事件；解析失败计入 failed 不中断", async () => {
    const good = writeSession(dir, "good.jsonl", sessionFixture([{ role: "user", text: "修一个坑" }]));
    const bad = join(dir, "bad.jsonl");
    writeFileSync(bad, "not json at all\n");
    utimesSync(good, new Date(NOW - QUIET - 1), new Date(NOW - QUIET - 1));
    utimesSync(bad, new Date(NOW - QUIET - 1), new Date(NOW - QUIET - 1));
    const files = [
      { path: good, mtimeMs: NOW - QUIET - 1, sizeBytes: statSync(good).size },
      { path: bad, mtimeMs: NOW - QUIET - 1, sizeBytes: 16 },
    ];
    let modelCalls = 0;
    const deps = jsonlDeps(() => { modelCalls++; return `摘要${modelCalls}`; });
    const stats = await Effect.runPromise(runIndexerPass(dir, files, deps, NOW));
    assert.equal(stats.added, 1);
    assert.equal(stats.failed, 1);
    assert.ok(stats.failureCause);
    const index = loadIndex(dir);
    assert.ok(index.get(good)?.summary.startsWith("摘要"));
    assert.ok(stats.noModel === false);
    const events = readCompletionEventsSince(dir, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.added, 1);
    assert.equal(events[0]!.failureCause !== undefined, true);
  });
});
