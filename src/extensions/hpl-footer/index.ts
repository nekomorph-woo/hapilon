/**
 * hpl-footer — Pi TUI 状态栏定制扩展
 *
 * 通过 ctx.ui.setFooter() 全量接管 footer 渲染：
 *   第1行  工作目录 | 分支
 *   第2行  ↑ N ↓ N hit N% ctx N%/W [HOT]     模型名 • thinking 档位
 *   第3行  扩展状态（存在时）
 *
 * [HOT] 为上下文占用指示灯：背景色随占用率渐变 + 感叹号分级（见 ding.ts）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderDing } from "./ding.js";
import {
  aggregateUsage,
  buildLine1,
  buildQuotaSegment,
  buildStatsLeft,
  buildStatusLine,
  layoutLine,
  shortenHome,
  truncatePlain,
} from "./format.js";
import { readQuotaSnapshot } from "../hpl-quota-usage/cache.js";
import type { QuotaWindowSnapshot } from "../hpl-quota-usage/snapshot.js";

export default function hplFooter(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          // ── 第 1 行：工作目录 | 分支 ─────────────────────────
          const home = process.env.HOME || process.env.USERPROFILE;
          const cwd = shortenHome(ctx.sessionManager.getCwd(), home);
          const line1 = truncatePlain(buildLine1(cwd, footerData.getGitBranch()), width);

          // ── 第 2 行：统计 + [HOT] + 右侧模型信息 ────────────
          const stats = aggregateUsage(ctx.sessionManager.getEntries());
          const usage = ctx.getContextUsage();
          // 内置语义对齐：无 usage → 0%；usage.percent 为 null（压缩后未知）→ "?"
          const percent: number | null = usage === undefined ? 0 : usage.percent;
          const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const baseLeft = buildStatsLeft(stats, percent, window, renderDing(percent));

          // ── 限额段（模板 A）：18%/5h~2h 76%/wk~9d / ¥327 ─────────
          // 文件通道读缓存（模块隔离约束），缺失/过期静默无段。
          // provider 须与当前模型匹配（glm 系归并同一命名空间）——
          // 模型切换后旧 provider 的缓存不再展示；不支持的 provider 无段。
          const now = Date.now();
          const snapshot = readQuotaSnapshot(now);
          const QUOTA_NS = new Set(["zai", "zai-coding-cn"]);
          const currentQuotaKey = QUOTA_NS.has(ctx.model?.provider ?? "") ? "glm" : ctx.model?.provider;
          let quotaSegment = "";
          let quotaHot = false;
          let left = baseLeft;
          if (snapshot && snapshot.provider === currentQuotaKey) {
            const quotaWindows = snapshot.windows as QuotaWindowSnapshot[];
            quotaSegment = buildQuotaSegment(
              quotaWindows.map((w) => ({ percent: w.percent, window: w.window, resetAt: w.resetAt })),
              snapshot.balanceCny,
              now,
            );
            quotaHot = quotaWindows.some((w) => w.percent >= 90);
            if (quotaSegment) left = `${baseLeft} ${quotaSegment}`;
          }

          const modelName = ctx.model?.id ?? "no-model";
          // 模型支持思考时展示档位（与内置 footer 判断一致）
          const right = ctx.model?.reasoning
            ? `${modelName} • thinking ${pi.getThinkingLevel()}`
            : modelName;
          const line2 = layoutLine(left, right, width);

          // 分段 dim：[HOT] 自带真彩码且以复位结尾，整体包裹会被复位打断。
          // left 内 [HOT] 位于末尾，其复位不影响 left 前段；余下部分单独 dim。
          // 限额段 ≥90% 时用 warning 色替代 dim。
          let dimLeft = theme.fg("dim", left);
          let dimRemainder = theme.fg("dim", line2.slice(left.length));
          if (quotaSegment) {
            const head = left.slice(0, left.length - quotaSegment.length);
            dimLeft = theme.fg("dim", head) + theme.fg(quotaHot ? "warning" : "dim", quotaSegment);
            dimRemainder = theme.fg("dim", line2.slice(left.length));
          }

          const lines = [theme.fg("dim", line1), dimLeft + dimRemainder];

          // ── 第 3 行：扩展状态（存在时）──────────────────────
          const statuses = Array.from(footerData.getExtensionStatuses().entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => text);
          const line3 = buildStatusLine(statuses);
          if (line3 !== null) {
            lines.push(theme.fg("dim", truncatePlain(line3, width)));
          }

          return lines;
        },
      };
    });
  });
}
