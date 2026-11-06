/**
 * find-session-lifecycle.test.ts — 索引锁生命周期接入测试。
 *
 * 验收点（模型/计时/锁全部可注入）：
 * 1. release 途中不提前 unlock：锁只在 pass settle 后释放
 * 2. 取消后不会再写：abort 后不再调模型、不再写索引
 * 3. 重复 release 请求幂等：requestRelease 只发一次
 * 4. 原 owner 释放后暂停，另一实例可接手
 * 5. resume 恢复竞争
 * 6. shutdown 等待在途任务 settle 并释放锁后才返回
 * 7. 释放请求未获响应：状态是未响应，不显示成功
 * 8. 锁获取失败是真实 error 状态，不与空闲混淆
 * 9. 交接流：A 应 B 的释放请求 → 释放 + ack；B 收到 ack 才显示已释放
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import { Effect, Exit } from "effect";
import { runIndexerPass } from "../../extensions/hpl-find-session/indexer.js";
import { loadIndex } from "../../extensions/hpl-find-session/indexer.js";
import { createLifecycle, type LifecycleState } from "../../extensions/hpl-find-session/indexer-lifecycle.js";
import type { IndexLockHandle, IndexLockPort, RequestStatus } from "../../extensions/hpl-find-session/index-lock.js";
import { CoordinationError } from "../../extensions/hpl-find-session/coordination.js";
import type { ModelDeps } from "../../extensions/hpl-find-session/rank.js";

const NOW = 1_800_000_000_000;
const QUIET_MS = 10 * 60_000;
const MODEL = { provider: "p", id: "m", name: "M" };

// ── 可注入假锁端口：单槽互斥 + 事件流 + 调用记录 ──────────────────────

interface FakePort extends IndexLockPort {
  readonly log: string[];
  readonly requests: Array<{ from: string; target: string }>;
  holder(): string | null;
  ownerStatus(): string | null;
}

function fakePort(opts: { failReleaseTimes?: number } = {}): FakePort {
  const log: string[] = [];
  const requests: Array<{ from: string; target: string }> = [];
  const files = new Map<string, { targetOwner: string; requester: string; ts: number; status: RequestStatus }>();
  let current: string | null = null;
  let ownerStatus: string | null = null;
  let seq = 0;
  const port: FakePort = {
    log,
    requests,
    holder: () => current,
    acquireIndexLockEffect: (_root, owner) =>
      Effect.try({
        try: () => {
          if (current && current !== owner) return null;
          current = owner;
          ownerStatus = owner;
          log.push(`acquire:${owner}`);
          const handle: IndexLockHandle = {
            // 用 suspend+fail：同步 throw 在 Effect 里是 defect，不会被 either 捕获
            release: Effect.suspend(() =>
              (opts.failReleaseTimes ?? 0) > 0
                ? Effect.sync(() => {
                    opts.failReleaseTimes = (opts.failReleaseTimes ?? 0) - 1;
                  }).pipe(Effect.andThen(Effect.fail(new CoordinationError({ cause: "释放被拒" }))))
                : Effect.sync(() => {
                    if (current === owner) current = null;
                    log.push(`release:${owner}`);
                  }),
            ),
          };
          return handle;
        },
        catch: (cause) => new CoordinationError({ cause: String(cause) }),
      }),
    requestRelease: (_root, fromOwner, targetOwner) =>
      Effect.sync(() => {
        requests.push({ from: fromOwner, target: targetOwner });
        const id = `rel-${++seq}`;
        files.set(id, { targetOwner, requester: fromOwner, ts: ++seq, status: "pending" });
        return id;
      }),
    pendingReleaseRequests: (_root, owner) =>
      Effect.succeed(
        [...files.entries()]
          .filter(([, f]) => f.targetOwner === owner && f.status === "pending")
          .map(([id, f]) => ({ id, requester: f.requester, ts: f.ts })),
      ),
    markReleased: (_root, id) =>
      Effect.sync(() => {
        const f = files.get(id);
        if (f) files.set(id, { ...f, status: "released" });
      }),
    deleteRequest: (_root, id) => Effect.sync(() => files.delete(id)),
    readRequestStatus: (_root, id) => Effect.succeed(files.get(id)?.status ?? null),
    releaseBackoff: () => Effect.void,
    writeOwnerStatus: (_root, owner) => Effect.sync(() => { ownerStatus = owner; log.push(`owner-status:${owner}`); }),
    clearOwnerStatus: () => Effect.sync(() => { log.push("owner-status:cleared"); ownerStatus = null; }),
    ownerStatus: () => ownerStatus,
    readOwnerInfo: () => Effect.sync(() => (current ? { owner: current } : null)),
  };
  return port;
}

// ── 可注入 pass：受闸门控制，可观察 settle 与取消 ─────────────────────

function gatedPass(log: string[], opts: { ignoreAbort?: boolean } = {}) {
  let resolve!: () => void;
  let settled = false;
  const promise = new Promise<void>((r) => {
    resolve = () => {
      if (!settled) {
        settled = true;
        log.push("pass-settled");
        r();
      }
    };
  });
  const pass = (signal: AbortSignal): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => {
          // ignoreAbort：模拟一次无法立即中断的在途写，只有真正完成才 settle
          if (!opts.ignoreAbort) signal.addEventListener("abort", () => resolve());
          return promise;
        },
        catch: (cause) => new Error(String(cause)),
      }).pipe(Effect.catchAll(() => Effect.void));
    });
  return { pass, settle: resolve, isSettled: () => settled };
}

function makeLifecycle(deps: {
  port: IndexLockPort;
  owner: string;
  runPass: (signal: AbortSignal) => Effect.Effect<void, never>;
  now?: () => number;
}) {
  const notes: Array<{ message: string; level: string }> = [];
  const lifecycle = createLifecycle({
    port: deps.port,
    root: "/root",
    owner: deps.owner,
    now: deps.now ?? (() => NOW),
    notify: (message, level) => notes.push({ message, level }),
    requestTimeoutMs: 30_000,
    runPass: deps.runPass,
  });
  return { lifecycle, notes };
}

const run = (effect: Effect.Effect<void, never>) => Effect.runPromise(effect);

async function waitUntil(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`waitUntil 超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function sessionFixture(): Array<Record<string, unknown>> {
  return [
    { type: "session", id: "s1", timestamp: "2026-11-06T10:00:00.000Z", cwd: "/p" },
    { type: "message", id: "m0", timestamp: "2026-11-06T10:01:00.000Z", message: { role: "user", content: "修一个坑" } },
  ];
}

describe("release：取消 → 等 settle → 才 unlock", () => {
  const dir = mkdtempSync(join(tmpdir(), "fs-life-1-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("release 途中不提前 unlock；取消后不再调模型、不再写索引", async () => {
    const port = fakePort();
    const gate = gatedPass(port.log, { ignoreAbort: true });
    const file = join(dir, "a.jsonl");
    const second = join(dir, "b.jsonl");
    for (const f of [file, second]) {
      writeFileSync(f, sessionFixture().map((l) => JSON.stringify(l)).join("\n") + "\n");
    }
    const { lifecycle } = makeLifecycle({ port, owner: "A", runPass: (signal) => gate.pass(signal) });
    await run(lifecycle.tryRunPass);
    assert.equal(port.holder(), "A");
    assert.equal(lifecycle.state().kind, "indexing");

    const releaseDone = run(lifecycle.release);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(port.log.includes("release:A"), false, "pass 未 settle 不得 unlock");
    assert.equal(gate.isSettled(), false);
    gate.settle();
    await releaseDone;
    assert.ok(port.log.indexOf("pass-settled") < port.log.indexOf("release:A"), "先 settle 后 unlock");
    assert.equal(lifecycle.state().kind, "released");
    assert.equal(lifecycle.paused(), true);

    // 取消后真实索引器不再写：模型进入的显式 barrier 之后再 abort，不用 sleep 猜时序；
    // fixture stat mtime 与传参一致，失败路径不再被 catchAll 吞掉
    const MTIME = NOW - QUIET_MS - 1;
    utimesSync(file, new Date(MTIME), new Date(MTIME));
    utimesSync(second, new Date(MTIME), new Date(MTIME));
    let modelCalls = 0;
    let releaseModelEntered: () => void = () => {};
    const modelEntered = new Promise<void>((r) => { releaseModelEntered = r; });
    const deps: ModelDeps = {
      available: [MODEL],
      currentModel: undefined,
      resolvedTiers: { opus: [], sonnet: [], haiku: [{ provider: "p", id: "m" }] },
      complete: async (_model, _messages, _systemPrompt, signal) => {
        modelCalls++;
        releaseModelEntered();
        // 模型在途：等取消信号才结束，模拟真实慢调用
        await new Promise<void>((r) => signal?.addEventListener("abort", () => r()));
        throw new Error("已取消");
      },
    };
    const controller = new AbortController();
    const rerun = Effect.runPromiseExit(
      runIndexerPass(dir, [
        { path: file, mtimeMs: MTIME, sizeBytes: statSync(file).size },
        { path: second, mtimeMs: MTIME, sizeBytes: statSync(second).size },
      ], deps, NOW, controller.signal),
    );
    await Promise.race([
      modelEntered,
      new Promise((_, reject) => setTimeout(() => reject(new Error("模型未进入：barrier 超时")), 10_000).unref?.()),
    ]);
    controller.abort();
    const result = await rerun;
    assert.equal(Exit.isSuccess(result), true, `索引 pass 失败：${JSON.stringify(result)}`);
    assert.equal(modelCalls, 1, "取消后第 2 个文件不再调模型");
    assert.equal(loadIndex(dir).size, 0, "取消后不写索引");
  });
});

describe("释放请求：幂等、未响应、owner 交接", () => {
  it("重复请求幂等：requestRelease 只发一次；未响应不显示成功", async () => {
    const port = fakePort();
    Effect.runSync(port.acquireIndexLockEffect("/root", "A"));
    const now = { t: NOW };
    const { lifecycle } = makeLifecycle({
      port, owner: "B", now: () => now.t,
      runPass: () => Effect.void,
    });
    await run(lifecycle.release);
    await run(lifecycle.release);
    assert.equal(port.requests.length, 1, "重复 release 不重复发请求");
    assert.equal(lifecycle.state().kind, "releaseRequested");
    now.t = NOW + 31_000;
    assert.equal(lifecycle.state().kind, "unresponded", "超时未响应");
    await run(lifecycle.pollHandoff);
    assert.equal(lifecycle.state().kind, "unresponded");
  });

  it("原 owner 释放后暂停，另一实例接手；resume 恢复竞争", async () => {
    const port = fakePort();
    const gateA = gatedPass(port.log);
    const gateB = gatedPass(port.log);
    const a = makeLifecycle({ port, owner: "A", runPass: gateA.pass });
    const b = makeLifecycle({ port, owner: "B", runPass: gateB.pass });
    await run(a.lifecycle.tryRunPass);
    await run(a.lifecycle.release);
    assert.equal(a.lifecycle.paused(), true);
    assert.equal(port.holder(), null);

    await run(b.lifecycle.tryRunPass);
    assert.equal(port.holder(), "B", "另一实例接手");

    // A 暂停期间不抢锁
    await run(a.lifecycle.tryRunPass);
    await run(a.lifecycle.joinCycle);
    assert.equal(port.holder(), "B");
    assert.equal(a.lifecycle.paused(), true);

    // B 交还后 A resume 恢复竞争
    gateB.settle();
    await run(b.lifecycle.joinCycle);
    await run(b.lifecycle.release);
    await run(a.lifecycle.resume);
    await run(a.lifecycle.joinCycle);
    assert.ok(port.log.includes("acquire:A"), "resume 后恢复竞争");
  });

  it("交接流：owner 应请求释放并发 ack；请求方收到 ack 才显示已释放", async () => {
    const port = fakePort();
    const gateA = gatedPass(port.log);
    const a = makeLifecycle({ port, owner: "A", runPass: gateA.pass });
    const b = makeLifecycle({ port, owner: "B", runPass: () => Effect.void });
    await run(a.lifecycle.tryRunPass);

    await run(b.lifecycle.release);
    assert.equal(port.requests.length, 1);
    assert.equal(port.holder(), "A", "请求本身不解锁");
    assert.equal(b.lifecycle.state().kind, "releaseRequested");

    await run(a.lifecycle.pollHandoff);
    assert.equal(a.lifecycle.paused(), true, "owner 释放并暂停");
    assert.equal(port.holder(), null);
    assert.equal(a.lifecycle.state().kind, "released");

    await run(b.lifecycle.pollHandoff);
    assert.ok(b.notes.some((n) => n.message.includes("owner 已释放索引锁")), "收到 ack 才播报已释放");
    assert.ok(port.log.includes("acquire:B"), "其他实例获知 handoff 后尝试接手");
  });
});

describe("shutdown 与错误状态", () => {
  it("shutdown 等待在途任务 settle 并释放锁后才返回", async () => {
    const port = fakePort();
    const gate = gatedPass(port.log, { ignoreAbort: true });
    const { lifecycle } = makeLifecycle({ port, owner: "A", runPass: gate.pass });
    await run(lifecycle.tryRunPass);
    let shutdownDone = false;
    const shutting = run(lifecycle.shutdown).then(() => { shutdownDone = true; });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(shutdownDone, false, "任务未 settle 前 shutdown 不返回");
    gate.settle();
    await shutting;
    assert.deepEqual(port.log.filter((l) => l === "release:A").length, 1);
    assert.equal(port.holder(), null);
  });

  it("锁获取失败是 error 状态，不与空闲混淆；无 owner 时 release 不发请求", async () => {
    const port = fakePort();
    const failing = new Proxy(port, {
      get(target, prop, receiver) {
        if (prop === "acquireIndexLockEffect") {
          return () => Effect.fail(new CoordinationError({ cause: "sqlite busy" }));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const { lifecycle } = makeLifecycle({ port: failing, owner: "A", runPass: () => Effect.void });
    await run(lifecycle.tryRunPass);
    const state: LifecycleState = lifecycle.state();
    assert.equal(state.kind, "error");
    assert.ok(state.kind === "error" && state.message.includes("sqlite busy"));

    // 无 owner：release 直接提示，不发请求
    const { lifecycle: idle } = makeLifecycle({ port, owner: "A", runPass: () => Effect.void });
    await run(idle.release);
    assert.equal(port.requests.length, 0);
    assert.equal(idle.state().kind, "idle");
  });
});

describe("回归：异常退出、释放失败、状态文件所有权、并发、迟到 ack、损坏展示文件", () => {
  it("runPass die：仍释放锁，状态是 error 不是 idle", async () => {
    const port = fakePort();
    const { lifecycle, notes } = makeLifecycle({
      port, owner: "A",
      runPass: () => Effect.die(new Error("boom")) as unknown as Effect.Effect<void, never>,
    });
    await run(lifecycle.tryRunPass);
    await run(lifecycle.joinCycle);
    assert.equal(port.holder(), null);
    assert.equal(lifecycle.state().kind, "error");
    assert.ok(notes.some((n) => n.message.includes("会话索引异常终止")));
    assert.equal(port.log.filter((l) => l === "release:A").length, 1);
  });

  it("释放失败：句柄保留，连续 3 次 poll 不 ack；resume 被拒；重试成功后才 ack", async () => {
    const port = fakePort({ failReleaseTimes: 5 });
    const gateA = gatedPass(port.log, { ignoreAbort: true });
    const a = makeLifecycle({ port, owner: "A", runPass: gateA.pass });
    const b = makeLifecycle({ port, owner: "B", runPass: () => Effect.void });
    await run(a.lifecycle.tryRunPass);
    await waitUntil(() => a.lifecycle.state().kind === "indexing", "A 进入 indexing");
    await run(b.lifecycle.release);

    // 第 1 次 poll：完整收尾（settle → release 失败），句柄保留
    const poll1 = run(a.lifecycle.pollHandoff);
    await new Promise((r) => setTimeout(r, 10));
    gateA.settle();
    await poll1;
    assert.equal(port.holder(), "A", "释放失败句柄必须保留，锁仍在 A");
    assert.equal(a.lifecycle.state().kind, "error");
    assert.ok(!a.notes.some((n) => n.message.includes("已释放会话索引锁")));
    await run(b.lifecycle.pollHandoff);
    assert.notEqual(b.lifecycle.state().kind, "released", "释放失败不得显示已释放");

    // 第 2、3 次 poll：重试仍失败，绝不 ack
    for (let i = 2; i <= 3; i++) {
      await run(a.lifecycle.pollHandoff);
      assert.equal(port.holder(), `A`);
      await run(b.lifecycle.pollHandoff);
      assert.notEqual(b.lifecycle.state().kind, "released", `第 ${i} 次 poll 后不得 ack`);
    }
    const markedBefore = [...port.requests];
    assert.equal(markedBefore.length, 1, "请求从未被标记（fake port 不暴露状态，这里只验请求未被删）");

    // resume：先重试释放（第 4 次，仍失败）→ 拒绝恢复
    await run(a.lifecycle.resume);
    assert.ok(a.notes.some((n) => n.message.includes("恢复被拒绝")), "锁未可靠释放前 resume 被拒");
    assert.equal(port.holder(), "A");

    // 第 5 次尝试成功：poll 重试释放 → ack → B 认领并接手
    await run(a.lifecycle.pollHandoff);
    assert.equal(port.holder(), null, "成功后锁已释放");
    await run(b.lifecycle.pollHandoff);
    assert.ok(b.notes.some((n) => n.message.includes("owner 已释放索引锁")));
    assert.ok(port.log.includes("acquire:B"), "B 接手");
  });

  it("旧 owner：先清本实例状态文件再释放；之后新 owner 状态不被旧 owner 删除", async () => {
    const port = fakePort();
    const gateA = gatedPass(port.log, { ignoreAbort: true });
    const a = makeLifecycle({ port, owner: "A", runPass: gateA.pass });
    await run(a.lifecycle.tryRunPass);
    const releasing = run(a.lifecycle.release);
    await new Promise((r) => setTimeout(r, 10));
    gateA.settle();
    await releasing;
    const cleared = port.log.indexOf("owner-status:cleared");
    const released = port.log.indexOf("release:A");
    assert.ok(cleared !== -1 && released !== -1 && cleared < released, "清状态文件在 release 之前");
    assert.equal(port.ownerStatus(), null);
    // 新 owner 写入后，旧 owner 的 watcher 已结束，不会再清
    await Effect.runPromise(Effect.either(port.writeOwnerStatus("/root", "B")));
    assert.equal(port.ownerStatus(), "B");
  });

  it("并发 tryRunPass / resume / release：busy 互斥，acquire 只进一次，最终释放一次", async () => {
    const port = fakePort();
    const gate = gatedPass(port.log, { ignoreAbort: true });
    const { lifecycle } = makeLifecycle({ port, owner: "A", runPass: gate.pass });
    // acquire 期间并发触发第二个 tryRunPass 与 release
    const t1 = run(lifecycle.tryRunPass);
    await run(lifecycle.tryRunPass);
    const rel = run(lifecycle.release);
    await t1;
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(port.log.includes("release:A"), false, "pass 未 settle 不得 unlock");
    gate.settle();
    await rel;
    assert.equal(port.log.filter((l) => l === "acquire:A").length, 1, "重入被拒");
    assert.equal(port.log.filter((l) => l === "release:A").length, 1, "释放只一次");
    assert.equal(port.holder(), null);
    assert.equal(lifecycle.paused(), true);
    assert.equal(lifecycle.state().kind, "released");
  });

  it("超时只是提示：迟到的 released 仍被认领并接手", async () => {
    const port = fakePort();
    const now = { t: NOW };
    const a = makeLifecycle({ port, owner: "A", runPass: () => Effect.void });
    const b = makeLifecycle({ port, owner: "B", now: () => now.t, runPass: () => Effect.void });
    await run(a.lifecycle.tryRunPass);
    await run(b.lifecycle.release);
    now.t = NOW + 31_000;
    await run(b.lifecycle.pollHandoff);
    assert.equal(b.lifecycle.state().kind, "unresponded");
    // owner 迟到应答
    await run(a.lifecycle.pollHandoff);
    await run(b.lifecycle.pollHandoff);
    assert.ok(b.notes.some((n) => n.message.includes("owner 已释放索引锁")), "迟到确认仍被认领");
    assert.equal(b.lifecycle.state().kind, "indexing", "认领后接手索引");
    assert.ok(port.log.includes("acquire:B"), "请求方接手");
  });

  it("展示文件损坏是真实 error：release 不发请求，不冒充无 owner", async () => {
    const port = fakePort();
    const corrupt = new Proxy(port, {
      get(target, prop, receiver) {
        if (prop === "readOwnerInfo") {
          return () => Effect.fail(new CoordinationError({ cause: "owner 状态文件内容损坏" }));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const { lifecycle, notes } = makeLifecycle({ port: corrupt, owner: "A", runPass: () => Effect.void });
    await run(lifecycle.release);
    assert.equal(lifecycle.state().kind, "error");
    assert.ok(notes.some((n) => n.message.includes("读取 owner 状态失败")));
    assert.equal(port.requests.length, 0);
  });
});
