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
import { acquireIndexLockEffect, deleteReleaseRequestEffect, markReleaseBackoffEffect, markReleaseRequestReleasedEffect, pendingReleaseRequestsForOwnerEffect, requestReleaseEffect, CoordinationError, } from "./coordination.js";
function writeJsonAtomic(file, data) {
    const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
}
function ownerStatusFile(root) {
    return join(root, "indexer-owner.json");
}
const OwnerStatusSchema = Schema.Struct({ owner: Schema.String, ts: Schema.optional(Schema.Number) });
const RequestStatusSchema = Schema.Struct({ status: Schema.Literal("pending", "released") });
const describeFsCause = (cause) => (cause instanceof Error ? cause.message : String(cause));
const formatSchemaError = (error) => Array.isArray(error) && error.length > 0 && "message" in (error[0] ?? {})
    ? String(error[0].message)
    : String(error);
function requestFile(root, id) {
    return join(root, "coordination", "release-requests", `${id}.json`);
}
function writeOwnerStatusFile(root, owner) {
    return Effect.try({
        try: () => {
            const file = ownerStatusFile(root);
            if (owner === null) {
                try {
                    unlinkSync(file);
                }
                catch {
                    // 已不存在即已清理
                }
            }
            else {
                const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
                writeFileSync(tmp, JSON.stringify({ owner, ts: Date.now() }));
                renameSync(tmp, file);
            }
        },
        catch: (cause) => new CoordinationError({ cause: `owner 状态文件读写失败：${describeFsCause(cause)}` }),
    });
}
const readValidatedJson = (file, what, schema) => Effect.gen(function* () {
    let content;
    try {
        if (!existsSync(file))
            return null;
        content = readFileSync(file, "utf8");
    }
    catch (cause) {
        return yield* Effect.fail(new CoordinationError({ cause: `读取${what}失败：${describeFsCause(cause)}` }));
    }
    return yield* Schema.decodeUnknown(schema)(content).pipe(Effect.mapError((error) => new CoordinationError({ cause: `${what}内容损坏：${formatSchemaError(error)}` })));
});
const OwnerStatusDecoded = Schema.parseJson(OwnerStatusSchema);
const RequestStatusDecoded = Schema.parseJson(RequestStatusSchema);
export const sqliteCoordinationPort = {
    acquireIndexLockEffect: (root, owner) => acquireIndexLockEffect(root, owner).pipe(Effect.map((handle) => (handle ? { release: handle.release() } : null))),
    requestRelease: (root, fromOwner, targetOwner) => requestReleaseEffect(root, targetOwner, fromOwner),
    pendingReleaseRequests: (root, owner) => pendingReleaseRequestsForOwnerEffect(root, owner).pipe(Effect.map((all) => all.map(({ id, requester, ts }) => ({ id, requester, ts })))),
    markReleased: (root, id) => markReleaseRequestReleasedEffect(root, id),
    deleteRequest: (root, id) => deleteReleaseRequestEffect(root, id).pipe(Effect.catchAll(() => Effect.void)),
    readRequestStatus: (root, id) => readValidatedJson(requestFile(root, id), "释放请求", RequestStatusDecoded).pipe(Effect.map((parsed) => (parsed === null ? null : parsed.status))),
    releaseBackoff: (root, owner) => markReleaseBackoffEffect(root, owner),
    writeOwnerStatus: (root, owner) => writeOwnerStatusFile(root, owner),
    clearOwnerStatus: (root) => writeOwnerStatusFile(root, null),
    readOwnerInfo: (root) => readValidatedJson(ownerStatusFile(root), "owner 状态文件", OwnerStatusDecoded).pipe(Effect.map((parsed) => (parsed === null ? null : { owner: parsed.owner }))),
};
