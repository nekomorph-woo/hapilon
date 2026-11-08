import { existsSync } from "node:fs";
import { loadTasksConfig } from "@tintinweb/pi-tasks/dist/tasks-config.js";
import { notify } from "../notify.js";
import { buildReminderText, pickContextInjection, readUnfinishedTasks, resolveTaskFilePath, } from "./store.js";
export default function tasksReconcile(pi) {
    let nudgedThisRun = false;
    // context_with_system 事件里的 messages 含首条 system，排除后再比长度；
    // 长度变短即刚发生压缩（session 切换时重置为 0，resume 大历史不会误判）。
    let lastMessageCount = 0;
    const locateTasks = (ctx) => resolveTaskFilePath({
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        piTasks: process.env.PI_TASKS,
        taskScope: loadTasksConfig(ctx.cwd).taskScope,
    });
    // 续跑（before_settle 返回 continue）本身会触发新的 agent_start：守卫若在
    // agent_start 重置，请求续跑恰恰解掉限制自己的闸，形成自激提醒风暴；只在真实
    // 用户输入处重置，「每次用户输入最多提醒一次」才成立。
    pi.on("input", () => {
        nudgedThisRun = false;
    });
    pi.on("session_start", () => {
        lastMessageCount = 0;
    });
    // 不用 context 事件：billion-context-pi 也挂 context 且返回自己 state 重建的全量
    // messages，会整体覆盖先前 handler 注入的 reminder；context_with_system 在其后跑，
    // 且无人再返回全量数组，注入能到达最终 payload。
    pi.on("context_with_system", async (event, ctx) => {
        const count = event.messages.filter((m) => m.role !== "system").length;
        const compacted = count < lastMessageCount;
        lastMessageCount = count;
        const path = locateTasks(ctx);
        if (!path || !existsSync(path))
            return {};
        const text = pickContextInjection(readUnfinishedTasks(path), compacted);
        if (!text)
            return {};
        return {
            messages: [
                ...event.messages,
                { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
            ],
        };
    });
    pi.on("agent_before_settle", async (event, ctx) => {
        if (nudgedThisRun)
            return;
        const path = locateTasks(ctx);
        if (!path || !existsSync(path))
            return;
        const unfinished = readUnfinishedTasks(path);
        if (unfinished.length === 0)
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
        const path = locateTasks(ctx);
        if (!path || !existsSync(path))
            return;
        const unfinished = readUnfinishedTasks(path);
        if (unfinished.length > 0) {
            notify(`任务清单仍有 ${unfinished.length} 项未收尾（续跑提醒已发过一次）`, "warning");
        }
    });
}
