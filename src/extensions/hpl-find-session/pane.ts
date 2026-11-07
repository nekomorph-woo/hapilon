/**
 * pane.ts — /find-session 浮层面板：临时多轮小对话
 *
 * 与 RPC 子进程对话的主界面：滚动区渲染助手文本/工具进度/结果候选，
 * 固定输入行与状态行贴底。esc 在运行中停止当前轮（面板保留、可继续问），
 * 空闲时关闭面板（杀子进程清内存）；输入非空回车=发送，输入空回车=确认
 * 恢复选中的候选。渲染层复用 FloatingPane 的边框与滚动语义，只 override
 * render 以固定底部两行。
 */

import { matchesKey, visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { FloatingPane } from "../../shared/floating-pane/index.js";
import type { VerifiedResult } from "./rpc-session.js";

export interface ChatPaneHooks {
  onSend(text: string): void;
  onAbort(): void;
  /** 用户确认恢复某条候选；面板随即关闭，切换由父扩展执行 */
  onPick(result: VerifiedResult): void;
}

interface Entry {
  text: string;
  color?: ThemeColor;
}

const CHROME_ROWS = 5; // 上边框 + 输入行 + 状态行 + 快捷键行 + 下边框

export class SessionChatPane extends FloatingPane {
  private readonly hooks: ChatPaneHooks;
  private entries: Entry[] = [];
  private live = "";
  private input = "";
  private status = "子进程启动中…";
  private busy = false;
  private queued = 0;
  private candidates: VerifiedResult[] = [];
  private sel = 0;
  private follow = true;
  private toolLineIndex: number | null = null;
  private closed = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tuiInst: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(tui: any, theme: Theme, kb: unknown, done: () => void, hooks: ChatPaneHooks) {
    super(tui, theme, kb, done, { title: "找回会话", lines: [] });
    this.tuiInst = tui;
    this.hooks = hooks;
  }

  private rerender(): void {
    this.tuiInst?.requestRender?.();
  }

  // ── rpc 回调入口（index.ts 接线）；面板关闭后一律拒绝迟到更新 ──
  private accept(): boolean {
    return !this.closed;
  }

  onUserAccepted(text: string): void {
    if (!this.accept()) return;
    this.entries.push({ text: `你：${text}`, color: "accent" });
    this.busy = true;
    this.queued = 0;
    this.status = "思考中…";
    this.follow = true;
    this.rerender();
  }

  onAssistantDelta(delta: string): void {
    if (!this.accept()) return;
    this.live += delta;
    this.rerender();
  }

  onAssistantFinal(text: string): void {
    if (!this.accept()) return;
    this.live = text;
    this.rerender();
  }

  onToolStart(toolName: string, label: string): void {
    if (!this.accept()) return;
    this.flushLive();
    this.entries.push({ text: `⏺ ${toolName}${label ? ` ${label}` : ""}`, color: "muted" });
    this.toolLineIndex = this.entries.length - 1;
    this.status = `工具执行：${toolName}`;
    this.rerender();
  }

  onToolEnd(toolName: string, isError: boolean): void {
    if (!this.accept()) return;
    const index = this.toolLineIndex;
    if (index !== null && this.entries[index]) {
      this.entries[index] = {
        text: isError ? `⏺ ${toolName}（失败）` : `⏺ ${toolName}（完成）`,
        color: isError ? "error" : "muted",
      };
      this.toolLineIndex = null;
    }
    this.rerender();
  }

  onSettled(aborted: boolean): void {
    if (!this.accept()) return;
    this.flushLive();
    this.busy = false;
    this.queued = 0;
    this.status = aborted ? "已停止，可继续提问" : "完成，可继续提问";
    this.rerender();
  }

  onError(message: string): void {
    if (!this.accept()) return;
    this.entries.push({ text: `错误：${message}`, color: "error" });
    this.rerender();
  }

  onResults(results: VerifiedResult[]): void {
    if (!this.accept()) return;
    this.candidates = results;
    this.sel = 0;
    if (results.length === 0) {
      this.entries.push({ text: "无匹配结果（子进程已发布空结果）。", color: "warning" });
    } else {
      this.entries.push({ text: `已发布 ${results.length} 条候选，↑↓ 选择，输入留空按回车恢复。`, color: "warning" });
    }
    this.rerender();
  }

  onQueued(count: number): void {
    if (!this.accept()) return;
    this.queued = count;
    this.status = `运行中，已排队 ${count} 条`;
    this.rerender();
  }

  /** 关闭前由 index.ts 调用：杀子进程、清内存；此后所有更新被拒 */
  onClosed(): void {
    this.closed = true;
    this.entries = [];
    this.candidates = [];
    this.live = "";
  }

  private flushLive(): void {
    if (this.live.trim()) {
      this.entries.push({ text: this.live.replace(/\s+$/, "") });
    }
    this.live = "";
  }

  // ── 渲染 ─────────────────────────────────────────────────────────
  private buildLines(width: number): string[] {
    const th = this.theme;
    const textW = Math.max(8, this.innerW - 2);
    const lines: string[] = [];
    const push = (text: string, color?: ThemeColor): void => {
      for (const wrapped of wrapTextWithAnsi(color ? th.fg(color, text) : text, textW)) {
        lines.push(wrapped);
      }
    };
    for (const entry of this.entries) push(entry.text, entry.color);
    if (this.live) push(this.live.replace(/\s+$/, "") + "▏");
    if (this.candidates.length > 0) {
      push("", undefined);
      push("─ 候选 ─", "muted");
      this.candidates.forEach((candidate, index) => {
        const selected = index === this.sel;
        const color = selected ? "accent" : "muted";
        const marker = selected ? "▌" : " ";
        push(`${marker}${index + 1}. sessionId: ${candidate.sessionId}`, color);
        push(`  路径：${candidate.path}`);
        const evidenceLines = candidate.evidence.map((item) => item.line).join("、");
        if (evidenceLines) push(`  证据行：${evidenceLines}`, color);
        push(`  ${candidate.summary}`);
        push(`  匹配：${candidate.reason}`, color);
      });
    }
    void width;
    return lines;
  }

  render(width: number): string[] {
    const th = this.theme;
    this.innerW = Math.max(1, Math.floor(width) - 2);
    const rows: number = this.tuiInst?.terminal?.rows ?? 40;
    const bodyW = Math.max(1, this.innerW - 1);
    const content = this.buildLines(width);

    const budget = Math.max(CHROME_ROWS + 1, Math.floor(rows * 80 / 100));
    const visibleRows = budget - CHROME_ROWS;

    const wrapped: string[] = [];
    for (const line of content) {
      if (visibleWidth(line) <= bodyW) wrapped.push(line);
      else wrapped.push(...wrapTextWithAnsi(line, bodyW));
    }

    if (this.follow) this.scrollOffset = Math.max(0, wrapped.length - visibleRows);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, wrapped.length - 1)));
    const visible = wrapped.slice(this.scrollOffset, this.scrollOffset + visibleRows);
    while (visible.length < visibleRows) visible.push("");

    const result: string[] = [];
    const titleStr = truncateToWidth(` 找回会话 `, this.innerW, "", true);
    const titleW = visibleWidth(titleStr);
    result.push(
      th.fg("border", "╭") + th.fg("accent", titleStr) +
        th.fg("border", "─".repeat(Math.max(0, this.innerW - titleW)) + "╮"),
    );
    for (const line of visible) {
      const trimmed = truncateToWidth(line, this.innerW, "…", true);
      const padLen = this.innerW - visibleWidth(trimmed);
      result.push(th.fg("border", "│") + trimmed + " ".repeat(Math.max(0, padLen)) + th.fg("border", "│"));
    }

    const inputLine = `${th.fg("accent", "›")} ${this.input}▏`;
    const statusText = [this.status, this.queued > 0 ? `排队 ${this.queued}` : "", `${this.scrollOffset + 1}/${Math.max(wrapped.length, 1)}`]
      .filter(Boolean).join(" · ");
    for (const row of [inputLine, th.fg("muted", `  ${statusText}`), th.fg("muted", `  ${SessionChatPane.keysRow(this.busy)}`)]) {
      const trimmed = truncateToWidth(row, this.innerW, "…", true);
      const padLen = this.innerW - visibleWidth(trimmed);
      result.push(th.fg("border", "│") + trimmed + " ".repeat(Math.max(0, padLen)) + th.fg("border", "│"));
    }
    result.push(th.fg("border", "╰" + "─".repeat(this.innerW) + "╯"));
    return result;
  }

  private static keysRow(busy: boolean): string {
    return busy
      ? "esc 停止本轮 · ctrl+c 关闭"
      : "回车发送（输入空=恢复选中候选）· ↑↓ 选候选 · pgup/pgdn 翻看 · esc 关闭";
  }

  // ── 输入 ─────────────────────────────────────────────────────────
  handleInput(data: string): boolean {
    if (matchesKey(data, "ctrl+c")) {
      this.closePane();
      return true;
    }
    if (matchesKey(data, "escape")) {
      if (this.busy) this.hooks.onAbort();
      else this.closePane();
      return true;
    }
    if (matchesKey(data, "enter")) {
      const text = this.input.trim();
      if (text) {
        this.input = "";
        this.hooks.onSend(text);
      } else if (this.candidates[this.sel]) {
        const picked = this.candidates[this.sel];
        this.closePane();
        this.hooks.onPick(picked);
      }
      return true;
    }
    if (matchesKey(data, "up")) {
      if (this.candidates.length > 0) {
        this.sel = Math.max(0, this.sel - 1);
        this.rerender();
      }
      return true;
    }
    if (matchesKey(data, "down")) {
      if (this.candidates.length > 0) {
        this.sel = Math.min(this.candidates.length - 1, this.sel + 1);
        this.rerender();
      }
      return true;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) {
      this.follow = false;
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
      this.rerender();
      return true;
    }
    if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) {
      this.scrollOffset += 10;
      this.follow = true;
      this.rerender();
      return true;
    }
    if (matchesKey(data, "backspace") || matchesKey(data, "ctrl+h")) {
      this.input = this.input.slice(0, -1);
      this.rerender();
      return true;
    }
    // 粘贴：括号粘贴序列整段到达；换行压成空格，控制字符剔除
    if (data.includes("\x1b[200~")) {
      const pasted = data.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
      this.input += pasted.replace(/[\r\n]+/g, " ").replace(/[\x00-\x1f]/g, "");
      this.rerender();
      return true;
    }
    const printable = /^[\x20-\x7e\u00a0-\uffff]+$/.test(data) && !/[\x00-\x1f]/.test(data);
    if (printable) {
      this.input += data;
      this.rerender();
      return true;
    }
    return true;
  }

  private closePane(): void {
    this.onClosed();
    this.doneCb();
  }
}
