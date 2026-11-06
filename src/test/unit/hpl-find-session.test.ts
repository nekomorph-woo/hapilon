import { after, describe, it } from "node:test";
import { Effect, Exit, Cause, Option } from "effect";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanUserText,
  grepSessions,
  parseSessionFile,
  prefilter,
  scanSessions,
  listSessionFiles,
  tokenizeQuery,
  type SessionExcerpt,
} from "../../extensions/hpl-find-session/index-core.js";
import { fallbackSummary, parseRankedJson, rankEntries, type ModelDeps, type RankedEntry } from "../../extensions/hpl-find-session/rank.js";
import { writeIndexAtomic, type IndexRecord } from "../../extensions/hpl-find-session/indexer.js";
import { searchIndexedSessions, type QueryStatus } from "../../extensions/hpl-find-session/query.js";

const MODEL = { provider: "p", id: "m", name: "M" };

function writeSession(root: string, dir: string, file: string, lines: Array<Record<string, unknown>>): string {
  const sub = join(root, dir);
  mkdirSync(sub, { recursive: true });
  const path = join(sub, file);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

function entryFixture(overrides: Partial<SessionExcerpt> = {}): SessionExcerpt {
  return {
    path: "/tmp/s.jsonl",
    id: "id-1",
    cwd: "/Volumes/Under_M2/morphiiouo/hapilon",
    name: "",
    created: "2026-11-01T00:00:00.000Z",
    modified: "2026-11-01T01:00:00.000Z",
    messageCount: 5,
    firstUser: "帮我修 tsx 跑法坑",
    lastUser: "谢谢",
    sizeBytes: 100,
    ...overrides,
  };
}

describe("cleanUserText", () => {
  it("去掉 acp 标签与 skill XML 包裹", () => {
    const text = cleanUserText('<skill name="ask">内容</skill>\n<acp tokens="1" type="text">m1</acp>你好');
    assert.equal(text, "内容 你好");
  });
});

describe("parseSessionFile / scanSessions", () => {
  const root = mkdtempSync(join(tmpdir(), "hpl-find-session-"));

  it("解析 header、名字、首末用户消息并跳过空文件", async () => {
    writeSession(root, "dirA", "a.jsonl", [
      { type: "session", id: "aaa", timestamp: "2026-11-01T00:00:00.000Z", cwd: "/proj/x" },
      { type: "session_info", name: "发版脚本" },
      { type: "message", timestamp: "2026-11-01T00:01:00.000Z", message: { role: "system", content: "sys" } },
      { type: "message", timestamp: "2026-11-01T00:02:00.000Z", message: { role: "user", content: "第一个问题" } },
      { type: "message", timestamp: "2026-11-01T00:03:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "回答" }] } },
      { type: "message", timestamp: "2026-11-01T00:04:00.000Z", message: { role: "user", content: "最后一个问题" } },
    ]);
    writeSession(root, "dirA", "empty.jsonl", []);
    const entries = await scanSessions(root);
    assert.equal(entries.length, 1);
    const e = entries[0]!;
    assert.equal(e.id, "aaa");
    assert.equal(e.name, "发版脚本");
    assert.equal(e.firstUser, "第一个问题");
    assert.equal(e.lastUser, "最后一个问题");
    assert.equal(e.modified, "2026-11-01T00:04:00.000Z");
  });

  it("不存在的目录返回空", () => {
    assert.deepEqual(listSessionFiles(join(root, "nope")), []);
  });

  it("损坏行被跳过不炸", async () => {
    const sub = join(root, "dirB");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "broken.jsonl"), '{"type":"session","id":"b"\nnot-json\n');
    const parsed = await parseSessionFile(join(sub, "broken.jsonl"), 10);
    assert.equal(parsed, null);
  });

  after(() => rmSync(root, { recursive: true, force: true }));
});

describe("tokenizeQuery / prefilter：中文自然句命中", () => {
  it("中文查询产出整词与二字组", () => {
    const terms = tokenizeQuery("修复登录超时的坑");
    assert.ok(terms.includes("登录超时") || terms.includes("登录"), `terms=${terms.join(",")}`);
    assert.ok(terms.includes("登录") && terms.includes("超时"));
  });

  it("中文自然句能命中摘要字段（不靠空格切词）", () => {
    const entries = [
      entryFixture({ path: "/1", firstUser: "随便聊聊" }),
      entryFixture({ path: "/2", firstUser: "修复登录超时的坑", lastUser: "搞定了" }),
    ];
    assert.deepEqual(prefilter(entries, "登录超时怎么修").map((e) => e.path), ["/2"]);
    assert.deepEqual(prefilter(entries, "不存在词"), []);
    assert.equal(prefilter(entries, "").length, 2);
  });

  it("拉丁词命中不变", () => {
    const entries = [entryFixture({ path: "/1", firstUser: "修复 tsx 坑" })];
    assert.deepEqual(prefilter(entries, "tsx").map((e) => e.path), ["/1"]);
  });
});

