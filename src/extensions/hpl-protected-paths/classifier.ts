/**
 * classifier.ts — 路径分类纯函数
 *
 * expandTilde — ~ 展开为 home 目录
 * resolveTarget — 解析绝对路径 + symlink + `..` 归一化
 * classifyPath — 按工具类型返回 block / confirm / allow
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { WRITE_BLOCK, WRITE_CONFIRM, READ_CONFIRM } from "./rules.js";

export type PathVerdict = "block" | "confirm" | "allow";

export function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return homedir() + p.slice(1);
  }
  return p;
}

export function resolveTarget(targetPath: string, cwd: string): string {
  if (!targetPath) return resolve(cwd);
  const expanded = expandTilde(targetPath);
  const absPath = resolve(cwd, expanded);
  try {
    return realpathSync(absPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return absPath;
    console.warn("路径解析异常 (realpath):", code ?? String(err), "→ 回退到未解析路径");
    return absPath;
  }
}

export function classifyPath(
  targetPath: string,
  toolName: "write" | "edit" | "read",
  cwd?: string,
): PathVerdict {
  const cwd_ = cwd ?? process.cwd();
  const resolved = resolveTarget(targetPath, cwd_);
  const name = basename(resolved);

  if (toolName === "write" || toolName === "edit") {
    for (const pattern of WRITE_BLOCK) {
      if (pattern.test(resolved, name)) return "block";
    }
    for (const pattern of WRITE_CONFIRM) {
      if (pattern.test(resolved, name)) return "confirm";
    }
    return "allow";
  }

  if (toolName === "read") {
    for (const pattern of READ_CONFIRM) {
      if (pattern.test(resolved)) return "confirm";
    }
    return "allow";
  }

  return "allow";
}
