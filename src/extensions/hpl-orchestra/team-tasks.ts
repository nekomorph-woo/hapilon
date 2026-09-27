/**
 * team-tasks.ts — 按 role 隔离的 pi-tasks 任务列表：只读解析。
 *
 * 每个 role pane 的列表由 pi-tasks 自己维护（PI_TASKS 指向同一个文件）并独自写入；
 * 本模块只读：team-status 的任务摘要与 stale 判定都从这里取数。写入是 pi-tasks
 * 的领地——曾经的外部追加入口（team-enqueue）已随队列自领机制一起删除。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
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

/**
 * 任务最后一次更新的时间戳。pi-tasks 改状态时会写 updatedAt，旧记录没有则退回
 * createdAt；两者都不可得时返回 undefined——宁可不报 stale，也不在未知时长上错判。
 */
export function taskUpdatedAt(task: StoredTask): number | undefined {
  for (const value of [task.updatedAt, task.createdAt]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}
