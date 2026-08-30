/**
 * overlay.ts — /context TUI overlay 组件
 *
 * 使用 pi-tui Component 接口（duck-typing）创建全屏浮层。
 * 填满终端全高防止 Pi 自身 UI 元素透过。
 * 按任意键关闭。
 *
 * 设计来源: _plans/hpl-context-viewer.md §3
 */
import { renderContextLines } from "./renderer.js";
export class ContextOverlay {
    done;
    contentLines;
    hint;
    tuiRef;
    constructor(snapshot, tui, theme, done) {
        this.done = done;
        this.tuiRef = tui;
        const rawLines = renderContextLines(snapshot);
        // dim 主题色，标题用 accent
        this.contentLines = rawLines.map((line) => {
            if (line.trim().length === 0)
                return "";
            if (line.includes("Context Usage"))
                return theme.fg("accent", line);
            return theme.fg("dim", line);
        });
        this.hint = theme.fg("accent", "  Press any key to close");
    }
    handleKey(_key) {
        this.done();
        return true;
    }
    get isFocusable() {
        return true;
    }
    invalidate() { }
    /** 获取终端行数（若可用）；否则 fallback 0 不做填充 */
    getTerminalRows() {
        return this.tuiRef?.terminal?.rows ?? 0;
    }
    render(width) {
        const result = [];
        const termRows = this.getTerminalRows();
        // 顶部留白 2 行
        result.push("", "");
        // 居中标题
        const title = " ═══ Hapilon Context ═══ ";
        const padLeft = Math.max(0, Math.floor((width - visibleWidth(title)) / 2));
        result.push(" ".repeat(padLeft) + title);
        result.push("");
        // 主体内容
        for (const line of this.contentLines) {
            result.push(line.length > width ? line.substring(0, width) : line);
        }
        result.push("");
        result.push(this.hint);
        // 填充剩余行，防止 Pi UI 元素透过
        const usedRows = result.length;
        if (termRows > usedRows) {
            for (let i = usedRows; i < termRows; i++) {
                result.push("");
            }
        }
        return result;
    }
}
function visibleWidth(s) {
    return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
