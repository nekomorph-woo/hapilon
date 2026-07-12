/**
 * slash-command.ts — 注册 /command + CLI Flag 示例
 *
 * 功能：
 *   1. 注册 /todos 命令 —— 列出项目 _todo.md 中的待办事项
 *   2. 注册 --todos-file CLI flag —— 允许用户指定自定义 todo 文件路径
 *
 * 用法：
 *   1. pi -e ./slash-command.ts
 *   2. 在对话中输入 /todos 查看待办
 *   3. hapilon --todos-file ./my-todos.md 指定自定义文件
 *
 * 来源: doc/pi-wiki.md §6.4 (pi.registerCommand), §6.6 (ExtensionCommandContext)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  // ─── 注册 CLI Flag ────────────────────────────────────────────────
  pi.registerFlag("todos-file", {
    description: "指定 TODO 文件路径（默认 _todo.md）",
    type: "string",
  });

  // ─── 注册 /todos 命令 ─────────────────────────────────────────────
  pi.registerCommand("todos", {
    description: "列出项目待办事项（从 _todo.md 读取）",

    handler: async (_args, ctx) => {
      // 确定文件路径：用户 flag > 默认 _todo.md
      const customPath = pi.getFlag("todos-file") as string | undefined;
      const filePath = customPath
        ? join(ctx.cwd, customPath)
        : join(ctx.cwd, "_todo.md");

      if (!existsSync(filePath)) {
        ctx.ui.notify(
          `文件不存在: ${filePath}\n使用 --todos-file <path> 指定自定义路径`,
          "error",
        );
        return;
      }

      const content = readFileSync(filePath, "utf8");
      // 提取所有 [ ] 和 [x] 和 [~] 行
      const todoLines = content
        .split("\n")
        .filter((line) => /^\s*- \[[ x~]\]/.test(line));

      if (todoLines.length === 0) {
        ctx.ui.notify("没有找到待办事项", "info");
        return;
      }

      // 统计
      const pending = todoLines.filter((l) => l.includes("[ ]")).length;
      const done = todoLines.filter((l) => l.includes("[x]")).length;
      const archived = todoLines.filter((l) => l.includes("[~]")).length;

      // 显示小部件（编辑器上方）
      ctx.ui.setWidget("todos", [
        `📋 待办事项 (${filePath})`,
        `  未完成: ${pending}  |  已完成: ${done}  |  已归档: ${archived}`,
        "",
        ...todoLines.slice(0, 10).map((l) => `  ${l.trim()}`),
        todoLines.length > 10 ? `  ... 还有 ${todoLines.length - 10} 项` : "",
      ]);

      ctx.ui.notify(
        `共 ${todoLines.length} 项：${pending} 未完成, ${done} 已完成`,
        "info",
      );
    },
  });

  // ─── 启动时提示可用命令 ──────────────────────────────────────────
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus(
      "todos-hint",
      "输入 /todos 查看待办事项",
    );
  });
}
