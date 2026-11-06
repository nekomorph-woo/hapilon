/**
 * coordination.ts — 跨进程协调：SQLite 单写者锁、完成事件（单条最新）、
 * 补建请求队列（per-request 文件）、锁释放请求通道。
 *
 * 锁规则：持有者对 index.lock.db 持 BEGIN IMMEDIATE 写事务（busy_timeout=0，
 * SQLITE_BUSY=errcode 5 视为正常忙，其余一律 typed 错误），进程崩溃由 OS 关闭
 * 连接、SQLite 回滚自动释放锁；卡死的活进程持有的事务无法被其他进程解锁——
 * 这是设计取舍，不做强制解锁入口。BEGIN 事务本身就排他，锁 DB 不建表不写行；
 * 释放 = ROLLBACK + close；close 成功即锁已释放，回滚失败降为 notify warning（不吞），close 失败才报错。
 * 每个 handle 只释放自己的连接；不删除、不替换锁 DB，不改 journal 模式。
 * 锁 DB 不写业务数据；跨进程 JSON 边界一律过 Effect Schema，损坏/权限显式失败，
 * 仅 ENOENT 这类明确缺失按正常缺席处理。
 */

import { Data, Effect, Schema } from "effect";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { notify } from "../notify.js";

export class CoordinationError extends Data.TaggedError("CoordinationError")<{ readonly cause: string }> {}

const errMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

function isEnoent(cause: unknown): boolean {
  return (cause as { code?: unknown } | null)?.code === "ENOENT";
}

// ── 目录与路径 ────────────────────────────────────────────────────────

export const LOCK_DB_FILE = "index.lock.db";
const COORD_DIR = "coordination";
const RELEASE_DIR = "release-requests";
const REBUILD_DIR = "rebuild-requests";
const BACKOFF_DIR = "backoff";
const LATEST_EVENT_FILE = "latest-event.json";

/** 释放锁后的暂退窗口：自己刚释放就不立刻抢回，让等待者赢下竞争。 */
export const RELEASE_BACKOFF_MS = 15_000;

function lockDbPath(sessionsRoot: string): string {
  return join(sessionsRoot, LOCK_DB_FILE);
}

function coordDir(sessionsRoot: string, sub: string): string {
  return join(sessionsRoot, COORD_DIR, sub);
}

/** 协调相关目录都挂在 session root 下，写入前确保存在。 */
export function ensureCoordinationDirs(sessionsRoot: string): void {
  for (const sub of [RELEASE_DIR, REBUILD_DIR, BACKOFF_DIR]) {
    try {
      mkdirSync(coordDir(sessionsRoot, sub), { recursive: true });
    } catch (cause) {
      throw new CoordinationError({ cause: `创建协调目录失败（${sub}）：${errMessage(cause)}` });
    }
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
  } catch (cause) {
    throw new CoordinationError({ cause: `写入 ${file} 失败：${errMessage(cause)}` });
  }
}

/**
 * JSON 文件读取 + Schema 解码：ENOENT（仅当 allowMissing）返回 null，
 * 权限/IO 失败、JSON 损坏、Schema 不符一律 CoordinationError，绝不吞成缺省值。
 */
function readJsonFileSync<A, I>(schema: Schema.Schema<A, I>, file: string, allowMissing: boolean): A | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (cause) {
    if (allowMissing && isEnoent(cause)) return null;
    throw new CoordinationError({ cause: `读取 ${file} 失败：${errMessage(cause)}` });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new CoordinationError({ cause: `解析 ${file} 失败（非合法 JSON）：${errMessage(cause)}` });
  }
  try {
    return Schema.decodeUnknownSync(schema)(parsed);
  } catch (cause) {
    throw new CoordinationError({ cause: `${file} 内容不符合 Schema：${errMessage(cause)}` });
  }
}

// ── Schema 边界（跨进程文件 = 不可信输入） ────────────────────────────

const ReleaseRequestSchema = Schema.Struct({
  id: Schema.String,
  targetOwner: Schema.String,
  requester: Schema.optionalWith(Schema.String, { default: () => "" }),
  ts: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  status: Schema.Literal("pending", "released"),
});

const RebuildRequestSchema = Schema.Struct({
  p: Schema.String,
  ts: Schema.optionalWith(Schema.Number, { default: () => 0 }),
});

const CompletionEventSchema = Schema.Struct({
  id: Schema.String,
  ts: Schema.Number,
  scanned: Schema.Number,
  added: Schema.Number,
  updated: Schema.Number,
  failed: Schema.Number,
  remaining: Schema.Number,
  indexedTotal: Schema.Number,
  totalFiles: Schema.Number,
  noModel: Schema.optional(Schema.Boolean),
  failureCause: Schema.optional(Schema.String),
});

// ── SQLite 单写者锁 ───────────────────────────────────────────────────

