/**
 * pane.ts — FloatingPane 核心类
 *
 * 实现 pi-tui Component 接口 (duck-typing)：
 *   render(width) → string[], handleInput(data) → boolean,
 *   isFocusable, invalidate
 */

import { visibleWidth, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FloatingPaneOptions } from "./options.js";

export class FloatingPane {
  protected theme: Theme;
  protected lines: string[];
  protected title: string;
  protected footer: string;
  protected doneCb: () => void;

  protected scrollOffset = 0;
  protected innerW = 60;
  protected visibleRows = 20;
  private termRows = 40;

  protected wrappedLines: string[] = [];

  constructor(
    _tui: unknown,
    theme: Theme,
    _keybindings: unknown,
    done: () => void,
    options: FloatingPaneOptions,
  ) {
    this.theme = theme;
    this.lines = options.lines.length > 0 ? options.lines : ["No content"];
    this.title = options.title;
    this.footer = options.footer ?? "";
    this.doneCb = done;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.termRows = (_tui as any)?.terminal?.rows ?? 40;
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")) {
      this.doneCb();
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

  get isFocusable(): boolean {
    return true;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const th = this.theme;
    this.innerW = Math.max(20, width - 2);
    this.visibleRows = Math.max(6, Math.floor(this.termRows * 0.85) - 4);

    this.wrappedLines = [];
    for (const line of this.lines) {
      const plainLen = visibleWidth(line);
      if (plainLen <= this.innerW - 1) {
        this.wrappedLines.push(line);
      } else {
        const wrapped = wrapTextWithAnsi(line, this.innerW - 1);
        this.wrappedLines.push(...wrapped);
      }
    }

    const maxScroll = Math.max(0, this.wrappedLines.length - this.visibleRows);
    if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;

    const visible = this.wrappedLines.slice(
      this.scrollOffset, this.scrollOffset + this.visibleRows,
    );
    while (visible.length < this.visibleRows) visible.push("");

    const result: string[] = [];

    const titleStr = ` ${this.title} `;
    const titleW = visibleWidth(titleStr);
    result.push(
      th.fg("border", "╭") +
        th.fg("accent", titleStr) +
        th.fg("border", "─".repeat(Math.max(0, this.innerW - titleW)) + "╮"),
    );

    for (const line of visible) {
      const trimmed = truncateToWidth(line, this.innerW, "…", true);
      const padLen = this.innerW - visibleWidth(trimmed);
      result.push(
        th.fg("border", "│") + trimmed +
          " ".repeat(Math.max(0, padLen)) + th.fg("border", "│"),
      );
    }

    result.push(
      th.fg("border", "╰" + "─".repeat(this.innerW) + "╯"),
    );

    if (this.footer) {
      result.push(th.fg("dim", `  ${truncateToWidth(this.footer, width, "…", true)}`));
    }

    return result;
  }

  protected scrollUp(amount: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - amount);
  }

  scrollBy(n: number): void {
    const maxScroll = Math.max(0, this.wrappedLines.length - this.visibleRows);
    this.scrollOffset = Math.max(0, Math.min(maxScroll, this.scrollOffset + n));
  }

  protected scrollDown(amount: number): void {
    this.scrollBy(amount);
  }

  private scrollMax(): void {
    this.scrollOffset = Math.max(0, this.wrappedLines.length - this.visibleRows);
  }
}
