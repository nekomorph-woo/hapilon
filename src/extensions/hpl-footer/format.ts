/**
 * format.ts — hpl-footer 文本拼装纯函数
 *
 * usage 累加、token/窗口格式化、三行文本构建、宽度布局。
 * 设计来源: _plans/hpl-footer-custom.md §3.3
 */

export interface FooterStats {
  input: number;
  output: number;
  cacheHitRate?: number;
}

/** 自适应 token 格式：<1000 原样 / 2.2k / 34k / 1.0M */
export function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
  return `${Math.round(n / 1000000)}M`;
}

/** 窗口小写紧凑格式：200k / 1m */
export function formatWindow(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  const m = n / 1000000;
  return m % 1 === 0 ? `${m}m` : `${m.toFixed(1)}m`;
}

/** 第 1 行：`cwd | branch`；无分支时仅 cwd */
export function buildLine1(cwd: string, branch: string | null): string {
  return branch ? `${cwd} | ${branch}` : cwd;
}

/** 单行状态清洗：换行/制表压成单空格 */
function sanitizeStatus(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
}

/** 第 3 行：` | ` 分隔扩展状态；空数组返回 null（整行隐藏） */
export function buildStatusLine(statuses: readonly string[]): string | null {
  if (statuses.length === 0) return null;
  return statuses.map(sanitizeStatus).join(" | ");
}

/** 家目录前缀缩写为 ~（仅目录边界匹配） */
export function shortenHome(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

/** 纯文本超宽截断并追加省略号 */
export function truncatePlain(text: string, width: number, ellipsis = "..."): string {
  if (text.length <= width) return text;
  return text.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis;
}

// ─── usage 累加 ─────────────────────────────────────────────────────

/** 会话条目的最小结构（与 Pi SessionEntry 兼容，仅取所需字段） */
export interface EntryLike {
  type: string;
  message?: {
    role: string;
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  };
}

/** 遍历会话条目累加 assistant usage；命中率取最后一条 assistant 消息 */
export function aggregateUsage(entries: readonly EntryLike[]): FooterStats {
  let input = 0;
  let output = 0;
  let cacheHitRate: number | undefined;
  for (const e of entries) {
    if (e.type !== "message" || e.message?.role !== "assistant" || !e.message.usage) continue;
    const u = e.message.usage;
    input += u.input;
    output += u.output;
    const promptTokens = u.input + u.cacheRead + u.cacheWrite;
    cacheHitRate = promptTokens > 0 ? (u.cacheRead / promptTokens) * 100 : undefined;
  }
  return { input, output, cacheHitRate };
}

// ─── 第 2 行左侧 ────────────────────────────────────────────────────

/**
 * 拼装第 2 行左侧统计：
 * `up.N | down.N | hit: N% | ctx/win: N%/W | [DING]`
 * 0 值项跳过；占用未知（null）时百分比显示 `?`
 */
export function buildStatsLeft(
  stats: FooterStats,
  ctxPercent: number | null,
  ctxWindow: number,
  ding: string,
): string {
  const parts: string[] = [];
  if (stats.input) parts.push(`up.${formatTokens(stats.input)}`);
  if (stats.output) parts.push(`down.${formatTokens(stats.output)}`);
  if (stats.cacheHitRate !== undefined) parts.push(`hit: ${stats.cacheHitRate.toFixed(1)}%`);
  const percentStr = ctxPercent === null ? "?" : `${ctxPercent.toFixed(1)}%`;
  parts.push(`ctx/win: ${percentStr}/${formatWindow(ctxWindow)}`);
  parts.push(ding);
  return parts.join(" | ");
}

// ─── ANSI 宽度与布局 ────────────────────────────────────────────────

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** 剥离 ANSI 转义码后的可见宽度 */
export function visibleWidth(text: string): number {
  return text.replace(ANSI_PATTERN, "").length;
}

/**
 * 左右两端对齐布局：宽度足够时中间补空格右对齐；
 * 不足时截断右侧（右侧为纯文本）；极窄时仅输出左侧。
 */
export function layoutLine(left: string, right: string, width: number): string {
  const minPadding = 2;
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);

  if (leftWidth + minPadding + rightWidth <= width) {
    return left + " ".repeat(width - leftWidth - rightWidth) + right;
  }

  const availableForRight = width - leftWidth - minPadding;
  if (availableForRight > 0) {
    const truncated = right.slice(0, availableForRight);
    return left + " ".repeat(minPadding) + truncated;
  }
  return left;
}
