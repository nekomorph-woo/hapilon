/**
 * hpl-safety-gate/index.ts — 危险命令拦截扩展
 *
 * 通过 pi.on("tool_call", ...) 拦截 bash 工具调用：
 *   BLOCK — 高危直接阻止
 *   CONFIRM — 中危 4 选项弹框
 *   ALLOW — 正常放行
 *
 * 用法: hapilon 启动时自动加载（discoverExtensions() → -e 注入）
 * 拦截点: pi 的 tool_call 事件（能读到工具入参，也就能放行/改写）
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { agentDir, hapilonHome } from "../../config/hapilon-home.js";
import { classifyCommand, classifyWithLabel, hasShellInjection } from "./classifier.js";
import { checkSandboxWrite, type SandboxTarget } from "./sandbox-allow.js";
import {
  judgeCommand,
  readGateAutoConfig,
  type AutoVerdict,
  type GateAutoConfig,
  type GateAutoError,
} from "./auto-judge.js";
import { deriveAllowPattern } from "./derive-allow.js";
import { hasSensitiveReadArg, sensitiveReadLabels } from "./sensitive-args.js";
import { requestConfirm } from "../hpl-protected-paths/confirm.js";
import { addTrust, isTrusted, initProjectTrust } from "../../config/trust-store.js";

// subagent 会话探针（分级依赖）：与 hpl-protected-paths 同款。
// bash 读敏感文件时 subagent block、主会话 confirm——与 read 分级一致。
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

// 提示文本紧凑化：折叠空白（多行/正则命令不再断行爆宽），截 80 字符，超长补省略号
function compactCommand(command: string): string {
  const oneLine = command.trim().replace(/\s+/g, " ");
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

// ─── Auto 模式：审计与会话状态 ──────────────────────────────────────────

export interface GateAutoAuditEntry {
  ts: string;
  cwd: string;
  command: string;
  ruleLabel?: string;
  layer: "sandbox" | "model" | "cache";
  verdict: AutoVerdict;
  reason: string;
  model: string;
  latencyMs?: number;
  outcome: "auto-allow" | "fallback-confirm" | "fallback-block";
}

/** 审计 append-only；写失败只 warn 不阻塞主流程 */
export function appendGateAutoAudit(
  entry: GateAutoAuditEntry,
  filePath: string = join(agentDir(), "gate-auto.jsonl"),
): void {
  try {
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    console.warn(`[hpl-safety-gate] gate-auto 审计写入失败（不阻塞）: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function sandboxSummary(targets: SandboxTarget[]): string {
  if (targets.length === 0) return "无写目标";
  return targets
    .map((t) => `${t.raw} → ${t.resolved}${t.note ? `（${t.note}）` : ""}`)
    .join("; ");
}

function gateAutoErrorReason(error: GateAutoError): string {
  return error._tag === "GateAutoTimeout"
    ? `判定超时（${error.timeoutMs}ms）`
    : error.message;
}

/** HAPILON_HOME 非法（相对路径）时退回默认，不让审计/沙箱判定炸掉主流程 */
function safeHapilonHome(): string {
  try {
    return hapilonHome();
  } catch {
    return join(homedir(), ".hapilon");
  }
}

export { classifyCommand, classifyWithLabel, hasShellInjection } from "./classifier.js";

export default function (pi: ExtensionAPI) {
  // 加载时初始化项目信任缓存：本进程是 project trust 的消费方
  initProjectTrust(process.cwd());

  // Auto 模式会话级开关：--gate-auto 强制开启（settings gateAuto.enabled 亦可）
  pi.registerFlag("gate-auto", {
    type: "boolean",
    default: false,
    description: "会话级开启安全门 Auto 判定（confirm 级命令由沙箱规则/档位模型自动放行）",
  });

  // Auto 会话状态：配置 + 同命令判定缓存（会话级，session_start 重置）
  let gateAutoConfig: GateAutoConfig | undefined;
  let verdictCache = new Map<string, { verdict: AutoVerdict; reason: string }>();

  pi.on("session_start", () => {
    gateAutoConfig = readGateAutoConfig();
    verdictCache = new Map();
  });

  /** Auto 判定 + 审计；返回 true 表示已放行/已决，调用方直接返回；false 回落现状 */
  const runAutoGate = async (
    command: string,
    normalized: string,
    ruleLabel: string | undefined,
    ctx: ExtensionContext,
  ): Promise<boolean> => {
    if (gateAutoConfig === undefined) gateAutoConfig = readGateAutoConfig();
    const enabled = gateAutoConfig.enabled || pi.getFlag("gate-auto") === true;
    if (!enabled) return false;

    const audit = (entry: Omit<GateAutoAuditEntry, "ts" | "cwd" | "command" | "ruleLabel">) =>
      appendGateAutoAudit({ ts: new Date().toISOString(), cwd: ctx.cwd, command: normalized, ruleLabel, ...entry });

    // 1. 会话内缓存：沿用上次 verdict，不重复调模型
    const cached = verdictCache.get(normalized);
    if (cached) {
      if (cached.verdict === "allow") {
        audit({ layer: "cache", verdict: "allow", reason: cached.reason, model: "cache", outcome: "auto-allow" });
        return true;
      }
      audit({
        layer: "cache",
        verdict: cached.verdict,
        reason: cached.reason,
        model: "cache",
        outcome: ctx.hasUI ? "fallback-confirm" : "fallback-block",
      });
      return false;
    }

    // 2. 沙箱规则先行：破坏性命令词 + 全部写目标在沙箱集 → 免模型直接放行
    const sandbox = checkSandboxWrite(command, { cwd: ctx.cwd, home: safeHapilonHome() });
    if (sandbox.allowed) {
      audit({ layer: "sandbox", verdict: "allow", reason: sandboxSummary(sandbox.targets), model: "sandbox", outcome: "auto-allow" });
      return true;
    }

    // 3. 档位模型判定；超时/错误/不合法 → 按 unsure 回落现状
    const startedAt = Date.now();
    const result = await Effect.runPromise(Effect.either(judgeCommand({
      modelSpec: gateAutoConfig.model,
      timeoutMs: gateAutoConfig.timeoutMs,
      command,
      cwd: ctx.cwd,
      ruleLabel,
      sandboxSummary: sandboxSummary(sandbox.targets),
      available: ctx.modelRegistry.getAvailable(),
      complete: (model, request, options) => ctx.modelRegistry.complete(model, request, options),
    })));
    const latencyMs = Date.now() - startedAt;

    if (result._tag === "Right") {
      const judgement = result.right;
      verdictCache.set(normalized, { verdict: judgement.verdict, reason: judgement.reason });
      if (judgement.verdict === "allow") {
        audit({ layer: "model", verdict: "allow", reason: judgement.reason, model: judgement.model ?? gateAutoConfig.model, latencyMs, outcome: "auto-allow" });
        return true;
      }
      audit({
        layer: "model",
        verdict: judgement.verdict,
        reason: judgement.reason,
        model: judgement.model ?? gateAutoConfig.model,
        latencyMs,
        outcome: ctx.hasUI ? "fallback-confirm" : "fallback-block",
      });
      return false;
    }
    audit({
      layer: "model",
      verdict: "unsure",
      reason: gateAutoErrorReason(result.left),
      model: gateAutoConfig.model,
      latencyMs,
      outcome: ctx.hasUI ? "fallback-confirm" : "fallback-block",
    });
    return false;
  };

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command: string = event.input.command;
    if (!command) return;

    // 标准化空白字符用于信任匹配
    const normalized = command.trim().replace(/\s+/g, " ");
    // 折叠后的单行命令（超长截断），所有 warn/reason 提示文本共用
    const shown = compactCommand(command);

    const { verdict, label } = classifyWithLabel(command);
    if (verdict === "allow") {
      // 敏感文件 bash 读检测：危险命令规则放行后，
      // 参数命中 READ_CONFIRM 的命令进入分级拦截——
      // subagent 会话硬拦（read 同级），主会话走 confirm。
      if (hasSensitiveReadArg(command, ctx.cwd)) {
        const labels = sensitiveReadLabels(command, ctx.cwd).join("、");
        if (inSubagentSession()) {
          console.warn(`[hpl-safety-gate] subagent 会话禁止读取敏感文件（${labels}）: ${shown}`);
          return {
            block: true,
            reason: `🛡️ subagent 会话禁止读取敏感文件（${labels}）：secret 只该被应用运行时读取，agent 读取会进入 LLM 上下文与 transcript。请在主会话中操作，或使用白名单文件（.env.example）。`,
          };
        }
        if (isTrusted("bash", normalized, ctx.cwd)) return;
        if (!ctx.hasUI) {
          console.warn(`[hpl-safety-gate] 非交互模式下禁止读取敏感文件（${labels}）: ${shown}`);
          return {
            block: true,
            reason: `🛡️ 非交互模式下禁止读取敏感文件（${labels}）：${shown}`,
          };
        }
        const result = await requestConfirm(
          ctx,
          "⚠️ 敏感文件读取确认",
          `命令将读取敏感文件（${labels}）：\n\n> ${normalized.slice(0, 200)}\n\n是否仍然执行？`,
          { allowSuggestion: deriveAllowPattern(normalized) },
        );
        if (result.status !== "approved") {
          const reason = result.status === "unavailable"
            ? `🛡️ 非交互模式下禁止读取敏感文件（${labels}）`
            : `用户拒绝了敏感文件读取：${shown}`;
          console.warn(`[hpl-safety-gate] ${reason}`);
          return { block: true, reason };
        }
        try {
          if (result.scope !== "once") {
            addTrust("bash", result.allowPattern ?? normalized, result.scope, ctx.cwd);
          }
        } catch (err) {
          console.warn("添加信任失败（不影响本次操作）:", err instanceof Error ? err.message : String(err));
        }
      }
      return;
    }

    if (verdict === "block") {
      // 拦截必须留痕（Make It Observable）
      console.warn(`[hpl-safety-gate] 危险命令已阻止: ${shown}`);
      return {
        block: true,
        reason: `🛡️ 危险命令已阻止：${shown}`,
      };
    }

    // confirm → 先查 trust（用标准化后的命令）
    if (isTrusted("bash", normalized, ctx.cwd)) return;

    // Auto 模式：缓存 → 沙箱规则 → 模型判定先行接管 confirm 级（block 级永不放松）
    if (await runAutoGate(command, normalized, label, ctx)) return;

    if (!ctx.hasUI) {
      // 拦截必须留痕（Make It Observable）
      console.warn(`[hpl-safety-gate] 非交互模式下拦截中危命令: ${shown}`);
      return {
        block: true,
        reason: `🛡️ 非交互模式下拦截中危命令：${shown}`,
      };
    }

    const result = await requestConfirm(
      ctx,
      "⚠️ 危险操作确认",
      `检测到潜在危险操作：\n\n> ${normalized.slice(0, 200)}\n\n是否仍然执行？`,
      { allowSuggestion: deriveAllowPattern(normalized) },
    );
    if (result.status !== "approved") {
      const reason = result.status === "unavailable"
        ? `🛡️ 非交互模式下拦截中危命令：${shown}`
        : result.status === "error"
        ? `🛡️ 确认对话框异常，已阻止：${shown}`
        : `用户拒绝了此操作：${shown}`;
      // 拦截必须留痕（Make It Observable）
      console.warn(`[hpl-safety-gate] ${reason}`);
      return { block: true, reason };
    }
    try {
      if (result.scope !== "once") {
        addTrust("bash", result.allowPattern ?? normalized, result.scope, ctx.cwd);
      }
    } catch (err) {
      console.warn("添加信任失败（不影响本次操作）:", err instanceof Error ? err.message : String(err));
    }
  });
}
