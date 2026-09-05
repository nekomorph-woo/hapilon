/**
 * hpl-safety-gate/index.ts — 危险命令拦截扩展
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
import { hasSensitiveReadArg, sensitiveReadLabels } from "./sensitive-args.js";
import { requestConfirm } from "../hpl-protected-paths/confirm.js";
import { addTrust, isTrusted, initProjectTrust } from "../../trust-store.js";

// subagent 会话探针（issue #47 分级依赖）：与 hpl-protected-paths 同款。
// bash 读敏感文件时 subagent block、主会话 confirm——与 #39 read 分级一致。
let subagentProbe: (() => boolean) | undefined;
import("@tintinweb/pi-subagents/dist/child-context.js")
  .then((mod) => {
    subagentProbe = mod.inChildSessionContext;
  })
  .catch(() => {
    console.warn("[hpl-safety-gate] subagent 探针不可得，bash 敏感读取将走 confirm 流程");
  });

function inSubagentSession(): boolean {
  return subagentProbe ? subagentProbe() : false;
}

export { classifyCommand, hasShellInjection } from "./classifier.js";

export default function (pi: ExtensionAPI) {
  // 加载时初始化项目信任缓存（issue #15）：本进程是 project trust 的消费方
  initProjectTrust(process.cwd());

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command: string = event.input.command;
    if (!command) return;

    // 标准化空白字符用于信任匹配
    const normalized = command.trim().replace(/\s+/g, " ");

    const verdict = classifyCommand(command);
    if (verdict === "allow") {
      // 敏感文件 bash 读检测（issue #47）：危险命令规则放行后，
      // 参数命中 READ_CONFIRM 的命令进入分级拦截——
      // subagent 会话硬拦（#39 read 同级），主会话走 confirm。
      if (hasSensitiveReadArg(command, ctx.cwd)) {
        const labels = sensitiveReadLabels(command, ctx.cwd).join("、");
        if (inSubagentSession()) {
          console.warn(`[hpl-safety-gate] subagent 会话禁止读取敏感文件（${labels}）: ${command.slice(0, 120)}`);
          return {
            block: true,
            reason: `🛡️ subagent 会话禁止读取敏感文件（${labels}）：secret 只该被应用运行时读取，agent 读取会进入 LLM 上下文与 transcript。请在主会话中操作，或使用白名单文件（.env.example）。`,
          };
        }
        if (isTrusted("bash", normalized, ctx.cwd)) return;
        if (!ctx.hasUI) {
          console.warn(`[hpl-safety-gate] 非交互模式下禁止读取敏感文件（${labels}）: ${command.slice(0, 120)}`);
          return {
            block: true,
            reason: `🛡️ 非交互模式下禁止读取敏感文件（${labels}）：${command.slice(0, 120)}`,
          };
        }
        const result = await requestConfirm(
          ctx,
          "⚠️ 敏感文件读取确认",
          `命令将读取敏感文件（${labels}）：\n\n> ${command.slice(0, 200)}\n\n是否仍然执行？`,
        );
        if (result.status !== "approved") {
          const reason = result.status === "unavailable"
            ? `🛡️ 非交互模式下禁止读取敏感文件（${labels}）`
            : `用户拒绝了敏感文件读取：${command.slice(0, 120)}`;
          console.warn(`[hpl-safety-gate] ${reason}`);
          return { block: true, reason };
        }
        try {
          if (result.scope !== "once") {
            addTrust("bash", normalized, result.scope, ctx.cwd);
          }
        } catch (err) {
          console.warn("添加信任失败（不影响本次操作）:", err instanceof Error ? err.message : String(err));
        }
      }
      return;
    }

    if (verdict === "block") {
      // 拦截必须留痕（Make It Observable），issue #6
      console.warn(`[hpl-safety-gate] 危险命令已阻止: ${command.slice(0, 120)}`);
      return {
        block: true,
        reason: `🛡️ 危险命令已阻止：${command.slice(0, 120)}`,
      };
    }

    // confirm → 先查 trust（用标准化后的命令）
    if (isTrusted("bash", normalized, ctx.cwd)) return;

    if (!ctx.hasUI) {
      // 拦截必须留痕（Make It Observable），issue #6
      console.warn(`[hpl-safety-gate] 非交互模式下拦截中危命令: ${command.slice(0, 120)}`);
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
      console.warn(`[hpl-safety-gate] ${reason}`);
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
