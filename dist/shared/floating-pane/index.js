/**
 * floating-pane/index.ts — 通用浮层组件入口
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import { FloatingPane } from "./pane.js";
export { FloatingPane } from "./pane.js";
export { OVERLAY_MOUSE_ON, MOUSE_OFF, SGR_MOUSE_RE, parseMouseEvent } from "./mouse.js";
/** ANSI 剥离后的可见宽度取整到终端偶数对齐（pi overlay 宽度按终端列数上限截断）。 */
export function fitContentWidth(lines, footer, termWidth, min = 20) {
    let widest = visibleWidth(footer ?? "");
    for (const line of lines)
        widest = Math.max(widest, visibleWidth(line));
    // 内容 + 左右 padding(2) + 边框(2)
    const content = widest + 4;
    // 超出终端宽会让 overlay 横向截断（顶边框右端被切、长行与 base 内容叠画）
    return Math.max(min, termWidth ? Math.min(content, termWidth) : content);
}
/**
 * 显示一个 FloatingPane overlay。
 * 封装 ctx.ui.custom() 调用，一行即可弹窗。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function showFloatingPane(ctx, options) {
    if (ctx.mode === "tui" && ctx.hasUI) {
        const termWidth = ctx.ui?.terminal?.columns
            ?? process.stdout.columns;
        const width = options.width === "fit-content"
            ? fitContentWidth(options.lines, options.footer, termWidth)
            : options.width ?? "90%";
        const custom = ctx.ui.custom;
        await custom((tui, theme, kb, done) => new FloatingPane(tui, theme, kb, done, options), {
            overlay: true,
            overlayOptions: {
                anchor: "center",
                width,
                maxHeight: `${options.maxHeight ?? 85}%`,
            },
        });
    }
    else {
        const text = [options.title, "─".repeat(40), ...options.lines].join("\n");
        if (typeof ctx.ui?.notify === "function") {
            ctx.ui.notify(text, "info");
        }
        else {
            console.log(text);
        }
    }
}
