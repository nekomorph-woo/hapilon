/**
 * collector.ts — /context 数据收集器
 *
 * 纯函数：从各数据源聚合上下文快照，不直接依赖 ExtensionContext
 * （与 ctx 的交互由 index.ts 的 command handler 完成）。
 *
 */

import type {
  CategoryBreakdown,
  CategoryItem,
  ContextSnapshot,
  SystemPromptMeta,
} from "./types.js";
import { CHARS_PER_TOKEN, estimateTokens, safePercent } from "./types.js";
import { getLastMeta } from "../hpl-system-prompt/metadata.js";

// ── 输入类型 ──────────────────────────────────────────────────────────

export interface CollectorInput {
  /** ctx.getContextUsage() 的返回值 */
  contextUsage:
    | { tokens: number | null; contextWindow: number; percent: number | null }
    | undefined;
  /** ctx.getSystemPromptOptions() 的返回值（部分字段） */
  systemPromptOptions?: {
    toolSnippets?: Record<string, string>;
    selectedTools?: string[];
    contextFiles?: Array<{ path: string; content: string }>;
    skills?: Array<{ name: string; description: string }>;
  };
  /** ctx.model */
  model?: { id: string; name: string; contextWindow: number };
  /** session stats */
  sessionStats?: {
    userMessages: number;
    assistantMessages: number;
    totalMessages: number;
    tokens: { input: number; output: number; total: number };
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

/** 估算多段已计算长度的文本的 token 数（避免创建中间字符串） */
function estimateTokensFromLengths(...lengths: number[]): number {
  const total = lengths.reduce((sum, len) => sum + len, 0);
  return Math.ceil(total / CHARS_PER_TOKEN);
}

// ── Collector ──────────────────────────────────────────────────────────

/** 从各数据源聚合上下文快照（纯函数） */
export function collectContextSnapshot(input: CollectorInput): ContextSnapshot {
  const { contextUsage, systemPromptOptions, model, sessionStats } = input;

  const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
  const tokens = contextUsage?.tokens ?? null;
  const percent = contextUsage?.percent ?? null;

  // ── System prompt 分解（从 metadata） ──────────────────────
  const meta: SystemPromptMeta | undefined = getLastMeta();

  // 只累加纯 system 组成（role/guidelines/pi docs/env 等）。
  // tools/skills/contextFiles/hapilonRules/hapilonInstructions 各自独立成类，
  // 避免被双倍计入（issue #8）。
  const PURE_SYSTEM_SECTIONS = [
    "roleAndIdentity",
    "piDocumentation",
    "guidelines",
    "codeStyle",
    "customToolsNote",
    "additionalData",
    "environment",
  ] as const;

  const spTokens = meta
    ? estimateTokensFromLengths(...PURE_SYSTEM_SECTIONS.map((k) => meta.sections[k]))
    : null;

  // ── Rules（hapilonRules 独立分类） ─────────────────────────
  const rulesTokens = meta
    ? estimateTokensFromLengths(meta.sections.hapilonRules)
    : null;

  // ── HAPILON.md（hapilonInstructions 独立分类） ─────────────
  const hapilonMdTokens = meta
    ? estimateTokensFromLengths(meta.sections.hapilonInstructions)
    : null;

  // ── Tools ─────────────────────────────────────────────────
  const toolSnippets = systemPromptOptions?.toolSnippets ?? {};
  const selectedTools = systemPromptOptions?.selectedTools ?? Object.keys(toolSnippets);
  const toolsTotal = selectedTools.length > 0
    ? selectedTools.reduce((sum, name) => {
        const snippet = toolSnippets[name] ?? "";
        return sum + estimateTokens(`${name}: ${snippet}`);
      }, 0)
    : null;

  const toolItems: CategoryItem[] = selectedTools.map((name) => ({
    name,
    tokens: estimateTokens(`${name}: ${toolSnippets[name] ?? ""}`),
    description: toolSnippets[name],
  }));

  // ── Context files ──────────────────────────────────────────
  const contextFiles = systemPromptOptions?.contextFiles ?? [];
  const contextFilesTokens = contextFiles.length > 0
    ? contextFiles.reduce((sum, f) => sum + estimateTokens(`${f.path}\n${f.content}`), 0)
    : null;

  const contextFileItems: CategoryItem[] = contextFiles.map((f) => ({
    name: f.path,
    tokens: estimateTokens(`${f.path}\n${f.content}`),
  }));

  // ── Skills ─────────────────────────────────────────────────
  const skills = systemPromptOptions?.skills ?? [];
  const skillsTokens = skills.length > 0
    ? skills.reduce((sum, s) => sum + estimateTokens(`<skill><name>${s.name}</name><description>${s.description}</description></skill>`), 0)
    : null;

  const skillItems: CategoryItem[] = skills.map((s) => ({
    name: s.name,
    tokens: estimateTokens(s.description),
    description: s.description,
  }));

  // ── Messages ───────────────────────────────────────────────
  // total tokens - static parts = messages（粗略分解）
  // chars/4 会保守高估 static 部分 → 当 staticTotal > tokens 时 messages 估算无意义
  const staticTotal =
    (spTokens ?? 0) + (hapilonMdTokens ?? 0) + (rulesTokens ?? 0) +
    (toolsTotal ?? 0) + (contextFilesTokens ?? 0) + (skillsTokens ?? 0);
  const messagesTokens =
    tokens !== null && tokens > staticTotal ? tokens - staticTotal : null;

  // ── Build categories ───────────────────────────────────────
  const categories: CategoryBreakdown[] = [];

  // System prompt（纯组成：role + guidelines + pi docs + env，不含独立分类）
  if (spTokens !== null) {
    categories.push({
      label: "System prompt",
      tokens: spTokens,
      percent: safePercent(spTokens, contextWindow),
    });
  }

  // HAPILON.md（hapilonInstructions section）
  if (hapilonMdTokens !== null && hapilonMdTokens > 0) {
    categories.push({
      label: "HAPILON.md",
      tokens: hapilonMdTokens,
      percent: safePercent(hapilonMdTokens, contextWindow),
    });
  }

  // Rules（hapilonRules section）
  if (rulesTokens !== null && rulesTokens > 0) {
    categories.push({
      label: "Rules",
      tokens: rulesTokens,
      percent: safePercent(rulesTokens, contextWindow),
    });
  }

  // Tools
  {
    categories.push({
      label: "System tools",
      tokens: toolsTotal,
      percent: safePercent(toolsTotal, contextWindow),
      items: toolItems.length > 0 ? toolItems : undefined,
    });
  }

  // Context files
  if (contextFilesTokens !== null) {
    categories.push({
      label: "Context files",
      tokens: contextFilesTokens,
      percent: safePercent(contextFilesTokens, contextWindow),
      items: contextFileItems.length > 0 ? contextFileItems : undefined,
    });
  }

  // Skills
  {
    categories.push({
      label: "Skills",
      tokens: skillsTokens,
      percent: safePercent(skillsTokens, contextWindow),
      items: skillItems.length > 0 ? skillItems : undefined,
    });
  }

  // Messages
  if (messagesTokens !== null) {
    categories.push({
      label: "Messages",
      tokens: messagesTokens,
      percent: safePercent(messagesTokens, contextWindow),
    });
  }

  // Free space
  const usedTokens = tokens ?? staticTotal;
  const freeTokens = contextWindow > 0 ? Math.max(0, contextWindow - usedTokens) : 0;
  categories.push({
    label: "Free space",
    tokens: freeTokens,
    percent: safePercent(freeTokens, contextWindow),
  });

  // ── Estimated total ────────────────────────────────────────
  const estimatedTotal = spTokens !== null
    ? spTokens + (hapilonMdTokens ?? 0) + (rulesTokens ?? 0) +
      (toolsTotal ?? 0) + (contextFilesTokens ?? 0) + (skillsTokens ?? 0) + (messagesTokens ?? 0)
    : null;

  return {
    model: model ?? { id: "unknown", name: "unknown", contextWindow },
    usage: { tokens, percent, contextWindow },
    categories,
    estimatedTotal,
    sessionStats,
  };
}

/**
 * 从 CollectorInput 收集数据（薄封装，便于 index.ts 调用）。
 * 这里直接使用 getLastMeta()，不依赖 ctx。
 */
export function collectSnapshot(input: CollectorInput): ContextSnapshot {
  return collectContextSnapshot(input);
}
