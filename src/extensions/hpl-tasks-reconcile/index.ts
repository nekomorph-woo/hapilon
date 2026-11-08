// hpl-tasks-reconcile/index.ts — 完工对账 + 清单注入：让任务清单在正确的时机回到模型眼前。
//
// pi-tasks 自带的 stale 提醒只注入「下一次 LLM 调用」；完工即结束的 run 没有下一次
// 调用，提醒永远等不到注入机会（实测：任务全部完工后清单仍挂 in_progress/pending）。
// 这里补两个时机：
// - context 钩子（每个 LLM 请求）：常态注入一行计数维持存在感；messages 变短即刚发生
//   压缩，改注入完整清单——摘要可能丢任务细节，清单是唯一可靠的真相源。
// - agent_before_settle（最终可行动边界）：有残留就 append 提醒（附清单全文，续跑轮
//   不必再 TaskList）并请求续跑；单 run 最多续跑一次，续跑后仍残留则通知用户。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { loadTasksConfig } from "@tintinweb/pi-tasks/dist/tasks-config.js";
import { notify } from "../notify.js";
import {
  buildReminderText,
  pickContextInjection,
  readUnfinishedTasks,
  resolveTaskFilePath,
} from "./store.js";

export default function tasksReconcile(pi: ExtensionAPI) {
  let nudgedThisRun = false;
  // context_with_system 事件里的 messages 含首条 system，排除后再比长度；
  // 长度变短即刚发生压缩（session 切换时重置为 0，resume 大历史不会误判）。
  let lastMessageCount = 0;

  const locateTasks = (ctx: { cwd: string; sessionManager: { getSessionId(): string | undefined } }) =>
    resolveTaskFilePath({
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      piTasks: process.env.PI_TASKS,
      taskScope: loadTasksConfig(ctx.cwd).taskScope,
    });

  pi.on("agent_start", () => {
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
    if (!path || !existsSync(path)) return {};
    const text = pickContextInjection(readUnfinishedTasks(path), compacted);
    if (!text) return {};
    return {
      messages: [
        ...event.messages,
        { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
      ],
    };
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (nudgedThisRun) return;
    const path = locateTasks(ctx);
    if (!path || !existsSync(path)) return;
    const unfinished = readUnfinishedTasks(path);
    if (unfinished.length === 0) return;
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
    if (!nudgedThisRun) return;
    const path = locateTasks(ctx);
    if (!path || !existsSync(path)) return;
    const unfinished = readUnfinishedTasks(path);
    if (unfinished.length > 0) {
      notify(`任务清单仍有 ${unfinished.length} 项未收尾（续跑提醒已发过一次）`, "warning");
    }
  });
}
