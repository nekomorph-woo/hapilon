/**
 * floating-pane.ts — hapilon 通用浮层组件
 *
 * 借鉴 pi-pop 的 viewer.ts 和 Pi overlay-qa-tests 的 BaseOverlay.box()：
 * - Unicode 边框 (╭─╮│╰─╯) + pi-tui theme 颜色
 * - ↑↓/PgUp/PgDn/Home/End 滚动
 * - 长行自动换行 (wrapTextWithAnsi)
 * - 静态 show() 方法封装 ctx.ui.custom() 调用
 *
 * 任何 hapilon 扩展只需 import { FloatingPane } 即可复用。
 *
 * 设计来源: _plans/hpl-floating-pane.md
 */
import { visibleWidth, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
// ── Component ───────────────────────────────────────────────────────────
/**
 * 通用浮层组件。
 * 实现 pi-tui Component 接口 (duck-typing)：
 *   render(width) → string[], handleInput(data) → boolean,
 *   isFocusable, invalidate
 */
export class FloatingPane {
    theme;
    lines;
    title;
    footer;
    done;
    scrollOffset = 0;
    innerW = 60;
    visibleRows = 20;
    termRows = 40;
    wrappedLines = [];
    constructor(_tui, theme, _keybindings, done, options) {
        this.theme = theme;
        this.lines = options.lines.length > 0 ? options.lines : ["No content"];
        this.title = options.title;
        this.footer = options.footer ?? "";
        this.done = done;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.termRows = _tui?.terminal?.rows ?? 40;
    }
    // ── Component 接口 ─────────────────────────────────────────────────
    handleInput(data) {
        if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")) {
            this.done();
            return true;
        }
        if (matchesKey(data, "up") || data === "k") {
            this.scrollUp(1);
            return true;
        }
        if (matchesKey(data, "down") || data === "j") {
            this.scrollDown(1);
            return true;
        }
        if (matchesKey(data, "shift+up") || data === "b") {
            this.scrollUp(this.visibleRows);
            return true;
        }
        if (matchesKey(data, "shift+down") || data === " ") {
            this.scrollDown(this.visibleRows);
            return true;
        }
        if (data === "g") {
            this.scrollOffset = 0;
            return true;
        }
        if (data === "G") {
            this.scrollMax();
            return true;
        }
        return false;
    }
    get isFocusable() {
        return true;
    }
    invalidate() { }
    render(width) {
        const th = this.theme;
        this.innerW = Math.max(20, width - 2);
        // 85% 终端高度 - 边框 overhead (top border 1 + bottom border 1 + footer 1 + padding 1)
        this.visibleRows = Math.max(6, Math.floor(this.termRows * 0.85) - 4);
        // 长行换行
        this.wrappedLines = [];
        for (const line of this.lines) {
            // 先 strip ANSI 判断是否需要换行，再用 ANSI-aware wrap
            const plainLen = visibleWidth(line);
            if (plainLen <= this.innerW - 1) {
                this.wrappedLines.push(line);
            }
            else {
                const wrapped = wrapTextWithAnsi(line, this.innerW - 1);
                this.wrappedLines.push(...wrapped);
            }
        }
        const maxScroll = Math.max(0, this.wrappedLines.length - this.visibleRows);
        if (this.scrollOffset > maxScroll)
            this.scrollOffset = maxScroll;
        const visible = this.wrappedLines.slice(this.scrollOffset, this.scrollOffset + this.visibleRows);
        // 填充空白行
        while (visible.length < this.visibleRows) {
            visible.push("");
        }
        const result = [];
        // 顶部边框 + 标题
        const titleStr = ` ${this.title} `;
        const titleW = visibleWidth(titleStr);
        const topLeft = th.fg("border", "╭");
        const topRight = th.fg("border", "╮");
        const topFill = th.fg("border", "─".repeat(Math.max(0, this.innerW - titleW)));
        result.push(topLeft + th.fg("accent", titleStr) + topFill + topRight);
        // 内容行
        for (const line of visible) {
            const trimmed = truncateToWidth(line, this.innerW, "…", true);
            const padLen = this.innerW - visibleWidth(trimmed);
            result.push(th.fg("border", "│") + trimmed + " ".repeat(Math.max(0, padLen)) + th.fg("border", "│"));
        }
        // 底部边框
        const bottomLeft = th.fg("border", "╰");
        const bottomRight = th.fg("border", "╯");
        const bottomFill = th.fg("border", "─".repeat(this.innerW));
        result.push(bottomLeft + bottomFill + bottomRight);
        // Footer
        if (this.footer) {
            result.push(th.fg("dim", `  ${truncateToWidth(this.footer, width, "…", true)}`));
        }
        return result;
    }
    // ── 滚动 ───────────────────────────────────────────────────────────
    scrollUp(amount) {
        this.scrollOffset = Math.max(0, this.scrollOffset - amount);
    }
    scrollDown(amount) {
        const maxScroll = Math.max(0, this.wrappedLines.length - this.visibleRows);
        this.scrollOffset = Math.min(maxScroll, this.scrollOffset + amount);
    }
    scrollMax() {
        this.scrollOffset = Math.max(0, this.wrappedLines.length - this.visibleRows);
    }
    // ── 静态入口 ───────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static async show(ctx, options) {
        if (ctx.mode === "tui" && ctx.hasUI) {
            // 用 any 绕过 generic 类型限制
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
            // 非 TUI fallback — 优先 notify，不可用时降级 console.log
            const text = [options.title, "─".repeat(40), ...options.lines].join("\n");
            if (typeof ctx.ui?.notify === "function") {
                ctx.ui.notify(text, "info");
            }
            else {
                console.log(text);
            }
        }
    }
}
