/**
 * digest.ts — 器物晚报的文字管线：摘要、头条、固定分析、目标分析、推荐、器物荐语。
 *
 * 上下文组织是「渐进式 + 工具化」：不把有损摘要一次性塞给模型，而是给它一组
 * 本插件私有的数据查询（标准 pi Tool 协议，见 DATA_TOOLS——插件私有，不注册进
 * hapi 工具体系），模型按需多轮拉取，探索够了再产出文字。质量优先，轮次换深度。
 *
 * 模型与选模：recap 同款（haiku 优先，非推理）。摘要缓存按 hash 落盘。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { Effect } from "effect";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message, Tool } from "@earendil-works/pi-ai";
import { readResolvedTiersEffect } from "../../hpl-model-tiers/resolved.js";
import { selectRecapModel } from "../../hpl-recap/model.js";
import type { AvailableSkill } from "./stats.js";
import type { SkillUsageEvent } from "./usage.js";
import { digestsPath } from "./storage.js";
import {
  FIXED_ANALYSIS_STYLE,
  FRONT_PAGE_STYLE,
  GOAL_ANALYSIS_STYLE,
  OBSERVER_STYLE,
  SUGGESTION_STYLE,
  WARE_NOTE_STYLE,
} from "./style.js";

/* ——— 原话摘要缓存 ——— */

export interface DigestEntry {
  key: string;
  digest: string;
  consistency?: string;
}

export interface DigestItem {
  skill: string;
  tail: string;
  purpose?: string;
}

export function digestKey(skill: string, tail: string): string {
  return createHash("sha1").update(`${skill}\u0000${tail}`).digest("hex").slice(0, 12);
}

/** 损坏行跳过：缓存宁可缺不崩 */
export function loadDigests(): Map<string, DigestEntry> {
  const path = digestsPath();
  const digests = new Map<string, DigestEntry>();
  if (!existsSync(path)) return digests;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as DigestEntry;
        if (typeof entry.key === "string" && typeof entry.digest === "string") digests.set(entry.key, entry);
      } catch {
        continue;
      }
    }
  } catch (error) {
    console.warn(`[hpl-metrics] digest 缓存读取失败，按空缓存处理：${String(error)}`);
  }
  return digests;
}

export function saveDigests(entries: readonly DigestEntry[]): void {
  if (entries.length === 0) return;
  const path = digestsPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

/* ——— 模型调用 ——— */

const DIGEST_TOKEN_BUDGET = 2048;

/** recap 同款选模 + 单次补全，返回纯文本 */
async function callModel(
  ctx: ExtensionContext,
  systemPrompt: string,
  messages: ReadonlyArray<{ role: "user"; content: string; timestamp: number }>,
  maxTokens: number,
): Promise<string> {
  const available = ctx.modelRegistry.getAvailable();
  const resolvedTiers = await Effect.runPromise(readResolvedTiersEffect);
  const choice = selectRecapModel(available, ctx.model, resolvedTiers);
  if (!choice.model) throw new Error(choice.reason ?? "没有可用摘要模型");
  const response = await ctx.modelRegistry.complete(
    choice.model,
    { systemPrompt, messages: messages.map((m) => ({ ...m, timestamp: Date.now() })) },
    { maxTokens },
  );
  const content = (response as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part as { text?: unknown })?.text ?? "")
    .filter((t): t is string => typeof t === "string")
    .join("\n")
    .trim();
}

/** 容错取 JSON 对象：截取首个 { 到末个 } */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** JSON 壳提取：模型把最终文字包进 JSON 时，取其中的长文本字段 */
function unwrapAnswer(text: string): string {
  const parsed = parseJsonObject(text);
  if (parsed) {
    for (const key of ["answer", "analysis", "text", "content", "result"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim().length > 20) return value.trim();
    }
  }
  return text;
}

