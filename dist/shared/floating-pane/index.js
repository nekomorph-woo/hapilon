/**
 * floating-pane/index.ts — 通用浮层组件入口
 */
import { FloatingPane } from "./pane.js";
export { FloatingPane } from "./pane.js";
export { OVERLAY_MOUSE_ON, MOUSE_OFF, SGR_MOUSE_RE, parseMouseEvent } from "./mouse.js";
/**
 * 显示一个 FloatingPane overlay。
 * 封装 ctx.ui.custom() 调用，一行即可弹窗。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function showFloatingPane(ctx, options) {
    if (ctx.mode === "tui" && ctx.hasUI) {
        const custom = ctx.ui.custom;
        await custom((tui, theme, kb, done) => new FloatingPane(tui, theme, kb, done, options), {
            overlay: true,
            overlayOptions: {
                anchor: "center",
                width: options.width ?? "90%",
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
