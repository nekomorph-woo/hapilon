/**
 * pane.ts — /find-session 悬浮面板：输入 → 搜索 → 候选列表选择
 */

import { matchesKey } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { FloatingPane } from "../../shared/floating-pane/index.js";
import type { RankedEntry } from "./rank.js";

export type PaneMode = "input" | "searching" | "list";

export interface FindSessionHooks {
  /** 发起搜索（粗滤 + 模型排序），完成后调 pane.setResults */
  onSearch: (query: string, pane: FindSessionPane) => void;
  /** 用户选中一条并回车；返回后面板自行关闭 */
  onPick: (entry: RankedEntry) => void;
}

export class FindSessionPane extends FloatingPane {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tuiInst: any;
  private hooks: FindSessionHooks;
  mode: PaneMode = "input";
  private query = "";
  private entries: RankedEntry[] = [];
  private sel = 0;
  private statusLine = "";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(tui: any, theme: Theme, kb: unknown, done: () => void, hooks: FindSessionHooks, initialQuery = "") {
    super(tui, theme, kb, done, { title: "Find Session", lines: [] });
    this.tuiInst = tui;
    this.hooks = hooks;
    if (initialQuery) {
      this.startSearch(initialQuery);
    } else {
      this.rebuild();
    }
  }

  private rerender(): void {
    this.rebuild();
    this.tuiInst?.requestRender?.();
  }

  private startSearch(query: string): void {
    this.mode = "searching";
    this.query = query;
    this.statusLine = "";
    this.rebuild();
    this.hooks.onSearch(query, this);
  }

  /** 搜索管线回调：写入结果并切到列表态。 */
  setResults(entries: RankedEntry[], status: string): void {
    this.entries = entries.slice(0, 15);
    this.sel = 0;
    this.mode = this.entries.length > 0 ? "list" : "input";
    this.statusLine = status;
    this.rerender();
  }

  private truncate(text: string, width: number): string {
    return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
  }

  private rebuild(): void {
    const th = this.theme;
    if (this.mode === "searching") {
      this.title = `Find Session — 搜索中：${this.query}`;
      this.lines = [th.fg("muted", "正在扫描会话并排序……")];
      this.footer = "esc 退出";
      return;
    }
    if (this.mode === "input") {
      this.title = "Find Session — 用一句话描述要找的会话";
      this.lines = [
        `${th.fg("accent", "›")} ${this.query}▏`,
        th.fg("muted", "回车搜索 · esc 退出"),
        ...(this.statusLine ? ["", th.fg("warning", this.statusLine)] : []),
      ];
      this.footer = "";
      return;
    }
    this.title = `Find Session — ${this.entries.length} 个候选（${this.query}）`;
    this.lines = this.entries.map((item, index) => {
      const selected = index === this.sel;
      const time = item.entry.modified.slice(0, 16).replace("T", " ");
      const cwd = item.entry.cwd.replace(/^\/Users\/[^/]+/, "~");
      const name = item.entry.name || item.entry.firstUser.slice(0, 24) || "(未命名)";
      const head = selected ? th.fg("accent", "▸ ") : "  ";
      return `${head}${time} ${this.truncate(cwd, 28)} ${this.truncate(name, 24)} · ${this.truncate(item.summary, 34)}`;
    });
    this.lines.push("", th.fg("muted", "↑/k ↓/j 选择 · 回车切换到该会话 · e 重新输入 · esc 退出"));
    if (this.statusLine) this.lines.push(th.fg("warning", this.statusLine));
    this.footer = "";
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.doneCb();
      return true;
    }
    if (this.mode === "input") {
      if (matchesKey(data, "enter")) {
        if (this.query.trim()) this.startSearch(this.query.trim());
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
