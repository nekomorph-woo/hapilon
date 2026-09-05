/**
 * hpl-protected-paths/index.ts — 文件路径保护扩展（分层版）
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
import { classifyPath, resolveTarget } from "./classifier.js";
import { requestConfirm, requestHighRiskConfirm } from "./confirm.js";
import { addTrust, isTrusted, isSessionTrusted, clearSessionTrust, listSessionTrust, listProjectTrust, initProjectTrust } from "../../trust-store.js";

export { classifyPath, expandTilde, resolveTarget } from "./classifier.js";

// 加载时初始化项目信任缓存（issue #15）：本进程是 project trust 的消费方
initProjectTrust(process.cwd());

// subagent 会话探针（issue #39）：pi-subagents 用 AsyncLocalStorage 标记
// 子会话构建/运行，探针在 tool_call 回调内实时求值即对应触发会话。
// 该模块是 pi-subagents 的内部路径（非 exports 公共 API），上游重构可能
// 破坏——不可得时退回 confirm 行为（多弹一次确认，安全侧），不硬崩。
// 加载期预热：tool_call 到达时探针已就绪，避免首读竞态放行。
let subagentProbe: (() => boolean) | undefined;
import("@tintinweb/pi-subagents/dist/child-context.js")
  .then((mod) => {
    subagentProbe = mod.inChildSessionContext;
  })
  .catch(() => {
    console.warn("[hpl-protected-paths] subagent 探针不可得，子会话敏感读取将走 confirm 流程");
  });

function inSubagentSession(): boolean {
  return subagentProbe ? subagentProbe() : false;
}

/**
 * /allow 参数解析 — 纯函数，独立可测。
 *
 * 支持空格分隔批量路径（计划 line 353 语义）。
 */
export type AllowArgs =
  | { kind: "list"; paths: [] }
  | { kind: "clear"; paths: [] }
  | { kind: "add"; paths: string[] };

export function parseAllowArgs(argsStr: string): AllowArgs {
  const arg = argsStr.trim();
  if (arg === "--list") return { kind: "list", paths: [] };
  if (arg === "--clear") return { kind: "clear", paths: [] };
  const paths = arg.split(/\s+/).filter(Boolean);
  return { kind: "add", paths };
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const rawPath: string = event.input.path ?? "";
      if (!rawPath) {
        console.warn("write/edit 工具调用缺少 path 参数，安全扩展无法生效");
        return;
      }

      // 入口统一 resolve（~ 展开 + 相对路径解析 + symlink 跟随），
      // 后续所有信任检查/写入均基于规范化路径——保证 /allow .env 后
      // agent 写 ./.env 也能命中白名单（resolve 幂等，已解析路径无副作用）
      const filePath = resolveTarget(rawPath, ctx.cwd);

      const toolName = isToolCallEventType("edit", event) ? "edit" : "write";

      // confirm 路径 → 查 session + project trust
      const verdict = classifyPath(filePath, toolName, ctx.cwd);

      if (verdict === "block") {
        // block 路径 → 仅 session trust
        if (!isSessionTrusted(toolName, filePath)) {
          // 拦截必须留痕（Make It Observable），issue #6
          console.warn(`[hpl-protected-paths] 受保护的文件路径，不允许写入: ${filePath}`);
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
          console.warn(`[hpl-protected-paths] ${reason}`);
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
      const rawPath: string = event.input.path ?? "";
      if (!rawPath) {
        console.warn("read 工具调用缺少 path 参数，安全扩展无法生效");
        return;
      }

      // 与 write/edit 分支一致：入口 resolve，信任检查基于规范化路径
      const filePath = resolveTarget(rawPath, ctx.cwd);

      if (isTrusted("read", filePath, ctx.cwd)) return;

      const verdict = classifyPath(filePath, "read", ctx.cwd);
      if (verdict !== "confirm") return;

      // subagent 无人在场确认（issue #39）：confirm 框的 unavailable 分支
      // 在子会话本就会 block，但语义上应显式区分——子会话内敏感读取一律
      // 直接拦截，不走 confirm 流程。
      if (inSubagentSession()) {
        const reason = `🛡️ subagent 会话禁止读取敏感文件：${filePath}（如需读取请在主会话操作）`;
        console.warn(`[hpl-protected-paths] ${reason}`);
        return { block: true, reason };
      }

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
        console.warn(`[hpl-protected-paths] ${reason}`);
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
    description: "会话级临时白名单（读写均生效）。用法：/allow <path>... | --list | --clear",
    handler: async (argsStr, ctx) => {
      // 非交互上下文（无 UI）时 notify 静默，不抛异常
      const notify = (msg: string, level: "info" | "warning" = "info") => ctx.ui?.notify(msg, level);
      const args = parseAllowArgs(argsStr);

      if (args.kind === "list") {
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
          notify("白名单为空", "info");
        } else {
          notify(lines.join("\n"), "info");
        }
        return;
      }

      if (args.kind === "clear") {
        // 计数按路径条数（不是 toolName 分组数），issue #10 发现 6
        const count = listSessionTrust().reduce((n, g) => n + g.targets.length, 0);
        clearSessionTrust();
        notify(`已清空 ${count} 条 session 白名单`, "info");
        return;
      }

      if (args.paths.length === 0) {
        notify("用法：/allow <path>... | --list | --clear", "warning");
        return;
      }

      // /allow → 加入 session 白名单（支持空格分隔批量，issue #10 发现 3）
      const added: string[] = [];
      for (const p of args.paths) {
        const resolved = resolveTarget(p, ctx.cwd);

        // block 路径（SSH key/凭证等高危）：需高危二次确认，且强制 session 级
        // （不提供 project 持久化选项，block 保护不可被项目配置永久绕过）
        if (classifyPath(resolved, "write", ctx.cwd) === "block") {
          const ok = await requestHighRiskConfirm(
            ctx,
            "⚠️⚠️ 高危路径确认",
            `将解除高危路径的写保护：\n\n> ${p}\n\n` +
              "该路径（SSH 密钥/凭证/证书等）本应被硬性阻止写入。" +
              "确认本次会话允许修改它？",
          );
          if (!ok) {
            notify(`已拒绝高危路径：${p}`, "warning");
            continue;
          }
        }

        addTrust("write", resolved, "session", ctx.cwd);
        addTrust("edit", resolved, "session", ctx.cwd);
        addTrust("read", resolved, "session", ctx.cwd);
        added.push(p);
      }

      if (added.length > 0) {
        notify(`✅ 已添加 session 白名单：${added.join(", ")}（读写均生效）`, "info");
      }
    },
  });
}
