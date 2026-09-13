/**
 * format.ts — hpl-footer 文本拼装纯函数
 *
 * usage 累加、token/窗口格式化、三行文本构建、宽度布局。
 */

import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

// 宽度一律以 pi-tui 的表为准：判定「渲染行超宽 → 中止进程」的就是它，
// 自带一张表必然漂移（⏳/⚡/⭐ 等 emoji 表现形曾被记 1 列，状态行因此超宽崩溃）。
export { visibleWidth };

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

/** 重置倒计时：~45m / ~2h / ~6d（不足 1 分钟显示 <1m） */
export function formatResetCountdown(remainingMs: number): string {
  const minutes = Math.floor(remainingMs / 60000);
  if (minutes < 1) return "~<1m";
  if (minutes < 60) return `~${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 > 0 ? `~${hours}h${minutes % 60}m` : `~${hours}h`;
  return `~${Math.floor(hours / 24)}d`;
}

export interface FooterQuotaWindow {
  /** 已用百分比 */
  percent: number;
  /** 窗口标签（snapshot 已格式化：5h / mo / wk） */
  window?: string;
  /** 重置时刻 epoch ms */
  resetAt?: number;
}

/**
 * footer 限额段："18%/5h~2h 76%/mo~9d"（窗口标签缺失退化为 "18%"）。
 * 余额型（deepseek）走 balance 模板。
 */
export function buildQuotaSegment(
  windows: FooterQuotaWindow[],
  balance: string | undefined,
  now: number,
): string {
  if (balance !== undefined) return `¥${balance}`;
  return windows
    .map((w) => {
      const base = w.window !== undefined
        ? `${Math.round(w.percent)}%/${w.window}`
        : `${Math.round(w.percent)}%`;
      if (w.resetAt === undefined || w.resetAt <= now) return base;
      return `${base}${formatResetCountdown(w.resetAt - now)}`;
    })
    .join(" ");
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

/** 纯文本超宽按可见宽度截断并追加省略号 */
export function truncatePlain(text: string, width: number, ellipsis = "..."): string {
  if (visibleWidth(text) <= width) return text;
  const avail = width - visibleWidth(ellipsis);
  // 窄到装不下省略号时不加：宁可少提示，也不能吐出一条超宽行（TUI 直接中止）
  if (avail <= 0) return truncateByWidth(text, width);
  return truncateByWidth(text, avail) + ellipsis;
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
 * 拼装第 2 行左侧统计（符号流布局）：
 * `↑ N ↓ N hit N% ctx N%/W [HOT]`
 * 0 值项跳过；占用未知（null）时百分比显示 `?`
 */
export function buildStatsLeft(
  stats: FooterStats,
  ctxPercent: number | null,
  ctxWindow: number,
  ding: string,
): string {
  const parts: string[] = [];
  if (stats.input) parts.push(`↑ ${formatTokens(stats.input)}`);
  if (stats.output) parts.push(`↓ ${formatTokens(stats.output)}`);
  if (stats.cacheHitRate !== undefined) parts.push(` • hit ${stats.cacheHitRate.toFixed(1)}%`);
  const percentStr = ctxPercent === null ? "?" : `${ctxPercent.toFixed(1)}%`;
  parts.push(` • ctx ${percentStr}/${formatWindow(ctxWindow)}`);
  parts.push(ding);
  return parts.join(" ");
}

// ─── ANSI 宽度与布局 ────────────────────────────────────────────────

/** 按可见宽度截断为前缀子串（不含省略号），宽字符不切半 */
function truncateByWidth(text: string, width: number): string {
  return visibleWidth(text) <= width ? text : sliceByColumn(text, 0, width, true);
}

/**
 * 左右两端对齐布局：宽度足够时中间补空格右对齐；
 * 不足时按可见宽度截断右侧（右侧为纯文本）；left 本身超宽时截断 left——
 * 不截断会让 pi TUI 以 "Rendered line exceeds terminal width" 直接崩溃
 * （team 模式的窄分割面板实测触发）。
 */
export function layoutLine(left: string, right: string, width: number): string {
  const minPadding = 2;
  let leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);

  if (leftWidth + minPadding + rightWidth <= width) {
    return left + " ".repeat(width - leftWidth - rightWidth) + right;
  }

  if (leftWidth + minPadding > width) {
    left = truncateByWidth(left, Math.max(0, width - minPadding));
    leftWidth = visibleWidth(left);
  }

  const availableForRight = width - leftWidth - minPadding;
  if (availableForRight > 0) {
    return left + " ".repeat(minPadding) + truncateByWidth(right, availableForRight);
  }
  return left;
}
