/**
 * event-hook.ts — 生命周期事件订阅示例
 *
 * 功能：演示三个常用事件 Hook 的组合使用：
 *   1. session_start   → 显示 session 信息 + 从 session 重建状态
 *   2. before_agent_start → 注入项目 README 为 LLM 上下文
 *   3. tool_call       → 拦截危险 bash 命令
 *
 * 用法：
 *   1. pi -e ./event-hook.ts            # 临时测试
 *   2. 启动后观察通知，尝试让 Agent 执行 rm -rf 看拦截效果
 *
 * 来源: doc/pi-wiki.md §4.3 (Agent 事件), §4.3 (Tool 事件)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  // ─── Hook 1: session_start — 初始化 + 状态重建 ───────────────────
  pi.on("session_start", async (event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile() ?? "临时 session";
    ctx.ui.notify(
      `📋 Session: ${sessionFile}\n   原因: ${event.reason}`,
      "info",
    );

    // 从 session entries 重建扩展状态（示例：统计 tool 调用次数）
    let toolCallCount = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        toolCallCount++;
      }
    }
    if (toolCallCount > 0) {
      ctx.ui.setStatus(
        "event-hook",
        `已记录 ${toolCallCount} 次 tool 调用`,
      );
    }
  });

  // ─── Hook 2: before_agent_start — 注入项目上下文 ─────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    // 读取项目 README 前 2000 字符注入为 LLM 上下文
    const readmePath = join(ctx.cwd, "README.md");
    if (existsSync(readmePath)) {
      const content = readFileSync(readmePath, "utf8").slice(0, 2000);
      return {
        message: {
          customType: "project-readme",
          content: `以下是项目 README.md 的摘要（前 2000 字符），请参考项目背景：\n\n${content}`,
          display: true,
        },
      };
    }
  });

  // ─── Hook 3: tool_call — 拦截危险命令 ────────────────────────────
  pi.on("tool_call", async (event, ctx) => {
    // 类型安全地检查 bash 工具调用
    if (isToolCallEventType("bash", event)) {
      const cmd = event.input.command;

      // 危险命令黑名单
      const blockedPatterns = [
        { pattern: "rm -rf /", reason: "删除根目录" },
        { pattern: "sudo rm", reason: "sudo 删除" },
        { pattern: "> /dev/sda", reason: "直接写入块设备" },
        { pattern: "mkfs.", reason: "格式化磁盘" },
        { pattern: "dd if=", reason: "磁盘低级操作" },
        { pattern: ":(){ :|:& };:", reason: "fork bomb" },
      ];

      for (const { pattern, reason } of blockedPatterns) {
        if (cmd.includes(pattern)) {
          const confirmed = await ctx.ui.confirm(
            "⚠️  危险命令检测",
            `命令包含 "${pattern}" (${reason})，是否允许执行？\n\n命令: ${cmd}`,
          );
          if (!confirmed) {
            return { block: true, reason: `用户拒绝了危险命令: ${reason}` };
          }
        }
      }
    }
  });

  // ─── Hook 4: tool_result — 记录所有工具执行 ──────────────────────
  pi.on("tool_result", async (event, _ctx) => {
    // 仅记录，不修改结果
    const status = event.isError ? "❌" : "✅";
    console.log(`[audit] ${status} tool=${event.toolName} callId=${event.toolCallId}`);
  });
}
