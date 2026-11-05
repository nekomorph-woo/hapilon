/**
 * calibrate-pane.ts — /calibrate-gate 阻塞面板：调参期间吞掉所有按键，
 * 跑完显示结果，按任意键关闭。
 */

import { FloatingPane } from "../../shared/floating-pane/index.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

export class CalibratePane extends FloatingPane {
  private finished = false;
  private progressLines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tuiInst: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(tui: any, theme: Theme, kb: unknown, done: () => void, title: string) {
    super(tui, theme, kb, done, { title, lines: ["启动中……"], footer: "" });
    this.tuiInst = tui;
    this.rebuild();
  }

  /** runTune 进度回调：追加一行并重画。 */
  update(line: string): void {
    this.progressLines = [...this.progressLines, line].slice(-12);
    this.rebuild();
    this.tuiInst?.requestRender?.();
  }

  /** 调参结束：展示总结，放开关闭键。 */
  finish(summary: string[]): void {
    this.progressLines = [...this.progressLines, "", ...summary].slice(-16);
    this.finished = true;
    this.rebuild();
    this.tuiInst?.requestRender?.();
  }

  override handleInput(data: string): boolean {
    if (this.finished) {
      this.doneCb();
      return true;
    }
    void data; // 未完成时吞掉一切按键（含 esc/ctrl+c）——调参不可中断
    return true;
  }

  private rebuild(): void {
    const th = this.theme;
    this.title = "Calibrate Gate — 安全门判官调参";
    this.lines = [
      ...this.progressLines,
      "",
      this.finished ? th.fg("accent", "按任意键关闭") : th.fg("muted", "进行中……请稍候（此面板不可关闭）"),
    ];
    this.footer = "";
  }
}
