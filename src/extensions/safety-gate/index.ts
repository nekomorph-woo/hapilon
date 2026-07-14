/**
 * safety-gate/index.ts — 危险命令拦截扩展
 *
 * 通过 pi.on("tool_call", ...) 拦截 bash 工具调用：
 *   BLOCK — 高危直接阻止（rm -rf /、sudo、mkfs、dd、fork bomb ...）
 *   CONFIRM — 中危弹确认框（rm -rf 非根、git push --force、curl|sh ...）
 *   ALLOW — 正常放行
 *
 * 用法: hapilon 启动时自动加载（discoverExtensions() → -e 注入）
 * 来源: doc/pi-wiki.md §4.3 tool_call 事件
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { classifyCommand } from "./classifier.js";

export { classifyCommand, hasShellInjection } from "./classifier.js";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command: string = event.input.command;
    if (!command) return;

    const verdict = classifyCommand(command);
    if (verdict === "allow") return;

    if (verdict === "block") {
      return {
        block: true,
        reason: `🛡️ 危险命令已阻止：${command.slice(0, 120)}`,
      };
    }

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `🛡️ 非交互模式下拦截中危命令：${command.slice(0, 120)}`,
      };
    }

    try {
      const approved = await ctx.ui.confirm(
        "⚠️ 危险操作确认",
        `检测到潜在危险操作：\n\n> ${command.slice(0, 200)}\n\n是否仍然执行？`,
      );
      if (!approved) {
        return {
          block: true,
          reason: `用户拒绝了此操作：${command.slice(0, 120)}`,
        };
      }
    } catch (err) {
      console.warn("安全确认对话框异常:", err instanceof Error ? err.message : String(err));
      return {
        block: true,
        reason: `🛡️ 确认对话框异常，已阻止：${command.slice(0, 120)}`,
      };
    }
  });
}
