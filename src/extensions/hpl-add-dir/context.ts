/**
 * context.ts — hpl-add-dir 目录上下文扫描与注入构建（纯函数）
 *
 * vendor 自 pi-add-dir v1.3.1，按 hapilon 受控上下文设计改造（#29）：
 * 只注入 HAPILON.md（目录根 + .pi/ 子目录），AGENTS.md / CLAUDE.md
 * 不读取、不注入；外部 skills 不注入、不注册。
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ────────────────────────────────────────────────────────────

export interface AddedDir {
  /** Absolute path to the directory */
  absolutePath: string;
  /** Display label (basename or user-provided alias) */
  label: string;
  /** Timestamp when added */
  addedAt: number;
}

export interface DirContext {
  /** Path to the directory */
  dir: string;
  /** Content of HAPILON.md if found（根 + .pi/ 合并） */
  hapilonMd: string | null;
  /** Extensions found in .pi/extensions/ */
  extensionPaths: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** 只注入 HAPILON.md——hapilon 受控上下文体系（AGENTS/CLAUDE 由 --no-context-files 关闭） */
const CONTEXT_FILES = ["HAPILON.md"];

// Extension directories to scan, relative to a project root
const EXTENSION_DIRS = [".pi/extensions"];

function dirExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

// ─── Scan ─────────────────────────────────────────────────────────────

/**
 * Scan a directory for HAPILON.md（根 + .pi/ 子目录）和扩展提示。
 */
export function scanDirContext(dir: string): DirContext {
  const ctx: DirContext = {
    dir,
    hapilonMd: null,
    extensionPaths: [],
  };

  // Read HAPILON.md from root and .pi/ subdirectory
  for (const name of CONTEXT_FILES) {
    const content = readFileSafe(path.join(dir, name));
    if (content) ctx.hapilonMd = content;
  }
  for (const name of CONTEXT_FILES) {
    const piContent = readFileSafe(path.join(dir, ".pi", name));
    if (piContent) {
      ctx.hapilonMd = (ctx.hapilonMd ?? "") + "\n\n" + piContent;
    }
  }

  // Discover extensions（仅提示，不自动加载——与 pi-add-dir 原行为一致）
  for (const extDir of EXTENSION_DIRS) {
    const fullExtDir = path.join(dir, extDir);
    if (!dirExists(fullExtDir)) continue;

    try {
      const entries = fs.readdirSync(fullExtDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".ts")) {
          ctx.extensionPaths.push(path.join(fullExtDir, entry.name));
        } else if (entry.isDirectory()) {
          const indexPath = path.join(fullExtDir, entry.name, "index.ts");
          if (readFileSafe(indexPath) !== null) {
            ctx.extensionPaths.push(indexPath);
          }
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  return ctx;
}

// ─── Context injection cache ──────────────────────────────────────────

let contextCache: { dirs: string; injection: string } | null = null;

/**
 * Invalidate the context injection cache.
 * Called when dirs are added/removed so the next turn re-scans.
 */
export function invalidateContextCache(): void {
  contextCache = null;
}

/**
 * Build the system prompt injection from all added directories.
 * Cached by directory list — only re-scans when dirs change.
 */
export function buildContextInjection(dirs: AddedDir[]): string {
  if (dirs.length === 0) return "";

  // Cache key: sorted absolute paths
  const cacheKey = dirs.map((d) => d.absolutePath).sort().join("\0");
  if (contextCache && contextCache.dirs === cacheKey) {
    return contextCache.injection;
  }

  const sections: string[] = [];
  sections.push("\n\n## External Directories (added via /add-dir)");
  sections.push(
    `\nThe following ${dirs.length} external director${dirs.length === 1 ? "y is" : "ies are"} included in this session. You can read, edit, and write files in these directories using absolute paths.\n`,
  );

  for (const dir of dirs) {
    const ctx = scanDirContext(dir.absolutePath);
    sections.push(`### 📁 ${dir.label} — \`${dir.absolutePath}\``);

    // HAPILON.md — 唯一注入的上下文文件（hapilon 受控上下文设计）
    if (ctx.hapilonMd) {
      sections.push(`\n#### HAPILON.md (from ${dir.label})\n${ctx.hapilonMd}`);
    }

    // Summary of directory contents
    try {
      const entries = fs.readdirSync(dir.absolutePath, { withFileTypes: true });
      const topLevel = entries
        .filter((e) => !e.name.startsWith(".") || e.name === ".pi" || e.name === ".agents")
        .slice(0, 20)
        .map((e) => `${e.isDirectory() ? "📂" : "📄"} ${e.name}`);
      if (topLevel.length > 0) {
        sections.push(`\n<details><summary>Top-level contents</summary>\n\n${topLevel.join("\n")}\n</details>`);
      }
    } catch {
      // Skip if unreadable
    }
  }

  const injection = sections.join("\n");
  contextCache = { dirs: cacheKey, injection };
  return injection;
}
