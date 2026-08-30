/**
 * viewer.ts — 面板查看器 overlay 组件
 *
 * 继承 FloatingPane，覆盖 getContent() 来从 TUI component tree 读取面板渲染内容。
 * 支持面板切换（← →）、实时同步（sync）、mouse wheel 滚动。
 */
import { visibleWidth, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { FloatingPane } from "../../shared/floating-pane/index.js";
import { OVERLAY_MOUSE_ON, MOUSE_OFF } from "../../shared/floating-pane/index.js";
import { state } from "./shared.js";
import { navigableExpandables, panelTitle, panelContent, } from "./panels.js";
export class PanelViewer extends FloatingPane {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tuiInst;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    panels = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pinned = null;
    sel = 0;
    titles = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(tui, theme, _kb, done, target) {
        super(tui, theme, _kb, done, { title: "", lines: ["loading..."] });
        this.tuiInst = tui;
        this.pinned = target ?? null;
        this.sync();
        if (target) {
            const idx = this.panels.indexOf(target);
            this.sel = idx >= 0 ? idx : Math.max(0, this.panels.length - 1);
        }
        else {
            this.sel = Math.max(0, this.panels.length - 1);
        }
        state.activeViewer = this;
        tui.terminal.write(OVERLAY_MOUSE_ON);
    }
    /** 实时同步面板列表，按对象引用保持选中 */
    sync() {
        const current = this.panels[this.sel] ?? null;
        this.panels = navigableExpandables(this.tuiInst);
        if (this.pinned && !this.panels.includes(this.pinned))
            this.panels.push(this.pinned);
        this.titles = this.panels.map((p) => panelTitle(p, this.tuiInst.terminal.columns));
        const idx = current ? this.panels.indexOf(current) : -1;
        this.sel = idx >= 0 ? idx : Math.min(this.sel, Math.max(0, this.panels.length - 1));
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleInput(data) {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
            this.close();
            return true;
        }
        this.sync();
        if (!this.panels.length)
            return false;
        if (matchesKey(data, "left") || data === "h") {
            this.sel = (this.sel - 1 + this.panels.length) % this.panels.length;
            this.scrollOffset = 0;
            this.tuiInst.requestRender();
            return true;
        }
        if (matchesKey(data, "right") || data === "l") {
            this.sel = (this.sel + 1) % this.panels.length;
            this.scrollOffset = 0;
            this.tuiInst.requestRender();
            return true;
        }
        // 其余委托 FloatingPane（↑↓ 滚动等）
        return super.handleInput(data);
    }
    render(width) {
        this.sync();
        const th = this.theme;
        this.innerW = Math.max(20, width - 2);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.visibleRows = Math.max(6, Math.floor((this.tuiInst.terminal?.rows ?? 40) * 0.85) - 4);
        const border = (c) => th.fg("border", c);
        const row = (s) => border("│") + truncateToWidth(s, this.innerW, "…", true) + border("│");
        const out = [];
        const pos = this.panels.length ? `${this.sel + 1}/${this.panels.length}` : "0/0";
        const title = this.panels.length ? this.titles[this.sel] ?? "(panel)" : "no expandable panels";
        const head = ` ${pos}  ${title} `;
        const dash = Math.max(0, this.innerW - visibleWidth(head));
        out.push(border("╭") + th.fg("accent", head) + border("─".repeat(dash) + "╮"));
        // 从 TUI panel 读取渲染后内容
        const raw = this.panels.length
            ? panelContent(this.panels[this.sel], this.tuiInst.terminal.columns)
            : [];
        const content = [];
        for (const line of raw) {
            const trimmed = line.replace(/\s+((?:\x1b\[[0-9;]*m)*)$/, "$1");
            const parts = wrapTextWithAnsi(trimmed, this.innerW - 1);
            if (parts.length === 0)
                content.push("");
            else
                for (const p of parts)
                    content.push(p);
        }
        this.wrappedLines = content;
        const maxScroll = Math.max(0, content.length - this.visibleRows);
        if (this.scrollOffset > maxScroll)
            this.scrollOffset = maxScroll;
        const slice = content.slice(this.scrollOffset, this.scrollOffset + this.visibleRows);
        for (const line of slice)
            out.push(row(" " + line));
        for (let i = slice.length; i < this.visibleRows; i++)
            out.push(row(""));
        const range = content.length > this.visibleRows
            ? `   ${this.scrollOffset + 1}-${Math.min(content.length, this.scrollOffset + this.visibleRows)}/${content.length}`
            : "";
        out.push(border("│") +
            th.fg("dim", truncateToWidth(` ←/→ panel   ↑↓ scroll   shift+↑↓ page   esc close${range}`, this.innerW, "…", true)) +
            border("│"));
        out.push(border("╰" + "─".repeat(this.innerW) + "╯"));
        return out;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    close() {
        state.activeViewer = null;
        this.tuiInst.terminal.write(MOUSE_OFF);
        this.doneCb();
    }
    dispose() {
        if (state.activeViewer === this)
            state.activeViewer = null;
        this.tuiInst?.terminal?.write(MOUSE_OFF);
    }
}
/**
 * 打开 viewer overlay。
 * 与 pi-pop 的 launchViewer 相同：使用 ctx.ui.custom()。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function launchViewer(ui, target) {
    if (state.viewerOpen || typeof ui?.custom !== "function")
        return;
    state.viewerOpen = true;
    ui.custom((tui, theme, _kb, done) => new PanelViewer(tui, theme, _kb, done, target), {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: "85%" },
    }).finally(() => { state.viewerOpen = false; });
}
