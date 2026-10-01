/**
 * hpl-metrics — hapi 内置统计工具（`/hapi-metrics`）
 *
 * 子命令制，且**不带子命令时只打印用法、不执行任何分析**：统计要扫全部会话文件，
 * 一次跑全部维度既慢又没法按需扩展。每个子命令各自负责自己的数据源与渲染。
 *
 * 目前子命令：
 *   ponytail   会话级的「体量与形状」对照（token/成本/文本-代码比/编辑规模）
 *
 * 后续可加（各自独立数据源，互不影响）：
 *   quality    reviewer P0/P1、verify 通过率、返工次数
 *   tools      工具使用分布、失败率
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { showFloatingPane } from "../../shared/floating-pane/index.js";
import { argumentCompletions } from "../../shared/argument-completion.js";
import { hapilonHome } from "../../config/hapilon-home.js";
import { loadSamples } from "./ponytail/samples.js";
import { hapilonHomes } from "./sessions.js";
import { groupSamples, renderPonytailLines, type GroupBy } from "./ponytail/report.js";
import { loadSkillUsage } from "./skills/usage.js";
import { localDateKey, listAvailableSkills, originBreakdown, perSkill, idleSkills, weeklyBuckets, heatmap, hourlyHistogram, type AvailableSkill } from "./skills/stats.js";
import { appendGoal, readGoals, skillMetricsDir } from "./skills/storage.js";
import {
  digestKey,
  generateMissingDigestsAsync,
  generateFrontPage,
  fallbackFrontPage,
  generateFixedAnalyses,
  generateGoalAnalyses,
  generateSuggestions,
  generateWareNotes,
  type DataSummary,
  type FixedAnalysis,
} from "./skills/digest.js";
import { renderSkillsReport, type SkillsReportData } from "./skills/report.js";

const GROUP_BYS: readonly GroupBy[] = ["ponytail", "model", "day", "project"];
/** skills 统计默认滚动窗口：7 天（不按自然周/月） */
const SKILLS_WINDOW_MS = 7 * 86_400_000;

export type MetricsInvocation =
  | { kind: "usage"; reason?: string }
  | { kind: "ponytail"; groupBy: GroupBy; sinceMs?: number; project?: string; json: boolean }
  | { kind: "skills"; sinceMs?: number; eli60: boolean; json: boolean }
  | { kind: "purpose"; text: string };

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

/** 纯解析：用法/未知子命令都不触发扫描（测试的主要入口） */
export function parseMetricsArgs(args: string): MetricsInvocation {
  const argv = args.trim().split(/\s+/).filter(Boolean);
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") return { kind: "usage" };

  if (sub === "purpose") {
    const text = rest.join(" ").trim();
    if (!text) return { kind: "usage", reason: "purpose 需要分析目标文字" };
    return { kind: "purpose", text };
  }

  if (sub === "skills") {
    const sinceParsed = parseSince(rest);
    if (typeof sinceParsed === "string") return { kind: "usage", reason: sinceParsed };
    return { kind: "skills", sinceMs: sinceParsed, eli60: rest.includes("--eli60"), json: rest.includes("--json") };
  }

  if (sub !== "ponytail") return { kind: "usage", reason: `未知子命令：${sub}` };

  const groupByRaw = flagValue(rest, "--group-by") ?? "ponytail";
  if (!GROUP_BYS.includes(groupByRaw as GroupBy)) {
    return { kind: "usage", reason: `--group-by 只支持 ${GROUP_BYS.join(" | ")}` };
  }
  const sinceMs = parseSince(rest);
  if (typeof sinceMs === "string") return { kind: "usage", reason: sinceMs };
  return {
    kind: "ponytail",
    groupBy: groupByRaw as GroupBy,
    sinceMs,
    project: flagValue(rest, "--project"),
    json: rest.includes("--json"),
  };
}

/** --since 解析：YYYY-MM-DD 按当天 0 点（UTC）计；无 flag 返回 undefined；非法返回错误文案 */
function parseSince(args: string[]): number | string | undefined {
  const sinceRaw = flagValue(args, "--since");
  if (sinceRaw === undefined) return undefined;
  const parsed = Date.parse(sinceRaw.length === 10 ? `${sinceRaw}T00:00:00Z` : sinceRaw);
  if (!Number.isFinite(parsed)) return `--since 无法解析：${sinceRaw}`;
  return parsed;
}

