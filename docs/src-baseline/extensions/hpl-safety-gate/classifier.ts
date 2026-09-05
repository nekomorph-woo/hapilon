/**
 * classifier.ts — 命令安全分类纯函数
 *
 * classifyCommand — block / confirm / allow 三级分类
 * hasShellInjection — shell 注入技巧检测
 */

import { BLOCK_PATTERNS, CONFIRM_PATTERNS, SHELL_INJECTION_PATTERNS } from "./rules.js";

export type SafetyVerdict = "block" | "confirm" | "allow";

/**
 * 归一化检测副本——不修改原始命令，仅用于规则匹配。
 * 反斜杠转义空白（`rm\ -rf\ /`）与 IFS 变量（`${IFS}`/`$IFS`，shell 展开为空白）
 * 在真实执行中等价于普通空白，检测时需同步归一化，否则绕过 `\s+` 匹配。issue #6
 */
function normalizeForInspection(command: string): string {
  return command
    .replace(/\\ /g, " ")
    .replace(/\$\{IFS\}/g, " ")
    .replace(/\$IFS\b/g, " ");
}

export function classifyCommand(command: string): SafetyVerdict {
  const trimmed = command.trim();
  if (!trimmed) return "allow";

  const normalized = normalizeForInspection(trimmed);

  if (hasShellInjection(normalized)) return "block";

  for (const pattern of BLOCK_PATTERNS) {
    if (pattern.test(normalized)) return "block";
  }

  for (const pattern of CONFIRM_PATTERNS) {
    if (pattern.test(normalized)) return "confirm";
  }

  return "allow";
}

export function hasShellInjection(command: string): boolean {
  if (!command) return false;
  return SHELL_INJECTION_PATTERNS.some((re) => re.test(command));
}
