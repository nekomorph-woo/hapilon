// hpl-tasks-reconcile/index.ts — 完工对账：run 结束前任务清单有残留就请求一次续跑。
//
// pi-tasks 自带的 stale 提醒只注入「下一次 LLM 调用」；完工即结束的 run 没有下一次
// 调用，提醒永远等不到注入机会（实测：任务全部完工后清单仍挂 in_progress/pending）。
// 这里补 agent_before_settle 这个最终可行动边界：有残留就 append 提醒并请求续跑，
// 让模型自己 TaskUpdate 收尾；单 run 最多续跑一次，续跑后仍残留则通知用户。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { loadTasksConfig } from "@tintinweb/pi-tasks/dist/tasks-config.js";
import { notify } from "../notify.js";
import { buildReminderText, countUnfinishedTasks, resolveTaskFilePath } from "./store.js";

export default function tasksReconcile(pi: ExtensionAPI) {
  let nudgedThisRun = false;

  pi.on("agent_start", () => {
    nudgedThisRun = false;
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (nudgedThisRun) return;
    const path = resolveTaskFilePath({
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      piTasks: process.env.PI_TASKS,
      taskScope: loadTasksConfig(ctx.cwd).taskScope,
    });
    if (!path || !existsSync(path)) return;
    const unfinished = countUnfinishedTasks(path);
    if (unfinished <= 0) return;
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
    const path = resolveTaskFilePath({
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      piTasks: process.env.PI_TASKS,
      taskScope: loadTasksConfig(ctx.cwd).taskScope,
    });
    if (!path || !existsSync(path)) return;
    const unfinished = countUnfinishedTasks(path);
    if (unfinished > 0) {
      notify(`任务清单仍有 ${unfinished} 项未收尾（续跑提醒已发过一次）`, "warning");
    }
  });
}
