/**
 * widget.ts — hpl-add-dir TUI 顶栏 widget 渲染（纯渲染）
 *
 * 在编辑器上方显示已添加的外部目录，宽度自适应防 TUI 溢出崩溃。
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
/**
 * 更新顶栏 widget。addedDirs 传引用，render 时读取最新内容。
 */
export function updateWidget(ctx, addedDirs) {
    if (!ctx.hasUI)
        return;
    if (addedDirs.length === 0) {
        ctx.ui.setWidget("add-dir", undefined);
        return;
    }
    ctx.ui.setWidget("add-dir", (_tui, theme) => {
        return {
            dispose() { },
            invalidate() { },
            render(width) {
                const prefix = theme.fg("accent", "📂");
                const count = theme.fg("muted", ` ${addedDirs.length} external dir${addedDirs.length === 1 ? "" : "s"}`);
                const sep = theme.fg("dim", " │ ");
                const suffix = theme.fg("dim", "  (/dirs to manage)");
                const dirLabels = addedDirs.map((d) => theme.fg("text", d.label)).join(theme.fg("dim", ", "));
                const fullLine = ` ${prefix}${count}${sep}${dirLabels}${suffix}`;
                const fullWidth = visibleWidth(fullLine);
                if (fullWidth <= width) {
                    return [fullLine];
                }
                // 截断目录标签以适配——保留 prefix/count/sep/suffix，收缩中间部分
                const withoutLabels = ` ${prefix}${count}${sep}`;
                const overhead = visibleWidth(withoutLabels) + visibleWidth(suffix);
                const available = width - overhead;
                if (available > 5) {
                    const truncatedLabels = truncateToWidth(dirLabels, available, "…");
                    return [`${withoutLabels}${truncatedLabels}${suffix}`];
                }
                // 极窄时仅显示数量
                const minimal = ` ${prefix}${count}`;
                return [truncateToWidth(minimal, width, "…")];
            },
        };
    });
}