export interface IndexLockHandle {
  readonly owner: string;
  /** 只释放自己这条连接持有的锁；重复释放是显式错误。 */
  readonly release: () => Effect.Effect<void, CoordinationError>;
}

/** SQLITE_BUSY=5，extended 5xxx 低 8 位同为 5；无 errcode 时按锁定文案兜底。 */
export function isSqliteBusy(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  if (typeof errcode === "number") return (errcode & 0xff) === 5;
  return error instanceof Error && /database is locked/i.test(error.message);
}

function openLockDb(sessionsRoot: string): import("node:sqlite").DatabaseSync {
  if (typeof DatabaseSync !== "function") {
    throw new CoordinationError({ cause: "node:sqlite 不可用：需要 Node ≥ 22.19.0（内置 node:sqlite），拒绝无锁继续" });
  }
  let db: import("node:sqlite").DatabaseSync;
  try {
    db = new DatabaseSync(lockDbPath(sessionsRoot));
  } catch (cause) {
    throw new CoordinationError({ cause: `打开锁 DB 失败：${errMessage(cause)}` });
  }
  // busy_timeout=0：拿不到写锁立刻 SQLITE_BUSY，不排队等待
  try {
    db.exec("PRAGMA busy_timeout = 0");
  } catch (cause) {
    let closeNote = "";
    try {
      db.close();
    } catch (closeCause) {
      closeNote = `；且关闭连接也失败：${errMessage(closeCause)}`;
    }
    throw new CoordinationError({ cause: `设置 busy_timeout 失败${closeNote}：${errMessage(cause)}` });
  }
  return db;
}

/**
 * 抢索引锁。锁空闲且自己不在暂退窗口内 → 返回 handle；他人持有（SQLITE_BUSY）→ null；
 * DB 损坏、权限等非 busy 错误 → CoordinationError，绝不静默无锁继续。
 * BEGIN IMMEDIATE 成功即持锁（写事务排他，无需锁表），崩溃随连接关闭自动释放。
 * 释放语义：close 成功 = 锁已释放的确定依据；回滚失败降为 warning 显式报告（不吞），
 * close 失败才返回 typed 错误（附回滚错误）。正常重复 release 仍是显式错误（close 已关再关必败）。
 */
export const acquireIndexLockEffect = (
  sessionsRoot: string,
  owner: string,
): Effect.Effect<IndexLockHandle | null, CoordinationError> =>
  Effect.try({
    try: () => {
      ensureCoordinationDirs(sessionsRoot);
      const backoffFile = join(coordDir(sessionsRoot, BACKOFF_DIR), `${encodeURIComponent(owner)}.json`);
      const backoff = readJsonFileSync(Schema.Struct({ until: Schema.Number }), backoffFile, true);
      if (backoff && Date.now() < backoff.until) return null;
      const db = openLockDb(sessionsRoot);
      try {
        db.exec("BEGIN IMMEDIATE");
      } catch (error) {
        let closeNote = "";
        try {
          db.close();
        } catch (closeCause) {
          closeNote = `；且关闭连接也失败：${errMessage(closeCause)}`;
        }
        if (isSqliteBusy(error)) return null;
        throw new CoordinationError({ cause: `BEGIN IMMEDIATE 失败${closeNote}：${errMessage(error)}` });
      }
      const handle: IndexLockHandle = {
        owner,
        release: () =>
          Effect.suspend(() => {
            // close 成功 = 锁已随连接释放的确定依据；回滚失败降为 warning 显式报告不吞，
            // close 失败才报 typed 错误并附上回滚错误
            let rollbackError: CoordinationError | null = null;
            return Effect.try({
              try: () => {
                db.exec("ROLLBACK");
              },
              catch: (cause) => new CoordinationError({ cause: `锁事务回滚失败（owner=${owner}）：${errMessage(cause)}` }),
            }).pipe(
              Effect.catchAll((error) => {
                rollbackError = error;
                notify(error.cause, "warning");
                return Effect.void;
              }),
              Effect.flatMap(() =>
                Effect.try({
                  try: () => {
                    db.close();
                  },
                  catch: (cause) =>
                    new CoordinationError({
                      cause: `锁连接关闭失败（owner=${owner}）${rollbackError ? `，此前回滚已失败：${rollbackError.cause}` : ""}：${errMessage(cause)}`,
                    }),
                }),
              ),
            );
          }),
      };
      return handle;
    },
    catch: (cause) =>
      cause instanceof CoordinationError
        ? cause
        : new CoordinationError({ cause: `获取索引锁失败：${errMessage(cause)}` }),
  });

// ── 锁释放请求通道（per-request 文件，不写锁 DB） ─────────────────────

