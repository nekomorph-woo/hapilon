import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { formatClock, formatElapsed } from "../hpl-thinking-timer/timer.js";
const toMs = (ts) => new Date(ts).getTime();
/** 工具耗时：10 秒内带一位小数（读文件 0.2s 与 2.1s 要分得开），之后同思考计时 */
export function formatToolElapsed(ms) {
    return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : formatElapsed(ms);
}
/** 工具块那一行的文本：开始时刻 · 耗时；开跑前返回 undefined（保持空行） */
export function toolTimeText(comp, state, now = Date.now()) {
    const done = !comp.isPartial && comp.result !== undefined;
    if (!comp.executionStarted && !done)
        return undefined;
    if (state.startAt === undefined) {
        if (!done) {
            state.startAt = now;
        }
        else {
            // 回放的历史工具没有经过执行中状态：结束时刻减耗时
            const endAt = comp.result?.timestamp ?? (comp.executionStarted ? now : undefined);
            if (endAt === undefined)
                return undefined;
            state.startAt = toMs(endAt) - (comp.result?.durationMs ?? 0);
        }
    }
    const elapsed = done ? comp.result?.durationMs : now - state.startAt;
    return `${formatClock(state.startAt)}${elapsed === undefined ? "" : ` · ${formatToolElapsed(elapsed)}`}`;
}
/** 正文上方那一行：这条回复写完的时刻。流式期间不出；实时路径在写完后的第一帧记时刻 */
export function assistantTextTimeText(comp, state, now = Date.now()) {
    if (comp.timestamp !== undefined)
        state.doneAt ??= toMs(comp.timestamp);
    if (comp.isStreaming)
        return undefined;
    state.doneAt ??= now;
    return formatClock(state.doneAt);
}
/**
 * 空行与时间行二选一的一行：resolve 给出文本就换成暗色时间行，否则保持空行，行数不变。
 * 每帧 render 时重算——流式期间 spinner 已在驱动重绘，不用自起定时器。
 */
export class TimeLine extends Container {
    resolve;
    style;
    spacer = new Spacer(1);
    text;
    last;
    constructor(resolve, pad, style) {
        super();
        this.resolve = resolve;
        this.style = style;
        this.text = new Text("", pad, 0);
        this.addChild(this.spacer);
    }
    render(width) {
        const next = this.resolve();
        if (next !== this.last) {
            this.last = next;
            this.clear();
            if (next === undefined) {
                this.addChild(this.spacer);
            }
            else {
                this.text.setText(this.style(next));
                this.addChild(this.text);
            }
        }
        return super.render(width);
    }
}
/** 补丁调用的两个钩子：工具块顶部的空行、正文块上方的空行 */
export function attachStepTimes(theme) {
    const style = (text) => theme.fg("dim", text);
    // 计时状态跟着行节点走：节点在每个流式块都重建的子节点里按组件实例复用
    const line = (textOf) => (comp) => {
        const state = {};
        return new TimeLine(() => textOf(comp, state, Date.now()), comp.outputPad, style);
    };
    return { tool: line(toolTimeText), text: line(assistantTextTimeText) };
}
