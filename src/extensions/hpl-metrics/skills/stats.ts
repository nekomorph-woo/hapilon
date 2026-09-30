/**
 * skill-stats.ts — skill 使用事件的纯聚合：时段、热力矩阵、排行、趋势、闲置。
 *
 * 时间一律取本地时区（「热点时段」只对用户的钟面有意义）；输出全部是可序列化
 * 结构，JSON 导出与 HTML 模板共用同一份计算。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SkillOrigin, SkillUsageEvent } from "./usage.js";

export function localDateKey(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function hourlyHistogram(events: SkillUsageEvent[]): number[] {
  const hours = Array.from({ length: 24 }, () => 0);
  for (const event of events) hours[new Date(event.ts).getHours()]!++;
  return hours;
}

export interface HeatmapDay {
  day: string;
  /** 24 格，本地小时 */
  hours: number[];
}

/** 小时 × 天矩阵：按日期升序；只含有使用的天 */
export function heatmap(events: ReadonlyArray<{ ts: number }>): HeatmapDay[] {
  const byDay = new Map<string, number[]>();
  for (const event of events) {
    const date = new Date(event.ts);
    const key = localDateKey(event.ts);
    let hours = byDay.get(key);
    if (!hours) {
      hours = Array.from({ length: 24 }, () => 0);
      byDay.set(key, hours);
    }
    hours[date.getHours()]!++;
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, hours]) => ({ day, hours }));
}

export interface WeekBucket {
  /** 周一日期 */
  weekStart: string;
  count: number;
}

function mondayOf(ts: number): number {
  const date = new Date(ts);
  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - day);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 按自然周（周一为界）分桶，升序 */
export function weeklyBuckets(events: SkillUsageEvent[]): WeekBucket[] {
  const buckets = new Map<number, number>();
  for (const event of events) {
    const monday = mondayOf(event.ts);
    buckets.set(monday, (buckets.get(monday) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([monday, count]) => ({ weekStart: localDateKey(monday), count }));
}

export interface TailShape {
  count: number;
  avgLen: number;
  /** 看起来像路径或文件引用（以 / 或 ~ 开头）的比例，0-1 */
  pathishRatio: number;
  /** 出现次数最多的开头 12 字符（参数形态趋同的粗信号），无重复为空 */
  topPrefix: string;
  topPrefixCount: number;
}

export function tailShape(tails: string[]): TailShape {
  if (tails.length === 0) return { count: 0, avgLen: 0, pathishRatio: 0, topPrefix: "", topPrefixCount: 0 };
  const totalLen = tails.reduce((sum, tail) => sum + tail.length, 0);
  const pathish = tails.filter((tail) => /^[~/.]/.test(tail)).length;
  const prefixes = new Map<string, number>();
  for (const tail of tails) {
    const prefix = tail.slice(0, 12);
    prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
  }
  const [topPrefix, topPrefixCount] = [...prefixes.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  return {
    count: tails.length,
    avgLen: Math.round(totalLen / tails.length),
    pathishRatio: Math.round((pathish / tails.length) * 100) / 100,
    topPrefix: topPrefixCount > 1 ? topPrefix : "",
    topPrefixCount: topPrefixCount > 1 ? topPrefixCount : 0,
  };
}

export interface SkillStat {
  skill: string;
  origin: SkillOrigin;
  explicit: number;
  model: number;
  total: number;
  firstTs: number;
  lastTs: number;
  /** 相邻两次使用的间隔中位（天，一位小数）；不足 2 次为 null */
  revisitMedianDays: number | null;
  purpose: string;
  /** explicit 的用户原话（时间升序） */
  tails: string[];
  shape: TailShape;
}

export function perSkill(events: SkillUsageEvent[], purposes: Record<string, string> = {}): SkillStat[] {
  const bySkill = new Map<string, SkillUsageEvent[]>();
  for (const event of events) {
    const bucket = bySkill.get(event.skill);
    if (bucket) bucket.push(event);
    else bySkill.set(event.skill, [event]);
  }
  const stats: SkillStat[] = [];
  for (const [skill, bucket] of bySkill) {
    const sorted = [...bucket].sort((a, b) => a.ts - b.ts);
    const gaps = sorted.slice(1).map((event, index) => event.ts - sorted[index]!.ts);
    stats.push({
      skill,
      origin: bucket[0]!.origin,
      explicit: bucket.filter((event) => event.source === "explicit").length,
      model: bucket.filter((event) => event.source === "model").length,
      total: bucket.length,
      firstTs: sorted[0]!.ts,
      lastTs: sorted[sorted.length - 1]!.ts,
      revisitMedianDays: gaps.length === 0 ? null : Math.round((median(gaps) / 86_400_000) * 10) / 10,
      purpose: purposes[skill] ?? "",
      tails: sorted.filter((event) => event.source === "explicit" && event.args).map((event) => event.args),
      shape: tailShape(sorted.filter((event) => event.source === "explicit" && event.args).map((event) => event.args)),
    });
  }
  return stats.sort((a, b) => b.total - a.total || a.skill.localeCompare(b.skill));
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function originBreakdown(events: SkillUsageEvent[]): Record<SkillOrigin, number> {
  const breakdown: Record<SkillOrigin, number> = { builtin: 0, user: 0, project: 0 };
  for (const event of events) breakdown[event.origin]!++;
  return breakdown;
}

export interface AvailableSkill {
  name: string;
  /** SKILL.md frontmatter 的 description（读不到为空串） */
  description: string;
}

/**
 * 可用 skill 全集：内置包 resources/skills + 各 home 的 agent/skills + cwd 的 .pi/skills。
 * CLI 路径缺失（裸 pi 加载）时内置部分为空，不猜。
 */
export function listAvailableSkills(homeDir: string): AvailableSkill[] {
  const byName = new Map<string, AvailableSkill>();
  const addFrom = (dir: string): void => {
    if (!existsSync(dir)) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const name = entry.name.toLowerCase();
        if (byName.has(name)) continue;
        let description = "";
        try {
          const meta = readFileSync(join(dir, entry.name, "SKILL.md"), "utf8");
          description = (/^description: (.+)$/m.exec(meta)?.[1] ?? "").trim().slice(0, 140);
        } catch {
          // 无 SKILL.md 或读失败：名字仍入册，描述留空
        }
        byName.set(name, { name, description });
      }
    } catch {
      // 目录不可读跳过：差集宁可少列不误报
    }
  };
  const cliPath = process.env.HAPILON_CLI_PATH;
  if (cliPath) addFrom(join(dirname(cliPath), "..", "resources", "skills"));
  addFrom(join(homeDir, "agent", "skills"));
  addFrom(join(process.cwd(), ".pi", "skills"));
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 窗口内零使用的 skill（对可用全集做差集） */
export function idleSkills(available: readonly AvailableSkill[], used: ReadonlySet<string>): AvailableSkill[] {
  return available.filter((skill) => !used.has(skill.name)).sort((a, b) => a.name.localeCompare(b.name));
}
