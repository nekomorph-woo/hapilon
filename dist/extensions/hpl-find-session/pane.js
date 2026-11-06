/**
 * pane.ts — /find-session 悬浮面板：输入 → 搜索 → 候选列表选择
 *
 * 列表态每条候选固定 4 行（时间行 + 2 行摘要 + 1 行空隔），选中项加竖线与
 * selectedBg 底色；查询固定在标题行、状态与快捷键各占面板内固定一行，
 * 总 render 行数受 index.ts overlay maxHeight 80% 约束，因此列表态在本类
 * 内 override render（不动共享 FloatingPane）。
 */
import { matchesKey, visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { FloatingPane } from "../../shared/floating-pane/index.js";
/** 每条候选占的行数：1 时间 + 2 摘要 + 1 空隔，固定不变（时间行截断不折行） */
const ITEM_LINES = 4;
export class FindSessionPane extends FloatingPane {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tuiInst;
    hooks;
    mode = "input";
    query = "";
    entries = [];
    sel = 0;
    statusLine = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(tui, theme, kb, done, hooks, initialQuery = "") {
        super(tui, theme, kb, done, { title: "找回会话", lines: [] });
        this.tuiInst = tui;
        this.hooks = hooks;
        if (initialQuery) {
            this.startSearch(initialQuery);
        }
        else {
            this.rebuild();
        }
    }
    rerender() {
        this.rebuild();
        this.tuiInst?.requestRender?.();
    }
    startSearch(query) {
        this.mode = "searching";
        this.query = query;
        this.statusLine = "";
        this.rebuild();
        this.hooks.onSearch(query, this);
    }
    /** 搜索结果回调：写入结果并切到列表态。 */
    setResults(entries, status) {
        this.entries = entries.slice(0, 15);
        this.sel = 0;
        this.mode = this.entries.length > 0 ? "list" : "input";
        this.statusLine = status;
        this.rerender();
    }
    /** 搜索过程进度状态行（仅 searching 态刷新文案，不动列表排版）。 */
    setStatus(status) {
        if (this.mode !== "searching")
            return;
        this.statusLine = status;
        this.rerender();
    }
    rebuild() {
        const th = this.theme;
        if (this.mode === "searching") {
            this.title = `找回会话 — 搜索中：${this.query}`;
            this.lines = [th.fg("muted", this.statusLine || "正在扫描会话并排序……")];
            this.footer = "esc 退出";
            return;
        }
        if (this.mode === "input") {
            this.title = "找回会话 — 用一句话描述要找的会话";
            this.lines = [
                `${th.fg("accent", "›")} ${this.query}▏`,
                th.fg("muted", "回车搜索 · esc 退出"),
                ...(this.statusLine ? ["", th.fg("warning", this.statusLine)] : []),
            ];
            this.footer = "";
            return;
        }
        // 列表态：查询固定在标题行；状态与快捷键由 render 画在面板底部固定行
        this.title = `找回会话 — ${this.query}`;
        this.lines = [];
        const textW = Math.max(8, this.innerW - 3); // 2 前导 + textW ≤ bodyW(innerW-1)，避免 render 二次截断
        const compact = this.innerW < 48;
        this.entries.forEach((item, index) => {
            const selected = index === this.sel;
            const time = truncateIfOver(formatTimes(item.entry, compact), Math.max(8, this.innerW - 2));
            const timeLine = `${selected ? th.fg("accent", "▌") : " "} ${th.fg(selected ? "accent" : "muted", time)}`;
            // 摘要完整保留，按显示宽度折行；真实溢出时末行以 … 省略
            const wrapped = wrapTextWithAnsi(item.summary, textW);
            const omitted = wrapped.length > 2;
            const shown = wrapped.slice(0, 2);
            if (omitted) {
                // 先预留省略号宽度再截断，避免末行恰好占满时只丢字不出省略号
                const last = shown[1];
                shown[1] = (visibleWidth(last) > textW - 1
                    ? truncateToWidth(last, textW - 1, "", true)
                    : last) + "…";
            }
            while (shown.length < 2)
                shown.push("");
            this.lines.push(timeLine);
            for (const line of shown) {
                this.lines.push(selected
                    ? this.selectedLine(`  ${line}`)
                    : `  ${th.fg("text", line)}`);
            }
            this.lines.push(""); // 固定空隔，条目间距稳定
        });
        this.footer = "";
    }
    /** 选中行：正文补齐到面板可用宽度后整体套低对比底色 */
    selectedLine(body) {
        const pad = Math.max(0, this.innerW - 1 - visibleWidth(body));
        return this.theme.bg("selectedBg", body + " ".repeat(pad));
    }
    statusRow(narrow) {
        const pos = `${this.sel + 1}/${this.entries.length}`;
        if (!this.statusLine)
            return pos;
        return narrow ? `${pos} ${this.statusLine}` : `${pos} · ${this.statusLine}`;
    }
    static keysRow(narrow) {
        // 窄列去分隔空格，保证 esc 等基本动作在极窄宽度仍完整可见
        return narrow ? "↑↓·回车·e·esc" : "↑↓ 选择 · 回车切换 · e 重输 · esc 退出";
    }
    /**
     * 列表态自绘：总行数 ≤ floor(rows*0.8)（index.ts overlay maxHeight），
     * 高度随 render 更新，选中项整条保持在可见窗口内；其余模式走基类。
     */
    render(width) {
        if (this.mode !== "list")
            return super.render(width);
        const th = this.theme;
        this.innerW = Math.max(1, Math.floor(width) - 2);
        const rows = this.tuiInst?.terminal?.rows ?? 40;
        // 以当前宽度重排条目；行内已保证不超宽，逐行截断兜底（不折行，保 ITEM_LINES）
        this.rebuild();
        const bodyW = Math.max(1, this.innerW - 1);
        const lines = this.lines.map((line) => visibleWidth(line) <= bodyW ? line : truncateToWidth(line, bodyW, "…", true));
        // chrome = 上下边框 + 状态行 + 快捷键行；预算不足时先砍固定行，正文至少 1 行
        const budget = Math.max(2, Math.floor(rows * 80 / 100));
        const chrome = 4;
        const degraded = budget < chrome + 1;
        const visibleRows = Math.max(1, degraded ? budget - 2 : budget - chrome);
        // 选中项（固定 ITEM_LINES 行）整条保持在可见窗口内
        const start = this.sel * ITEM_LINES;
        const bottom = start + ITEM_LINES - 1;
        if (this.scrollOffset > start)
            this.scrollOffset = start;
        if (bottom - this.scrollOffset >= visibleRows)
            this.scrollOffset = bottom - visibleRows + 1;
        this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, lines.length - visibleRows)));
        const visible = lines.slice(this.scrollOffset, this.scrollOffset + visibleRows);
        while (visible.length < visibleRows)
            visible.push("");
        const result = [];
        const titleStr = truncateToWidth(` ${this.title} `, this.innerW, "", true);
        const titleW = visibleWidth(titleStr);
        result.push(th.fg("border", "╭") + th.fg("accent", titleStr) +
            th.fg("border", "─".repeat(Math.max(0, this.innerW - titleW)) + "╮"));
        for (const line of visible) {
            const trimmed = truncateToWidth(line, this.innerW, "…", true);
            const padLen = this.innerW - visibleWidth(trimmed);
            result.push(th.fg("border", "│") + trimmed + " ".repeat(Math.max(0, padLen)) + th.fg("border", "│"));
        }
        // 面板内固定状态行/快捷键行，在闭合底边框之前
        if (!degraded) {
            const narrow = this.innerW < 40;
            for (const row of [this.statusRow(narrow), FindSessionPane.keysRow(narrow)]) {
                const trimmed = truncateToWidth(th.fg("muted", `  ${row}`), this.innerW, "…", true);
                const padLen = this.innerW - visibleWidth(trimmed);
                result.push(th.fg("border", "│") + trimmed + " ".repeat(Math.max(0, padLen)) + th.fg("border", "│"));
            }
        }
        result.push(th.fg("border", "╰" + "─".repeat(this.innerW) + "╯"));
        return result;
    }
    handleInput(data) {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
            this.doneCb();
            return true;
        }
        if (this.mode === "input") {
            if (matchesKey(data, "enter")) {
                if (this.query.trim())
                    this.startSearch(this.query.trim());
                return true;
            }
            if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
                this.query = this.query.slice(0, -1);
                this.rerender();
                return true;
            }
            // 粘贴：终端保证以括号粘贴序列整段到达；换行压成空格，控制字符剔除
            if (data.includes("\x1b[200~")) {
                const pasted = data.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
                this.query += pasted.replace(/[\r\n]+/g, " ").replace(/[\x00-\x1f]/g, "");
                this.rerender();
                return true;
            }
            // 可打印 ASCII 与常见中文（多字节整段到达）
            const printable = /^[\x20-\x7e\u00a0-\uffff]+$/.test(data) && !/[\x00-\x1f]/.test(data);
            if (printable) {
                this.query += data;
                this.rerender();
                return true;
            }
            return true;
        }
        if (this.mode === "searching") {
            return true;
        }
        // list
        if (matchesKey(data, "up") || data === "k") {
            this.sel = Math.max(0, this.sel - 1);
            this.rerender();
            return true;
        }
        if (matchesKey(data, "down") || data === "j") {
            this.sel = Math.min(this.entries.length - 1, this.sel + 1);
            this.rerender();
            return true;
        }
        if (matchesKey(data, "enter")) {
            const picked = this.entries[this.sel];
            if (picked) {
                this.doneCb();
                this.hooks.onPick(picked);
            }
            return true;
        }
        if (data === "e" || data === "/") {
            this.mode = "input";
            this.statusLine = "";
            this.rerender();
            return true;
        }
        return true;
    }
}
/** 只在真实超宽时截断（truncateToWidth 对短字符串会补空格到目标宽度，直接用会把时间行撑到溢出） */
function truncateIfOver(text, maxWidth) {
    return visibleWidth(text) > maxWidth ? truncateToWidth(text, maxWidth, "…", true) : text;
}
/** 创建/最后活动时间，带显式标签；两者跨年都带年份避免歧义，
 * 同年只显 MM-DD HH:mm。compact 用短标签适配窄列。
 */
function formatTimes(entry, compact) {
    const sameYear = entry.created.slice(0, 4) === entry.modified.slice(0, 4);
    const fmt = (iso) => iso.slice(sameYear ? 5 : 0, 16).replace("T", " ") || "?";
    const createdLabel = "创建 ";
    const modLabel = compact ? "活动 " : "最后活动 ";
    return `${createdLabel}${fmt(entry.created)} · ${modLabel}${fmt(entry.modified)}`;
}
