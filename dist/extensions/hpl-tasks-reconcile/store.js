// hpl-tasks-reconcile/store.ts — 读 pi-tasks 的任务存储并判定完工残留。
// 路径分支对齐 @tintinweb/pi-tasks 0.9.x 的 resolveStoreTarget；sessionTaskFile
// 直接 import 它的导出，避免两处各自实现产生漂移。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sessionTaskFile } from "@tintinweb/pi-tasks/dist/task-paths.js";
/** 对齐 pi-tasks 的存储路径分支；memory scope 与无法定位会话文件时返回 undefined。 */
export function resolveTaskFilePath(input) {
    const { piTasks } = input;
    if (piTasks === "off")
        return undefined;
    if (piTasks?.startsWith("/"))
        return piTasks;
    if (piTasks?.startsWith("."))
        return resolve(input.cwd, piTasks);
    if (piTasks)
        return piTasks;
    const scope = input.taskScope ?? "session";
    if (scope === "memory")
        return undefined;
    if (scope === "session" || scope === "session-global") {
        if (!input.sessionId)
            return undefined;
        return sessionTaskFile(input.cwd, input.sessionId, scope);
    }
    return join(input.cwd, ".pi", "tasks", "tasks.json");
}
/** run 结束仍存在的未收尾任务（pending/in_progress）。
 *  文件存在但结构损坏时抛错，由 pi 的 handler 错误通道浮出。 */
export function readUnfinishedTasks(path) {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(data.tasks)) {
        throw new Error(`任务存储缺 tasks 数组: ${path}`);
    }
    return data.tasks
        .filter((t) => t.status !== "completed")
        .map((t) => ({ id: t.id, subject: t.subject, status: t.status }));
}
/** run 结束仍存在的未收尾任务数；全 completed 或空列表返回 0。 */
export function countUnfinishedTasks(path) {
    return readUnfinishedTasks(path).length;
}
function statusCounts(tasks) {
    const by = { in_progress: 0, pending: 0 };
    for (const t of tasks)
        by[t.status]++;
    return `${tasks.length} unfinished (${by.in_progress} in_progress, ${by.pending} pending)`;
}
function taskLines(tasks) {
    return tasks.map((t) => `- #${t.id} [${t.status}] ${t.subject}`).join("\n");
}
/** 本请求要注入的清单文本（追加为不持久化的 user message）。
 *  空清单不注入；刚压缩后给完整清单（抗失忆硬保障，不押注摘要质量），常态只给一行计数维持存在感。 */
export function pickContextInjection(tasks, compacted) {
    if (tasks.length === 0)
        return undefined;
    if (compacted) {
        return [
            "<system-reminder>",
            "Context was just compacted; the task list below is the authoritative remaining work:",
            taskLines(tasks),
            "</system-reminder>",
        ].join("\n");
    }
    return `<system-reminder>Task list: ${statusCounts(tasks)}.</system-reminder>`;
}
/** 续跑提醒：与 pi-tasks 的 stale 提醒同风格，附上清单全文（续跑轮不必再 TaskList），
 *  明确「收尾或清理，勿开新工」。 */
export function buildReminderText(tasks) {
    return [
        "<system-reminder>",
        `This run is about to settle, but the task list still has ${statusCounts(tasks)}:`,
        taskLines(tasks),
        "If the work for them is done, mark them completed via TaskUpdate; if they are stale or superseded, delete them.",
        "Do not start new substantive work.",
        "</system-reminder>",
    ].join("\n");
}
