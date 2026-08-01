/**
 * safety-gate/index.ts — 危险命令拦截扩展
 *
 * 通过 pi.on("tool_call", ...) 拦截 bash 工具调用：
 *   BLOCK — 高危直接阻止
 *   CONFIRM — 中危 4 选项弹框
 *   ALLOW — 正常放行
 *
 * 用法: hapilon 启动时自动加载（discoverExtensions() → -e 注入）
 * 来源: doc/pi-wiki.md §4.3 tool_call 事件
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { classifyCommand } from "./classifier.js";
import { requestConfirm } from "../protected-paths/confirm.js";
import { addTrust, isTrusted } from "../../trust-store.js";

export { classifyCommand, hasShellInjection } from "./classifier.js";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command: string = event.input.command;
    if (!command) return;

    // 标准化空白字符用于信任匹配
    const normalized = command.trim().replace(/\s+/g, " ");

    const verdict = classifyCommand(command);
    if (verdict === "allow") return;

    if (verdict === "block") {
      // 拦截必须留痕（Make It Observable），issue #6
      console.warn(`[safety-gate] 危险命令已阻止: ${command.slice(0, 120)}`);
      return {
        block: true,
        reason: `🛡️ 危险命令已阻止：${command.slice(0, 120)}`,
      };
    }

    // confirm → 先查 trust（用标准化后的命令）
    if (isTrusted("bash", normalized, ctx.cwd)) return;

    if (!ctx.hasUI) {
      // 拦截必须留痕（Make It Observable），issue #6
      console.warn(`[safety-gate] 非交互模式下拦截中危命令: ${command.slice(0, 120)}`);
      return {
        block: true,
        reason: `🛡️ 非交互模式下拦截中危命令：${command.slice(0, 120)}`,
      };
    }

    const result = await requestConfirm(
      ctx,
      "⚠️ 危险操作确认",
      `检测到潜在危险操作：\n\n> ${command.slice(0, 200)}\n\n是否仍然执行？`,
    );
    if (result.status !== "approved") {
      const reason = result.status === "unavailable"
        ? `🛡️ 非交互模式下拦截中危命令：${command.slice(0, 120)}`
        : result.status === "error"
        ? `🛡️ 确认对话框异常，已阻止：${command.slice(0, 120)}`
        : `用户拒绝了此操作：${command.slice(0, 120)}`;
      // 拦截必须留痕（Make It Observable），issue #6
      console.warn(`[safety-gate] ${reason}`);
      return { block: true, reason };
    }
    try {
      if (result.scope !== "once") {
        addTrust("bash", normalized, result.scope, ctx.cwd);
      }
    } catch (err) {
      console.warn("添加信任失败（不影响本次操作）:", err instanceof Error ? err.message : String(err));
    }
  });
}
