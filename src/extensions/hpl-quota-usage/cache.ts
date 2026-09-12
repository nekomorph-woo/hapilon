/**
 * cache.ts — 限额快照的文件通道（quota-cache）
 *
 * pi loader 每扩展独立 jiti 实例，跨扩展模块状态不共享（R2 教训），
 * 轮询结果写 JSON 文件，hpl-footer 等其它扩展各自读取。
 * 文件位置可由 HAPILON_QUOTA_CACHE 覆盖（测试注入）。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuotaSnapshot } from "./snapshot.js";

const MAX_AGE_MS = 15 * 60 * 1000;

export function quotaCachePath(): string {
  return process.env["HAPILON_QUOTA_CACHE"] ?? join(tmpdir(), "hapilon-quota-cache.json");
}

export function readQuotaSnapshot(now = Date.now()): QuotaSnapshot | undefined {
  const path = quotaCachePath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as QuotaSnapshot;
    if (typeof parsed.provider !== "string" || !Array.isArray(parsed.windows)) return undefined;
    if (now - parsed.timestamp > MAX_AGE_MS) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeQuotaSnapshot(snapshot: QuotaSnapshot): void {
  try {
    writeFileSync(quotaCachePath(), JSON.stringify(snapshot), "utf8");
  } catch {
    // 缓存写失败不影响主流程
  }
}
