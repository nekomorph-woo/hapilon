/**
 * team-tasks.ts — 按 role 隔离的 pi-tasks 任务列表：只读解析 + 加锁追加。
 *
 * 每个 role pane 的列表由 pi-tasks 自己维护（PI_TASKS 指向同一个文件），所以外部
 * 进程碰它必须遵守它那套协议：`<file>.lock` 的 O_EXCL 文件锁 + 读→改→tmp+rename
 * 原子替换（协议抄自 @tintinweb/pi-tasks 的 task-store，与它共存而不是另立一套）。
 *
 * 写前先解析既有文件校验形状：上游改了格式就报错退出，绝不硬写——写坏这个文件
 * 等于把某个 role 的任务列表整个弄没。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Data, Effect } from "effect";

export class TeamTasksError extends Data.TaggedError("TeamTasksError")<{
  message: string;
}> {}

/** pi-tasks 的任务记录：只声明本模块要读的字段，其余原样透传。 */
export interface StoredTask {
  id: string;
  subject?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TaskStore {
  nextId: number;
  tasks: StoredTask[];
}

export interface PendingTaskInput {
  /** 队列里给这条任务的归属：pane id（列表本身已按 pane 隔离，这里只是自描述） */
  paneId: string;
  subject: string;
  brief?: string;
  enqueuedBy?: string;
}

const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * O_EXCL 建锁；持锁进程已死（或锁内容不可读满两次重试）即回收。
 * 锁文件先建后写，所以「读到空 pid」只在最初两次重试里容忍。
 */
function acquireLock(lockPath: string): string {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${randomUUID()}`;
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      writeFileSync(lockPath, token, { flag: "wx" });
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const pid = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
        stale = pid > 0 ? !isProcessRunning(pid) : i >= 2;
      } catch {
        // 锁刚被释放：下一轮就能建上
      }
      if (stale) {
        unlinkSync(lockPath);
        continue;
      }
      const start = Date.now();
      while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait，与 wait-pane 同款的同步等待 */ }
    }
  }
  throw new Error(`等待任务列表锁超时：${lockPath}`);
}

/** 只释放自己的锁：别人把超时的旧锁回收掉后可能已经换了持有者。 */
function releaseLock(lockPath: string, token: string): void {
  try {
    if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
  } catch {
    // 锁已不在：无需处理
  }
}

function parseStore(raw: unknown, path: string): TaskStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`任务列表结构不符（顶层不是对象）：${path}`);
  }
  const { nextId, tasks } = raw as { nextId?: unknown; tasks?: unknown };
  if (!Array.isArray(tasks)) throw new Error(`任务列表结构不符（缺 tasks 数组）：${path}`);
  if (typeof nextId !== "number" || !Number.isInteger(nextId) || nextId < 1) {
    throw new Error(`任务列表结构不符（nextId 非正整数）：${path}`);
  }
  tasks.forEach((task, index) => {
    if (!task || typeof task !== "object" || typeof (task as { id?: unknown }).id !== "string") {
      throw new Error(`任务列表结构不符（第 ${index + 1} 条缺 id）：${path}`);
    }
  });
  return { nextId, tasks: tasks as StoredTask[] };
}

/** 读任务列表；文件不存在返回 undefined（新 pane 还没建过任务），形状不符则报错。 */
export const readTaskStoreEffect = (
  path: string,
): Effect.Effect<TaskStore | undefined, TeamTasksError> => Effect.try({
  try: () => {
    if (!existsSync(path)) return undefined;
    return parseStore(JSON.parse(readFileSync(path, "utf8")) as unknown, path);
  },
  catch: (error) => new TeamTasksError({
    message: error instanceof Error ? error.message : String(error),
  }),
});

/**
 * 追加一条 pending 任务，返回新任务 id。锁内重读一遍再改，避免与 pi-tasks 的
 * 并发写互相覆盖；nextId 取「文件里的 nextId」与「现有最大 id + 1」的较大者。
 */
export const appendPendingTaskEffect = (
  path: string,
  input: PendingTaskInput,
  now: () => number = Date.now,
): Effect.Effect<string, TeamTasksError> => Effect.try({
  try: () => {
    const lockPath = `${path}.lock`;
    const token = acquireLock(lockPath);
    try {
      const store = existsSync(path)
        ? parseStore(JSON.parse(readFileSync(path, "utf8")) as unknown, path)
        : { nextId: 1, tasks: [] };
      const maxId = store.tasks.reduce((max, task) => Math.max(max, Number.parseInt(task.id, 10) || 0), 0);
      const id = String(Math.max(store.nextId, maxId + 1));
      const timestamp = now();
      store.nextId = Number(id) + 1;
      store.tasks.push({
        id,
        subject: input.subject,
        description: input.brief ? `brief: ${input.brief}` : "",
        status: "pending",
        activeForm: undefined,
        owner: undefined,
        metadata: {
          pane: input.paneId,
          enqueuedBy: input.enqueuedBy ?? "owner",
          ...(input.brief ? { brief: input.brief } : {}),
        },
        blocks: [],
        blockedBy: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const tmpPath = `${path}.tmp`;
      writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`);
      renameSync(tmpPath, path);
      return id;
    } finally {
      releaseLock(lockPath, token);
    }
  },
  catch: (error) => new TeamTasksError({
    message: error instanceof Error ? error.message : String(error),
  }),
});

/** 任务条目的面板标签：subject 缺失时退化成 id，不猜内容。 */
export function taskLabel(task: StoredTask): string {
  const subject = typeof task.subject === "string" && task.subject.trim().length > 0
    ? task.subject.trim()
    : "(无 subject)";
  return `#${task.id} ${subject}`;
}

/** 任务里登记的 brief 路径 → 回执所在目录（brief 可以是档案目录，也可以是 task-brief.md 本身）。 */
export function briefDirOf(task: StoredTask): string | undefined {
  const brief = task.metadata?.brief;
  if (typeof brief !== "string" || brief.length === 0) return undefined;
  return brief.endsWith(".md") ? dirname(brief) : brief;
}