export function usageText(reason?: string): string {
  return [
    ...(reason ? [`✗ ${reason}`, ""] : []),
    "用法：/hapi-metrics <子命令> [选项]",
    "",
    "子命令：",
    "  ponytail               会话级「体量与形状」对照（按档位/模型/天/项目分组）",
    "  skills                 skill 使用统计（面板；--json 导出；--eli60 出 HTML 报告）",
    "  purpose <skill> <文字>  登记/更新某 skill 的用途描述（进统计报告）",
    "",
    "ponytail 选项：",
    "  --group-by <档>        ponytail | model | day | project（默认 ponytail）",
    "  --since <YYYY-MM-DD>   只看该日期之后开始的会话",
    "  --project <子串>       按 cwd 过滤",
    "  --json                 输出 JSON（给后续工具/脚本用）",
    "",
    "skills 选项：",
    "  --since <YYYY-MM-DD>   统计窗口起点（默认现在 - 7 天）",
    "  --eli60                生成 HTML 详报（热力图/排行/干了什么）并打开",
    "  --json                 输出聚合 JSON",
    "",
    "不带子命令只打印本用法，不执行任何统计（子命令各自独立，便于扩展与控耗时）。",
  ].join("\n");
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  ctx.ui?.notify?.(message, type);
}

/** 报告写入 agent/skill-metrics/ 并用系统默认程序打开；打开失败不影响产物 */
function writeAndOpenReport(name: string, startLabel: string, endLabel: string, html: string): string {
  mkdirSync(skillMetricsDir(), { recursive: true });
  const path = join(skillMetricsDir(), `${name}-${startLabel}-${endLabel}.html`);
  writeFileSync(path, html, "utf8");
  try {
    let command: string;
    let args: string[];
    if (process.platform === "darwin") {
      command = "open";
      args = [path];
    } else if (process.platform === "win32") {
      command = "cmd";
      args = ["/c", "start", "", path];
    } else {
      command = "xdg-open";
      args = [path];
    }
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } catch (error) {
    console.warn(`[hpl-metrics] 报告打开失败（文件已生成）：${String(error)}`);
  }
  return path;
}