/** 容错取 JSON 数组：截取首个 [ 到末个 ] */
export function parseJsonArray(text: string): unknown[] | undefined {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/* ——— 原话摘要（批量、纯格式化，不走探索） ——— */

export interface GeneratedDigests {
  entries: Map<string, DigestEntry>;
  error?: string;
}

export async function generateMissingDigests(
  items: readonly DigestItem[],
  ctx: ExtensionContext,
): Promise<GeneratedDigests> {
  const digests = loadDigests();
  const missing = items.filter((item) => item.tail && !digests.has(digestKey(item.skill, item.tail)));
  if (missing.length === 0) return { entries: digests };
  try {
    const list = missing
      .map((item, index) => `${index + 1}. skill=${item.skill}${item.purpose ? `（登记用途：${item.purpose}）` : ""}\n   原话：${item.tail}`)
      .join("\n");
    const text = await callModel(
      ctx,
      `${OBSERVER_STYLE}\n只输出 JSON 数组，其余一个字都不要。`,
      [{ role: "user", content: `任务：逐条给出 digest（≤30 字，概括这条原话想让器物干什么）；若该条给了登记用途，再给 consistency：一句话判断实际用法与登记用途一致还是偏移。无登记用途的条目不要 consistency 字段。\n\n${list}`, timestamp: Date.now() }],
      DIGEST_TOKEN_BUDGET,
    );
    const parsed = parseJsonArray(text) ?? [];
    const fresh: DigestEntry[] = [];
    for (const item of parsed) {
      const entry = item as { i?: unknown; digest?: unknown; consistency?: unknown };
      const index = typeof entry.i === "number" ? entry.i - 1 : -1;
      if (index < 0 || index >= missing.length || typeof entry.digest !== "string") continue;
      const target = missing[index]!;
      const record: DigestEntry = {
        key: digestKey(target.skill, target.tail),
        digest: entry.digest.trim().slice(0, 80),
        ...(typeof entry.consistency === "string" ? { consistency: entry.consistency.trim().slice(0, 120) } : {}),
      };
      digests.set(record.key, record);
      fresh.push(record);
    }
    if (fresh.length > 0) saveDigests(fresh);
    return { entries: digests };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[hpl-metrics] skill 摘要调用失败：${message.slice(0, 160)}`);
    return { entries: digests, error: "摘要模型调用失败，相关条目降级显示原文" };
  }
}

/* ——— 渐进式数据探索（标准 tool-use agent 循环） ——— */

export interface DataScope {
  /** 窗口内全部使用事件（skill + 命令） */
  events: SkillUsageEvent[];
  /** 会话名 → 首条用户消息线索 */
  sessionPreviews: Record<string, string>;
  /** 已安装器物清单（含描述） */
  available: AvailableSkill[];
  window: { start: string; end: string; days: number };
  /** 可 slash 的全量命令清单（含描述） */
  commandCatalog: Array<{ name: string; description: string; source: string }>;
}

const dayLabelOf = (ts: number): string => {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const whenLabelOf = (ts: number): string => {
  const d = new Date(ts);
  return `${dayLabelOf(ts)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function executeTool(scope: DataScope, name: string, args: Record<string, unknown>): string {
  const argString = (key: string): string => (typeof args[key] === "string" ? (args[key] as string).toLowerCase() : "");
  const argNumber = (key: string, fallback: number): number => (typeof args[key] === "number" ? (args[key] as number) : fallback);

  switch (name) {
    case "list_skills": {
      const counts = new Map<string, { total: number; explicit: number; model: number; command: number }>();
      for (const event of scope.events) {
        const entry = counts.get(event.skill) ?? { total: 0, explicit: 0, model: 0, command: 0 };
        entry.total += 1;
        if (event.source === "explicit") entry.explicit += 1;
        else if (event.source === "model") entry.model += 1;
        else entry.command += 1;
        counts.set(event.skill, entry);
      }
      const lines = [...counts.entries()]
        .sort((a, b) => b[1].total - a[1].total)
        .map(([skill, c]) => `${skill}: ${c.total} 次（显式 ${c.explicit}/自动 ${c.model}/命令 ${c.command}）`);
      const installed = scope.available.map((skill) => skill.name).filter((name) => !counts.has(name));
      return JSON.stringify({ 排行: lines, 零使用: installed });
    }
    case "skill_summary": {
      const name = argString("name");
      const matched = scope.events.filter((event) => event.skill === name);
      if (matched.length === 0) return JSON.stringify({ error: `窗口内没有 ${name} 的记录` });
      const explicit = matched.filter((event) => event.source === "explicit").length;
      const hours = Array.from({ length: 24 }, () => 0);
      for (const event of matched) hours[new Date(event.ts).getHours()]!++;
      const sessions = [...new Set(matched.map((event) => event.session))];
      const sorted = [...matched].sort((a, b) => a.ts - b.ts);
      const tails = sorted
        .filter((event) => event.source === "explicit" && event.args)
        .map((event) => `${whenLabelOf(event.ts)}「${event.args}」`);
      const co = new Map<string, number>();
      for (const event of scope.events) {
        if (event.skill === name) continue;
        if (matched.some((m) => m.session === event.session)) co.set(event.skill, (co.get(event.skill) ?? 0) + 1);
      }
      const partner = [...co.entries()].sort((a, b) => b[1] - a[1])[0];
      return JSON.stringify({
        name,
        总次数: matched.length,
        显式: explicit,
        自动: matched.length - explicit,
        时段直方: hours,
        涉及会话: sessions.length,
        最近: whenLabelOf(sorted[sorted.length - 1]!.ts),
        全部原话: tails,
        最常见搭档: partner ? `${partner[0]}（${partner[1]} 次）` : "无",
        会话线索样例: sessions.slice(0, 3).map((s) => scope.sessionPreviews[s]).filter(Boolean),
      });
    }
    case "records_query": {
      const skill = argString("skill");
      const source = argString("source");
      const limit = argNumber("limit", 20);
      const matched = scope.events
        .filter((event) => (!skill || event.skill === skill) && (!source || event.source === source))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit);
      return JSON.stringify(
        matched.map((event) => ({
          时间: whenLabelOf(event.ts),
          skill: event.skill,
          来源: event.source,
          原话: event.args || undefined,
          会话: event.session.slice(0, 18),
        })),
      );
    }
    case "partners_of": {
      const name = argString("name");
      const sessions = new Set(scope.events.filter((event) => event.skill === name).map((event) => event.session));
      const co = new Map<string, number>();
      for (const event of scope.events) {
        if (event.skill === name || !sessions.has(event.session)) continue;
        co.set(event.skill, (co.get(event.skill) ?? 0) + 1);
      }
      return JSON.stringify(Object.fromEntries([...co.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)));
    }
    case "hour_profile": {
      const name = argString("name");
      const matched = name ? scope.events.filter((event) => event.skill === name) : scope.events;
      const hours = Array.from({ length: 24 }, () => 0);
      for (const event of matched) hours[new Date(event.ts).getHours()]!++;
      return JSON.stringify(hours);
    }
    case "day_counts": {
      const counts = new Map<string, number>();
      for (const event of scope.events) {
        const key = dayLabelOf(event.ts);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return JSON.stringify(Object.fromEntries([...counts.entries()].sort()));
    }
    case "session_preview": {
      const session = argString("session");
      return JSON.stringify({ session, 线索: scope.sessionPreviews[session] ?? "（无）" });
    }
    default:
      return JSON.stringify({ error: `未知工具 ${name}` });
  }
}

const prop = (description: string) => ({ type: "string", description });
const obj = (
  properties: Record<string, { type: string; description: string }>,
  required: string[] = [],
): { type: string; properties: Record<string, { type: string; description: string }>; required: string[] } => ({
  type: "object",
  properties,
  required,
});

/** 探索用数据查询：pi 原生 Tool 声明 + 执行器一体（本插件私有，不注册进 hapi 工具体系） */
export const DATA_TOOLS: Array<{
  name: string;
  description: string;
  parameters: { type: string; properties: Record<string, { type: string; description: string }>; required: string[] };
  execute: (scope: DataScope, args: Record<string, unknown>) => string;
}> = [
  {
    name: "list_skills",
    description: "全量器物与命令排行（含零使用与命令拆分）",
    parameters: obj({}, []),
    execute: (scope) => executeTool(scope, "list_skills", {}),
  },
  {
    name: "skill_summary",
    description: "单件器物全量档案：次数/显式自动/时段/间隔/全部原话/搭档/会话",
    parameters: obj({ name: prop("器物名") }, ["name"]),
    execute: (scope, args) => executeTool(scope, "skill_summary", args),
  },
  {
    name: "records_query",
    description: "筛选使用记录（时间倒序，含原话与会话线索）",
    parameters: obj({
      skill: prop("按器物名筛选（可选）"),
      source: prop("explicit | model | command（可选）"),
      limit: { type: "number", description: "返回条数上限（默认 20）" },
    }),
    execute: (scope, args) => executeTool(scope, "records_query", args),
  },
  {
    name: "partners_of",
    description: "该器物的同会话共现搭档",
    parameters: obj({ name: prop("器物名") }, ["name"]),
    execute: (scope, args) => executeTool(scope, "partners_of", args),
  },
  {
    name: "hour_profile",
    description: "时段直方（全局或某器物）",
    parameters: obj({ name: { type: "string", description: "器物名（可选）" } }, []),
    execute: (scope, args) => executeTool(scope, "hour_profile", args),
  },
  {
    name: "day_counts",
    description: "按日计数",
    parameters: obj({}, []),
    execute: (scope, args) => executeTool(scope, "day_counts", args),
  },
  {
    name: "session_preview",
    description: "某会话的首条用户消息",
    parameters: obj({ session: prop("会话名") }, ["session"]),
    execute: (scope, args) => executeTool(scope, "session_preview", args),
  },
];

export const FIXED_QUESTIONS = [
  "意图画像 · 它通常被用来干什么",
  "趋势与节奏 · 用量在升还是在降",
  "显式/自动与一致性 · 谁在用它",
  "搭档 · 它常和谁一起出场",
];

export const AGENT_MAX_ROUNDS = 30;

export interface AgentResult {
  answer: string;
  rounds: number;
}

async function resolveAgentModel(ctx: ExtensionContext) {
  const available = ctx.modelRegistry.getAvailable();
  const resolvedTiers = await Effect.runPromise(readResolvedTiersEffect);
  const choice = selectRecapModel(available, ctx.model, resolvedTiers);
  if (!choice.model) throw new Error(choice.reason ?? "没有可用摘要模型");
  return choice.model;
}

/** 标准 tool-use agent 循环：assistant(toolCalls) → toolResult → … → 最终文本 */
export async function runDataAgent(
  task: string,
  finalFormat: string,
  scope: DataScope,
  ctx: ExtensionContext,
  opts?: { extraStyle?: string; onProgress?: (info: string) => void },
): Promise<AgentResult | undefined> {
  try {
    const system = `${OBSERVER_STYLE}${opts?.extraStyle ? `\n${opts.extraStyle}` : ""}\n\n你将渐进式地探索数据来完成任务：不要假设数据，每轮调用一个查询，看结果再决定下一步；数据足够后直接用中文给出最终回答，不再调用工具。\n\n最终回答要求：${finalFormat}`;
    const tools: Tool[] = DATA_TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));
    const messages: Message[] = [
      {
        role: "user",
        content: `基础概览：窗口 ${scope.window.start} ~ ${scope.window.end}（${scope.window.days} 天），记录 ${scope.events.length} 条，已安装器物 ${scope.available.length} 件。\n\n[任务]\n${task}`,
        timestamp: Date.now(),
      },
    ];
    const model = await resolveAgentModel(ctx);
    const asUser = (content: string): Message => ({ role: "user", content, timestamp: Date.now() });

    for (let round = 1; round <= AGENT_MAX_ROUNDS; round++) {
      const response = await ctx.modelRegistry.complete(
        model,
        { systemPrompt: system, tools, messages },
        { maxTokens: DIGEST_TOKEN_BUDGET },
      );
      const parts = (response.content ?? []) as Array<{ type?: string; id?: string; name?: string; arguments?: Record<string, unknown>; text?: string }>;
      const toolCalls = parts.filter((part): part is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } => part?.type === "toolCall");
      const text = parts.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");

      if (toolCalls.length === 0) {
        const answer = text.trim() ? unwrapAnswer(text.trim()) : "";
        return answer ? { answer, rounds: round } : undefined;
      }

      // assistant 消息（含 toolCalls）原样进历史，工具结果以 toolResult 回传
      messages.push(response);
      for (const call of toolCalls) {
        opts?.onProgress?.(`第 ${round} 轮 · ${call.name} ${JSON.stringify(call.arguments ?? {}).slice(0, 60)}`);
        const output = DATA_TOOLS.find((tool) => tool.name === call.name)?.execute(scope, call.arguments ?? {})
          ?? JSON.stringify({ error: `未知工具 ${call.name}` });
        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: output }],
          isError: false,
          timestamp: Date.now(),
        });
      }
    }

    // 轮次用尽：不带工具再要一次最终回答
    const final = await ctx.modelRegistry.complete(
      await resolveAgentModel(ctx),
      { systemPrompt: `${system}\n\n探索轮次已用完。基于已看到的数据直接用中文给出最终回答。`, messages },
      { maxTokens: DIGEST_TOKEN_BUDGET },
    );
    const finalRaw = ((final.content ?? []) as Array<{ type?: string; text?: string }>)
      .filter((part) => part?.type === "text")
      .map((part) => part.text ?? "")
      .join("")
      .trim();
    const finalAnswer = finalRaw ? unwrapAnswer(finalRaw) : "";
    return finalAnswer ? { answer: finalAnswer, rounds: AGENT_MAX_ROUNDS + 1 } : undefined;
  } catch (error) {
    console.warn(`[hpl-metrics] 数据探索失败：${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
/* ——— 各版块管线：任务文案 + agent 调用 + 解析 ——— */

export interface FixedAnalysis {
  scope: string;
  title: string;
  text: string;
}

/** 单个 scope 的固定分析四问；不足四条视为失败（调用侧降级数据卡） */
export async function generateFixedAnalyses(
  scopeName: string,
  scope: DataScope,
  ctx: ExtensionContext,
  onProgress?: (info: string) => void,
): Promise<FixedAnalysis[] | undefined> {
  const result = await runDataAgent(
    `完成「固定分析目标」四问（范围：${scopeName}）。四条 title 依次为：${FIXED_QUESTIONS.join("、")}。`,
    `只输出 JSON 数组，恰好 4 条：[{"title":"…","text":"…"}]。每条 60~90 字，结论先行、引用数字。`,
    scope,
    ctx,
    { extraStyle: FIXED_ANALYSIS_STYLE, onProgress },
  );
  if (!result) return undefined;
  const parsed = parseJsonArray(result.answer) ?? [];
  const analyses = parsed
    .map((item) => item as { title?: unknown; text?: unknown })
    .filter((item): item is { title: string; text: string } => typeof item.title === "string" && typeof item.text === "string")
    .map((item) => ({ scope: scopeName, title: item.title.trim().slice(0, 40), text: item.text.trim().slice(0, 220) }));
  return analyses.length === FIXED_QUESTIONS.length ? analyses : undefined;
}

export interface FrontPage {
  title: string;
  dek: string;
  paragraphs: string[];
}

/** 头条文章；失败返回 undefined（调用侧用确定性模板兜底） */
export async function generateFrontPage(
  scope: DataScope,
  ctx: ExtensionContext,
  onProgress?: (info: string) => void,
): Promise<FrontPage | undefined> {
  const result = await runDataAgent(
    "为本期《器物晚报》写头版文章。",
    `只输出 JSON 对象：{"title":"…","dek":"…","paragraphs":["…","…","…"]}。标题对仗或化用诗句、14 字内、数字用汉字；dek 一句话点出榜首与最大反直觉事实；正文恰好三段，第一段以「本报讯」起笔给总量与时段事实，第二段讲榜首器物与显式/自动分工，第三段收在趋势或新变化。每段 60~110 字。`,
    scope,
    ctx,
    { extraStyle: FRONT_PAGE_STYLE, onProgress },
  );
  if (!result) return undefined;
  const parsed = parseJsonObject(result.answer);
  if (!parsed) return undefined;
  const paragraphs = Array.isArray(parsed.paragraphs)
    ? parsed.paragraphs
        .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        .slice(0, 3)
        .map((p) => p.trim().replace(/^本报讯[：,，\s]*/, ""))
    : [];
  if (typeof parsed.title !== "string" || paragraphs.length === 0) return undefined;
  return {
    title: parsed.title.trim().slice(0, 40),
    dek: typeof parsed.dek === "string" ? parsed.dek.trim().slice(0, 80) : "",
    paragraphs,
  };
}

export interface GoalAnalysis {
  goal: string;
  analysis: string;
}

/** 单条分析目标的模型分析；失败返回 undefined */
export async function generateGoalAnalysis(
  goal: string,
  scope: DataScope,
  ctx: ExtensionContext,
  onProgress?: (info: string) => void,
): Promise<string | undefined> {
  const result = await runDataAgent(
    `分析读者登记的分析目标：「${goal}」。`,
    `200 字以内，写足分析与证据；结论先行、至少引用两个数字、结尾指出数据局限；数据不足直说「本期数据不足以回答」并说明缺什么。`,
    scope,
    ctx,
    { extraStyle: GOAL_ANALYSIS_STYLE, onProgress },
  );
  return result ? unwrapAnswer(result.answer).slice(0, 500) || undefined : undefined;
}

export interface SuggestedGoal {
  title: string;
  why: string;
  dataNeeded: string;
}

/** 目标推荐 5 条（避开已登记）；失败返回空数组 */
export async function generateSuggestions(
  existingGoals: readonly string[],
  scope: DataScope,
  ctx: ExtensionContext,
  onProgress?: (info: string) => void,
): Promise<SuggestedGoal[]> {
  const existing = existingGoals.length > 0 ? `已登记目标（不要重复）：${existingGoals.join("；")}` : "（尚无登记目标）";
  const result = await runDataAgent(
    `基于数据提出 5 条值得登记的分析目标。${existing}`,
    `只输出 JSON 数组，恰好 5 条：[{"title":"…","why":"…","dataNeeded":"…"}]。目标必须能用窗口内数据回答。`,
    scope,
    ctx,
    { extraStyle: SUGGESTION_STYLE, onProgress },
  );
  if (!result) return [];
  return (parseJsonArray(result.answer) ?? [])
    .map((item) => item as { title?: unknown; why?: unknown; dataNeeded?: unknown })
    .filter((item): item is { title: string; why: string; dataNeeded: string } =>
      typeof item.title === "string" && typeof item.why === "string")
    .slice(0, 5)
    .map((item) => ({
      title: item.title.trim().slice(0, 80),
      why: item.why.trim().slice(0, 160),
      dataNeeded: typeof item.dataNeeded === "string" ? item.dataNeeded.trim().slice(0, 80) : "",
    }));
}

export interface WareNote {
  name: string;
  recommend: string;
}

/** 器物荐语（结合近期场景的一句话推荐）；失败返回空表 */
export interface WareItem {
  name: string;
  tag: string;
  /** SKILL.md 的英文原始描述（管线负责转成中文介绍） */
  description: string;
}

export interface WareNote {
  name: string;
  /** 中文功能介绍（非英文直译） */
  intro: string;
  /** 结合读者近期场景的推荐 */
  recommend: string;
}

/** 器物荐语：中文介绍 + 结合近期场景的推荐；失败降级英文原文 + 固定句 */
export async function generateWareNotes(
  items: readonly WareItem[],
  recentContext: string,
  scope: DataScope,
  ctx: ExtensionContext,
): Promise<Record<string, { intro: string; recommend: string }>> {
  if (items.length === 0) return {};
  const notes: Record<string, { intro: string; recommend: string }> = {};
  try {
    const list = items
      .map((item) => `- ${item.name}（${item.tag}）：${item.description || "（无描述）"}`)
      .join("\n");
    const text = await callModel(
      ctx,
      `${OBSERVER_STYLE}\n${WARE_NOTE_STYLE}\n只输出 JSON 数组：[{"name":"…","intro":"…","recommend":"…"}]，每件器物一条，其余一个字都不要。`,
      [{ role: "user", content: `任务：为下面这些「架上蒙尘」的器物各写两句——intro 用中文讲清它解决什么问题（不要英文直译腔）；recommend 结合读者近期的工作场景说清什么时机用得上。\n\n[读者近期在忙]\n${recentContext}\n\n[器物清单]\n${list}`, timestamp: Date.now() }],
      DIGEST_TOKEN_BUDGET,
    );
    const parsed = parseJsonArray(text) ?? [];
    for (const item of parsed) {
      const entry = item as { name?: unknown; intro?: unknown; recommend?: unknown };
      if (typeof entry.name !== "string" || typeof entry.intro !== "string") continue;
      notes[entry.name.toLowerCase()] = {
        intro: entry.intro.trim().slice(0, 120),
        recommend: typeof entry.recommend === "string" ? entry.recommend.trim().slice(0, 140) : "",
      };
    }
  } catch (error) {
    console.warn(`[hpl-metrics] 器物荐语生成失败，降级原文：${error instanceof Error ? error.message : String(error)}`);
  }
  return notes;
}
