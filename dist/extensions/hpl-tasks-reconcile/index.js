import { existsSync } from "node:fs";
import { loadTasksConfig } from "@tintinweb/pi-tasks/dist/tasks-config.js";
import { notify } from "../notify.js";
import { buildReminderText, countUnfinishedTasks, resolveTaskFilePath } from "./store.js";
export default function tasksReconcile(pi) {
    let nudgedThisRun = false;
    pi.on("agent_start", () => {
        nudgedThisRun = false;
    });
    pi.on("agent_before_settle", async (event, ctx) => {
        if (nudgedThisRun)
            return;
        const path = resolveTaskFilePath({
            cwd: ctx.cwd,
            sessionId: ctx.sessionManager.getSessionId(),
            piTasks: process.env.PI_TASKS,
            taskScope: loadTasksConfig(ctx.cwd).taskScope,
        });
        if (!path || !existsSync(path))
            return;
        const unfinished = countUnfinishedTasks(path);
        if (unfinished <= 0)
            return;
        nudgedThisRun = true;
        return {
            entries: [
                ...event.entries,
                {
                    type: "custom_message",
                    customType: "hapi-tasks-reconcile",
                    content: buildReminderText(unfinished),
                    display: false,
                },
            ],
            continue: true,
        };
    });
    pi.on("agent_settled", async (_event, ctx) => {
        if (!nudgedThisRun)
            return;
        const path = resolveTaskFilePath({
            cwd: ctx.cwd,
            sessionId: ctx.sessionManager.getSessionId(),
            piTasks: process.env.PI_TASKS,
            taskScope: loadTasksConfig(ctx.cwd).taskScope,
        });
        if (!path || !existsSync(path))
            return;
        const unfinished = countUnfinishedTasks(path);
        if (unfinished > 0) {
            notify(`任务清单仍有 ${unfinished} 项未收尾（续跑提醒已发过一次）`, "warning");
        }
    });
}