async function runSkillsCommand(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  invocation: Extract<MetricsInvocation, { kind: "skills" }>,
): Promise<void> {
  const setStatus = (text: string): void => ctx.ui?.setStatus?.("hapi-metrics", text);
  const clearStatus = (): void => ctx.ui?.setStatus?.("hapi-metrics", undefined);
  const digestItemsOf = (list: ReturnType<typeof perSkill>): number =>
    list.reduce((sum, stat) => sum + stat.tails.length, 0);
  const startMs = invocation.sinceMs ?? Date.now() - SKILLS_WINDOW_MS;
  const endMs = Date.now();
  const startLabel = localDateKey(startMs);
  const endLabel = localDateKey(endMs);
  const windowDays = Math.max(1, Math.round((endMs - startMs) / 86_400_000));
  const inWindow = (event: { ts: number }): boolean => event.ts >= startMs && event.ts <= endMs;

  setStatus(`扫描会话文件，重放 ${Math.round(windowDays)} 天窗口…`);
  const usage = loadSkillUsage();
  const events = usage.events.filter(inWindow);
  const excludedEvents = usage.excludedEvents.filter(inWindow);
  const stats = perSkill(events);
  const top = stats[0];
  const hours = hourlyHistogram(events);
  const peakHour = hours.indexOf(Math.max(...hours));
  const commandCount = events.filter((event) => event.source === "command").length;
  const explicitCount = events.filter((event) => event.source === "explicit").length;
  const modelCount = events.filter((event) => event.source === "model").length;
  const origins = originBreakdown(events);

  // 最忙一天与其主打器物
  const byDay = new Map<string, number>();
  for (const event of events) {
    const key = localDateKey(event.ts);
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  // 按日聚合主打器物
  const byDaySkill = new Map<string, Map<string, number>>();
  for (const event of events) {
    const key = localDateKey(event.ts);
    const skills = byDaySkill.get(key) ?? new Map<string, number>();
    skills.set(event.skill, (skills.get(event.skill) ?? 0) + 1);
    byDaySkill.set(key, skills);
  }
  const busyDayEntry = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
  const busyDay = busyDayEntry
    ? {
        day: busyDayEntry[0],
        count: busyDayEntry[1],
        skill: [...(byDaySkill.get(busyDayEntry[0]) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—",
      }
    : undefined;
  const busyDayTop = busyDay ?? undefined;

  // 榜首器物的固定搭档（同会话共现）
  const partners: Record<string, { partner: string; count: number; sessions: number }> = {};
  if (top) {
    const sessions = new Set(events.filter((event) => event.skill === top.skill).map((event) => event.session));
    const co = new Map<string, number>();
    for (const event of events) {
      if (event.skill === top.skill || !sessions.has(event.session)) continue;
      co.set(event.skill, (co.get(event.skill) ?? 0) + 1);
    }
    const best = [...co.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) partners[top.skill] = { partner: best[0], count: best[1], sessions: sessions.size };
  }
  const partnerText = top && partners[top.skill]
    ? `${top.skill} 与 ${partners[top.skill]!.partner} 在 ${partners[top.skill]!.sessions} 个会话里同框 ${partners[top.skill]!.count} 次`
    : "未发现固定搭档";

  const available = listAvailableSkills(hapilonHome());
  const usedNames = new Set(stats.map((stat) => stat.skill));
  const idleList = idleSkills(available, usedNames);
  const lowFreq = stats.slice(-3).filter((stat) => stat.total <= 3 && stat.total > 0);

  const summary: DataSummary = {
    window: `${startLabel} ~ ${endLabel}（${windowDays} 天）`,
    totals: `skill 唤起 ${events.length} 次（显式 ${explicitCount}、自动 ${modelCount}）、命令 ${commandCount} 条，日均 ${((events.length + commandCount) / windowDays).toFixed(1)} 次`,
    topSkills: stats.slice(0, 5).map((stat) => `${stat.skill} ${stat.total} 次（显式 ${stat.explicit}/自动 ${stat.model}）`).join("、"),
    hourProfile: `峰值在 ${peakHour} 时（${hours[peakHour] ?? 0} 次），深夜（18–24）占 ${Math.round((hours.slice(18, 24).reduce((a, b) => a + b, 0) / Math.max(1, events.length)) * 100)}%`,
    sourceProfile: `内置 ${origins.builtin}、外置 ${origins.user}、项目 ${origins.project}`,
    partners: partnerText,
  };

  if (invocation.json) {
    clearStatus();
    notify(
      ctx,
      JSON.stringify(
        {
          window: { start: startLabel, end: endLabel, days: windowDays },
          totals: { events: events.length, explicit: explicitCount, model: modelCount, command: commandCount },
          origins,
          hours,
          weeks: weeklyBuckets(events),
          skills: stats,
          commandCatalog: pi.getCommands().map((command) => ({
            name: command.name,
            description: command.description ?? "",
            source: command.source,
            count: commandUsageCount(events, command.name),
          })),
          idle: idleList.map((skill) => skill.name),
          sessionPreviews: usage.sessionPreviews,
        },
        null,
        1,
      ),
    );
    return;
  }

  if (!invocation.eli60) {
    clearStatus();
    const header = ["skill/命令", "次数", "显式", "自动", "来源", "最近"];
    const rows = stats.map((stat) => [
      stat.skill,
      String(stat.total),
      String(stat.explicit),
      String(stat.model),
      stat.origin,
      localDateKey(stat.lastTs),
    ]);
    const widths = header.map((_, index) => Math.max(header[index]!.length, ...rows.map((row) => row[index]!.length)));
    const lines = [
      `skill 使用统计 · ${startLabel} ~ ${endLabel} · skill ${events.length} 次 · 命令 ${commandCount} 条`,
      "",
      ...rows.map((row) => row.map((cell, index) => cell.padEnd(widths[index]! + 2)).join("")),
      "",
      stats.length === 0 ? "窗口内没有使用记录。" : "--eli60 出 HTML 详报 · --json 导出聚合数据",
    ];
    await showFloatingPane(ctx, {
      title: `器物晚报 · ${startLabel}~${endLabel}`,
      lines,
      footer: "Esc 关闭 · 显式/自动分列 · --eli60 出详报",
      width: "fit-content",
      maxHeight: 90,
    });
    return;
  }

  // —— --eli60：摘要 → 头条 → 目标分析 → 推荐 → 器物荐语 → 渲染 ——
  const goals = readGoals();
  setStatus(`撰写原话摘要（${digestItemsOf(stats)} 条）…`);
  const digestItems = stats.flatMap((stat) => stat.tails.map((tail) => ({ skill: stat.skill, tail, purpose: "" })));
  const { entries: digests, error } = await generateMissingDigestsAsync(digestItems, ctx);
  setStatus("撰写头条文章…");
  const frontPageModel = await generateFrontPage(summary, ctx);
  const frontPage = frontPageModel ?? fallbackFrontPage(
    summary,
    top?.skill ?? "—",
    top?.total ?? 0,
  );

  setStatus(goals.length > 0 ? `生成 ${Math.min(5, goals.length)} 个目标的分析…` : "生成目标推荐…");
  setStatus("完成固定分析四问…");
  const tailSample = stats
    .flatMap((stat) => stat.tails.slice(0, 3).map((tail) => `${stat.skill}：${tail}`))
    .slice(0, 15)
    .join("\n");
  const fixedAnalyses = await generateFixedAnalyses(summary, tailSample, ctx);
  const goalAnalyses = await generateGoalAnalyses(goals.slice(0, 5), summary, ctx);
  const goalData = goals.slice(0, 5).map((goal) => {
    const analysis = goalAnalyses.find((item) => item.goal === goal);
    return {
      title: goal,
      text: analysis ? analysis.analysis : "（本期分析生成失败，数据见简讯栏与各图。）",
      src: "数据源：窗口统计 + 原话摘要 · 每次出报告重新生成",
      signedAt: endLabel,
    };
  });
  setStatus("归纳目标建议与器物荐语…");
  const suggests = await generateSuggestions(goals, summary, ctx);

  const wareItems: Array<{ name: string; tag: string; origin: string; description: string }> = [
    ...idleList.map((skill) => ({ name: skill.name, tag: "零使用", origin: "内置", description: skill.description })),
    ...lowFreq.map((stat) => ({
      name: stat.skill,
      tag: `低频 · ${stat.total} 次`,
      origin: stat.origin,
      description: available.find((skill) => skill.name === stat.skill)?.description ?? "",
    })),
  ].slice(0, 10);
  const wareNotes = await generateWareNotes(wareItems, summary, ctx);
  clearStatus();
  const wares = wareItems.map((ware) => ({
    name: ware.name,
    tag: ware.tag,
    origin: ORIGIN_LABEL[ware.origin] ?? ware.origin,
    intro: ware.description || "（暂无描述）",
    recommend: wareNotes[ware.name.toLowerCase()] ?? "结合你最近的活儿看看它是否对得上。",
    how: `唤起：/skill:${ware.name} <主题>`,
  }));

  const reportRecords = [...events]
    .sort((a, b) => b.ts - a.ts)
    .map((event) => {
      const digestEntry = event.source === "explicit" && event.args
        ? digests.get(digestKey(event.skill, event.args))
        : undefined;
      return {
        ts: event.ts,
        skill: event.skill,
        source: event.source,
        args: event.args.slice(0, 160),
        ...(digestEntry?.digest ? { digest: digestEntry.digest } : {}),
        sessionPreview: event.sessionPreview || undefined,
      };
    });

  const cheng = "零一二三四五六七八九";
  const modelShare = Math.min(9, Math.round((modelCount / Math.max(1, events.length)) * 10));
  const nightShare = Math.round((hours.slice(18, 24).reduce((a, b) => a + b, 0) / Math.max(1, events.length)) * 100);
  const top3 = stats.slice(0, 3);
  const briefing = [
    `${windowDays} 天共 ${events.length} 次 skill 唤起，另有 ${commandCount} 条命令入账。`,
    top ? `${top.skill} 以 ${top.total} 次登顶${stats[1] ? `，${stats[1].skill}（${stats[1].total}）` : ""}${stats[2] ? `、${stats[2].skill}（${stats[2].total}）` : ""}随后。` : "窗口内暂无使用。",
    `显式 ${explicitCount} 次、自动 ${modelCount} 次——约十之${cheng[modelShare]}由模型自取。`,
    `峰值在 ${peakHour} 时，深夜（18–24）占 ${nightShare}%。`,
    busyDay ? `最忙的一天是 ${busyDay.day}（${busyDay.count} 次），主打 ${busyDayTop?.skill}。` : "暂无最忙日。",
    partnerText !== "未发现固定搭档" ? `搭档方面，${partnerText}。` : "本期未见固定搭档组合。",
    `来源方面，内置 ${origins.builtin}、外置 ${origins.user}、项目 ${origins.project}。`,
    `${idleList.length} 件器物整月未动，末版已备荐语；另有低频 ${lowFreq.length} 件各得按语。`,
    goals.length > 0
      ? `读者来信版现有 ${goals.length} 个登记目标，附代拟建议 ${suggests.length} 条。`
      : "读者来信版尚无登记目标，末版附代拟建议 5 条。",
  ];

  const data: SkillsReportData = {
    window: { start: startLabel, end: endLabel, days: windowDays },
    totals: {
      events: events.length + commandCount,
      explicit: explicitCount,
      model: modelCount,
      command: commandCount,
      perDay: (events.length + commandCount) / windowDays,
      skills: stats.length,
    },
    origins,
    hours,
    days: fullCalendarDays(events, startMs, endMs),
    weeks: weeklyBuckets(events),
    peakHour,
    frontPage,
    frontBullets: [
      ["日均", `${((events.length + commandCount) / windowDays).toFixed(1)} 次`, "口径：skill 唤起 + 命令入账"],
      ["显式 / 自动 / 命令", `${explicitCount} / ${modelCount} / ${commandCount}`, "你点名 / 模型自取 / 敲下"],
      ["居首", `${top?.skill ?? "—"} · ${top?.total ?? 0} 次`, modelCount > explicitCount ? "自动占绝大多数" : "显式为主"],
      ["最热时辰", `${peakHour}:00 前后`, "按时段热力"],
      ["最忙一天", busyDay ? `${busyDay.day.slice(5)} · ${busyDay.count} 次` : "—", busyDayTop ? `主打 ${busyDayTop.skill}` : undefined],
      ["新到器物", `${wareItems.length} 件`, "末版有荐语"],
    ],
    briefing,
    skills: stats,
    records: reportRecords,
    ...(fixedAnalyses ? { fixedAnalyses } : {}),
    goals: goalData,
    suggests,
    wares,
    idle: idleList.map((skill) => skill.name),
    updates: REPORT_UPDATES,
    ...(error ? { digestError: error } : {}),
    generatedAt: new Date().toLocaleString("zh-CN"),
  };

  const mainPath = writeAndOpenReport("skills-report", startLabel, endLabel, renderSkillsReport(data));
  const messages = [`主报告：${mainPath}`];
  if (excludedEvents.length > 0) {
    const excludedStats = perSkill(excludedEvents);
    const excludedPath = writeAndOpenReport(
      "skills-excluded",
      startLabel,
      endLabel,
      renderSkillsReport({
        ...data,
        window: { ...data.window },
        totals: { ...data.totals, events: excludedEvents.length, skills: excludedStats.length },
        skills: excludedStats,
        records: excludedEvents
          .slice()
          .sort((a, b) => b.ts - a.ts)
          .map((event) => ({ ts: event.ts, skill: event.skill, source: event.source, args: event.args.slice(0, 160), sessionPreview: event.sessionPreview || undefined })),
        days: fullCalendarDays(excludedEvents, startMs, endMs),
        weeks: weeklyBuckets(excludedEvents),
        hours: hourlyHistogram(excludedEvents),
        goals: [],
        suggests: [],
        wares: [],
        idle: [],
        frontPage: {
          title: "自动型器物一览",
          dek: "以下器物由 agent 自动触发（无用户意图），不计入主统计。",
          paragraphs: [],
        },
        digestError: undefined,
      }),
    );
    messages.push(`自动型：${excludedPath}`);
  }
  notify(ctx, messages.join("\n"));
}

/** 确定性：窗口全日历（无使用天补空行） */
function fullCalendarDays(
  events: Array<{ ts: number }>,
  startMs: number,
  endMs: number,
): Array<{ day: string; hours: number[] }> {
  const filled = heatmap(events);
  const byKey = new Map(filled.map((day) => [day.day, day]));
  const calendar: Array<{ day: string; hours: number[] }> = [];
  for (let ts = startMs; ts <= endMs; ts += 86_400_000) {
    const key = localDateKey(ts);
    calendar.push(byKey.get(key) ?? { day: key, hours: Array.from({ length: 24 }, () => 0) });
  }
  return calendar;
}

function commandUsageCount(events: Array<{ skill: string; source: string }>, name: string): number {
  return events.filter((event) => event.source === "command" && (event.skill === name || event.skill.startsWith(name + "/"))).length;
}

const ORIGIN_LABEL: Record<string, string> = { builtin: "内置", user: "外置", project: "项目" };

/** 本报更新：相对上一期晚报的变化（随版本维护） */
const REPORT_UPDATES: Array<{ date: string; text: string }> = [
  { date: "09-30", text: "版式大改：报名定「器物晚报」，头条成文，要数改要闻栏，排行让位走势折线。" },
  { date: "09-30", text: "命令行首次入账：/exit、/new 等扩展命令与 skill 同流程统计（金签）。" },
  { date: "09-30", text: "recap 撤专属座席——它不经 skill 机制，会话无痕可采，特此说明。" },
  { date: "09-30", text: "简讯改信息流：一条一卡，四列瀑布，附「当日正在办」会话线索。" },
  { date: "09-30", text: "固定分析增至四问，新增「搭档」；意图画像并入会话线索。" },
  { date: "09-30", text: "读者来信版新增一键登记：本报建议五条，点击即取命令。" },
];

export default function hplMetrics(pi: ExtensionAPI): void {
  pi.registerCommand("hapi-metrics", {
    description: "hapi 内置统计工具（子命令制：ponytail …）",
    // 参数补全：pi 的 slash 补全由 getArgumentCompletions 提供，内置命令都挂了它；
    // 不挂则输入子命令时无提示（与 /thinking、/model 的差异所在）。
    getArgumentCompletions: (query) =>
      // value 携带子命令前缀：pi 选中候选后整段替换参数文本，
      // 用户跳过子命令直接敲 flag（如 "--g"）也会被引导到合法路径。
      argumentCompletions(
        [
          { value: "ponytail", label: "ponytail", description: "会话级体量与形状对照" },
          { value: "skills", label: "skills", description: "skill 使用统计（面板）" },
          { value: "skills --eli60 ", label: "skills --eli60", description: "HTML 详报（热力图/干了什么）" },
          { value: "skills --json ", label: "skills --json", description: "导出聚合 JSON" },
          { value: "skills --since ", label: "--since", description: "窗口起点（默认 7 天前）", searchText: "skills since 日期窗口" },
          { value: "purpose ", label: "purpose", description: "登记 skill 的用途描述" },
          { value: "ponytail --group-by ", label: "--group-by", description: "按档位分组", searchText: "ponytail --group-by 按档位分组" },
          { value: "ponytail --since ", label: "--since", description: "只看该日期之后的会话", searchText: "ponytail --since 只看日期" },
          { value: "ponytail --project ", label: "--project", description: "按 cwd 过滤", searchText: "ponytail --project 项目过滤" },
          { value: "ponytail --json ", label: "--json", description: "输出 JSON", searchText: "ponytail --json 输出 JSON" },
        ],
        query,
      ),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const invocation = parseMetricsArgs(args);
      if (invocation.kind === "usage") {
        notify(ctx, usageText(invocation.reason), invocation.reason ? "warning" : "info");
        return;
      }

      if (invocation.kind === "purpose") {
        const added = appendGoal(invocation.text);
        notify(ctx, added ? `已登记分析目标：${invocation.text}` : `该目标已在册：${invocation.text}`);
        return;
      }

      if (invocation.kind === "skills") {
        await runSkillsCommand(ctx, pi, invocation);
        return;
      }

      const homes = hapilonHomes();
      const samples = loadSamples({
        ...(invocation.sinceMs !== undefined ? { sinceMs: invocation.sinceMs } : {}),
        ...(invocation.project ? { project: invocation.project } : {}),
      });
      const groups = groupSamples(samples, invocation.groupBy);

      if (invocation.json) {
        notify(ctx, JSON.stringify({
          groupBy: invocation.groupBy,
          samples: samples.length,
          groups,
        }, null, 1));
        return;
      }

      const meta = {
        homes,
        groupBy: invocation.groupBy,
        samples: samples.length,
        ponytailFromSession: samples.filter((sample) => sample.ponytailSource === "session").length,
        ...(invocation.project ? { project: invocation.project } : {}),
        ...(invocation.sinceMs !== undefined ? { since: new Date(invocation.sinceMs).toISOString().slice(0, 10) } : {}),
      };
      await showFloatingPane(ctx, {
        title: `hapi metrics · ponytail · ${invocation.groupBy}`,
        lines: renderPonytailLines(groups, meta),
        footer: "Esc 关闭 · 体量 ≠ 正确性",
        width: "fit-content",
        maxHeight: 90,
      });
    },
  });
}
