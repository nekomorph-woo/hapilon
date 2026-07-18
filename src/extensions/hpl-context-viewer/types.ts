/**
 * types.ts — hpl-context-viewer 共享类型
 *
 * 定义 ContextSnapshot、CategoryBreakdown、SystemPromptMeta 等类型，
 * 供 collector.ts、renderer.ts 和 hpl-system-prompt/metadata.ts 使用。
 */

// ── System Prompt 元数据 ──────────────────────────────────────────────

/** 记录最后一次 system prompt 组装的各部分长度（用于 token 估算） */
export interface SystemPromptMeta {
  assembledAt: number;
  cwd: string;
  sections: {
    roleAndIdentity: number;
    piDocumentation: number;
    tools: number;
    guidelines: number;
    hapilonInstructions: number;
    hapilonRules: number;
    contextFiles: number;
    skills: number;
    customToolsNote: number;
    additionalData: number;
    environment: number;
  };
}

// ── 上下文快照 ─────────────────────────────────────────────────────────

export interface CategoryBreakdown {
  /** 显示标签 */
  label: string;
  /** 估算 token 数（null = 未知） */
  tokens: number | null;
  /** 百分比（相对于 contextWindow），null = 未知 */
  percent: number | null;
  /** 子项详情（可选） */
  items?: CategoryItem[];
}

export interface CategoryItem {
  name: string;
  tokens: number | null;
  /** 可选描述（如 tool snippet、skill description） */
  description?: string;
}

export interface ContextSnapshot {
  /** 模型标识 */
  model: {
    id: string;
    name: string;
    contextWindow: number;
  };
  /** Pi 估算的上下文用量 */
  usage: {
    tokens: number | null;
    percent: number | null;
    contextWindow: number;
  };
  /** 按类别分解 */
  categories: CategoryBreakdown[];
  /** 汇总：所有分类 token 之和（用于校验） */
  estimatedTotal: number | null;
  /** Session 消息统计 */
  sessionStats?: {
    userMessages: number;
    assistantMessages: number;
    totalMessages: number;
    tokens: { input: number; output: number; total: number };
  };
}

// ── Token 估算工具 ─────────────────────────────────────────────────────

/** Pi 内置 token 估算策略：chars / 4（保守高估） */
export const CHARS_PER_TOKEN = 4;

/** 估算一段文本的 token 数 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** 估算多段文本的总 token 数 */
export function estimateTotalTokens(...texts: string[]): number {
  return texts.reduce((sum, t) => sum + estimateTokens(t), 0);
}

/** 安全计算百分比（handle 0/NaN/null） */
export function safePercent(tokens: number | null, contextWindow: number): number | null {
  if (tokens === null || contextWindow <= 0) return null;
  return Math.round((tokens / contextWindow) * 1000) / 10; // 1 decimal
}
