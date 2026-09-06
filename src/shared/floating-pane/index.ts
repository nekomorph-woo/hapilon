/**
 * floating-pane/index.ts — 通用浮层组件入口
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FloatingPane } from "./pane.js";
import type { FloatingPaneOptions } from "./options.js";

export { FloatingPane } from "./pane.js";
export type { FloatingPaneOptions } from "./options.js";
export { OVERLAY_MOUSE_ON, MOUSE_OFF, SGR_MOUSE_RE, parseMouseEvent } from "./mouse.js";

/** ANSI 剥离后的可见宽度取整到终端偶数对齐（pi overlay 宽度按终端列数上限截断）。 */
export function fitContentWidth(lines: string[], footer: string | undefined, min = 20): number {
  let widest = visibleWidth(footer ?? "");
  for (const line of lines) widest = Math.max(widest, visibleWidth(line));
  // 内容 + 左右 padding(2) + 边框(2)；宽度上限由 overlay 自身按终端截断
  return Math.max(min, widest + 4);
}

/**
 * 显示一个 FloatingPane overlay。
 * 封装 ctx.ui.custom() 调用，一行即可弹窗。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function showFloatingPane(ctx: any, options: FloatingPaneOptions): Promise<void> {
  if (ctx.mode === "tui" && ctx.hasUI) {
    const width = options.width === "fit-content"
      ? fitContentWidth(options.lines, options.footer)
      : options.width ?? "90%";
    const custom: Function = ctx.ui.custom;
    await custom(
      (tui: unknown, theme: Theme, kb: unknown, done: () => void) =>
        new FloatingPane(tui, theme, kb, done, options),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width,
          maxHeight: `${options.maxHeight ?? 85}%`,
        },
      },
    );
  } else {
    const text = [options.title, "─".repeat(40), ...options.lines].join("\n");
    if (typeof ctx.ui?.notify === "function") {
      ctx.ui.notify(text, "info");
    } else {
      console.log(text);
    }
  }
}
