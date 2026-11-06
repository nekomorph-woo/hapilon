/**
 * indexer-lifecycle.ts — 索引器生命周期：锁获取、pass 运行、取消收尾、释放请求/交接、暂停与恢复。
 *
 * 不变量：
 * - 一个 busy 标志覆盖 acquire → pass → settle → clearOwnerStatus → release 整个周期；期间 tryRunPass
 *   不可重入，release/resume 等周期结束才继续，不存在「锁还在释放就能发下一轮」的窗口。
 * - handle.release 只在 pass fiber 完全 settle（含最后一次写盘）之后执行；clearOwnerStatus 在仍持锁时
 *   先清本实例状态文件再释放，绝不在解锁后 unlink（防止删掉新 owner 刚写的状态）。
 * - watcher 用 Fiber.await 观察所有退出路径（成功/die/interrupt），ensuring 保证任何路径都收尾。
 * - 释放结果显式传播：只有真实释放成功才置 releaseOutcome=ok、清 handle、markReleased、发已释放通知、
 *   接手；失败保留句柄与 error 状态，之后每轮 poll / release / resume 重试释放，直到可靠释放——
 *   绝不凭「没有 handle」就 ack 或恢复竞争。
 * - 释放请求（requestRelease）不是 ack：只有请求被标记 released 才算已释放；超时只提示未响应，
 *   不终止观察——迟到的 released 仍然被认领。绝不强解锁。
 * - 本实例交出锁后 paused（coordination 15s backoff 只是让位窗口，不承担暂停语义）直到显式 resume。
 */

import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect";
import type { CoordinationError } from "./coordination.js";
import type { IndexLockHandle, IndexLockPort } from "./index-lock.js";

export type LifecycleState =
  | { readonly kind: "idle" }
  | { readonly kind: "indexing" }
  | { readonly kind: "paused" }
  | { readonly kind: "releaseRequested" }
  | { readonly kind: "released" }
  | { readonly kind: "unresponded" }
  | { readonly kind: "error"; readonly message: string };

export interface LifecycleDeps {
  readonly port: IndexLockPort;
  readonly root: string;
  readonly owner: string;
  readonly now: () => number;
  readonly notify: (message: string, level: "info" | "warning" | "error") => void;
  /** 一轮索引；通过 signal 接收取消。失败已由调用方包装 notify，不向上抛 */
  readonly runPass: (signal: AbortSignal) => Effect.Effect<void, never>;
  /** 释放请求超过该时长未见 released 视为未响应（提示性；不终止观察） */
  readonly requestTimeoutMs: number;
}