describe("grepSessions", () => {
  const root = mkdtempSync(join(tmpdir(), "hpl-find-session-grep-"));
  writeSession(root, "dirC", "c.jsonl", [
    { type: "session", id: "ccc", timestamp: "2026-11-01T00:00:00.000Z", cwd: "/proj/y" },
    { type: "message", timestamp: "2026-11-01T00:01:00.000Z", message: { role: "user", content: "我们讨论过 release-notes 生成器" } },
  ]);
  it("命中返回片段", async () => {
    const { hits, truncated } = await grepSessions(root, "release-notes");
    assert.equal(truncated, false);
    assert.equal(hits.length, 1);
    assert.ok(hits[0]!.snippet.includes("release-notes"));
  });
  it("无效正则抛错", async () => {
    await assert.rejects(() => grepSessions(root, "(["), /正则无效/);
  });
  after(() => rmSync(root, { recursive: true, force: true }));
});

describe("parseRankedJson", () => {
  it("解析带围栏的 JSON", () => {
    const out = parseRankedJson('```json\n[{"i":0,"s":"修坑会话"}]\n```');
    assert.deepEqual(out, [{ index: 0, summary: "修坑会话" }]);
  });
  it("非 JSON / 缺字段返回空", () => {
    assert.deepEqual(parseRankedJson("我觉得没有相关会话"), []);
    assert.deepEqual(parseRankedJson('[{"s":"无编号"}]'), []);
  });
});

function rankedCandidates(entries: SessionExcerpt[], summary = "缓存摘要"): RankedEntry[] {
  return entries.map((entry) => ({ entry, summary }));
}

describe("rankEntries：无匹配 / 无效 / 失败 / 档位回退分离", () => {
  const deps = (handler: () => string | Promise<string> | null, haiku = true): ModelDeps => ({
    available: [MODEL],
    currentModel: undefined,
    resolvedTiers: haiku ? { opus: [], sonnet: [], haiku: [{ provider: "p", id: "m" }] } : { opus: [], sonnet: [], haiku: [], },
    complete: async () => {
      const text = await handler();
      if (text === null) throw new Error("网络错误 boom");
      return { content: text };
    },
  });
  const candidates = rankedCandidates([entryFixture({ path: "/1" }), entryFixture({ path: "/2", firstUser: "发版脚本问题" })]);

  it("按模型顺序重排；模型返回 [] 判定无匹配（不再宁滥勿缺）", async () => {
    const noMatch = await rankEntries("发版", candidates, deps(() => "[]"));
    assert.equal(noMatch.noMatch, true);
    assert.deepEqual(noMatch.ranked, []);
    assert.equal(noMatch.modelError, undefined, "无匹配不是失败");
    const ok = await rankEntries("发版", candidates, deps(() => '[{"i":1,"s":"讨论发版脚本"},{"i":0,"s":"修坑"}]'));
    assert.equal(ok.noMatch, false);
    assert.deepEqual(ok.ranked.map((r) => r.entry.path), ["/2", "/1"]);
  });

  it("模型调用失败：modelError 带真实原因，回落关键词序兜底", async () => {
    const out = await rankEntries("发版", candidates, deps(() => null));
    assert.equal(out.modelError, "网络错误 boom");
    assert.equal(out.degraded, false, "调用失败不是档位回退");
    assert.deepEqual(out.ranked.map((r) => r.entry.path), ["/1", "/2"]);
    assert.equal(out.ranked[0]!.summary, fallbackSummary(candidates[0]!.entry));
  });

  it("模型输出编号全无效：按失败处理并说明原因", async () => {
    const out = await rankEntries("发版", candidates, deps(() => '[{"i":99,"s":"越界"}]'));
    assert.equal(out.modelError, "模型输出越界候选编号（候选共 2 条）");
    assert.deepEqual(out.ranked.map((r) => r.entry.path), ["/1", "/2"]);
  });

  it("档位回退（haiku 缺失落到当前模型）：degraded=true 但排序照常，不是失败", async () => {
    const out = await rankEntries("发版", candidates, {
      available: [MODEL],
      currentModel: MODEL,
      resolvedTiers: { opus: [], sonnet: [], haiku: [] },
      complete: async () => ({ content: '[{"i":1,"s":"发版讨论"}]' }),
    });
    assert.equal(out.degraded, true);
    assert.equal(out.modelError, undefined);
    assert.deepEqual(out.ranked.map((r) => r.entry.path), ["/2"]);
  });

  it("无可用模型：报错原因，不冒充回答", async () => {
    const out = await rankEntries("发版", candidates, {
      available: [], currentModel: undefined,
      resolvedTiers: { opus: [], sonnet: [], haiku: [] },
      complete: async () => ({}),
    });
    assert.ok(out.modelError);
    assert.ok(out.modelError.includes("无可用模型"));
  });
});

