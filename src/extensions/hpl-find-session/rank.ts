/**
 * rank.ts — 用 haiku 档模型对候选会话排序并生成一行摘要
 */

import type { SessionExcerpt } from "./index-core.js";
import { selectRecapModel, type RecapModelShape } from "../hpl-recap/model.js";
import type { ResolvedTierModels } from "../hpl-model-tiers/resolved.js";

export interface RankedEntry {
  entry: SessionExcerpt;
  /** 模型给出的一行中文摘要；降级时为首条用户消息截断 */
  summary: string;
}

export interface ModelDeps {
  available: readonly RecapModelShape[];
  currentModel: RecapModelShape | undefined;
  resolvedTiers: ResolvedTierModels;
  /** rankEntries 选好模型后回调执行；实现方注入 modelRegistry.complete */
  complete: (
    model: RecapModelShape,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    systemPrompt: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

const RANK_SYSTEM_PROMPT = [
  "你是会话检索助手。给你用户的一句话描述和一批历史会话候选（含首末用户消息）。",
  "任务：挑出与描述相关的会话，按相关度降序，每个给一段不超过 80 字的中文总结。",
  "总结必须针对用户的描述回答：这个会话里做了什么、得到了什么结论或结果、能帮用户解决描述中的问题到什么程度。",
  "不要泛泛概括会话主题，要让用户读完就能判断这是不是要找的那个会话。",
  '只返回严格 JSON 数组，不要任何其它文字：[{"i":<候选编号>,"s":"<不超过80字总结>"}]，最多 10 项，i 必须来自候选编号。',
  "即使没有明显相关的会话，也必须挑出最接近的候选返回（宁滥勿缺）；只有候选列表为空时才返回 []。",
].join("\n");

function candidateLine(index: number, entry: SessionExcerpt): string {
  const cwd = entry.cwd.replace(/^\/Users\/[^/]+/, "~");
  const name = entry.name || "(未命名)";
  return `[${index}] ${entry.modified.slice(0, 16)} ${cwd} 「${name}」 消息${entry.messageCount}条 首:${entry.firstUser.slice(0, 120)} 末:${entry.lastUser.slice(0, 120)}`;
}

function responseText(response: unknown): string {
  if (response && typeof response === "object") {
    const content = (response as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((b) => (typeof b === "object" && b !== null && (b as { text?: unknown }).text) ?? "")
        .join("");
    }
  }
  return "";
}

interface RankJsonItem {
  i?: unknown;
  s?: unknown;
}

/** 解析模型输出；容错代码围栏与非 JSON 输出，返回 null 表示降级。 */
export function parseRankedJson(text: string): Array<{ index: number; summary: string }> {
  const stripped = text.trim().replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Array<{ index: number; summary: string }> = [];
  for (const item of parsed as RankJsonItem[]) {
    if (typeof item !== "object" || item === null) continue;
    if (typeof item.i !== "number" || !Number.isInteger(item.i)) continue;
    if (typeof item.s !== "string" || !item.s.trim()) continue;
    out.push({ index: item.i, summary: item.s.trim().slice(0, 100) });
  }
  return out;
}

/** 候选超过上限时截断，返回摘要降级用的短句。 */
export function fallbackSummary(entry: SessionExcerpt): string {
  const base = entry.firstUser || entry.lastUser || "(无用户消息)";
  return base.slice(0, 60);
}

/**
 * 用 haiku 档模型对候选排序 + 摘要。模型不可用或输出无效时降级为原序 + 首条消息截断。
 * 返回按相关度降序的候选（含被模型排除在 top 之外的，排在其后，保持关键词序）。
 */
export async function rankEntries(query: string, candidates: SessionExcerpt[], deps: ModelDeps): Promise<{
  ranked: RankedEntry[];
  degraded: boolean;
  modelLabel: string;
}> {
  const choice = selectRecapModel(deps.available, deps.currentModel, deps.resolvedTiers);
  if (!choice.model || candidates.length === 0) {
    return {
      ranked: candidates.map((entry) => ({ entry, summary: fallbackSummary(entry) })),
      degraded: true,
      modelLabel: choice.model ? "" : "无可用模型",
    };
  }
  const modelLabel = choice.model.name?.trim() || `${choice.model.provider}/${choice.model.id}`;

  let modelOrder: Array<{ index: number; summary: string }> = [];
  try {
    const userPrompt = `用户描述：${query}\n\n候选：\n${candidates.map((entry, index) => candidateLine(index, entry)).join("\n")}`;
    const text = responseText(await deps.complete(
      choice.model,
      [{ role: "user", content: userPrompt }],
      RANK_SYSTEM_PROMPT,
    ));
    modelOrder = parseRankedJson(text);
  } catch {
    modelOrder = [];
  }

  const ranked: RankedEntry[] = [];
  for (const item of modelOrder) {
    const entry = candidates[item.index];
    if (entry) ranked.push({ entry, summary: item.summary });
  }
  // 模型已选出相关候选：只展示选中的（每行都是针对查询的总结）；
  // 降级时才全量展示，首句兜底。
  if (ranked.length > 0) return { ranked, degraded: choice.degraded, modelLabel };
  for (let index = 0; index < candidates.length; index++) {
    ranked.push({ entry: candidates[index], summary: fallbackSummary(candidates[index]) });
  }
  return { ranked, degraded: true, modelLabel };
}
