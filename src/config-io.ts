import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configFilePath } from "./hapilon-home.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface HapilonConfig {
  defaultProvider?: string;
  defaultModel?: string;
  safetyNoticeShown?: boolean;
}

// ─── Config file I/O ─────────────────────────────────────────────────

export function readHapilonConfig(): HapilonConfig {
  const path = configFilePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn("Warning: config.json 格式异常，将以空配置处理");
      return {};
    }
    // Validate property types
    const obj = parsed as Record<string, unknown>;
    const result: HapilonConfig = {};
    if (typeof obj.defaultProvider === "string") {
      result.defaultProvider = obj.defaultProvider;
    } else if (obj.defaultProvider !== undefined) {
      console.warn("Warning: config.json 中 defaultProvider 不是字符串，已忽略");
    }
    if (typeof obj.defaultModel === "string") {
      result.defaultModel = obj.defaultModel;
    } else if (obj.defaultModel !== undefined) {
      console.warn("Warning: config.json 中 defaultModel 不是字符串，已忽略");
    }
    if (typeof obj.safetyNoticeShown === "boolean") {
      result.safetyNoticeShown = obj.safetyNoticeShown;
    } else if (obj.safetyNoticeShown !== undefined) {
      console.warn("Warning: config.json 中 safetyNoticeShown 不是布尔值，已忽略");
    }
    return result;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(
      `Warning: config.json 读取或解析失败 (${detail})，将以空配置处理`,
    );
    return {};
  }
}

export function writeHapilonConfig(config: HapilonConfig): void {
  const path = configFilePath();
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  }
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// ─── CLI arg helpers ─────────────────────────────────────────────────

/** hapilon 自有 flag 注册表 —— pi 不认识、spawn 前必须剥离的参数 */
export const HAPILON_FLAGS = ["--no-safety", "--sandbox"] as const;

export function hasFlag(args: string[], flag: string): boolean {
  return args.some(
    (a) => a === flag || a.startsWith(flag + "="),
  );
}

/**
 * 剥离 hapilon 自有 flag（含 --flag=value 形式，与 hasFlag 语义对称）。
 *
 * hapilon 是 pi 的薄包装：未知命令/参数原样透传（issue #14），
 * 但自有 flag 是 hapilon 的启动器语义，pi 不认识——透传会让 pi 直接
 * 报 Unknown option 退出（#38）。新增自有 flag 时在此注册一处。
 */
export function stripHapilonFlags(args: string[]): string[] {
  return args.filter(
    (a) => !HAPILON_FLAGS.some(
      (f) => a === f || a.startsWith(f + "="),
    ),
  );
}

export function injectDefaultArgs(
  userArgs: string[],
  config: HapilonConfig,
): string[] {
  const result = [...userArgs];
  if (config.defaultProvider && !hasFlag(userArgs, "--provider")) {
    result.unshift("--provider", config.defaultProvider);
  }
  if (config.defaultModel && !hasFlag(userArgs, "--model")) {
    result.unshift("--model", config.defaultModel);
  }
  return result;
}
