/**
 * protected-paths/index.ts — 文件路径保护扩展（分层版）
 *
 * 通过 pi.on("tool_call", ...) 拦截 write/edit/read 工具调用：
 *   write/edit → trust-check → block（高危硬阻止）→ confirm（中危 4 选项弹框）
 *   read → trust-check → confirm（敏感路径 4 选项弹框）
 *
 * /allow <path> — 会话级临时白名单，读写均生效
 *
 * 用法: hapilon 启动时自动加载（discoverExtensions() → -e 注入）
 * 来源: doc/pi-wiki.md §4.3 tool_call 事件
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { classifyPath } from "./classifier.js";
import { requestConfirm } from "./confirm.js";
import { addTrust, isTrusted, isSessionTrusted, clearSessionTrust, listSessionTrust, listProjectTrust } from "../../trust-store.js";

export { classifyPath, expandTilde, resolveTarget } from "./classifier.js";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const filePath: string = event.input.path ?? "";
      if (!filePath) {
        console.warn("write/edit 工具调用缺少 path 参数，安全扩展无法生效");
        return;
      }

      const toolName = isToolCallEventType("edit", event) ? "edit" : "write";

      // confirm 路径 → 查 session + project trust
      const verdict = classifyPath(filePath, toolName, ctx.cwd);

      if (verdict === "block") {
        // block 路径 → 仅 session trust
        if (!isSessionTrusted(toolName, filePath)) {
          // 拦截必须留痕（Make It Observable），issue #6
          console.warn(`[protected-paths] 受保护的文件路径，不允许写入: ${filePath}`);
          return { block: true, reason: `🛡️ 受保护的文件路径，不允许写入：${filePath}` };
        }
        return;
      }

      if (verdict === "confirm") {
        // confirm 路径 → session + project trust
        if (isTrusted(toolName, filePath, ctx.cwd)) return;

        const result = await requestConfirm(
          ctx,
          "⚠️ 写入确认",
          `Agent 正在尝试写入受保护文件：\n\n> ${filePath}\n\n类型：中危路径\n\n是否允许？`,
        );
        if (result.status !== "approved") {
          const reason = result.status === "unavailable"
            ? `🛡️ 非交互模式下拦截中危写入：${filePath}`
            : result.status === "error"
            ? `🛡️ 确认对话框异常，已阻止：${filePath}`
            : `用户拒绝了写入：${filePath}`;
          // 拦截必须留痕（Make It Observable），issue #6
          console.warn(`[protected-paths] ${reason}`);
          return { block: true, reason };
        }
        // 用户批准 → 按 scope 添加信任
        try {
          if (result.scope !== "once") {
            addTrust(toolName, filePath, result.scope, ctx.cwd);
          }
        } catch (err) {
          console.warn("添加信任失败（不影响本次操作）:", err instanceof Error ? err.message : String(err));
        }
      }
      return;
    }

    if (isToolCallEventType("read", event)) {
      const filePath: string = event.input.path ?? "";
      if (!filePath) {
        console.warn("read 工具调用缺少 path 参数，安全扩展无法生效");
        return;
      }

      if (isTrusted("read", filePath, ctx.cwd)) return;

      const verdict = classifyPath(filePath, "read", ctx.cwd);
      if (verdict !== "confirm") return;

      const result = await requestConfirm(
        ctx,
        "⚠️ 敏感文件读取确认",
        `Agent 正在尝试读取敏感文件：\n\n> ${filePath}\n\n是否允许？`,
      );
      if (result.status !== "approved") {
        const reason = result.status === "unavailable"
          ? `🛡️ 非交互模式下禁止读取敏感文件：${filePath}`
          : result.status === "error"
          ? `🛡️ 确认对话框异常，已阻止读取：${filePath}`
          : `用户拒绝了读取敏感文件：${filePath}`;
        // 拦截必须留痕（Make It Observable），issue #6
        console.warn(`[protected-paths] ${reason}`);
        return { block: true, reason };
      }
      try {
        if (result.scope !== "once") {
          addTrust("read", filePath, result.scope, ctx.cwd);
        }
      } catch (err) {
        console.warn("添加信任失败（不影响本次操作）:", err instanceof Error ? err.message : String(err));
      }
    }
  });

  pi.registerCommand("allow", {
    description: "会话级临时白名单（读写均生效）。用法：/allow <path> | --list | --clear",
    handler: async (argsStr, ctx) => {
      const arg = argsStr.trim();

      if (arg === "--list") {
        const session = listSessionTrust();
        const project = listProjectTrust(ctx.cwd);
        const lines: string[] = [];
        if (session.length > 0) {
          lines.push("Session 白名单：");
          for (const s of session) lines.push(`  ${s.toolName}: ${s.targets.join(", ")}`);
        }
        if (project.length > 0) {
          lines.push("项目白名单：");
          for (const p of project) lines.push(`  ${p.toolName}: ${p.targets.join(", ")}`);
        }
        if (lines.length === 0) {
          ctx.ui.notify("白名单为空", "info");
        } else {
          ctx.ui.notify(lines.join("\n"), "info");
        }
        return;
      }

      if (arg === "--clear") {
        const count = listSessionTrust().length;
        clearSessionTrust();
        ctx.ui.notify(`已清空 ${count} 条 session 白名单`, "info");
        return;
      }

      if (!arg) {
        ctx.ui.notify("用法：/allow <path> | --list | --clear", "warning");
        return;
      }

      // /allow → 加入 session 白名单（适用于 block 和 confirm 路径）
      addTrust("write", arg, "session", ctx.cwd);
      addTrust("edit", arg, "session", ctx.cwd);
      addTrust("read", arg, "session", ctx.cwd);
      ctx.ui.notify(`✅ 已添加 session 白名单：${arg}（读写均生效）`, "info");
    },
  });
}
