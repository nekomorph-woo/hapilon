/**
 * config.ts — 禁读名单的持久化
 *
 * 全局独立文件 <HAPILON_HOME>/blocked-files.json，格式：
 *   { "blockedFiles": ["/abs/path/a.md", ...] }
 *
 * 只存用户追加条目；默认名单（CLAUDE.md/AGENTS.md）是代码常量，不落盘。
 * 模式照搬 hpl-model-tiers/config.ts：读失败降级空名单 + notify。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
import { notify } from "../notify.js";

export interface BlockedFilesConfig {
  blockedFiles: string[];
}

const configPath = (): string => join(hapilonHome(), "blocked-files.json");

export const readBlockedFilesEffect = (): Effect.Effect<string[], never> =>
  Effect.sync(() => {
    const path = configPath();
    if (!existsSync(path)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) &&
        Array.isArray((parsed as BlockedFilesConfig).blockedFiles)
      ) {
        return (parsed as BlockedFilesConfig).blockedFiles.filter(
          (p): p is string => typeof p === "string",
        );
      }
      notify(`[hpl-blocked-files] ${path} 格式异常（需 {"blockedFiles": [...]}），按空名单继续`, "warning");
      return [];
    } catch (err) {
      notify(
        `[hpl-blocked-files] 名单文件读取失败，按空名单继续：${err instanceof Error ? err.message : String(err)}`,
        "warning",
      );
      return [];
    }
  });

export const saveBlockedFilesEffect = (paths: string[]): Effect.Effect<boolean, never> =>
  Effect.try({
    try: () => {
      const path = configPath();
      mkdirSync(hapilonHome(), { recursive: true, mode: 0o700 });
      writeFileSync(
        path,
        JSON.stringify({ blockedFiles: paths } satisfies BlockedFilesConfig, null, 2) + "\n",
        "utf8",
      );
      return true;
    },
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        notify(`[hpl-blocked-files] 保存名单失败：${String(error)}`, "warning");
        return false;
      })
    ),
  );

export function readBlockedFiles(): string[] {
  return Effect.runSync(readBlockedFilesEffect());
}

export function saveBlockedFiles(paths: string[]): boolean {
  return Effect.runSync(saveBlockedFilesEffect(paths));
}
