import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../../hapilon-home.js";

/**
 * settings.ts — hpl-econ 参数读取（issue #52 组合甲默认）。
 *
 * 配置文件 <agentDir>/econ-config.json；ensure-extension-configs 负责播种，
 * 本模块只读（读不到字段用默认值，文件不存在同样走默认——与内核
 * "missing file is silent" 对扩展配置的惯例一致）。
 *
 * 运行时覆盖（/econ 菜单、--no-econ、HAPILON_ECON_OFF）不落此文件，
 * 由 index.ts 的 runtime state 管理；「Save as default」显式写回时才落盘。
 */

export interface EconSettings {
  enabled: boolean;
  threshold: number;
  headLines: number;
  tailLines: number;
}

/** 组合甲 · 稳妥默认（issue #52 实测裁决） */
export const ECON_DEFAULTS: EconSettings = {
  enabled: true,
  threshold: 8 * 1024,
  headLines: 40,
  tailLines: 20,
};

/** /econ 菜单提供的档位 */
export const THRESHOLD_CHOICES = [4 * 1024, 8 * 1024, 16 * 1024, 32 * 1024];
export const RETENTION_CHOICES: Array<{ head: number; tail: number }> = [
  { head: 20, tail: 10 },
  { head: 40, tail: 20 },
  { head: 80, tail: 40 },
];

export function econConfigPath(agentDirPath: string): string {
  return join(agentDirPath, "econ-config.json");
}

/** 读配置；文件缺失/损坏时逐字段回落默认（损坏时 warn 一次，不吞——Fail Fast 交给调用方决定） */
export function readEconSettings(agentDirPath: string): EconSettings {
  const path = econConfigPath(agentDirPath);
  if (!existsSync(path)) return { ...ECON_DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<EconSettings>;
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : ECON_DEFAULTS.enabled,
      threshold:
        typeof raw.threshold === "number" && raw.threshold > 0 ? raw.threshold : ECON_DEFAULTS.threshold,
      headLines:
        typeof raw.headLines === "number" && raw.headLines > 0 ? raw.headLines : ECON_DEFAULTS.headLines,
      tailLines:
        typeof raw.tailLines === "number" && raw.tailLines > 0 ? raw.tailLines : ECON_DEFAULTS.tailLines,
    };
  } catch (err) {
    console.warn(
      `[hpl-econ] econ-config.json 解析失败，使用默认参数：${err instanceof Error ? err.message : String(err)}`,
    );
    return { ...ECON_DEFAULTS };
  }
}

/** 写配置（/econ 菜单「Save as default」）；目录不存在时创建 */
export function writeEconSettings(agentDirPath: string, settings: EconSettings): void {
  if (!existsSync(agentDirPath)) {
    mkdirSync(agentDirPath, { recursive: true, mode: 0o700 });
  }
  writeFileSync(econConfigPath(agentDirPath), JSON.stringify(settings, null, 2) + "\n", "utf8");
}

/** env 通道：HAPILON_ECON_OFF=1 时旁路（脚本化场景） */
export function envDisabled(): boolean {
  return process.env.HAPILON_ECON_OFF === "1";
}
