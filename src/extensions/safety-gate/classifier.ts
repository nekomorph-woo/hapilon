/**
 * classifier.ts — 命令安全分类纯函数
 *
 * classifyCommand — block / confirm / allow 三级分类
 * hasShellInjection — shell 注入技巧检测
 */

import { BLOCK_PATTERNS, CONFIRM_PATTERNS, SHELL_INJECTION_PATTERNS } from "./rules.js";

export type SafetyVerdict = "block" | "confirm" | "allow";

export function classifyCommand(command: string): SafetyVerdict {
  const trimmed = command.trim();
  if (!trimmed) return "allow";

  if (hasShellInjection(trimmed)) return "block";

  for (const pattern of BLOCK_PATTERNS) {
    if (pattern.test(trimmed)) return "block";
  }

  for (const pattern of CONFIRM_PATTERNS) {
    if (pattern.test(trimmed)) return "confirm";
  }

  return "allow";
}

export function hasShellInjection(command: string): boolean {
  if (!command) return false;
  return SHELL_INJECTION_PATTERNS.some((re) => re.test(command));
}
