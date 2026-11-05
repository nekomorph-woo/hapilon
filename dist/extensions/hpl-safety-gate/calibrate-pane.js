/**
 * calibrate-pane.ts — /calibrate-gate 阻塞面板：调参期间吞掉所有按键，
 * 跑完显示结果，按任意键关闭。
 */
import { FloatingPane } from "../../shared/floating-pane/index.js";
export class CalibratePane extends FloatingPane {
    finished = false;
    progressLines = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tuiInst;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(tui, theme, kb, done, title) {
        super(tui, theme, kb, done, { title, lines: ["启动中……"], footer: "" });
        this.tuiInst = tui;
        this.rebuild();
    }
    /** runTune 进度回调：追加一行并重画。 */
    update(line) {
        this.progressLines = [...this.progressLines, line].slice(-12);
        this.rebuild();
        this.tuiInst?.requestRender?.();
    }
    /** 调参结束：展示总结，放开关闭键。 */
    finish(summary) {
        this.progressLines = [...this.progressLines, "", ...summary].slice(-16);
        this.finished = true;
        this.rebuild();
        this.tuiInst?.requestRender?.();
    }
    handleInput(data) {
        if (this.finished) {
            this.doneCb();
            return true;
        }
        void data; // 未完成时吞掉一切按键（含 esc/ctrl+c）——调参不可中断
        return true;
    }
    rebuild() {
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
