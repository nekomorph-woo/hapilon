import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { SessionStore, type MessageCursor } from "../../extensions/hpl-find-session/session-store.js";

const header = (id: string, parentSession?: string) => ({ type: "session", id, timestamp: "2026-01-01", cwd: "/project", ...(parentSession ? { parentSession } : {}) });
const message = (id: string, parentId: string | null, role: string, text: string) => ({
  type: "message", id, parentId, timestamp: "2026-01-01", message: { role, content: [{ type: "text", text }] },
});
const writeSession = (path: string, entries: unknown[]) => writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

it("分页遍历元数据、中文搜索和长消息，保留分支关系", async () => {
  const base = mkdtempSync(join(tmpdir(), "session-store-"));
  try {
    const root = join(base, "sessions");
    const dir = join(root, "project");
    mkdirSync(dir, { recursive: true });
    const longText = "中文😀".repeat(50);
    const first = join(dir, "a.jsonl");
    writeSession(first, [header("s1"), message("a", null, "user", "中文问题"), message("b", "a", "assistant", "中文分支一"), message("c", "a", "toolResult", longText)]);
    writeSession(join(dir, "b.jsonl"), [header("s2", first), message("d", null, "user", "中文分支二")]);
    writeSession(join(dir, "c.jsonl"), [header("s3"), message("e", null, "assistant", "其他")]);
    const store = new SessionStore(root);
    const ids: string[] = [];
    let listCursor: number | null = 0;
    do {
      const page: Effect.Effect.Success<ReturnType<SessionStore["listPage"]>> = await Effect.runPromise(store.listPage(listCursor!, 1));
      ids.push(...page.items.map((item) => item.id));
      assert.equal(page.total, 3);
      listCursor = page.nextCursor;
    } while (listCursor !== null);
    assert.deepEqual(ids, ["s1", "s2", "s3"]);
    const hits: string[] = [];
    let searchCursor: number | null = 0;
    do {
      const page: Effect.Effect.Success<ReturnType<SessionStore["searchPage"]>> = await Effect.runPromise(store.searchPage("中文", searchCursor!, 1));
      hits.push(...page.items.map((hit) => `${hit.sessionId}:${hit.messageId}:${hit.parentId}`));
      assert.equal(page.coverage, 3);
      assert.equal(page.incomplete, 0);
      assert.ok(page.items.every((hit) => hit.line >= 2 && hit.path.endsWith(".jsonl") && hit.snippet.includes("中文")));
      searchCursor = page.nextCursor;
    } while (searchCursor !== null);
    assert.deepEqual(hits, ["s1:a:null", "s1:b:a", "s1:c:a", "s2:d:null"]);
    let cursor: MessageCursor | null = { message: 0, offset: 0 };
    const content = new Map<string, string>();
    do {
      const page: Effect.Effect.Success<ReturnType<SessionStore["messagesPage"]>> = await Effect.runPromise(store.messagesPage(first, cursor!, 7));
      assert.ok(page.item);
      content.set(page.item.id, (content.get(page.item.id) ?? "") + page.item.text);
      if (page.item.id === "c") assert.equal(page.item.parentId, "a");
      cursor = page.nextCursor;
    } while (cursor !== null);
    assert.deepEqual([...content], [["a", "中文问题"], ["b", "中文分支一"], ["c", longText]]);
    const parent = await Effect.runPromise(store.parent(join(dir, "b.jsonl")));
    assert.equal(parent?.header.id, "s1");
    assert.equal(parent?.path, realpathSync(first));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

it("拒绝越界、非会话文件和损坏的中间行，标记未写完的末行", async () => {
  const base = mkdtempSync(join(tmpdir(), "session-store-"));
  try {
    const root = join(base, "sessions");
    const dir = join(root, "project");
    mkdirSync(dir, { recursive: true });
    const outside = join(base, "outside.jsonl");
    writeSession(outside, [header("outside")]);
    const path = join(dir, "session.jsonl");
    writeSession(path, [header("s", outside), message("a", null, "user", "正文")]);
    const link = join(dir, "link.jsonl");
    symlinkSync(outside, link);
    const other = join(root, "secret.txt");
    writeFileSync(other, "秘密");
    const rootJsonl = join(root, "secret.jsonl");
    writeSession(rootJsonl, [header("secret")]);
    const store = new SessionStore(root);
    assert.ok(Exit.isFailure(await Effect.runPromiseExit(store.parent(path))));
    assert.ok(Exit.isFailure(await Effect.runPromiseExit(store.read(link))));
    assert.ok(Exit.isFailure(await Effect.runPromiseExit(store.read(other))));
    assert.ok(Exit.isFailure(await Effect.runPromiseExit(store.read(rootJsonl))));
    writeFileSync(path, `${JSON.stringify(header("s"))}\n{坏\n${JSON.stringify(message("a", null, "user", "正文"))}\n`);
    assert.ok(Exit.isFailure(await Effect.runPromiseExit(store.read(path))));
    writeFileSync(path, `${JSON.stringify(header("s"))}\n${JSON.stringify(message("a", null, "user", "正文"))}\n{未完成`);
    const partial = await Effect.runPromise(store.read(path));
    assert.equal(partial.incomplete, true);
    assert.equal(partial.messages.length, 1);
    assert.equal((await Effect.runPromise(store.searchPage("正文"))).incomplete, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

it("搜索跳过单个坏文件与非文本 message 条目，不阻断整页", async () => {
  const base = mkdtempSync(join(tmpdir(), "session-store-skip-"));
  try {
    const root = join(base, "sessions");
    const dir = join(root, "project");
    mkdirSync(dir, { recursive: true });
    const good = join(dir, "good.jsonl");
    writeSession(good, [header("s-good"), message("a", null, "user", "检索目标在这里")]);
    // 坏文件：有效 JSON 头 + 非文本语义条目（bashExecution）+ 中间坏行
    const bad = join(dir, "bad.jsonl");
    writeFileSync(bad, [
      JSON.stringify(header("s-bad")),
      JSON.stringify({ type: "message", id: "x", parentId: null, timestamp: "t", message: { role: "bashExecution", command: "ls" } }),
      "{坏行",
    ].join("\n") + "\n");
    const store = new SessionStore(root);
    const badRead = await Effect.runPromise(Effect.either(store.read(bad)));
    assert.ok(badRead._tag === "Left", "read 单文件仍应严格失败");
    const search = await Effect.runPromise(store.searchPage("检索目标"));
    assert.equal(search.items.length, 1);
    assert.equal(search.coverage, 2);
    assert.equal(search.failedFiles, 1);
    const bashOnly = join(dir, "bashy.jsonl");
    writeFileSync(bashOnly, [
      JSON.stringify(header("s-bashy")),
      JSON.stringify({ type: "message", id: "x", parentId: null, timestamp: "t", message: { role: "bashExecution", command: "检索目标在这里" } }),
      JSON.stringify(message("a", null, "user", "可见正文")),
    ].join("\n") + "\n");
    const readBashy = await Effect.runPromise(store.read(bashOnly));
    assert.equal(readBashy.skipped, 1, "非文本 message 条目跳过并计数");
    assert.equal(readBashy.messages.length, 1);
    const searchBashy = await Effect.runPromise(store.searchPage("检索目标在这里"));
    assert.deepEqual(searchBashy.items.map((hit) => hit.sessionId), ["s-good"], "bashExecution 不参与搜索");
    const list = await Effect.runPromise(store.listPage(0, 20));
    assert.equal(list.total, 3);
    assert.equal(list.failedFiles, 1);
    assert.deepEqual(list.items.map((item) => item.id), ["s-bashy", "s-good"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

it("可中断正在读取的会话", async () => {
  const base = mkdtempSync(join(tmpdir(), "session-store-abort-"));
  try {
    const dir = join(base, "project");
    mkdirSync(dir);
    const path = join(dir, "large.jsonl");
    writeSession(path, [header("s"), message("a", null, "toolResult", "x".repeat(16 * 1024 * 1024))]);
    const controller = new AbortController();
    const result = Effect.runPromiseExit(new SessionStore(base).read(path), { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 0);
    assert.ok(Exit.isInterrupted(await result));
    clearTimeout(timer);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
