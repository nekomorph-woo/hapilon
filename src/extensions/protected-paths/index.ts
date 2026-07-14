/**
 * protected-paths/index.ts — 文件路径保护扩展（分层版）
 *
 * 通过 pi.on("tool_call", ...) 拦截 write/edit/read 工具调用：
 *   write/edit → 白名单 → block（高危硬阻止）→ confirm（中危弹确认）
 *   read → 白名单 → confirm（敏感路径弹确认）
 *
 * 写保护分层：
 *   高危 block — SSH/凭证/证书（永远硬阻止，除非 /allow 显式白名单）
 *   中危 confirm — .env/lock 文件/CI 管道
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
import { addAllow, clearAllow, listAllow, isPathAllowed } from "./whitelist.js";

export { classifyPath, expandTilde, resolveTarget } from "./classifier.js";
export { addAllow, removeAllow, isAllowed, clearAllow, listAllow } from "./whitelist.js";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const filePath: string = event.input.path ?? "";
      if (!filePath) {
        console.warn("write/edit 工具调用缺少 path 参数，安全扩展无法生效");
        return;
      }

      // 白名单检查（/allow 后可绕过所有保护）
      if (isPathAllowed(filePath, ctx.cwd)) return;

      const verdict = classifyPath(
        filePath,
        isToolCallEventType("edit", event) ? "edit" : "write",
        ctx.cwd,
      );

      if (verdict === "block") {
        return { block: true, reason: `🛡️ 受保护的文件路径，不允许写入：${filePath}` };
      }

      if (verdict === "confirm") {
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
          return { block: true, reason };
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

      if (isPathAllowed(filePath, ctx.cwd)) return;

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
        return { block: true, reason };
      }
    }
  });

  pi.registerCommand("allow", {
    description: "会话级临时白名单（读写均生效）。用法：/allow <path> | --list | --clear",
    handler: async (argsStr, ctx) => {
      const arg = argsStr.trim();

      if (arg === "--list") {
        const paths = listAllow();
        if (paths.length === 0) {
          ctx.ui.notify("白名单为空", "info");
        } else {
          ctx.ui.notify(`当前白名单（${paths.length} 条）：\n${paths.join("\n")}`, "info");
        }
        return;
      }

      if (arg === "--clear") {
        const count = listAllow().length;
        clearAllow();
        ctx.ui.notify(`已清空 ${count} 条白名单`, "info");
        return;
      }

      if (!arg) {
        ctx.ui.notify("用法：/allow <path> | --list | --clear", "warning");
        return;
      }

      addAllow(arg, ctx.cwd);
      const key = listAllow()[listAllow().length - 1];
      ctx.ui.notify(`✅ 已添加白名单：${key}（当前 session 有效，读写均生效）`, "info");
    },
  });
}
