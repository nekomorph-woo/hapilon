/**
 * find-session-wiring.test.ts — 扩展接线测试：真实 index.ts 注册表 + 真实 sqlite 端口。
 *
 * 验证点：
 * - /session-index 命令与 session_index 工具真实注册；
 * - session_shutdown handler 返回 Promise（pi runner 逐个 await handler 的契约），
 *   锁在 pass settle（含最后一次写盘）前不提前释放；
 * - shutdown 返回后锁已释放、owner 状态文件已清理（真实 acquire 验证，不读 owner 表）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import { Effect } from "effect";

// HAPILON_HOME 必须在 import index.ts 之前指向隔离目录（hapilonHome() 每次调用读 env）
const home = mkdtempSync(join(tmpdir(), "fs-wiring-"));
process.env.HAPILON_HOME = home;
const sessionsRoot = join(home, "agent", "sessions");
// listSessionFiles 只扫子目录（pi 会话按项目分目录存放）
const projectDir = join(sessionsRoot, "proj-a");
mkdirSync(projectDir, { recursive: true });
const sessionFile = join(projectDir, "s1.jsonl");
writeFileSync(sessionFile, [
  JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/p" }),
  JSON.stringify({ type: "message", id: "m0", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user", content: "修一个坑" } }),
].join("\n") + "\n");
const MTIME = Date.now() - 11 * 60_000; // 越过 10 分钟安静门
utimesSync(sessionFile, new Date(MTIME), new Date(MTIME));

const { default: hplFindSession, __lifecyclesForTest } = await import("../../extensions/hpl-find-session/index.js");
const { sqliteCoordinationPort } = await import("../../extensions/hpl-find-session/index-lock.js");

async function waitUntil(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`waitUntil 超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const asRight = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const result = await Effect.runPromise(Effect.either(effect));
  if (result._tag === "Left") throw new Error(`Effect 失败：${JSON.stringify(result.left)}`);
  return result.right;
};

describe("扩展接线：真实 register + sqlite 端口 + shutdown 等待", () => {
  after(() => rmSync(home, { recursive: true, force: true }));

  it("命令/工具真实注册；shutdown 返回 Promise 且不提前 unlock，返回后锁已释放", async () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const commands = new Map<string, unknown>();
    const tools = new Map<string, unknown>();
    const pi = {
      on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn),
      registerCommand: (name: string, def: unknown) => commands.set(name, def),
      // registerTool 收单个定义对象（{ name, ... }）
      registerTool: (def: { name: string }) => tools.set(def.name, def),
    };

    hplFindSession(pi as never);
    assert.equal(commands.has("session-index"), true, "/session-index 已注册");
    assert.equal(tools.has("session_index"), true, "session_index 工具已注册");
    assert.equal(handlers.has("session_shutdown"), true);

    const lifecycle = __lifecyclesForTest.at(-1);
    assert.ok(lifecycle, "扩展实例创建了 lifecycle");
    const ctx = {
      mode: "tui",
      model: { provider: "p", id: "m", name: "M", reasoning: false },
      ui: { notify: () => {} },
      modelRegistry: {
        getAvailable: () => [{ provider: "p", id: "m", name: "M", reasoning: false }],
        complete: async (_model: unknown, _messages: unknown, options: { signal?: AbortSignal }) => {
          modelEntered();
          // 模拟在途模型调用：shutdown 取消后仍有 50ms 落盘尾巴，验证不提前 unlock
          await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()));
          await new Promise((r) => setTimeout(r, 50));
          throw new Error("已取消");
        },
      },
    };
    let releaseModelEntered: () => void = () => {};
    const modelEnteredPromise = new Promise<void>((r) => { releaseModelEntered = r; });
    const modelEntered = () => releaseModelEntered();

    handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    await Effect.runPromise(lifecycle!.tryRunPass);
    await waitUntil(() => lifecycle!.state().kind === "indexing", "pass 进入 indexing");
    // 模型真正进入（显式 barrier）后才触发 shutdown，避免 digest 入口的 abort 检查抢先把 pass 快速结束
    await Promise.race([
      modelEnteredPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("模型未进入：barrier 超时")), 10_000).unref?.()),
    ]);

    // 锁真实落盘：owner 状态文件可读
    const ownerInfo = await asRight(sqliteCoordinationPort.readOwnerInfo(sessionsRoot));
    assert.ok(ownerInfo && ownerInfo.owner.length > 0, "owner 状态文件已写");

    // shutdown 前其他人拿不到锁
    const duringA = await asRight(sqliteCoordinationPort.acquireIndexLockEffect(sessionsRoot, "other-1"));
    assert.equal(duringA, null, "持锁期间其他实例 acquire 为 null");

    // handler 返回 Promise（pi runner 会 await）；settle 完成前不 resolve
    const done = handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
    assert.equal(typeof (done as Promise<void>)?.then, "function", "session_shutdown 必须返回 Promise");
    await new Promise((r) => setTimeout(r, 10));
    const duringB = await asRight(sqliteCoordinationPort.acquireIndexLockEffect(sessionsRoot, "other-2"));
    assert.equal(duringB, null, "shutdown 未 settle 前锁未提前释放");

    await done;
    const ownerAfter = await asRight(sqliteCoordinationPort.readOwnerInfo(sessionsRoot));
    assert.equal(ownerAfter, null, "owner 状态文件已清理");
    const afterShutdown = await asRight(sqliteCoordinationPort.acquireIndexLockEffect(sessionsRoot, "other-3"));
    assert.notEqual(afterShutdown, null, "shutdown 返回后锁已真实释放（另一 owner 可 acquire）");
  });
});
