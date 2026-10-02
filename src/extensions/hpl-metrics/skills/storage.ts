/**
 * storage.ts — skill-metrics 的落盘存储：排除名单、purpose、digest 缓存。
 *
 * 统一目录 <hapilonHome>/agent/skill-metrics/。usage 本身不落盘（每次从会话
 * 文件重放，与 ponytail 同构）；只有计算昂贵或用户编辑的数据才存这里。
 */

import { notify } from "../../notify.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../../../config/hapilon-home.js";

/** 模型自动触发、无用户意图的 skill：统计里剔除，单独出报告。recap 已移出——它不经
 * skill 机制（扩展内部直接调模型写 widget），会话里本就没有可采的使用事件，
 * 名单移除后若它将来改走 skill 形态则自然纳入统计。 */
export const BUILTIN_EXCLUDED_SKILLS = [] as const;

export function skillMetricsDir(): string {
  return join(agentDir(), "skill-metrics");
}

export function excludedSkillsPath(): string {
  return join(skillMetricsDir(), "excluded-skills.json");
}

export function goalsPath(): string {
  return join(skillMetricsDir(), "goals.json");
}

export function digestsPath(): string {
  return join(skillMetricsDir(), "skill-digests.jsonl");
}

/** 内置排除 + 用户名单合并；文件损坏时告警并只用于内置名单 */
export function readExcludedSkills(): Set<string> {
  const excluded = new Set<string>(BUILTIN_EXCLUDED_SKILLS);
  const path = excludedSkillsPath();
  if (!existsSync(path)) return excluded;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) if (typeof item === "string" && item) excluded.add(item.toLowerCase());
    }
  } catch (error) {
    notify(`[hpl-metrics] 排除名单读取失败，仅用内置名单：${String(error)}`);
  }
  return excluded;
}

/** 用户自定义分析目标（读者来信）；损坏时告警并按空表处理 */
export function readGoals(): string[] {
  const path = goalsPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch (error) {
    notify(`[hpl-metrics] 分析目标读取失败，按空表处理：${String(error)}`);
    return [];
  }
}

/** 追加目标；重复（去空白比对）不重复入库，返回是否新增 */
export function appendGoal(text: string): boolean {
  const trimmed = text.trim();
  const goals = readGoals();
  if (goals.some((goal) => goal === trimmed)) return false;
  mkdirSync(skillMetricsDir(), { recursive: true });
  writeFileSync(goalsPath(), JSON.stringify([...goals, trimmed], null, 2) + "\n", "utf8");
  return true;
}
