/**
 * whitelist.ts — 会话级白名单（读写均生效）
 *
 * /allow <path> 加白名单 → Set 存解析后的绝对路径
 * session 结束时自动清除（不持久化）
 */

import { resolveTarget } from "./classifier.js";

const allowed: Set<string> = new Set();

function resolveKey(targetPath: string, cwd: string): string | null {
  if (!targetPath) return null;
  return resolveTarget(targetPath, cwd);
}

export function addAllow(targetPath: string, cwd: string): void {
  const key = resolveKey(targetPath, cwd);
  if (key) allowed.add(key);
}

export function removeAllow(targetPath: string, cwd: string): void {
  const key = resolveKey(targetPath, cwd);
  if (key) allowed.delete(key);
}

export function isAllowed(resolvedPath: string): boolean {
  return allowed.has(resolvedPath);
}

export function clearAllow(): void {
  allowed.clear();
}

export function listAllow(): string[] {
  return [...allowed];
}

export function isPathAllowed(targetPath: string, cwd: string): boolean {
  const key = resolveKey(targetPath, cwd);
  return key !== null && allowed.has(key);
}
