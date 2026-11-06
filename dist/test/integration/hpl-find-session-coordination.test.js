/**
 * coordination.ts 跨进程集成测试：全部用真实子进程验证锁竞争、交接、
 * 强杀重获、SIGSTOP、损坏 DB 显式失败、外来连接不可偷锁、并发补建队列不丢。
 * 临时目录自建自清，不碰用户索引。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { acquireIndexLockEffect, CoordinationError, LOCK_DB_FILE, consumeRebuildRequests, deleteReleaseRequestEffect, isSqliteBusy, pendingReleaseRequestsForOwnerEffect, readCompletionEventsSince, requestRebuild, requestReleaseEffect, } from "../../extensions/hpl-find-session/coordination.js";
const COORDINATION_JS = fileURLToPath(new URL("../../extensions/hpl-find-session/coordination.js", import.meta.url));
/** 子进程 worker：抢锁→按指令持有/释放/被杀，stdout 逐行输出 JSON 结果。 */
const WORKER_SRC = `
import { Effect } from "effect";
import {
  acquireIndexLockEffect,
  markReleaseBackoffEffect,
  markReleaseRequestReleasedEffect,
  pendingReleaseRequestsForOwnerEffect,
} from ${JSON.stringify(COORDINATION_JS)};
const [root, owner, mode, holdMs] = process.argv.slice(1);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
Effect.runPromise(
  Effect.gen(function* () {
    const handle = yield* acquireIndexLockEffect(root, owner);
    if (!handle) { emit({ event: "acquire", ok: false }); return; }
    emit({ event: "acquire", ok: true });
    if (mode === "release") {
      yield* handle.release();
      emit({ event: "released" });
      return;
    }
    if (mode === "serve") {
      for (let i = 0; i < 100; i++) {
        const reqs = yield* Effect.orDie(pendingReleaseRequestsForOwnerEffect(root, owner));
        if (reqs.length > 0) {
          for (const r of reqs) yield* Effect.orDie(markReleaseRequestReleasedEffect(root, r.id));
          yield* Effect.orDie(markReleaseBackoffEffect(root, owner));
          yield* handle.release();
          emit({ event: "released", served: reqs.map((r) => r.id) });
          return;
        }
        yield* Effect.sleep(20);
      }
      yield* handle.release();
      emit({ event: "released", served: [] });
      return;
    }
    yield* Effect.sleep(Number(holdMs ?? 30000));
    yield* handle.release();
    emit({ event: "released" });
  }),
).catch((e) => { emit({ event: "error", message: String(e) }); process.exit(1); });
`;
function startWorker(root, owner, mode, holdMs) {
    const worker = {
        child: spawn(process.execPath, ["--input-type=module", "-e", WORKER_SRC, root, owner, mode, String(holdMs ?? "")], {
            stdio: ["ignore", "pipe", "inherit"],
        }),
        lines: [],
        output: () => worker.lines.join("\n"),
        wait: (event, timeoutMs = 10_000) => new Promise((resolve, reject) => {
            let buffer = "";
            const timer = setTimeout(() => {
                worker.child.stdout.off("data", onData);
                reject(new Error(`等待 ${event} 超时；子进程输出：\n${worker.output()}`));
            }, timeoutMs);
            const onData = (chunk) => {
                buffer += chunk.toString();
                let idx;
                while ((idx = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 1);
                    if (!line)
                        continue;
                    worker.lines.push(line);
                    const parsed = JSON.parse(line);
                    if (parsed.event === event) {
                        clearTimeout(timer);
                        worker.child.stdout.off("data", onData);
                        resolve(parsed);
                    }
                }
            };
            worker.child.stdout.on("data", onData);
        }),
    };
    return worker;
}
/** 单次抢锁尝试的独立短命进程，返回 {acquired} 或抛错信息。 */
function tryAcquire(root, owner) {
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", WORKER_SRC, root, owner, "hold", "500"], {
        encoding: "utf8",
        timeout: 15_000,
    });
    const lines = probe.stdout.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const acquire = lines.find((l) => l.event === "acquire");
    const error = lines.find((l) => l.event === "error");
    return { acquired: acquire?.ok === true, error: error?.message };
}
const runEffect = (effect) => {
    const result = Effect.runSync(Effect.either(effect));
    if (result._tag === "Left")
        throw result.left;
    return result.right;
};
const runEffectResult = (effect) => {
    const result = Effect.runSync(Effect.either(effect));
    return result._tag === "Left" ? result.left : result.right;
};
describe("hpl-find-session coordination（跨进程）", () => {
    let root;
    before(() => {
        root = mkdtempSync(join(tmpdir(), "hapilon-find-session-coord-"));
    });
    after(() => {
        rmSync(root, { recursive: true, force: true });
    });
    it("busy 判定按 SQLite errcode 低 8 位：5 归忙，其他错误码与 busy 文案不混判", () => {
        assert.equal(isSqliteBusy(Object.assign(new Error("SQLITE_BUSY: database is locked"), { errcode: 5 })), true);
        assert.equal(isSqliteBusy(Object.assign(new Error("SQLITE_BUSY_SNAPSHOT"), { errcode: 517 })), true, "extended 5xxx 低 8 位为 5");
        assert.equal(isSqliteBusy(Object.assign(new Error("SQLITE_CORRUPT"), { errcode: 11 })), false, "损坏不是忙");
        assert.equal(isSqliteBusy(Object.assign(new Error("database is locked"), { errcode: 1 })), false, "errcode 优先于文案");
        assert.equal(isSqliteBusy(new Error("database is locked")), true, "无 errcode 时按文案兑底");
        assert.equal(isSqliteBusy(new Error("permission denied")), false);
    });
    it("同进程双连接争锁：恰一个 handle、一个 null、无 error；原始第二连接 BEGIN 得 errcode 5", async () => {
        const first = runEffect(acquireIndexLockEffect(root, "holder-a"));
        assert.ok(first, "先到者必须拿到 handle");
        try {
            const second = runEffectResult(acquireIndexLockEffect(root, "holder-b"));
            assert.ok(!(second instanceof CoordinationError), `竞争不得报错：${second instanceof CoordinationError ? second.cause : ""}`);
            assert.equal(second, null, "后到者必须是 null（正常忙），而非错误或误抢");
            const { DatabaseSync } = await import("node:sqlite");
            const raw = new DatabaseSync(join(root, LOCK_DB_FILE));
            raw.exec("PRAGMA busy_timeout = 0");
            assert.throws(() => raw.exec("BEGIN IMMEDIATE"), (e) => isSqliteBusy(e) && e.errcode === 5, "原始第二连接必须得 SQLITE_BUSY errcode 5");
            raw.close();
        }
        finally {
            runEffect(first.release());
        }
        const again = runEffect(acquireIndexLockEffect(root, "holder-b"));
        assert.ok(again, "释放后另一 owner 应拿到 handle");
        runEffect(again.release());
    });
    it("两个进程同时抢锁只有一个赢，释放后另一进程交接", async () => {
        const first = startWorker(root, "owner-a", "hold", 30_000);
        await first.wait("acquire");
        const busy = tryAcquire(root, "owner-b");
        assert.equal(busy.acquired, false, "锁被 A 持有时 B 应拿不到");
        assert.equal(busy.error, undefined, `B 忙等不得伴随 error：${busy.error ?? ""}`);
        assert.equal(tryAcquire(root, "owner-c").error, undefined, "并发竞争探针不得产生 error");
        first.child.kill("SIGTERM");
        // SIGTERM 是干净退出路径吗？worker 没装信号处理，默认终止 → fd 关闭 → OS 释放
        await new Promise((r) => first.child.on("exit", r));
        assert.equal(tryAcquire(root, "owner-b").acquired, true, "A 退出后 B 应能拿到锁");
    });
    it("显式 release 后锁立即交接", async () => {
        const holder = startWorker(root, "owner-a", "release");
        await holder.wait("released");
        assert.equal(tryAcquire(root, "owner-b").acquired, true);
    });
    it("强杀（SIGKILL）后 OS 释放锁，其他进程可重获", async () => {
        const holder = startWorker(root, "owner-a", "hold", 60_000);
        await holder.wait("acquire");
        holder.child.kill("SIGKILL");
        await new Promise((r) => holder.child.on("exit", r));
        assert.equal(tryAcquire(root, "owner-b").acquired, true, "强杀后连接被 OS 关闭，B 应能拿到锁");
    });
    it("SIGSTOP 卡死的活进程不可被抢锁；恢复后释放即可交接", { skip: process.platform === "win32" }, async () => {
        const holder = startWorker(root, "owner-a", "hold", 60_000);
        await holder.wait("acquire");
        holder.child.kill("SIGSTOP");
        await new Promise((r) => setTimeout(r, 100));
        const stopped = tryAcquire(root, "owner-b");
        assert.equal(stopped.acquired, false, "卡死活进程的事务仍在，不能被抢");
        assert.equal(stopped.error, undefined, "SIGSTOP 下的争锁是正常忙，不得报错");
        holder.child.kill("SIGCONT");
        await new Promise((r) => setTimeout(r, 100));
        holder.child.kill("SIGTERM");
        await new Promise((r) => holder.child.on("exit", r));
        assert.equal(tryAcquire(root, "owner-b").acquired, true);
    });
    it("DB 文件损坏时显式失败（CoordinationError），不静默无锁继续", () => {
        const corruptRoot = mkdtempSync(join(tmpdir(), "hapilon-find-session-corrupt-"));
        try {
            writeFileSync(join(corruptRoot, LOCK_DB_FILE), "this is not a sqlite database".repeat(20));
            const result = Effect.runSync(Effect.either(acquireIndexLockEffect(corruptRoot, "owner-a")));
            assert.equal(result._tag, "Left", "损坏 DB 必须返回 typed 错误");
            if (result._tag === "Left")
                assert.ok(result.left instanceof CoordinationError);
        }
        finally {
            rmSync(corruptRoot, { recursive: true, force: true });
        }
    });
    it("锁 DB 所在位置无权限时显式失败（无法创建 DB）", () => {
        if (typeof process.getuid === "function" && process.getuid() === 0)
            return; // root 下 chmod 无效
        const readonlyRoot = mkdtempSync(join(tmpdir(), "hapilon-find-session-readonly-"));
        try {
            // macOS 对已存在 DB 撤权限仍能延迟打开写句柄，故撤目录写权限断「建不了 DB」这条确定性路径
            chmodSync(readonlyRoot, 0o555);
            const result = Effect.runSync(Effect.either(acquireIndexLockEffect(readonlyRoot, "owner-b")));
            assert.equal(result._tag, "Left", "无写权限必须显式失败");
            if (result._tag === "Left")
                assert.ok(result.left instanceof CoordinationError);
        }
        finally {
            chmodSync(readonlyRoot, 0o755);
            rmSync(readonlyRoot, { recursive: true, force: true });
        }
    });
    it("外来连接在他人持锁期间写不进去（偷不了锁）", async () => {
        const holder = startWorker(root, "owner-a", "hold", 30_000);
        await holder.wait("acquire");
        try {
            const { DatabaseSync } = await import("node:sqlite");
            const foreign = new DatabaseSync(join(root, LOCK_DB_FILE));
            foreign.exec("PRAGMA busy_timeout = 0");
            assert.throws(() => foreign.exec("BEGIN IMMEDIATE"), /SQLITE_BUSY|database is locked/, "外来连接拿不到写事务");
            foreign.close();
        }
        finally {
            holder.child.kill("SIGKILL");
            await new Promise((r) => holder.child.on("exit", r));
        }
    });
    it("定向释放请求：持有者响应后状态 pending→released，暂退窗口内不抢回，等待者赢", async () => {
        const holder = startWorker(root, "owner-c", "serve");
        await holder.wait("acquire");
        const requestId = runEffect(requestReleaseEffect(root, "owner-c", "main"));
        const released = (await holder.wait("released"));
        assert.deepEqual(released.served, [requestId], "持有者应消费到定向请求");
        assert.equal(tryAcquireResult(root, "owner-d"), true, "已释放后等待者应赢下竞争");
        // 暂退窗口内 owner-c 自己不抢回
        assert.equal(tryAcquireResult(root, "owner-c"), false, "释放后暂退窗口内不应立刻抢回");
        // 请求状态已被持有者标为 released；发布者确认后删除自己的请求文件
        assert.equal(readFileSync(join(root, "coordination", "release-requests", `${requestId}.json`), "utf8").includes('"released"'), true);
        runEffect(deleteReleaseRequestEffect(root, requestId));
        assert.throws(() => readFileSync(join(root, "coordination", "release-requests", `${requestId}.json`), "utf8"), /ENOENT/);
    });
    it("释放请求文件 Schema 损坏时显式失败，不吞成空列表", () => {
        const badRoot = mkdtempSync(join(tmpdir(), "hapilon-find-session-badschema-"));
        try {
            mkdirSync(join(badRoot, "coordination", "release-requests"), { recursive: true });
            writeFileSync(join(badRoot, "coordination", "release-requests", "bad.json"), "{ id: 123, broken");
            const result = runEffectResult(pendingReleaseRequestsForOwnerEffect(badRoot, "owner-x"));
            assert.ok(result instanceof CoordinationError, `损坏请求必须报错，实际：${String(result)}`);
        }
        finally {
            rmSync(badRoot, { recursive: true, force: true });
        }
    });
    it("释放请求目录无权限时显式失败（root 跳过）", () => {
        if (typeof process.getuid === "function" && process.getuid() === 0)
            return;
        const permRoot = mkdtempSync(join(tmpdir(), "hapilon-find-session-perm-"));
        try {
            const dir = join(permRoot, "coordination", "release-requests");
            mkdirSync(dir, { recursive: true });
            chmodSync(dir, 0o000);
            const result = runEffectResult(pendingReleaseRequestsForOwnerEffect(permRoot, "owner-x"));
            chmodSync(dir, 0o755);
            assert.ok(result instanceof CoordinationError, `无权限必须报错，实际：${String(result)}`);
        }
        finally {
            rmSync(permRoot, { recursive: true, force: true });
        }
    });
    it("完成事件文件损坏显式抛错；缺失正常返回空；deleteReleaseRequest 仅 ENOENT 幂等", () => {
        const evRoot = mkdtempSync(join(tmpdir(), "hapilon-find-session-ev-"));
        try {
            assert.deepEqual(readCompletionEventsSince(evRoot, 0), [], "事件文件缺失返回空");
            mkdirSync(join(evRoot, "coordination"), { recursive: true });
            writeFileSync(join(evRoot, "coordination", "latest-event.json"), "not json at all");
            assert.throws(() => readCompletionEventsSince(evRoot, 0), CoordinationError, "损坏事件必须显式抛错");
            runEffect(deleteReleaseRequestEffect(evRoot, "never-existed"));
            const result = runEffectResult(acquireIndexLockEffect(evRoot, "owner-final"));
            assert.ok(!(result instanceof CoordinationError) && result !== null);
            runEffect(result.release());
        }
        finally {
            rmSync(evRoot, { recursive: true, force: true });
        }
    });
    it("补建请求文件损坏时消费显式失败，不静默清走", () => {
        const badRebuildRoot = mkdtempSync(join(tmpdir(), "hapilon-find-session-badrebuild-"));
        try {
            mkdirSync(join(badRebuildRoot, "coordination", "rebuild-requests"), { recursive: true });
            writeFileSync(join(badRebuildRoot, "coordination", "rebuild-requests", "bad.json"), "}{");
            assert.throws(() => consumeRebuildRequests(badRebuildRoot), CoordinationError);
        }
        finally {
            rmSync(badRebuildRoot, { recursive: true, force: true });
        }
    });
    it("并发补建请求队列不丢：多进程同时发布，一次消费全量收集", async () => {
        const allPaths = new Set();
        const writers = [1, 2, 3].map((n) => spawnSync(process.execPath, ["--input-type=module", "-e", WORKER_REBUILD_SRC, root, `writer-${n}`], { encoding: "utf8" }));
        for (const w of writers)
            assert.equal(w.status, 0, w.stderr);
        for (let i = 0; i < 30; i++) {
            const p = `${root}/session-${i}.jsonl`;
            allPaths.add(p);
            requestRebuild(root, [p]);
        }
        const consumed = consumeRebuildRequests(root);
        assert.equal(new Set(consumed).size, consumed.length, "消费结果无重复");
        for (const p of allPaths)
            assert.ok(consumed.includes(p), `请求 ${p} 不应丢失`);
        assert.deepEqual(consumeRebuildRequests(root), [], "消费后队列清空");
    });
    it("回滚失败但 close 成功：release 应成功并告警，另一连接可拿锁（node:sqlite 支持）", { skip: Number(process.versions.node.split(".")[0]) < 22 }, async () => {
        const { DatabaseSync: DS } = await import("node:sqlite");
        const origExec = DS.prototype.exec;
        DS.prototype.exec = function (sql) {
            if (sql === "ROLLBACK")
                throw new Error("mock rollback failure");
            return origExec.call(this, sql);
        };
        const warnings = [];
        const origWarn = console.warn;
        console.warn = (msg) => warnings.push(String(msg));
        try {
            const handle = runEffect(acquireIndexLockEffect(root, "mock-owner-a"));
            assert.ok(handle, "注入前必须拿到 handle");
            const result = Effect.runSync(Effect.either(handle.release()));
            assert.equal(result._tag, "Right", `close 成功时 release 不得失败：${result._tag === "Left" ? result.left.cause : ""}`);
            assert.ok(warnings.some((w) => w.includes("回滚失败") && w.includes("mock-owner-a")), `回滚失败必须显式告警，实际告警：${JSON.stringify(warnings)}`);
        }
        finally {
            DS.prototype.exec = origExec;
            console.warn = origWarn;
        }
        // OS 层锁已随 close 释放：另一连接应能拿到锁（修复前的缺陷是永远 database is not open）
        assert.equal(tryAcquireResult(root, "mock-owner-b"), true, "close 成功后锁应视为已释放");
    });
    it("close 失败：release 仍显式报错，不得假成功", async () => {
        const { DatabaseSync: DS } = await import("node:sqlite");
        const origClose = DS.prototype.close;
        DS.prototype.close = function () {
            throw new Error("mock close failure");
        };
        try {
            const handle = runEffect(acquireIndexLockEffect(root, "mock-owner-c"));
            assert.ok(handle);
            const result = Effect.runSync(Effect.either(handle.release()));
            assert.equal(result._tag, "Left", "close 失败必须返回 typed 错误");
            if (result._tag === "Left") {
                assert.ok(result.left instanceof CoordinationError);
                assert.ok(result.left.cause.includes("mock close failure"), `错误须含 close 失败原因：${result.left.cause}`);
            }
        }
        finally {
            DS.prototype.close = origClose;
        }
    });
    it("正常重复 release 维持既有契约：显式错误", () => {
        const handle = runEffect(acquireIndexLockEffect(root, "mock-owner-d"));
        assert.ok(handle);
        runEffect(handle.release());
        const second = runEffectResult(handle.release());
        assert.ok(second instanceof CoordinationError, `重复释放必须显式报错，实际：${String(second)}`);
    });
});
function tryAcquireResult(root, owner) {
    const handle = runEffect(acquireIndexLockEffect(root, owner));
    if (!handle)
        return false;
    runEffect(handle.release());
    return true;
}
const WORKER_REBUILD_SRC = `
import { requestRebuild } from ${JSON.stringify(COORDINATION_JS)};
const [root, name] = process.argv.slice(1);
for (let i = 0; i < 10; i++) requestRebuild(root, [\`\${root}/session-\${i}.jsonl\`]);
`;
