/**
 * index-lock.ts — 索引锁端口：hpl-find-session 对 coordination.ts 的依赖面。
 *
 * sqlitePort 直接对接 coordination.ts 的 SQLite 锁与释放请求通道：
 * requestRelease 是请求不是 ack；持有者完成收尾后 markReleased，请求方凭 readRequestStatus
 * 区分已释放/未响应。readOwnerInfo 只供展示，不是互斥事实。
 * readRequestStatus 目前直接读请求文件（coordination/release-requests/<id>.json）——
 * coordination 尚未导出请求方侧的正式读取接口，定稿后替换（见交接报告）。
 */

import { Effect, Schema } from "effect";
import { existsSync, readFileSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  acquireIndexLockEffect,
  deleteReleaseRequestEffect,
  markReleaseBackoffEffect,
  markReleaseRequestReleasedEffect,
  pendingReleaseRequestsForOwnerEffect,
  requestReleaseEffect,
  CoordinationError,
  type IndexLockHandle as CoordinationHandle,
} from "./coordination.js";

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

/** 请求方侧看到的请求状态；null = 请求文件不存在（已删或从未发出） */
export type RequestStatus = "pending" | "released";

export interface ReleaseRequestRef {
  readonly id: string;
  readonly requester: string;
  readonly ts: number;
}

export interface IndexLockHandle {
  readonly release: Effect.Effect<void, CoordinationError>;
}

export interface IndexLockPort {
  /** null = 锁被其他实例持有（含自己在暂退窗口内） */
  readonly acquireIndexLockEffect: (root: string, owner: string) => Effect.Effect<IndexLockHandle | null, CoordinationError>;
  /** 向 targetOwner 发布定向释放请求，返回请求 id；请求本身不构成释放 */
  readonly requestRelease: (root: string, fromOwner: string, targetOwner: string) => Effect.Effect<string, CoordinationError>;
  /** owner 侧：定向到自己、仍未响应的请求 */
  readonly pendingReleaseRequests: (root: string, owner: string) => Effect.Effect<ReleaseRequestRef[], CoordinationError>;
  /** owner 完成收尾（取消模型、当前写落盘、释放事务）后标记 released */
  readonly markReleased: (root: string, id: string) => Effect.Effect<void, CoordinationError>;
  /** 请求方确认后清理自己的请求文件；清理失败不阻塞 */
  readonly deleteRequest: (root: string, id: string) => Effect.Effect<void, never>;
  /** 请求方轮询自己的请求状态 */
  /** 请求方轮询自己的请求状态；仅 ENOENT 返回 null，损坏/权限是真实错误 */
  readonly readRequestStatus: (root: string, id: string) => Effect.Effect<RequestStatus | null, CoordinationError>;
  /** owner 释放后的暂退标记（coordination 侧窗口，让等待者赢竞争） */
  readonly releaseBackoff: (root: string, owner: string) => Effect.Effect<void, CoordinationError>;
  /** 本扩展自己的 owner 状态文件（不读锁 DB、不与锁 worker 文件重叠）：acquire 成功后写 */
  readonly writeOwnerStatus: (root: string, owner: string) => Effect.Effect<void, CoordinationError>;
  /** 释放后清理状态文件 */
  readonly clearOwnerStatus: (root: string) => Effect.Effect<void, CoordinationError>;
  /** 仅展示用：当前锁归属（读状态文件，Schema 校验）；仅 ENOENT 返回 null，损坏/权限是真实错误 */
  readonly readOwnerInfo: (root: string) => Effect.Effect<{ readonly owner: string } | null, CoordinationError>;
}

function ownerStatusFile(root: string): string {
  return join(root, "indexer-owner.json");
}

const OwnerStatusSchema = Schema.Struct({ owner: Schema.String, ts: Schema.optional(Schema.Number) });
const RequestStatusSchema = Schema.Struct({ status: Schema.Literal("pending", "released") });

const describeFsCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const formatSchemaError = (error: unknown): string =>
  Array.isArray(error) && error.length > 0 && "message" in (error[0] ?? {})
    ? String((error[0] as { message: unknown }).message)
    : String(error);

function requestFile(root: string, id: string): string {
  return join(root, "coordination", "release-requests", `${id}.json`);
}

function writeOwnerStatusFile(root: string, owner: string | null): Effect.Effect<void, CoordinationError> {
  return Effect.try({
    try: () => {
      const file = ownerStatusFile(root);
      if (owner === null) {
        try {
          unlinkSync(file);
        } catch {
          // 已不存在即已清理
        }
      } else {
        const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
        writeFileSync(tmp, JSON.stringify({ owner, ts: Date.now() }));
        renameSync(tmp, file);
      }
    },
    catch: (cause) => new CoordinationError({ cause: `owner 状态文件读写失败：${describeFsCause(cause)}` }),
  });
}
const readValidatedJson = <A>(
  file: string,
  what: string,
  schema: Schema.Schema<A, string, never>,
): Effect.Effect<A | null, CoordinationError> =>
  Effect.gen(function* () {
    let content: string;
    try {
      if (!existsSync(file)) return null;
      content = readFileSync(file, "utf8");
    } catch (cause) {
      return yield* Effect.fail(new CoordinationError({ cause: `读取${what}失败：${describeFsCause(cause)}` }));
    }
    return yield* Schema.decodeUnknown(schema)(content).pipe(
      Effect.mapError((error) => new CoordinationError({ cause: `${what}内容损坏：${formatSchemaError(error)}` })),
    );
  });

const OwnerStatusDecoded = Schema.parseJson(OwnerStatusSchema);
const RequestStatusDecoded = Schema.parseJson(RequestStatusSchema);

export const sqliteCoordinationPort: IndexLockPort = {
  acquireIndexLockEffect: (root, owner) =>
    acquireIndexLockEffect(root, owner).pipe(
      Effect.map((handle: CoordinationHandle | null) => (handle ? { release: handle.release() } : null)),
    ),
  requestRelease: (root, fromOwner, targetOwner) => requestReleaseEffect(root, targetOwner, fromOwner),
  pendingReleaseRequests: (root, owner) =>
    pendingReleaseRequestsForOwnerEffect(root, owner).pipe(
      Effect.map((all) => all.map(({ id, requester, ts }) => ({ id, requester, ts }))),
    ),
  markReleased: (root, id) => markReleaseRequestReleasedEffect(root, id),
  deleteRequest: (root, id) => deleteReleaseRequestEffect(root, id).pipe(Effect.catchAll(() => Effect.void)),
  readRequestStatus: (root, id) =>
    readValidatedJson(requestFile(root, id), "释放请求", RequestStatusDecoded).pipe(
      Effect.map((parsed) => (parsed === null ? null : parsed.status)),
    ),
  releaseBackoff: (root, owner) => markReleaseBackoffEffect(root, owner),
  writeOwnerStatus: (root, owner) => writeOwnerStatusFile(root, owner),
  clearOwnerStatus: (root) => writeOwnerStatusFile(root, null),
  readOwnerInfo: (root) =>
    readValidatedJson(ownerStatusFile(root), "owner 状态文件", OwnerStatusDecoded).pipe(
      Effect.map((parsed) => (parsed === null ? null : { owner: parsed.owner })),
    ),
};