// ── 查询管线（只读缓存） ─────────────────────────────────────────────

interface ScriptedCall { system: string; user: string }

function queryDeps(respond: (call: ScriptedCall) => string, log: ScriptedCall[]): ModelDeps {
  return {
    available: [MODEL],
    currentModel: undefined,
    resolvedTiers: { opus: [], sonnet: [], haiku: [{ provider: "p", id: "m" }] },
    complete: async (_model, messages, systemPrompt) => {
      const call = { system: systemPrompt, user: messages.map((m) => m.content).join("\n") };
      log.push(call);
      return { content: respond(call) };
    },
  };
}

function seedIndex(root: string, records: Array<{ path: string; summary: string; firstUser: string; modified: string; mtimeMs: number }>): void {
  const map = new Map<string, IndexRecord>();
  for (const r of records) {
    map.set(r.path, { excerpt: entryFixture({ path: r.path, firstUser: r.firstUser, modified: r.modified }), mtimeMs: r.mtimeMs, summary: r.summary });
  }
  writeIndexAtomic(root, map);
}

/** 断言 Effect 失败并返回类型化错误（与 find-session-indexer.test.ts 同款 helper）。 */
async function expectQueryFailure(effect: Effect.Effect<unknown, unknown>, check: (error: { _tag?: string; stage?: string; cause?: unknown }) => boolean): Promise<void> {
  const exit = await Effect.runPromiseExit(effect);
  assert.ok(Exit.isFailure(exit), "期望失败但成功了");
  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause)) as { _tag?: string; stage?: string; cause?: unknown } | undefined;
  assert.ok(failure && check(failure), `失败类型不符：${JSON.stringify(failure)}`);
}

