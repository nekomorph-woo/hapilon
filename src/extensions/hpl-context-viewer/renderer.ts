/**
 * renderer.ts — /context 渲染器
 */

import type { ContextSnapshot } from "./types.js";

const BAR_WIDTH = 30;
const BLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

/**
 * used + free 双色进度条：█ = used, ░ = free
 */
export function renderBar(percent: number | null): string {
  if (percent === null || percent <= 0) return "░".repeat(BAR_WIDTH);
  if (percent >= 100) return "█".repeat(BAR_WIDTH);

  const exact = (percent / 100) * BAR_WIDTH;
  const fullBlocks = Math.floor(exact);
  const remainder = exact - fullBlocks;
  const partialIdx = Math.round(remainder * 8);

  const used = "█".repeat(fullBlocks) + (partialIdx > 0 ? BLOCKS[partialIdx]! : "");
  const free = "░".repeat(Math.max(0, BAR_WIDTH - fullBlocks - (partialIdx > 0 ? 1 : 0)));
  return used + free;
}

export function formatTokens(n: number | null): string {
  if (n === null || n === undefined) return "?";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function pct(n: number | null): string {
  if (n === null) return "?%";
  return `${n.toFixed(1)}%`;
}

// ── Main renderer ───────────────────────────────────────────────────────

export function renderContextLines(snapshot: ContextSnapshot): string[] {
  const lines: string[] = [];
  const win = snapshot.model.contextWindow;

  // ── Progress bar ────────────────────────────────────────────
  const bar = renderBar(snapshot.usage.percent);
  lines.push("");
  lines.push(`  ${bar}`);
  lines.push("");

  // ── Estimated usage ─────────────────────────────────────────
  const used = formatTokens(snapshot.usage.tokens);
  const total = formatTokens(win);
  const usedPct = snapshot.usage.percent !== null ? snapshot.usage.percent.toFixed(1) + "%" : "?%";
  lines.push(`  Estimated usage: ${used} / ${total} tokens  (${usedPct})`);
  lines.push("");

  // ── Breakdown ───────────────────────────────────────────────
  lines.push("  Category          Tokens     %");
  lines.push("  " + "─".repeat(36));
  for (const cat of snapshot.categories) {
    const label = cat.label.padEnd(16);
    const tk = formatTokens(cat.tokens).padStart(8);
    const pt = pct(cat.percent).padStart(8);
    lines.push(`  ${label}${tk}  ${pt}`);
  }
  lines.push("");

  // ── Tools ───────────────────────────────────────────────────
  const toolsCat = snapshot.categories.find((c) => c.label === "System tools");
  if (toolsCat?.items && toolsCat.items.length > 0) {
    lines.push(`  Tools (${toolsCat.items.length}):`);
    for (const t of toolsCat.items) {
      const name = t.name.replace(/^_/, "");
      lines.push(`    ${name.padEnd(22)} ${formatTokens(t.tokens)} tokens`);
    }
    lines.push("");
  }

  // ── Skills ──────────────────────────────────────────────────
  const skillsCat = snapshot.categories.find((c) => c.label === "Skills");
  if (skillsCat?.items && skillsCat.items.length > 0) {
    lines.push(`  Skills (${skillsCat.items.length}):`);
    for (const s of skillsCat.items) {
      lines.push(`    ${s.name.padEnd(22)} ${formatTokens(s.tokens)} tokens`);
    }
    lines.push("");
  }

  // ── Session ─────────────────────────────────────────────────
  if (snapshot.sessionStats) {
    const ss = snapshot.sessionStats;
    lines.push(`  Session: ${ss.userMessages}u + ${ss.assistantMessages}a msgs`);
    lines.push(`  Tokens: ${formatTokens(ss.tokens.input)} in / ${formatTokens(ss.tokens.output)} out / ${formatTokens(ss.tokens.total)} total`);
  }

  return lines;
}

export function renderContextText(snapshot: ContextSnapshot): string {
  return renderContextLines(snapshot).join("\n");
}
