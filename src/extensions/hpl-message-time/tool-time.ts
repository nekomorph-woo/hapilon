import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { formatClock, formatElapsed } from "../hpl-thinking-timer/timer.js";
import type { ThemeLike } from "./index.js";

/** ToolExecutionComponent 的最小接面（pi 未公开该类，按补丁里用到的字段接） */
export interface ToolComponent {
  executionStarted: boolean;
  isPartial: boolean;
  /** 完成后是 toolResult 消息：带耗时与结束时刻（历史消息回放靠它还原开始时刻） */
  result?: { durationMs?: number; timestamp?: number };
  outputPad: number;
}

/** 工具耗时：10 秒内带一位小数（读文件 0.2s 与 2.1s 要分得开），之后同思考计时 */
export function formatToolElapsed(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : formatElapsed(ms);
}

/**
 * 工具块顶部那一行：pi 原本放一个空行，工具开始执行后换成「开始时刻 · 耗时」，行数不变。
 * 每帧 render 时按组件状态刷新——流式期间 spinner 已在驱动重绘，不用自起定时器。
 */
export class ToolTimeLine extends Container {
  private readonly spacer = new Spacer(1);
  private readonly text: Text;
  private startAt: number | undefined;
  private lastText: string | undefined;

  constructor(
    private readonly comp: ToolComponent,
    private readonly style: (text: string) => string,
  ) {
    super();
    this.text = new Text("", comp.outputPad, 0);
    this.addChild(this.spacer);
    this.refresh();
  }

  private refresh(): void {
    const { comp } = this;
    const done = !comp.isPartial && comp.result !== undefined;
    // 参数还在流式、没开跑：保持空行
    if (!comp.executionStarted && !done) return;
    if (this.startAt === undefined) {
      if (!done) {
        this.startAt = Date.now();
      } else {
        // 回放的历史工具没有经过执行中状态：结束时刻减耗时
        const endAt = comp.result?.timestamp ?? (comp.executionStarted ? Date.now() : undefined);
        if (endAt === undefined) return;
        this.startAt = endAt - (comp.result?.durationMs ?? 0);
      }
    }
    const elapsed = done ? comp.result?.durationMs : Date.now() - this.startAt;
    const text = this.style(`${formatClock(this.startAt)}${elapsed === undefined ? "" : ` · ${formatToolElapsed(elapsed)}`}`);
    if (text === this.lastText) return;
    this.lastText = text;
    this.text.setText(text);
    this.clear();
    this.addChild(this.text);
  }

  override render(width: number): readonly string[] {
    this.refresh();
    return super.render(width);
  }
}

export function attachToolTime(theme: ThemeLike): (comp: ToolComponent) => ToolTimeLine {
  return (comp) => new ToolTimeLine(comp, (text) => theme.fg("dim", text));
}
