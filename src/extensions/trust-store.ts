/**
 * trust-store.ts — 命令+路径双维度信任存储
 *
 * session 级：内存 Map<toolName, Set<target>>，结束自动清除
 * project 级：持久化到 .hapilon/config.local.json 的 allow 字段
 *
 * 使用：
 *   - confirm 路径 → isTrusted() 检查（session + project）
 *   - block 路径 → isSessionTrusted() 检查（仅 session）
 *
 * 来源: _plans/project-config-and-trust.md
 */

import { readProjectConfig, writeProjectLocalConfig, readProjectLocalConfig } from "../project-config.js";

// ─── Session 级信任（内存）──────────────────────────────────────────

const sessionTrust: Map<string, Set<string>> = new Map();

// ─── Session API ─────────────────────────────────────────────────────

export function addSessionTrust(toolName: string, target: string): void {
  let set = sessionTrust.get(toolName);
  if (!set) {
    set = new Set();
    sessionTrust.set(toolName, set);
  }
  set.add(target);
}

export function isSessionTrusted(toolName: string, target: string): boolean {
  const set = sessionTrust.get(toolName);
  return set?.has(target) ?? false;
}

export function clearSessionTrust(): void {
  sessionTrust.clear();
}

export function listSessionTrust(): Array<{ toolName: string; targets: string[] }> {
  const result: Array<{ toolName: string; targets: string[] }> = [];
  for (const [toolName, set] of sessionTrust) {
    if (set.size > 0) {
      result.push({ toolName, targets: [...set] });
    }
  }
  return result;
}

// ─── Project API ─────────────────────────────────────────────────────

/** 仅读本地 config.local.json 的 allow（不合并团队 config.json） */
function loadLocalAllow(cwd: string): Record<string, string[]> {
  const local = readProjectLocalConfig(cwd);
  const allow = local.allow;
  if (allow && typeof allow === "object" && !Array.isArray(allow)) {
    return allow as Record<string, string[]>;
  }
  return {};
}

/** 读合并后的 allow（用于检查：含团队 config.json + 本地） */
function loadMergedAllow(cwd: string): Record<string, string[]> {
  const config = readProjectConfig(cwd);
  const allow = config.allow;
  if (allow && typeof allow === "object" && !Array.isArray(allow)) {
    return allow as Record<string, string[]>;
  }
  return {};
}

function saveLocalAllow(allow: Record<string, string[]>, cwd: string): void {
  try {
    writeProjectLocalConfig({ allow }, cwd);
  } catch (err) {
    console.warn("写入项目级信任配置失败:", err instanceof Error ? err.message : String(err));
  }
}

export function addProjectTrust(toolName: string, target: string, cwd: string): void {
  const allow = loadLocalAllow(cwd);
  const list = allow[toolName] ?? [];
  if (!list.includes(target)) {
    list.push(target);
  }
  allow[toolName] = list;
  saveLocalAllow(allow, cwd);
}

export function isProjectTrusted(toolName: string, target: string, cwd: string): boolean {
  const allow = loadMergedAllow(cwd);
  const list = allow[toolName];
  return list?.includes(target) ?? false;
}

export function listProjectTrust(cwd: string): Array<{ toolName: string; targets: string[] }> {
  const allow = loadMergedAllow(cwd);
  return Object.entries(allow).map(([toolName, targets]) => ({ toolName, targets: targets as string[] }));
}

// ─── Unified API ─────────────────────────────────────────────────────

export type TrustScope = "session" | "project";

/**
 * 添加信任。
 * @param scope "session" — 内存 / "project" — 持久化到 config.local.json
 */
export function addTrust(
  toolName: string,
  target: string,
  scope: TrustScope,
  cwd: string,
): void {
  if (scope === "session") {
    addSessionTrust(toolName, target);
  } else {
    addProjectTrust(toolName, target, cwd);
  }
}

/**
 * 检查是否有信任（confirm 路径用）。
 * 查询顺序：session → project
 */
export function isTrusted(toolName: string, target: string, cwd: string): boolean {
  if (isSessionTrusted(toolName, target)) return true;
  return isProjectTrusted(toolName, target, cwd);
}
