/**
 * indexer.ts — 会话摘要索引：后台预建（查询快路径的数据源）
 *
 * 单写者：锁文件（独占创建 + 心跳内容为时间戳）决定哪个 hapi 实例干活，
 * 崩溃后心跳过期自动被其他实例接管。写入：整份 JSON 写临时文件后原子改名。
 * 防抖：会话文件 mtime 安静 10 分钟才算结束，才值得花一次模型调用。
 */

import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { selectRecapModel, type RecapModelShape } from "../hpl-recap/model.js";
import { parseRankedJson, type ModelDeps } from "./rank.js";
import { parseSessionFile, type SessionExcerpt } from "./index-core.js";

const QUIET_MS = 10 * 60 * 1000;
const BATCH_SIZE = 20;
const LOCK_STALE_MS = 10 * 60 * 1000;
const INDEX_VERSION = 1;

export interface IndexRecord {
  excerpt: SessionExcerpt;
  /** 建索引时文件 mtime（ms）；与当前不一致即需重算 */
  mtimeMs: number;
  summary: string;
}

interface IndexFile {
  version: number;
  records: Record<string, IndexRecord>;
}

export function indexPath(sessionsRoot: string): string {
  return join(sessionsRoot, "index.json");
}

function lockPath(sessionsRoot: string): string {
  return join(sessionsRoot, "indexer.lock");
}

/** 读索引；缺文件或损坏都返回空表（查询侧降级重扫，不抛错）。 */
export function loadIndex(sessionsRoot: string): Map<string, IndexRecord> {
  const out = new Map<string, IndexRecord>();
  const file = indexPath(sessionsRoot);
  if (!existsSync(file)) return out;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as IndexFile;
    if (parsed?.version === INDEX_VERSION && parsed.records && typeof parsed.records === "object") {
      for (const [path, record] of Object.entries(parsed.records)) {
        if (record && record.excerpt && typeof record.summary === "string") out.set(path, record);
      }
    }
  } catch {
    // 损坏的索引当不存在：后台索引器下一轮会用正确数据覆盖
  }
  return out;
}

export function writeIndexAtomic(sessionsRoot: string, records: Map<string, IndexRecord>): void {
  const file = indexPath(sessionsRoot);
  const tmp = join(dirname(file), `.${basename(file)}.tmp`);
  const payload: IndexFile = { version: INDEX_VERSION, records: Object.fromEntries(records) };
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, file);
}

/**
 * 从「当前文件清单 + 已有索引」挑出需要建索引的文件：
 * 已安静 QUIET_MS 且（无缓存或 mtime 变过），按最近优先。
 */