export interface ReleaseRequestFile {
  id: string;
  /** 定向的目标 owner；owner 状态仅辅助展示，不是锁权威 */
  targetOwner: string;
  requester: string;
  ts: number;
  /** pending = 未响应；released = 持有者已释放 */
  status: "pending" | "released";
}

/** 等待者发布定向释放请求；原子改名发布，不碰锁 DB。 */
export const requestReleaseEffect = (
  sessionsRoot: string,
  targetOwner: string,
  requester: string,
): Effect.Effect<string, CoordinationError> =>
  Effect.try({
    try: () => {
      ensureCoordinationDirs(sessionsRoot);
      const id = `rel-${Date.now()}-${randomBytes(6).toString("hex")}`;
      writeJsonAtomic(releaseRequestFile(sessionsRoot, id), {
        id,
        targetOwner,
        requester,
        ts: Date.now(),
        status: "pending",
      } satisfies ReleaseRequestFile);
      return id;
    },
    catch: (cause) =>
      cause instanceof CoordinationError ? cause : new CoordinationError({ cause: `发布释放请求失败：${errMessage(cause)}` }),
  });

function releaseRequestFile(sessionsRoot: string, id: string): string {
  return join(coordDir(sessionsRoot, RELEASE_DIR), `${id}.json`);
}

/** 持有者侧：轮询定向到自己、仍未响应的释放请求。仅目录消失返回空；单文件竞态删除（ENOENT）跳过。 */
export const pendingReleaseRequestsForOwnerEffect = (
  sessionsRoot: string,
  owner: string,
): Effect.Effect<ReleaseRequestFile[], CoordinationError> =>
  Effect.try({
    try: () => {
      const dir = coordDir(sessionsRoot, RELEASE_DIR);
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch (cause) {
        if (isEnoent(cause)) return [];
        throw new CoordinationError({ cause: `读取释放请求目录失败：${errMessage(cause)}` });
      }
      const out: ReleaseRequestFile[] = [];
      for (const name of names.filter((n) => n.endsWith(".json"))) {
        const parsed = readJsonFileSync(ReleaseRequestSchema, join(dir, name), true);
        if (parsed && parsed.targetOwner === owner && parsed.status === "pending") out.push(parsed);
      }
      return out;
    },
    catch: (cause) =>
      cause instanceof CoordinationError ? cause : new CoordinationError({ cause: `扫描释放请求失败：${errMessage(cause)}` }),
  });

/** 持有者释放完成后把请求标为 released（已释放）；文件缺失视为异常，由调用方决定。 */
export const markReleaseRequestReleasedEffect = (sessionsRoot: string, id: string): Effect.Effect<void, CoordinationError> =>
  Effect.try({
    try: () => {
      const file = releaseRequestFile(sessionsRoot, id);
      const parsed = readJsonFileSync(ReleaseRequestSchema, file, false);
      if (!parsed) throw new CoordinationError({ cause: `释放请求文件不存在：${file}` });
      writeJsonAtomic(file, { ...parsed, status: "released" } satisfies ReleaseRequestFile);
    },
    catch: (cause) =>
      cause instanceof CoordinationError ? cause : new CoordinationError({ cause: `标记释放请求失败：${errMessage(cause)}` }),
  });

/** 发布者确认已释放后删掉自己的请求文件；仅 ENOENT 幂等，权限等错误显式失败。 */
export const deleteReleaseRequestEffect = (sessionsRoot: string, id: string): Effect.Effect<void, CoordinationError> =>
  Effect.try({
    try: () => {
      const file = releaseRequestFile(sessionsRoot, id);
      try {
        unlinkSync(file);
      } catch (cause) {
        if (!isEnoent(cause)) throw new CoordinationError({ cause: `删除释放请求 ${file} 失败：${errMessage(cause)}` });
      }
    },
    catch: (cause) =>
      cause instanceof CoordinationError ? cause : new CoordinationError({ cause: `删除释放请求失败：${errMessage(cause)}` }),
  });

/** 持有者释放后的暂退标记：窗口内自己不参与抢锁竞争。 */
export const markReleaseBackoffEffect = (sessionsRoot: string, owner: string): Effect.Effect<void, CoordinationError> =>
  Effect.try({
    try: () => {
      ensureCoordinationDirs(sessionsRoot);
      writeJsonAtomic(join(coordDir(sessionsRoot, BACKOFF_DIR), `${encodeURIComponent(owner)}.json`), {
        until: Date.now() + RELEASE_BACKOFF_MS,
      });
    },
    catch: (cause) =>
      cause instanceof CoordinationError ? cause : new CoordinationError({ cause: `写入释放暂退标记失败：${errMessage(cause)}` }),
  });

// ── 完成事件：单条最新，各实例凭 id 去重 ──────────────────────────────

