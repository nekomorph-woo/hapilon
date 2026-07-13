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

export function hasFlag(args: string[], flag: string): boolean {
  return args.some(
    (a) => a === flag || a.startsWith(flag + "="),
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