export function pendingForIndex(
  files: Array<{ path: string; mtimeMs: number; sizeBytes: number }>,
  index: Map<string, IndexRecord>,
  now: number,
): Array<{ path: string; mtimeMs: number; sizeBytes: number }> {
  return files
    .filter((f) => {
      if (now - f.mtimeMs < QUIET_MS) return false;
      const cached = index.get(f.path);
      return !cached || cached.mtimeMs !== f.mtimeMs;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

const INDEX_SUMMARY_PROMPT = [
  "你是会话归档助手。给你一批历史会话（含首末用户消息、时间、目录）。",
  "任务：为每个会话写一段不超过 80 字的中文总结，概括这个会话做了什么、得出了什么结论或交付了什么。",
  "总结要能让读者日后凭一句话描述认出这个会话；写实质内容，不写「用户讨论了一些问题」这类空话。",
  '只返回严格 JSON 数组，不要任何其它文字：[{"i":<编号>,"s":"<不超过80字总结>"}]，每个编号一项，不得省略。',
].join("\n");

export interface SummarizeOutcome {
  /** 成功建立索引的记录（path → record，mtimeMs 由调用方按文件 stat 补上） */
  records: Map<string, IndexRecord>;
  /** 模型调用失败或输出无效应跳过的 path（本轮不写，下轮重试） */
  skipped: string[];
}

function responseTextOf(response: unknown): string {
  if (response && typeof response === "object") {
    const content = (response as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((b) => (typeof b === "object" && b !== null ? String((b as { text?: unknown }).text ?? "") : ""))
        .join("");
    }
  }
  return "";
}

/** 批量给会话建通用总结；单批失败只跳过该批，不写垃圾数据。 */
export async function summarizeEntries(
  excerpts: SessionExcerpt[],
  deps: ModelDeps,
): Promise<SummarizeOutcome> {
  const out = new Map<string, IndexRecord>();
  const skipped: string[] = [];
  if (excerpts.length === 0) return { records: out, skipped };
  const choice = selectRecapModel(deps.available, deps.currentModel, deps.resolvedTiers);
  if (!choice.model) return { records: out, skipped: excerpts.map((e) => e.path) };
  const model: RecapModelShape = choice.model;
  for (let start = 0; start < excerpts.length; start += BATCH_SIZE) {
    const batch = excerpts.slice(start, start + BATCH_SIZE);
    const lines = batch.map((e, i) => {
      const cwd = e.cwd.replace(/^\/Users\/[^/]+/, "~");
      return `[${i}] ${e.modified.slice(0, 16)} ${cwd} 「${e.name || "(未命名)"}」 消息${e.messageCount}条 首:${e.firstUser.slice(0, 120)} 末:${e.lastUser.slice(0, 120)}`;
    });
    let items: Array<{ index: number; summary: string }> = [];
    try {
      const response = await deps.complete(
        model,
        [{ role: "user", content: `会话列表：\n${lines.join("\n")}` }],
        INDEX_SUMMARY_PROMPT,
      );
      items = parseRankedJson(responseTextOf(response));
    } catch {
      items = [];
    }
    if (items.length === 0) {
      skipped.push(...batch.map((e) => e.path));
      continue;
    }
    for (const item of items) {
      const entry = batch[item.index];
      if (!entry) continue;
      out.set(entry.path, { excerpt: entry, mtimeMs: 0, summary: item.summary });
    }
  }
  return { records: out, skipped };
}

/** 抢领导者锁：独占创建成功即当选；已存在则看心跳时间戳是否过期。 */
export function acquireLeader(sessionsRoot: string, now: number): boolean {
  const lock = lockPath(sessionsRoot);
  if (existsSync(lock)) {
    let stale = false;
    try {
      const heartbeat = Number(readFileSync(lock, "utf8").trim());
      stale = !Number.isFinite(heartbeat) || now - heartbeat > LOCK_STALE_MS;
    } catch {
      stale = true;
    }
    if (!stale) return false;
    unlinkSync(lock);
  }
  try {
    const fd = openSync(lock, "wx");
    closeSync(fd);
    writeFileSync(lock, String(now));
    return true;
  } catch {
    return false;
  }
}

export function releaseLeader(sessionsRoot: string): void {
  try {
    unlinkSync(lockPath(sessionsRoot));
  } catch {
    // 已不存在即已释放
  }
}

/** 补充 mtime 并合并进索引（写前重读，减小与后台索引器的整文件覆盖竞态）。 */
export function mergeIntoIndex(
  sessionsRoot: string,
  fresh: Map<string, IndexRecord>,
  fileMtimes: Map<string, number>,
): void {
  if (fresh.size === 0) return;
  const index = loadIndex(sessionsRoot);
  for (const [path, record] of fresh) {
    record.mtimeMs = fileMtimes.get(path) ?? record.mtimeMs;
    index.set(path, record);
  }
  writeIndexAtomic(sessionsRoot, index);
}

/**
 * 跑一轮索引：挑安静且过期的文件 → 解析 + 批量总结 → 合并原子写回。
 * 返回本轮新建条数与剩余待索引数（跳过的仍算待索引，下轮重试）。
 */
export async function runIndexerPass(
  sessionsRoot: string,
  files: Array<{ path: string; mtimeMs: number; sizeBytes: number }>,
  deps: ModelDeps,
): Promise<{ added: number; remaining: number }> {
  const now = Date.now();
  const pending = pendingForIndex(files, loadIndex(sessionsRoot), now);
  if (pending.length === 0) return { added: 0, remaining: 0 };
  const parsed = (await Promise.all(pending.map((f) => parseSessionFile(f.path, f.sizeBytes)))).filter(
    (e): e is SessionExcerpt => e !== null,
  );
  const { records } = await summarizeEntries(parsed, deps);
  const mtimes = new Map(files.map((f) => [f.path, f.mtimeMs]));
  mergeIntoIndex(sessionsRoot, records, mtimes);
  return { added: records.size, remaining: pending.length - records.size };
}