describe("searchIndexedSessions：typed 失败 / 停用词 / 覆盖 / 截取 / 证据", () => {
  const root = mkdtempSync(join(tmpdir(), "fs-query-"));
  const sessDir = join(root, "s");
  mkdirSync(sessDir, { recursive: true });

  const fileA = join(sessDir, "a.jsonl"); // 登录超时会话：assistant 发起 toolCall，toolResult 验证
  writeFileSync(fileA, [
    JSON.stringify({ type: "session", id: "a", timestamp: "2026-11-01T00:00:00.000Z", cwd: "/p" }),
    JSON.stringify({ type: "message", id: "m0", timestamp: "2026-11-01T00:01:00.000Z", message: { role: "user", content: "修复登录超时的坑" } }),
    JSON.stringify({ type: "message", id: "m1", timestamp: "2026-11-01T00:02:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call1" }, { type: "text", text: "先查限流日志" }] } }),
    JSON.stringify({ type: "message", id: "m2", timestamp: "2026-11-01T00:03:00.000Z", message: { role: "toolResult", toolCallId: "call1", content: [{ type: "text", text: "验证结果：命中限流规则" }] } }),
    JSON.stringify({ type: "message", id: "m3", timestamp: "2026-11-01T00:04:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "结论：不是超时，是限流，已用日志验证" }] } }),
  ].join("\n") + "\n");
  const fileB = join(sessDir, "b.jsonl"); // 发版脚本会话
  writeFileSync(fileB, [
    JSON.stringify({ type: "session", id: "b", timestamp: "2026-11-02T00:00:00.000Z", cwd: "/q" }),
    JSON.stringify({ type: "message", id: "n0", timestamp: "2026-11-02T00:01:00.000Z", message: { role: "user", content: "写发版脚本" } }),
  ].join("\n") + "\n");
  const fileGone = join(sessDir, "gone.jsonl"); // 磁盘已删除但缓存还在
  const fileC = join(sessDir, "c.jsonl"); // 磁盘在但未索引（未覆盖）
  writeFileSync(fileC, [
    JSON.stringify({ type: "session", id: "c", timestamp: "2026-11-03T00:00:00.000Z", cwd: "/r" }),
    JSON.stringify({ type: "message", id: "c0", timestamp: "2026-11-03T00:01:00.000Z", message: { role: "user", content: "未索引会话" } }),
  ].join("\n") + "\n");

  seedIndex(root, [
    { path: fileA, summary: "修复登录超时问题，结论是限流；证据见行4", firstUser: "修复登录超时的坑", modified: "2026-11-01T01:00:00.000Z", mtimeMs: statSync(fileA).mtimeMs },
    { path: fileB, summary: "编写发布脚本与 tag 流程", firstUser: "写发版脚本", modified: "2026-11-02T01:00:00.000Z", mtimeMs: statSync(fileB).mtimeMs },
    { path: fileGone, summary: "已被删除的会话摘要", firstUser: "不存在了", modified: "2026-11-03T01:00:00.000Z", mtimeMs: 1 },
  ]);

  it("中文自然句（含通用词）只命中信息词：「帮我找到之前修锁的会话」不命中全部", async () => {
    // 修锁记录：单独目录避免污染上面的 seed
    const root2 = mkdtempSync(join(tmpdir(), "fs-query-lock-"));
    const dir2 = join(root2, "s");
    mkdirSync(dir2, { recursive: true });
    const f1 = join(dir2, "lock.jsonl");
    const f2 = join(dir2, "other.jsonl");
    writeFileSync(f1, [
      JSON.stringify({ type: "session", id: "l", timestamp: "2026-11-01T00:00:00.000Z", cwd: "/p" }),
      JSON.stringify({ type: "message", id: "l0", timestamp: "2026-11-01T00:01:00.000Z", message: { role: "user", content: "修索引锁的竞态" } }),
    ].join("\n") + "\n");
    writeFileSync(f2, [
      JSON.stringify({ type: "session", id: "o", timestamp: "2026-11-02T00:00:00.000Z", cwd: "/q" }),
      JSON.stringify({ type: "message", id: "o0", timestamp: "2026-11-02T00:01:00.000Z", message: { role: "user", content: "聊聊天气" } }),
    ].join("\n") + "\n");
    seedIndex(root2, [
      { path: f1, summary: "修复索引锁竞态：心跳续期方案", firstUser: "修索引锁的竞态", modified: "2026-11-01T01:00:00.000Z", mtimeMs: statSync(f1).mtimeMs },
      { path: f2, summary: "闲聊天气记录", firstUser: "聊聊天气", modified: "2026-11-02T01:00:00.000Z", mtimeMs: statSync(f2).mtimeMs },
    ]);
    const calls: ScriptedCall[] = [];
    const deps = queryDeps((call) => {
      if (call.system.includes("挑出与描述相关")) return '[{"i":0,"s":"锁竞态回答"}]';
      return "锁竞态修复回答。";
    }, calls);
    const result = await Effect.runPromise(searchIndexedSessions("帮我找到之前修锁的会话", deps, root2));
    assert.equal(result.status.expanded, false, "信息词「修锁」应本地命中，不扩大");
    assert.equal(result.ranked.length, 1);
    assert.equal(result.ranked[0]!.entry.path, f1);
    rmSync(root2, { recursive: true, force: true });
  });

  it("按摘要行号引用回读证据并关联 toolCallId；工具截断计数进状态", async () => {
    const calls: ScriptedCall[] = [];
    const deps = queryDeps((call) => {
      if (call.system.includes("挑出与描述相关")) return '[{"i":0,"s":"修坑回答"}]';
      return "用户请求修登录超时；会话定位到限流（宣称）；行4 工具结果已验证。";
    }, calls);
    const result = await Effect.runPromise(searchIndexedSessions("登录超时怎么修的", deps, root));
    const answerCall = calls.find((c) => c.system.includes("原始消息证据"));
    assert.ok(answerCall, "回答阶段带证据");
    assert.ok(answerCall.user.includes("行4"), `按摘要引用回读行4：${answerCall.user.slice(0, 200)}`);
    assert.ok(answerCall.user.includes("验证结果：命中限流规则"), "toolResult 正文在场");
    assert.ok(answerCall.user.includes("先查限流日志"), "toolCallId 关联的发起 assistant 消息在场");
    assert.equal(result.ranked.length, 1);
    assert.ok(result.ranked[0]!.summary.includes("限流"));
  });

  it("摘要无行号引用：诚实标注 evidenceMissing，不把截断当全部", async () => {
    const root2 = mkdtempSync(join(tmpdir(), "fs-q-missing-"));
    const dir2 = join(root2, "s");
    mkdirSync(dir2, { recursive: true });
    const f1 = join(dir2, "x.jsonl");
    writeFileSync(f1, [
      JSON.stringify({ type: "session", id: "x", timestamp: "2026-11-01T00:00:00.000Z", cwd: "/p" }),
      JSON.stringify({ type: "message", id: "x0", timestamp: "2026-11-01T00:01:00.000Z", message: { role: "user", content: "修复登录超时的坑" } }),
      JSON.stringify({ type: "message", id: "x1", timestamp: "2026-11-01T00:02:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "定位到是限流不是超时，已验证" }] } }),
    ].join("\n") + "\n");
    seedIndex(root2, [
      { path: f1, summary: "修复登录超时问题，结论是限流（摘要未标行号）", firstUser: "修复登录超时的坑", modified: "2026-11-01T01:00:00.000Z", mtimeMs: statSync(f1).mtimeMs },
    ]);
    const calls: ScriptedCall[] = [];
    const deps = queryDeps((call) => {
      if (call.system.includes("挑出与描述相关")) return '[{"i":0,"s":"回答"}]';
      return "限流结论回答。";
    }, calls);
    const result = await Effect.runPromise(searchIndexedSessions("登录超时", deps, root2));
    assert.equal(result.status.evidenceMissing, 1);
    assert.ok(result.ranked[0]!.summary.includes("证据未按行号定位"), `suffix=${result.ranked[0]!.summary}`);
    rmSync(root2, { recursive: true, force: true });
  });

  it("本地无命中→扩大检索；选择越界编号是失败不是无匹配；全部批次失败 typed 报错", async () => {
    // 越界编号：typed expand 失败
    const depsBad = queryDeps(() => '[{"i":99}]', []);
    await expectQueryFailure(
      searchIndexedSessions("完全无关的量子词汇", depsBad, root),
      (e) => e._tag === "QueryModelError" && e.stage === "expand",
    );
    // 模型全部调用失败（如 429）：typed 失败，绝不报 noMatch
    const depsDown: ModelDeps = {
      available: [MODEL], currentModel: undefined,
      resolvedTiers: { opus: [], sonnet: [], haiku: [{ provider: "p", id: "m" }] },
      complete: async () => { throw new Error("429 rate limit"); },
    };
    await expectQueryFailure(
      searchIndexedSessions("完全无关的量子词汇", depsDown, root),
      (e) => e._tag === "QueryModelError" && String(e.cause).includes("429"),
    );
    // 正常扩大检索：modified 降序第 0 位是 fileB
    const calls: ScriptedCall[] = [];
    const deps = queryDeps((call) => {
      if (call.user.startsWith("用户描述：完全无关的量子词汇\n\n候选会话：")) return '[{"i":0}]';
      if (call.system.includes("挑出与描述相关")) return '[{"i":0,"s":"发版脚本回答"}]';
      return "发版脚本会话的针对性回答。";
    }, calls);
    const result = await Effect.runPromise(searchIndexedSessions("完全无关的量子词汇", deps, root));
    assert.equal(result.status.expanded, true);
    assert.equal(result.status.expandedPartial, false);
    assert.equal(result.ranked.length, 1);
    assert.equal(result.ranked[0]!.entry.path, fileB);
  });

  it("全部候选回答失败：typed 失败，不回退伪装回答", async () => {
    const calls: ScriptedCall[] = [];
    const deps = queryDeps((call) => {
      if (call.system.includes("挑出与描述相关")) return '[{"i":0,"s":"ok"}]';
      if (call.system.includes("原始消息证据")) throw new Error("回答阶段模型崩溃");
      return "[]";
    }, calls);
    await expectQueryFailure(
      searchIndexedSessions("登录超时", deps, root),
      (e) => e._tag === "QueryModelError" && e.stage === "answer" && String(e.cause).includes("回答阶段模型崩溃"),
    );
  });

  it("部分候选回答失败：成功条目保留且都证据化，失败计入状态不伪装", async () => {
    const calls: ScriptedCall[] = [];
    let answerCalls = 0;
    const deps = queryDeps((call) => {
      if (call.system.includes("挑出与描述相关")) {
        // 本地命中只有 fileA，一条候选，构造不出部分失败——用扩大检索两条
        return call.user.includes("候选会话：") ? '[{"i":0},{"i":1}]' : '[{"i":0,"s":"a"},{"i":1,"s":"b"}]';
      }
      if (call.system.includes("原始消息证据")) {
        answerCalls++;
        if (answerCalls === 2) throw new Error("第二条回答失败");
        return "证据化回答。";
      }
      return "[]";
    }, calls);
    // 查询词只命中 fileA，先 rank 出 1 条无匹配→扩搜 2 条→rank 选 2 条→回答第 2 条失败
    const result = await Effect.runPromise(searchIndexedSessions("登录超时 发版脚本", deps, root));
    assert.equal(answerCalls >= 2, true);
    assert.ok(result.ranked.every((r) => r.summary.includes("证据化回答")), "展示条目全部证据化");
    assert.ok(result.status.error?.includes("1 条候选回答失败"), `status.error=${result.status.error}`);
  });

  it("候选超过 5 条：只返回证据化前 5 条，截取数进状态", async () => {
    const root2 = mkdtempSync(join(tmpdir(), "fs-q-top-"));
    const dir2 = join(root2, "s");
    mkdirSync(dir2, { recursive: true });
    const paths: string[] = [];
    const records: Array<{ path: string; summary: string; firstUser: string; modified: string; mtimeMs: number }> = [];
    for (let i = 0; i < 7; i++) {
      const f = join(dir2, `c${i}.jsonl`);
      writeFileSync(f, [
        JSON.stringify({ type: "session", id: `c${i}`, timestamp: "2026-11-01T00:00:00.000Z", cwd: "/p" }),
        JSON.stringify({ type: "message", id: `c${i}0`, timestamp: "2026-11-01T00:01:00.000Z", message: { role: "user", content: `讨论主题${i}` } }),
      ].join("\n") + "\n");
      paths.push(f);
      records.push({ path: f, summary: `主题${i}相关内容与锁有关联${i}`, firstUser: `讨论主题${i}`, modified: `2026-11-0${(i % 8) + 1}T01:00:00.000Z`, mtimeMs: statSync(f).mtimeMs });
    }
    seedIndex(root2, records);
    const calls: ScriptedCall[] = [];
    const deps = queryDeps((call) => {
      if (call.system.includes("挑出与描述相关")) {
        return `[${Array.from({ length: 7 }, (_, i) => `{"i":${i},"s":"候选${i}回答"}` ).join(",")}]`;
      }
      return "证据化回答。";
    }, calls);
    const result = await Effect.runPromise(searchIndexedSessions("锁 关联", deps, root2));
    assert.equal(result.ranked.length, 5);
    assert.equal(result.status.displayTruncated, 2);
    assert.ok(result.ranked.every((r) => r.summary.includes("证据化回答")));
    rmSync(root2, { recursive: true, force: true });
  });

  it("磁盘已删会话不算覆盖；缺索引=未覆盖（已请求补建）而非 noMatch", async () => {
    const coverageDeps = queryDeps(() => '[{"i":0,"s":"a"}]', []);
    // 只查 coverage：本地命中 fileA，回答阶段也会跑；先看 coverage 文案
    const result = await Effect.runPromise(searchIndexedSessions("登录超时", coverageDeps, root));
    assert.ok(result.status.coverage.includes("已索引 2/3"), `coverage=${result.status.coverage}`);
    assert.ok(result.status.coverage.includes("1 个未覆盖"), `coverage=${result.status.coverage}`);
    assert.ok(result.status.coverage.includes("已删除文件"), `coverage=${result.status.coverage}`);
    // 未覆盖的 fileC 缺缓存 → requestRebuild 已发布；fileB 已有缓存且未过期，不在请求里
    const { consumeRebuildRequests } = await import("../../extensions/hpl-find-session/coordination.js");
    const requested = await consumeRebuildRequests(root);
    assert.ok(requested.includes(fileC), `requested=${requested.join(",")}`);
    assert.ok(!requested.includes(fileB), `fileB 已有缓存不该请求：${requested.join(",")}`);
  });

  it("缺索引且无任何摘要：typed uncovered 失败，不是 noMatch", async () => {
    const root2 = mkdtempSync(join(tmpdir(), "fs-q-empty-"));
    const dir2 = join(root2, "s");
    mkdirSync(dir2, { recursive: true });
    const f = join(dir2, "u.jsonl");
    writeFileSync(f, [
      JSON.stringify({ type: "session", id: "u", timestamp: "2026-11-01T00:00:00.000Z", cwd: "/p" }),
      JSON.stringify({ type: "message", id: "u0", timestamp: "2026-11-01T00:01:00.000Z", message: { role: "user", content: "问题" } }),
    ].join("\n") + "\n");
    await expectQueryFailure(
      searchIndexedSessions("问题", queryDeps(() => "[]", []), root2),
      (e) => e._tag === "QueryModelError" && e.stage === "uncovered",
    );
    rmSync(root2, { recursive: true, force: true });
  });

  it("signal 已中止：搜索 typed aborted，不再生成", async () => {
    const controller = new AbortController();
    controller.abort();
    await expectQueryFailure(
      searchIndexedSessions("登录超时", queryDeps(() => "[]", []), root, controller.signal),
      (e) => e._tag === "QueryModelError" && e.stage === "aborted",
    );
  });

  it("本地命中排序无匹配：对未检查摘要扩搜并找回旧相关会话", async () => {
    const root2 = mkdtempSync(join(tmpdir(), "fs-q-retry-"));
    const dir2 = join(root2, "s");
    mkdirSync(dir2, { recursive: true });
    const weak = join(dir2, "weak.jsonl");
    const old = join(dir2, "old.jsonl");
    writeFileSync(weak, [
      JSON.stringify({ type: "session", id: "w", timestamp: "2026-11-01T00:00:00.000Z", cwd: "/p" }),
      JSON.stringify({ type: "message", id: "w0", timestamp: "2026-11-01T00:01:00.000Z", message: { role: "user", content: "修复登录超时" } }),
    ].join("\n") + "\n");
    writeFileSync(old, [
      JSON.stringify({ type: "session", id: "o", timestamp: "2026-11-05T00:00:00.000Z", cwd: "/q" }),
      JSON.stringify({ type: "message", id: "o0", timestamp: "2026-11-05T00:01:00.000Z", message: { role: "user", content: "登录超时的另一种场景" } }),
    ].join("\n") + "\n");
    seedIndex(root2, [
      { path: weak, summary: "修复登录超时：web 场景", firstUser: "修复登录超时", modified: "2026-11-01T01:00:00.000Z", mtimeMs: statSync(weak).mtimeMs },
      { path: old, summary: "CLI 连接重试的旧会话", firstUser: "连接重试排查", modified: "2026-11-05T01:00:00.000Z", mtimeMs: statSync(old).mtimeMs },
    ]);
    const calls: ScriptedCall[] = [];
    const deps = queryDeps((call) => {
      // 本地命中批（rank 阶段候选只有 weak）：返回 []，逼出扩搜分支
      if (call.system.includes("挑出与描述相关") && call.user.includes("web 场景") && !call.user.includes("候选会话：")) return "[]";
      // 扩搜批：选 old（全局编号 0 = modified 降序第一位）
      if (call.user.startsWith("用户描述：") && call.user.includes("候选会话：")) return '[{"i":0}]';
      if (call.system.includes("挑出与描述相关")) return '[{"i":0,"s":"连接重试回答"}]';
      return "连接重试场景回答。";
    }, calls);
    const result = await Effect.runPromise(searchIndexedSessions("登录超时", deps, root2));
    assert.equal(result.status.expanded, true, "rank 空后必须扩搜");
    assert.equal(result.ranked.length, 1);
    assert.equal(result.ranked[0]!.entry.path, old);
    rmSync(root2, { recursive: true, force: true });
  });

  it("「最早的会话」：直接按 modified 升序选择，模型不重排", async () => {
    const calls: ScriptedCall[] = [];
    const deps = queryDeps((call) => "证据化回答。", calls);
    const result = await Effect.runPromise(searchIndexedSessions("最早讨论登录的会话", deps, root));
    assert.equal(result.status.timeOrder, "earliest");
    // 无选择类调用：rank 未参与排序
    assert.ok(!calls.some((c) => c.system.includes("挑出与描述相关")), "时间意图不调模型排序");
    assert.ok(result.ranked.length >= 1);
    const times = result.ranked.map((r) => r.entry.modified);
    assert.deepEqual(times, [...times].sort(), "升序：最早在前");
    assert.equal(times[0], "2026-11-01T01:00:00.000Z");
  });

  it("「最新的修锁会话」：先相关筛选再按 modified 降序，rank 不改顺序", async () => {
    const root2 = mkdtempSync(join(tmpdir(), "fs-q-latest-"));
    const dir2 = join(root2, "s");
    mkdirSync(dir2, { recursive: true });
    const mk = (name: string, day: string) => {
      const f = join(dir2, `${name}.jsonl`);
      writeFileSync(f, [
        JSON.stringify({ type: "session", id: name, timestamp: `2026-11-${day}T00:00:00.000Z`, cwd: "/p" }),
        JSON.stringify({ type: "message", id: `${name}0`, timestamp: `2026-11-${day}T00:01:00.000Z`, message: { role: "user", content: "修锁相关" } }),
      ].join("\n") + "\n");
      return f;
    };
    const lockOld = mk("lockold", "01");
    const lockNew = mk("locknew", "07");
    const other = mk("other", "09");
    seedIndex(root2, [
      { path: lockOld, summary: "修复索引锁竞态（旧）", firstUser: "修锁相关", modified: "2026-11-01T01:00:00.000Z", mtimeMs: statSync(lockOld).mtimeMs },
      { path: lockNew, summary: "修复索引锁竞态（新）", firstUser: "修锁相关", modified: "2026-11-07T01:00:00.000Z", mtimeMs: statSync(lockNew).mtimeMs },
      { path: other, summary: "无关话题：天气", firstUser: "天气", modified: "2026-11-09T01:00:00.000Z", mtimeMs: statSync(other).mtimeMs },
    ]);
    const deps = queryDeps(() => "证据化回答。", []);
    const result = await Effect.runPromise(searchIndexedSessions("最新的修锁会话", deps, root2));
    assert.equal(result.status.timeOrder, "latest");
    assert.deepEqual(result.ranked.map((r) => r.entry.path), [lockNew, lockOld], "只有锁相关且新在前");
    assert.ok(!result.ranked.some((r) => r.entry.path === other));
    rmSync(root2, { recursive: true, force: true });
  });

  it("问「正在运行」：如实报无法判断，不用 mtime 声称运行", async () => {
    const calls: ScriptedCall[] = [];
    const deps = queryDeps((call) => {
      if (call.system.includes("挑出与描述相关")) return '[{"i":0,"s":"a"}]';
      return "回答。";
    }, calls);
    const result = await Effect.runPromise(searchIndexedSessions("正在运行的登录会话", deps, root));
    assert.equal(result.status.runningUndetermined, true);
    const answerCall = calls.find((c) => c.system.includes("原始消息证据"));
    assert.ok(answerCall?.user.includes("无法判断") && answerCall.user.includes("禁止用修改时间"), "回答提示词带运行状态防护");
  });

  it("进度回调真实汇报覆盖/扩大/回答阶段", async () => {
    const phases: string[] = [];
    const calls: ScriptedCall[] = [];
    const deps = queryDeps((call) => {
      if (call.user.startsWith("用户描述：完全无关的量子词汇\n\n候选会话：")) return '[{"i":0}]';
      if (call.system.includes("挑出与描述相关")) return '[{"i":0,"s":"a"}]';
      return "证据化回答。";
    }, calls);
    const result = await Effect.runPromise(
      searchIndexedSessions("完全无关的量子词汇", deps, root, undefined, (phase) => phases.push(phase)),
    );
    assert.ok(result.ranked.length === 1);
    assert.ok(phases.some((p) => p.includes("已读取索引覆盖")), `phases=${phases.join("|")}`);
    assert.ok(phases.some((p) => p.includes("扩大检索")), `phases=${phases.join("|")}`);
    assert.ok(phases.some((p) => p.includes("回答生成中")), `phases=${phases.join("|")}`);
    assert.ok(phases.every((p) => !/\d+%/.test(p)), "不用百分比伪造进度");
  });

  it("扩大检索也无命中（有效 []）：noMatch 如实上报且非失败", async () => {
    const result = await Effect.runPromise(
      searchIndexedSessions("完全无关的量子词汇", queryDeps(() => "[]", []), root),
    );
    assert.equal(result.status.expanded, true);
    assert.equal(result.status.noMatch, true);
    assert.deepEqual(result.ranked, []);
    assert.equal(result.status.error, undefined);
  });

  it("排序模型失败：真实原因进 status.error，不冒充回答", async () => {
    const deps: ModelDeps = {
      available: [MODEL], currentModel: undefined,
      resolvedTiers: { opus: [], sonnet: [], haiku: [{ provider: "p", id: "m" }] },
      complete: async () => { throw new Error("配额耗尽"); },
    };
    const result = await Effect.runPromise(searchIndexedSessions("登录超时", deps, root));
    assert.ok(result.status.error?.includes("配额耗尽"));
  });

  after(() => rmSync(root, { recursive: true, force: true }));
});
