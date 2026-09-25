/**
 * hpl-footer — Pi TUI 状态栏定制扩展
 *
 * 通过 ctx.ui.setFooter() 全量接管 footer 渲染（右侧优先：空间不足先截左段）：
 *   第1行  工作目录 | 分支                              限额段
 *   第2行  ↑ N ↓ N hit N% ctx N%/W [HOT]                模型名 • 档位
 *   第3行  扩展状态（存在时）
 *
 * [HOT] 为上下文占用指示灯：背景色随占用率渐变 + 感叹号分级（见 ding.ts）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dingLabel, renderDing } from "./ding.js";
import {
  aggregateUsage,
  buildLine1,
  buildModelRight,
  buildQuotaSegment,
  buildStatsLeft,
  buildStatusLine,
  layoutLineRight,
  shortenHome,
  truncatePlain,
} from "./format.js";
import { readQuotaSnapshotFor } from "../hpl-quota-usage/cache.js";
import { quotaNamespace } from "../hpl-quota-usage/snapshot.js";
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
          const home = process.env.HOME || process.env.USERPROFILE;
          const cwd = shortenHome(ctx.sessionManager.getCwd(), home);

          // ── 限额段（模板 A）：18%/5h~2h 76%/wk~9d / ¥327 ─────────
          // 文件通道读缓存（模块隔离约束），缺失/过期静默无段。
          // provider 须与当前模型匹配（glm 系归并同一命名空间）——
          // 模型切换后旧 provider 的缓存不再展示；不支持的 provider 无段。
          const now = Date.now();
          const currentQuotaKey = ctx.model?.provider ? quotaNamespace(ctx.model.provider) : undefined;
          let quotaSegment = "";
          let quotaHot = false;
          const snapshot = currentQuotaKey ? readQuotaSnapshotFor(currentQuotaKey, now) : undefined;
          if (snapshot) {
            const quotaWindows = snapshot.windows as QuotaWindowSnapshot[];
            quotaSegment = buildQuotaSegment(
              quotaWindows.map((w) => ({ percent: w.percent, window: w.window, resetAt: w.resetAt })),
              snapshot.balanceCny,
              now,
            );
            quotaHot = quotaWindows.some((w) => w.percent >= 90);
          }

          // ── 第 1 行：`cwd | branch`（左） · 限额段（右）──────────
          // 先按纯文本做右侧优先布局、再分段上色：ANSI 不参与截断，
          // 就不会把转义序列截成半截而污染后续行。
          const line1Plain = truncatePlain(
            layoutLineRight(buildLine1(cwd, footerData.getGitBranch()), quotaSegment, width),
            width,
          );
          const quotaIdx = quotaSegment ? line1Plain.lastIndexOf(quotaSegment) : -1;
          const quotaTail = quotaIdx < 0 ? "" : line1Plain.slice(quotaIdx + quotaSegment.length);
          const line1 = quotaIdx < 0
            ? theme.fg("dim", line1Plain)
            : theme.fg("dim", line1Plain.slice(0, quotaIdx))
              + theme.fg(quotaHot ? "warning" : "dim", quotaSegment)
              + (quotaTail ? theme.fg("dim", quotaTail) : "");

          // ── 第 2 行：统计 + [HOT]（左） · 模型名 • 档位（右）──────
          const stats = aggregateUsage(ctx.sessionManager.getEntries());
          const usage = ctx.getContextUsage();
          // 内置语义对齐：无 usage → 0%；usage.percent 为 null（压缩后未知）→ "?"
          const percent: number | null = usage === undefined ? 0 : usage.percent;
          const ctxWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          // [HOT] 先以纯文本入布局，布局后再单独换成真彩码——同第 1 行，避免 ANSI 被截断
          const dingText = dingLabel(percent);
          const leftPlain = buildStatsLeft(stats, percent, ctxWindow, dingText);
          // 模型支持思考时展示档位（与内置 footer 判断一致）；只留 level，去掉 "thinking " 前缀
          const rightPlain = buildModelRight(ctx.model, pi.getThinkingLevel());
          const line2Plain = truncatePlain(layoutLineRight(leftPlain, rightPlain, width), width);
          const dingIdx = line2Plain.indexOf(dingText);
          const dingTail = dingIdx < 0 ? "" : line2Plain.slice(dingIdx + dingText.length);
          const line2 = dingIdx < 0
            ? theme.fg("dim", line2Plain)
            : theme.fg("dim", line2Plain.slice(0, dingIdx))
              + renderDing(percent)
              + (dingTail ? theme.fg("dim", dingTail) : "");

          // 终极兜底：布局按可见宽度控制，ANSI 只由这里按段包裹，
          // 仍按可见宽度复核一次（truncatePlain 按 ANSI 感知宽度裁切）。
          const lines = [truncatePlain(line1, width), truncatePlain(line2, width)];

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
