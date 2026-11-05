/**
 * index-core.ts — 会话索引扫描 / 关键词粗滤 / 正文 grep（纯逻辑，供命令、面板、工具共用）
 *
 * 会话文件格式（实测 pi session-manager）：
 *   首行 {type:"session", id, timestamp, cwd}；session_info 带名字；
 *   message 条目的 message.content 为 string 或 {type:"text"} 块数组。
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SessionExcerpt {
  path: string;
  id: string;
  cwd: string;
  /** /name 设置的名字；未命名为空串 */
  name: string;
  created: string;
  modified: string;
  messageCount: number;
  firstUser: string;
  lastUser: string;
  sizeBytes: number;
}

export interface GrepHit {
  path: string;
  id: string;
  name: string;
  cwd: string;
  snippet: string;
}

export const DEFAULT_SCAN_LIMIT = 150;

/** 去掉工具注入的 acp 标签与 skill XML 包裹，只留人说的话。 */
export function cleanUserText(text: string): string {
  return text
    .replace(/\u003cacp[^>]*\u003e[\s\S]*?\u003c\/acp\u003e/g, " ")
    .replace(/\u003c\/?(?:acp[^>]*|skill[^>]*)\u003e/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: string } =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
    .map((block) => block.text ?? "")
    .join(" ");
}

/** 解析单个会话文件：header + 名字 + 首末用户消息。解析失败返回 null（视为损坏文件跳过）。 */
export async function parseSessionFile(
  filePath: string,
  sizeBytes: number,
): Promise<SessionExcerpt | null> {
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    let header: { id?: unknown; timestamp?: unknown; cwd?: unknown } | null = null;
    let name = "";
    let messageCount = 0;
    let firstUser = "";
    let lastUser = "";
    let lastModified = "";
    for await (const line of rl) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!header) {
        if (entry.type !== "session") return null;
        header = entry;
        continue;
      }
      if (entry.type === "session_info") {
        const v = entry.name;
        name = typeof v === "string" ? v.trim() : "";
      }
      if (entry.type !== "message") continue;
      messageCount++;
      if (typeof entry.timestamp === "string") lastModified = entry.timestamp;
      const message = entry.message as { role?: unknown; content?: unknown } | undefined;
      if (!message || message.role !== "user") continue;
      const cleaned = cleanUserText(extractTextContent(message.content));
      if (!cleaned) continue;
      if (!firstUser) firstUser = cleaned;
      lastUser = cleaned;
    }
    if (!header) return null;
    return {
      path: filePath,
      id: typeof header.id === "string" ? header.id : "",
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      name,
      created: typeof header.timestamp === "string" ? header.timestamp : "",
      modified: lastModified || (typeof header.timestamp === "string" ? header.timestamp : ""),
      messageCount,
      firstUser,
      lastUser,
      sizeBytes,
    };
  } catch {
    return null;
  }
}

/** 列出 sessions 根目录下全部 jsonl（跨目录），按 mtime 降序。 */
export function listSessionFiles(sessionsRoot: string): Array<{ path: string; mtimeMs: number; sizeBytes: number }> {
  const files: Array<{ path: string; mtimeMs: number; sizeBytes: number }> = [];
  let dirEntries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    dirEntries = readdirSync(sessionsRoot, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean }>;
  } catch {
    return files;
  }
  for (const dir of dirEntries) {
    if (!dir.isDirectory()) continue;
    const sub = join(sessionsRoot, dir.name);
    let fileEntries: Array<{ name: string; isFile(): boolean }> = [];
    try {
      fileEntries = readdirSync(sub, { withFileTypes: true }) as unknown as Array<{ name: string; isFile(): boolean }>;
    } catch {
      continue;
    }
    for (const file of fileEntries) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const full = join(sub, file.name);
      try {
        const stats = statSync(full);
        files.push({ path: full, mtimeMs: stats.mtimeMs, sizeBytes: stats.size });
      } catch {
        // 文件在列目录与 stat 之间被删——跳过
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 扫描最近 limit 个会话，产出索引。 */
export async function scanSessions(sessionsRoot: string, limit = DEFAULT_SCAN_LIMIT): Promise<SessionExcerpt[]> {
  const files = listSessionFiles(sessionsRoot).slice(0, limit);
  const parsed = await Promise.all(files.map((f) => parseSessionFile(f.path, f.sizeBytes)));
  return parsed.filter((e): e is SessionExcerpt => e !== null);
}

/** 关键词粗滤：每个查询 token 在 名字/cwd/首末消息 命中记 1 分，降序。 */
export function prefilter(entries: SessionExcerpt[], query: string): SessionExcerpt[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return entries;
  const scored = entries.map((entry) => {
    const haystack = `${entry.name} ${entry.cwd} ${entry.firstUser} ${entry.lastUser}`.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) score++;
    }
    return { entry, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.entry);
}

/** 对最近的会话文件做正文 grep，命中即返回片段。 */
export async function grepSessions(
  sessionsRoot: string,
  pattern: string,
  options: { maxFiles?: number; maxHits?: number } = {},
): Promise<{ hits: GrepHit[]; truncated: boolean }> {
  const maxFiles = options.maxFiles ?? 60;
  const maxHits = options.maxHits ?? 20;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch (error) {
    throw new Error(`正则无效：${error instanceof Error ? error.message : String(error)}`);
  }
  const files = listSessionFiles(sessionsRoot).slice(0, maxFiles);
  const hits: GrepHit[] = [];
  for (const file of files) {
    const excerpt = await parseSessionFile(file.path, file.sizeBytes);
    if (!excerpt) continue;
    const source = `${excerpt.firstUser}\n${excerpt.lastUser}`;
    if (!regex.test(source)) continue;
    const index = source.search(regex);
    const start = Math.max(0, index - 40);
    hits.push({
      path: excerpt.path,
      id: excerpt.id,
      name: excerpt.name,
      cwd: excerpt.cwd,
      snippet: source.slice(start, start + 160).replace(/\s+/g, " ").trim(),
    });
    if (hits.length >= maxHits) return { hits, truncated: true };
  }
  return { hits, truncated: false };
}