export interface IndexCompletionEvent {
  /** 唯一 id，实例凭它去重 */
  id: string;
  ts: number;
  scanned: number;
  added: number;
  updated: number;
  failed: number;
  remaining: number;
  indexedTotal: number;
  totalFiles: number;
  /** 本轮无可用模型，一条都没建 */
  noModel?: boolean;
  /** 本轮首个单文件失败的真实原因 */
  failureCause?: string;
}

export function nextEventId(): string {
  return `${Date.now()}-${randomBytes(6).toString("hex")}`;
}

/** 只保留单条最新事件（原子覆盖），无界 JSONL 已废弃。 */
export function appendCompletionEvent(sessionsRoot: string, event: IndexCompletionEvent): void {
  ensureCoordinationDirs(sessionsRoot);
  writeJsonAtomic(join(sessionsRoot, COORD_DIR, LATEST_EVENT_FILE), event);
}

/** 读 baseline 之后的事件（至多一条最新），id 去重交给调用方集合；损坏显式抛错。 */
export function readCompletionEventsSince(sessionsRoot: string, baselineTs: number): IndexCompletionEvent[] {
  const file = join(sessionsRoot, COORD_DIR, LATEST_EVENT_FILE);
  if (!existsSync(file)) return [];
  const parsed = readJsonFileSync(CompletionEventSchema, file, false);
  if (!parsed || parsed.ts <= baselineTs) return [];
  return [parsed];
}

// ── 补建请求队列：per-request 文件，消费者只删自己消费的文件 ──────────

/** 查询侧发现未索引/过期会话时发布补建请求；leader 下一轮 pass 消费。 */
export function requestRebuild(sessionsRoot: string, paths: string[]): void {
  if (paths.length === 0) return;
  ensureCoordinationDirs(sessionsRoot);
  const ts = Date.now();
  for (const p of paths) {
    const id = `req-${ts}-${randomBytes(6).toString("hex")}`;
    writeJsonAtomic(join(coordDir(sessionsRoot, REBUILD_DIR), `${id}.json`), { p, ts });
  }
}

/** 消费全部补建请求并删除已消费文件；损坏/权限显式抛错，仅消费竞态 ENOENT 跳过。 */
export function consumeRebuildRequests(sessionsRoot: string): string[] {
  const dir = coordDir(sessionsRoot, REBUILD_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (cause) {
    if (isEnoent(cause)) return [];
    throw new CoordinationError({ cause: `读取补建请求目录失败：${errMessage(cause)}` });
  }
  const paths = new Set<string>();
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const file = join(dir, name);
    const parsed = readJsonFileSync(RebuildRequestSchema, file, false);
    if (!parsed) throw new CoordinationError({ cause: `补建请求文件消失：${file}` });
    paths.add(parsed.p);
    try {
      unlinkSync(file);
    } catch (cause) {
      if (!isEnoent(cause)) throw new CoordinationError({ cause: `删除已消费补建请求 ${file} 失败：${errMessage(cause)}` });
    }
  }
  return [...paths];
}

/** mtime 探测：仅文件消失返回 null（调用方跳过）；其他 IO 错误显式抛错。 */
export function statMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch (cause) {
    if (isEnoent(cause)) return null;
    throw new CoordinationError({ cause: `stat ${path} 失败：${errMessage(cause)}` });
  }
}

// ── 遗留同步 API（index/indexer 未接入前保持兼容；主端接入 Effect API 后可删） ──

const heldLocks = new Map<string, IndexLockHandle>();

function lockKey(sessionsRoot: string, owner: string): string {
  return `${sessionsRoot}\u0000${owner}`;
}

/**
 * 兼容包装：签名保持 (root, owner, now, staleMs)，now/staleMs 已随心跳锁废弃。
 * 锁误用（他人持有/SQLITE_BUSY）返回 false；DB 损坏、权限等显式抛 CoordinationError。
 */
export function acquireLock(sessionsRoot: string, owner: string, _now?: number, _staleMs?: number): boolean {
  const key = lockKey(sessionsRoot, owner);
  if (heldLocks.has(key)) return true;
  const result = Effect.runSync(Effect.either(acquireIndexLockEffect(sessionsRoot, owner)));
  if (result._tag === "Left") throw result.left;
  if (!result.right) return false;
  heldLocks.set(key, result.right);
  return true;
}

/** 兼容包装：SQLite 锁不靠心跳续期，这里只校验自己仍持有。 */
export function renewLock(sessionsRoot: string, owner: string, _now?: number): boolean {
  return heldLocks.has(lockKey(sessionsRoot, owner));
}

/** 兼容包装：只释放自己这条进程持有的 handle，绝不碰别人的锁。 */
export function releaseLock(sessionsRoot: string, owner: string): void {
  const key = lockKey(sessionsRoot, owner);
  const handle = heldLocks.get(key);
  if (!handle) return;
  heldLocks.delete(key);
  Effect.runSync(handle.release());
}
