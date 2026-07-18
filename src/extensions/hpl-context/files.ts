/**
 * files.ts — hapilon 上下文文件发现函数（基于文件系统 I/O，非纯函数）
 *
 * 扫描 ~/.hapilon/ 和 .hapilon/ 目录体系，收集 HAPILON.md / rules / skills 文件。
 * 设计来源: _plans/hpl-context-system.md §4.2
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";

/** 拆分 YAML frontmatter 与正文；无 frontmatter 时返回 undefined + 原始内容 */
function splitFrontmatter(content: string): { meta: Record<string, string> | undefined; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return { meta: undefined, body: content };
  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx === -1) return { meta: undefined, body: content };
  const raw = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 3).trimStart();
  try {
    // 极简解析：key: value 每行一个；处理 YAML 布尔值和引号
    const meta: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const rawValue = line.slice(colonIdx + 1).trim();
      // YAML 布尔值：true / false
      if (rawValue === "true" || rawValue === "false") {
        meta[key] = rawValue;
      } else {
        // 剥离 YAML 引号
        meta[key] = /^["'](.*)["']$/.exec(rawValue)?.[1] ?? rawValue;
      }
    }
    return { meta, body };
  } catch {
    return { meta: undefined, body: content };
  }
}

/** 单层目录内的文件发现：返回匹配 pattern 的完整路径数组（仅直接子级，不递归；字母序） */
export function listFiles(dir: string, pattern: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    const entries = readdirSync(dir).sort();
    const isWildcard = pattern.startsWith("*");
    const suffix = isWildcard ? pattern.slice(1) : null;
    return entries
      .filter((name) => {
        if (name.startsWith(".")) return false;
        if (suffix !== null) return name.endsWith(suffix);
        return name === pattern;
      })
      .map((name) => join(dir, name));
  } catch (err) {
    console.warn(`Warning: 跳过目录 ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * 从 startDir 逐级向上遍历目录树（不含 home 之上的父级），
 * 在每层检查 `<dir>/.hapilon/<relative>`：若为文件则收集其路径；若为
 * 目录则收集该目录路径（供后续 listFiles 扫描）。
 * 返回数组按祖先→深层顺序排列（reverse，深层在后），使其在合并时
 * 最深层的同名条目覆盖浅层。
 */
export function collectUpward(startDir: string, home: string, relative: string): string[] {
  const results: string[] = [];
  let dir = resolve(startDir);
  const resolvedHome = resolve(home);
  while (true) {
    const candidate = join(dir, ".hapilon", relative);
    if (existsSync(candidate)) {
      results.push(candidate);
    }
    if (dir === resolvedHome) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  results.reverse(); // 祖先在前，近层在后
  return results;
}

/** 读取 HAPILON.md 文件，失败直接抛出（Fail Fast） */
export function readHapilonMd(paths: string[]): { path: string; content: string }[] {
  return paths.map((p) => ({ path: p, content: readFileSync(p, "utf8") }));
}

/**
 * 扫描规则目录，读取所有 .md 文件并解析 alwaysApply frontmatter。
 * 返回 alwaysApply 为 true（默认）的规则；文件名为规则名（去后缀）。
 * 目录不存在或单个文件读取/解析失败时静默跳过（输出 warning）。
 */
export function readRules(dirPaths: string[]): { name: string; content: string }[] {
  const rules: { name: string; content: string }[] = [];
  for (const dp of dirPaths) {
    for (const file of listFiles(dp, "*.md")) {
      try {
        const raw = readFileSync(file, "utf8");
        const { meta, body } = splitFrontmatter(raw);
        const alwaysApply = meta?.alwaysApply !== "false"; // 默认 true
        if (!alwaysApply) continue;
        rules.push({ name: basename(file, ".md"), content: body });
      } catch (err) {
        console.warn(`Warning: 跳过规则文件 ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return rules;
}

/**
 * 扫描技能目录，返回所有包含 SKILL.md 的子目录中的 SKILL.md 绝对路径。
 * Pi 的 loadSkillsFromPaths() 接收这些路径并解析 SKILL.md，自动处理
 * frontmatter 校验、名称去重和渐进式披露。
 */
export function discoverSkillPaths(dirs: string[]): string[] {
  const paths: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const skillMd = join(dir, entry.name, "SKILL.md");
        if (existsSync(skillMd)) paths.push(skillMd);
      }
    } catch (err) {
      console.warn(`Warning: 跳过 skill 目录 ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return paths;
}