const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export const createLifecycle = (deps: LifecycleDeps) => {
  let state: LifecycleState = { kind: "idle" };
  /** 覆盖 acquire→pass→settle→release 全周期；为真期间 tryRunPass 不可重入 */
  let busy = false;
  let paused = false;
  let shutdown = false;
  let selfReleased = false;
  let passAbort: AbortController | undefined;
  let passFiber: Fiber.RuntimeFiber<void, never> | undefined;
  /** 非 undefined = 本实例仍持有锁（含释放失败待重试）；undefined = 已确认不持锁 */
  let handle: IndexLockHandle | undefined;
  let releasePending = false;
  let requestTs = 0;
  let requestId = "";
  let releaseOutcome: "ok" | "failed" | "none" = "none";
  let lastError: string | null = null;
  let cycleDone: Deferred.Deferred<void> | null = null;

  const setState = (next: LifecycleState) => {
    state = next;
  };

  const setError = (message: string, level: "warning" | "error" = "warning") => {
    lastError = message;
    setState({ kind: "error", message });
    deps.notify(message, level);
  };

  const joinCycle: Effect.Effect<void, never> = Effect.gen(function* () {
    if (cycleDone) yield* Deferred.await(cycleDone);
  });

  /**
   * 一个完整周期：acquire →（取消点）→ pass → settle → 清状态文件 → release。
   * 所有退出路径经 ensuring 收尾：busy 归位、cycleDone 兑现；释放失败时句柄保留在 handle 上。
   */
  const runCycle: Effect.Effect<void, never> = Effect.gen(function* () {
    const acquired = yield* deps.port.acquireIndexLockEffect(deps.root, deps.owner).pipe(Effect.either);
    if (acquired._tag === "Left") {
      setError(`获取索引锁失败：${acquired.left.cause}`);
      return;
    }
    if (!acquired.right) return;
    const h = acquired.right;
    handle = h;
    yield* deps.port.writeOwnerStatus(deps.root, deps.owner).pipe(
      Effect.catchAll((error) => Effect.sync(() => deps.notify(`owner 状态文件写入失败：${error.cause}`, "warning"))),
    );
    if (selfReleased || shutdown) {
      // 释放请求先于 pass 启动到达：不启动 pass，直接收尾释放
      yield* settle(h);
      return;
    }
    setState({ kind: "indexing" });
    const abort = new AbortController();
    passAbort = abort;
    const fiber = yield* Effect.forkDaemon(deps.runPass(abort.signal));
    passFiber = fiber;
    yield* settle(h, fiber);
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        busy = false;
        if (cycleDone) yield* Deferred.succeed(cycleDone, undefined);
      }),
    ),
  );

  /**
   * pass settle（或未启动）后的统一收尾：先清本实例状态文件（仍持锁），再 release。
   * release 失败时句柄保留在 handle 上（不置 undefined），releaseOutcome=failed。
   */
  const settle = (
    h: IndexLockHandle,
    fiber?: Fiber.RuntimeFiber<void, never>,
  ): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      let passFailure: string | null = null;
      if (fiber) {
        const exit = yield* Fiber.await(fiber);
        passFiber = undefined;
        passAbort = undefined;
        if (Exit.isFailure(exit)) {
          const failure = Option.getOrUndefined(Cause.failureOption(exit.cause)) as
            | (Error & { _tag?: string })
            | undefined;
          passFailure = failure ? describeCause(failure) || (failure._tag ?? "Failure") : "pass 被 interrupt";
        }
      }
      // 清状态文件必须在仍持锁时做；失败不阻塞释放（释放优先），但向外播报
      yield* deps.port.clearOwnerStatus(deps.root).pipe(
        Effect.catchAll((error) => Effect.sync(() => deps.notify(`owner 状态文件清理失败：${error.cause}`, "warning"))),
      );
      const released = yield* h.release.pipe(Effect.either);
      if (released._tag === "Left") {
        releaseOutcome = "failed";
        setError(`释放索引锁失败：${released.left.cause}`, "error");
        return;
      }
      handle = undefined;
      releaseOutcome = "ok";
      if (paused) {
        setState({ kind: "paused" });
      } else if (passFailure) {
        setError(`会话索引异常终止：${passFailure}`, "error");
      } else if (lastError) {
        setState({ kind: "error", message: lastError });
      } else {
        setState({ kind: "idle" });
      }
    });

  /** 释放失败后的重试入口：句柄还在就再试一次 release，成功才清句柄、置 ok。 */
  const retryRelease: Effect.Effect<void, never> = Effect.gen(function* () {
    const h = handle;
    if (!h) return;
    const released = yield* h.release.pipe(Effect.either);
    if (released._tag === "Left") {
      releaseOutcome = "failed";
      setError(`释放索引锁失败（重试）：${released.left.cause}`, "error");
      return;
    }
    handle = undefined;
    releaseOutcome = "ok";
    deps.notify("索引锁重试释放成功。", "info");
  });

  /** 释放确认后的固定收尾：状态、通知、backoff（只有 releaseOutcome=ok 才有效果）。 */
  const finishReleased: Effect.Effect<void, never> = Effect.gen(function* () {
    if (releaseOutcome !== "ok") return;
    setState({ kind: "released" });
    deps.notify("已释放会话索引锁，本实例暂停索引竞争；/session-index resume 可恢复。", "info");
    yield* deps.port.releaseBackoff(deps.root, deps.owner).pipe(
      Effect.catchAll((error) => Effect.sync(() => deps.notify(`暂退标记失败：${error.cause}`, "warning"))),
    );
  });

  /** 自身释放：取消 → 等周期收尾 →（若句柄仍残留）重试释放 → 只有确认成功才算已释放。 */
  const releaseSelf: Effect.Effect<void, never> = Effect.gen(function* () {
    selfReleased = true;
    paused = true;
    passAbort?.abort();
    yield* joinCycle;
    if (releaseOutcome === "none") {
      // 周期内锁就没落到本实例手上（如 acquire 返回 null）
      deps.notify("锁已不在本实例，无需释放。", "info");
      return;
    }
    yield* retryRelease;
    yield* finishReleased;
  });

  const tryRunPass: Effect.Effect<void, never> = Effect.gen(function* () {
    // 句柄残留 = 上次释放失败锁仍在手上：不重新 acquire，先走 poll/release 的重试路径
    if (shutdown || paused || busy || handle) return;
    busy = true;
    cycleDone = yield* Deferred.make<void>();
    yield* Effect.forkDaemon(runCycle);
  });

  /** 非持有者：向 owner 发定向释放请求；请求不是 ack，响应靠 poll。 */
  const requestOwnerRelease: Effect.Effect<void, never> = Effect.gen(function* () {
    const ownerInfo = yield* deps.port.readOwnerInfo(deps.root).pipe(Effect.either);
    if (ownerInfo._tag === "Left") {
      setError(`读取 owner 状态失败：${ownerInfo.left.cause}`);
      return;
    }
    if (!ownerInfo.right) {
      // 状态文件缺失只说明未发现持锁者信息，不能断言当前无锁
      deps.notify("未发现持锁者信息，未发释放请求。", "info");
      return;
    }
    if (ownerInfo.right.owner === deps.owner) {
      deps.notify("锁由本实例持有但无在途索引任务。", "info");
      return;
    }
    const result = yield* deps.port.requestRelease(deps.root, deps.owner, ownerInfo.right.owner).pipe(Effect.either);
    if (result._tag === "Left") {
      setError(`发布释放请求失败：${result.left.cause}`);
      return;
    }
    requestTs = deps.now();
    requestId = result.right;
    setState({ kind: "releaseRequested" });
    deps.notify(`已向 owner ${ownerInfo.right.owner} 发出释放请求，等待响应。`, "info");
  });

  const release: Effect.Effect<void, never> = Effect.gen(function* () {
    if (releasePending) return;
    if (busy || handle) {
      // 持锁（含释放失败残留）：走收尾 + 重试路径
      releasePending = true;
      yield* releaseSelf.pipe(Effect.ensuring(Effect.sync(() => { releasePending = false; })));
      return;
    }
    // 在途请求（未超时）不重复发；已释放/已暂停则本就不持锁
    if (state.kind === "releaseRequested") {
      deps.notify("释放请求已在途，等待 owner 响应。", "info");
      return;
    }
    if (state.kind === "released" || state.kind === "paused") {
      deps.notify("本实例已不在持有索引锁。", "info");
      return;
    }
    // idle / unresponded / error：首次发布或未获响应后重新发布
    releasePending = true;
    yield* requestOwnerRelease.pipe(Effect.ensuring(Effect.sync(() => { releasePending = false; })));
  });

  const resume: Effect.Effect<void, never> = Effect.gen(function* () {
    if (handle) {
      // 释放失败的残留句柄：先重试释放，可靠释放前不恢复竞争
      yield* retryRelease;
      if (releaseOutcome !== "ok") {
        deps.notify("锁尚未可靠释放，恢复被拒绝；请继续 /session-index release 或排查错误。", "warning");
        return;
      }
    }
    paused = false;
    selfReleased = false;
    requestId = "";
    lastError = null;
    setState({ kind: "idle" });
    deps.notify("会话索引已恢复竞争。", "info");
    yield* tryRunPass;
  });

  /** 与完成事件同频轮询（pass 运行期间也执行）：owner 应释放请求；请求方核对 released。 */
  const pollHandoff: Effect.Effect<void, never> = Effect.gen(function* () {
    const pending = yield* deps.port.pendingReleaseRequests(deps.root, deps.owner).pipe(Effect.either);
    if (pending._tag === "Left") {
      setError(`查询释放请求失败：${pending.left.cause}`);
    } else if (pending.right.length > 0) {
      if (handle) {
        if (passFiber) {
          // pass 在途：完整收尾（取消 + settle + release）
          yield* releaseSelf;
        } else {
          // pass 已 settle 但上次释放失败：句柄仍在，重试释放
          yield* retryRelease;
        }
        if (releaseOutcome === "ok") {
          for (const request of pending.right) {
            const marked = yield* deps.port.markReleased(deps.root, request.id).pipe(Effect.either);
            if (marked._tag === "Left") setError(`标记已释放失败：${marked.left.cause}`, "error");
          }
        } else {
          deps.notify("释放仍未成功，未标记请求为已释放；锁仍在本实例手上。", "error");
        }
      } else {
        // 已确认不持锁（如 pass 刚自然结束）：直接应答，不误报尚持有；自己暂停到 resume
        paused = true;
        setState({ kind: "paused" });
        for (const request of pending.right) {
          const marked = yield* deps.port.markReleased(deps.root, request.id).pipe(Effect.either);
          if (marked._tag === "Left") setError(`标记已释放失败：${marked.left.cause}`, "error");
        }
        deps.notify("收到定向释放请求：本实例已不在持锁，已应答并暂停竞争；/session-index resume 可恢复。", "info");
      }
    }
    // 请求方侧：只有 released 才认；超时只是提示，继续观察迟到的确认
    if (requestId && (state.kind === "releaseRequested" || state.kind === "unresponded")) {
      const status = yield* deps.port.readRequestStatus(deps.root, requestId).pipe(Effect.either);
      if (status._tag === "Left") {
        deps.notify(`查询释放请求状态失败：${status.left.cause}`, "warning");
      } else if (status.right === "released") {
        yield* deps.port.deleteRequest(deps.root, requestId);
        requestId = "";
        setState({ kind: "released" });
        deps.notify("owner 已释放索引锁。", "info");
        yield* tryRunPass;
      } else if (deps.now() - requestTs > deps.requestTimeoutMs) {
        setState({ kind: "unresponded" });
      }
    }
  });

  const shutdownNow: Effect.Effect<void, never> = Effect.gen(function* () {
    shutdown = true;
    paused = false;
    passAbort?.abort();
    yield* joinCycle;
    // 释放失败残留句柄：退出前最后重试一次
    if (handle) yield* retryRelease;
    if (releaseOutcome === "failed") return; // 保留 error 状态
    setState({ kind: "idle" });
  });

  return {
    tryRunPass,
    release,
    resume,
    pollHandoff,
    shutdown: shutdownNow,
    joinCycle,
    state: (): LifecycleState => {
      if (state.kind === "releaseRequested" && deps.now() - requestTs > deps.requestTimeoutMs) {
        return { kind: "unresponded" };
      }
      return state;
    },
    paused: (): boolean => paused,
  };
};

export type SessionIndexLifecycle = ReturnType<typeof createLifecycle>;
