import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 安全门 settings 通道（#37）：
 *
 * hpl-safety-gate / hpl-protected-paths 写入 ~/.hapilon/settings.json 的
 * `extensions` 数组——settings 是 pi 的持久扩展配置，父会话与 pi-subagents
 * 创建的 subagent 会话（自建 SettingsManager）都会发现并加载它们，
 * 因此安全规则在所有会话中无处不在。
 *
 * 其余 hpl-* 扩展与 npm 扩展走 cli.ts 的 `-e` 通道，仅父会话生效。
 *
 * `--no-safety` 时把这两个条目从 settings 移除——这是用户显式关闭安全检查，
 * 必须真实生效于所有会话，而不是只影响当次启动。
 */

/** settings.json extensions 中标记安全门的键名（目录扩展入口） */
const SAFETY_EXTENSION_SUFFIXES = [
  "extensions/hpl-safety-gate/index.js",
  "extensions/hpl-protected-paths/index.js",
] as const;

/** SettingsJson 的局部结构（与 providers.ts 一致的防御性解析） */
type PartialSettings = Record<string, unknown> & { extensions?: unknown };

function distDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * 单一判定来源：给定扩展入口路径是否为安全门扩展。
 * cli.ts 的 -e 通道过滤与 settings 条目识别都从这里走，避免两份清单分叉。
 */
export function isSafetyExtensionPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return SAFETY_EXTENSION_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** 当前构建中安全门扩展的绝对入口路径 */
export function safetyExtensionPaths(): string[] {
  const base = join(distDir(), "extensions");
  return SAFETY_EXTENSION_SUFFIXES.map((suffix) => join(base, basename(dirname(suffix)), "index.js"));
}

/**
 * 从 settings.extensions 中分离安全门条目与其它条目。
 *
 * 仅按 isSafetyExtensionPath 匹配，用户手工加入的无关条目原样保留。
 */
export function partitionSafetyEntries(extensions: unknown): {
  safety: string[];
  others: string[];
} {
  const entries = Array.isArray(extensions) ? extensions.filter((e): e is string => typeof e === "string") : [];
  const safety: string[] = [];
  const others: string[] = [];
  for (const entry of entries) {
    if (isSafetyExtensionPath(entry)) {
      safety.push(entry);
    } else {
      others.push(entry);
    }
  }
  return { safety, others };
}

/**
 * 把安全门扩展条目同步进 <agentDir>/settings.json（幂等合并写）。
 *
 * - 安全门 dist 产物缺失 → 抛错（构建损坏应立刻爆出来）
 * - settings.json 解析失败 → console.warn + 不动原文件（不吞掉用户数据）
 * - 已包含正确条目 → 不写文件
 */
export function ensureSafetyExtensions(agentDir: string): void {
  const paths = safetyExtensionPaths();
  for (const p of paths) {
    if (!existsSync(p)) {
      throw new Error(
        `[hapilon] 安全门扩展缺失：${p} 不存在。请重新 npm run build——` +
          `安全门必须随 hapilon 一起安装，否则子代理将不受保护。`,
      );
    }
  }
  applySettingsExtensions(agentDir, (settings, others) => {
    settings.extensions = [...others, ...paths];
  });
}

/**
 * 从 <agentDir>/settings.json 移除安全门扩展条目（幂等合并写）。
 *
 * `--no-safety` 专用：用户显式要求所有会话都不加载安全门。
 * settings.json 解析失败时 warn + 不动原文件——此时宁可保守（继续带门运行），
 * 也不能把解析失败的文件覆写掉。
 */
export function removeSafetyExtensions(agentDir: string): void {
  applySettingsExtensions(agentDir, (settings, others) => {
    settings.extensions = others;
  });
}

function applySettingsExtensions(
  agentDir: string,
  apply: (settings: PartialSettings, others: string[]) => void,
): void {
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  }
  const path = join(agentDir, "settings.json");

  let settings: PartialSettings = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        console.warn(`Warning: ${path} 不是 JSON object，跳过安全门 settings 写入`);
        return;
      }
      settings = parsed as PartialSettings;
    } catch {
      console.warn(`Warning: ${path} 解析失败，跳过安全门 settings 写入`);
      return;
    }
  }

  const { others } = partitionSafetyEntries(settings.extensions);
  const before = JSON.stringify(settings.extensions);
  apply(settings, others);
  if (JSON.stringify(settings.extensions) === before) {
    return; // 幂等：无变化不写
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
}
