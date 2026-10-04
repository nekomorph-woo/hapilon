/**
 * list-picker.ts — 可搜索的列表选择器（ctx.ui.custom 实现）。
 *
 * pi 的 ctx.ui.select 是全量渲染的纯列表：接入几百个模型（如 pi-cursor-sdk）时，
 * 挂在列表末尾的「完成」在屏幕外翻不到（issue #66）。此组件对齐 pi 原生 /model
 * 选择器（ModelSelectorComponent）的交互：搜索框实时 fuzzyFilter、可视窗口滚动、
 * 「完成/取消」固定在列表上方不参与过滤。
 *
 * 无 TUI（print 模式等）回落 ctx.ui.select，并把完成项固定在列表顶部。
 */
import { Container, Input, Spacer, Text, fuzzyFilter, getKeybindings, } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
export class ListPickerComponent extends Container {
    tui;
    theme;
    done;
    title;
    options;
    doneLabel;
    searchInput;
    listContainer;
    filtered = [];
    /** 0 = 完成项（若有），1..n = filtered 的行号 */
    row = 0;
    closed = false;
    constructor(tui, theme, done, title, options, opts) {
        super();
        this.tui = tui;
        this.theme = theme;
        this.done = done;
        this.title = title;
        this.options = options;
        this.doneLabel = opts?.doneLabel;
        this.filtered = options;
        this.addChild(new DynamicBorder());
        this.addChild(new Spacer(1));
        this.addChild(new Text(this.theme.fg("accent", this.theme.bold(title)), 1, 0));
        this.addChild(new Spacer(1));
        this.searchInput = new Input();
        this.addChild(this.searchInput);
        this.addChild(new Spacer(1));
        this.listContainer = new Container();
        this.addChild(this.listContainer);
        this.addChild(new Spacer(1));
        this.addChild(new Text(this.theme.fg("dim", "  输入过滤 · ↑↓ 导航 · enter 选择 · esc 取消"), 1, 0));
        this.addChild(new Spacer(1));
        this.addChild(new DynamicBorder());
        this.redraw();
    }
    /** 供 TUI 焦点/IME 传导（与 pi 原生 ModelSelectorComponent 同款）。 */
    get focused() {
        return this.searchInput.focused;
    }
    set focused(value) {
        this.searchInput.focused = value;
    }
    get rowCount() {
        return (this.doneLabel ? 1 : 0) + this.filtered.length;
    }
    filter(query) {
        this.filtered = fuzzyFilter(this.options, query, (item) => item);
        this.row = 0;
        this.redraw();
    }
    redraw() {
        this.listContainer.clear();
        const maxVisible = 10;
        const start = Math.max(0, Math.min(this.row - Math.floor(maxVisible / 2), this.rowCount - maxVisible));
        const end = Math.min(start + maxVisible, this.rowCount);
        const drawRow = (line, text, selected) => {
            if (line < start || line >= end)
                return;
            const cursor = selected ? this.theme.fg("accent", "→ ") : "  ";
            this.listContainer.addChild(new Text(cursor + (selected ? this.theme.fg("accent", text) : this.theme.fg("text", text)), 1, 0));
        };
        let row = 0;
        if (this.doneLabel) {
            drawRow(row, `✓ ${this.doneLabel}`, this.row === row);
            row++;
        }
        for (const item of this.filtered) {
            drawRow(row, item, this.row === row);
            row++;
        }
        if (start > 0 || end < this.rowCount) {
            this.listContainer.addChild(new Text(this.theme.fg("muted", `  (${this.row + 1}/${this.rowCount})`), 1, 0));
        }
        if (this.filtered.length === 0 && !this.doneLabel) {
            this.listContainer.addChild(new Text(this.theme.fg("muted", "  无匹配模型"), 1, 0));
        }
    }
    close(result) {
        if (this.closed)
            return;
        this.closed = true;
        this.done(result);
    }
    handleInput(keyData) {
        if (this.closed)
            return;
        const kb = getKeybindings();
        if (kb.matches(keyData, "tui.select.cancel")) {
            this.close({ action: "cancel" });
        }
        else if (kb.matches(keyData, "tui.select.up")) {
            this.row = this.row === 0 ? this.rowCount - 1 : this.row - 1;
            this.redraw();
            this.tui.requestRender();
        }
        else if (kb.matches(keyData, "tui.select.down")) {
            this.row = this.row === this.rowCount - 1 ? 0 : this.row + 1;
            this.redraw();
            this.tui.requestRender();
        }
        else if (kb.matches(keyData, "tui.select.confirm")) {
            if (this.doneLabel && this.row === 0) {
                this.close({ action: "done" });
            }
            else {
                const value = this.filtered[this.row - (this.doneLabel ? 1 : 0)];
                if (value !== undefined)
                    this.close({ action: "select", value });
            }
        }
        else {
            this.searchInput.handleInput(keyData);
            this.filter(this.searchInput.getValue());
            this.tui.requestRender();
        }
    }
}
export async function pickFromList(ctx, title, options, doneLabel) {
    if (options.length === 0)
        return undefined;
    try {
        const result = await ctx.ui.custom((tui, theme, _keybindings, done) => new ListPickerComponent(tui, theme, done, title, options, { doneLabel }));
        if (!result || result.action === "cancel")
            return undefined;
        if (result.action === "done")
            return null;
        return result.value;
    }
    catch {
        // 无 TUI（print 模式）：ctx.ui.custom 不可用，回落纯列表，完成项固定在顶部
        const selected = await ctx.ui.select(title, doneLabel ? [doneLabel, ...options] : [...options]);
        if (selected === undefined)
            return undefined;
        if (doneLabel && selected === doneLabel)
            return null;
        return selected;
    }
}
