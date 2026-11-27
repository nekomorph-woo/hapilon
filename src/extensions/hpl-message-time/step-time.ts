import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { formatClock, formatElapsed } from "../hpl-thinking-timer/timer.js";
import type { ThemeLike } from "./index.js";

/** ToolExecutionComponent 的最小接面（pi 未公开该类，按补丁里用到的字段接） */
export interface ToolComponent {
  executionStarted: boolean;
  isPartial: boolean;
  /** 完成后是 toolResult 消息：带耗时与结束时刻（历史消息回放靠它还原开始时刻） */
  result?: { durationMs?: number; timestamp?: number | string };
  outputPad: number;
}

/** AssistantMessageComponent 里正文时间行用到的字段 */
export interface AssistantTextComponent {
  isStreaming: boolean;
  outputPad: number;
  /** 回放路径才有：所在会话条目的时间戳（ISO 字串），即这条回复写完的时刻 */
  timestamp?: number | string;
}

/** 按组件实例保存的计时状态 */
export interface StepTimeState {
  startAt?: number;
  doneAt?: number;
}

const toMs = (ts: number | string): number => new Date(ts).getTime();

/** 工具耗时：10 秒内带一位小数（读文件 0.2s 与 2.1s 要分得开），之后同思考计时 */
export function formatToolElapsed(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : formatElapsed(ms);
}

/** 工具块那一行的文本：开始时刻 · 耗时；开跑前返回 undefined（保持空行） */
export function toolTimeText(comp: ToolComponent, state: StepTimeState, now = Date.now()): string | undefined {
  const done = !comp.isPartial && comp.result !== undefined;
  if (!comp.executionStarted && !done) return undefined;
  if (state.startAt === undefined) {
    if (!done) {
      state.startAt = now;
    } else {
      // 回放的历史工具没有经过执行中状态：结束时刻减耗时
      const endAt = comp.result?.timestamp ?? (comp.executionStarted ? now : undefined);
      if (endAt === undefined) return undefined;
      state.startAt = toMs(endAt) - (comp.result?.durationMs ?? 0);
    }
  }
  const elapsed = done ? comp.result?.durationMs : now - state.startAt;
  return `${formatClock(state.startAt)}${elapsed === undefined ? "" : ` · ${formatToolElapsed(elapsed)}`}`;
}

/** 正文上方那一行：这条回复写完的时刻。流式期间不出；实时路径在写完后的第一帧记时刻 */
export function assistantTextTimeText(comp: AssistantTextComponent, state: StepTimeState, now = Date.now()): string | undefined {
  if (comp.timestamp !== undefined) state.doneAt ??= toMs(comp.timestamp);
  if (comp.isStreaming) return undefined;
  state.doneAt ??= now;
  return formatClock(state.doneAt);
}

/**
 * 空行与时间行二选一的一行：resolve 给出文本就换成暗色时间行，否则保持空行，行数不变。
 * 每帧 render 时重算——流式期间 spinner 已在驱动重绘，不用自起定时器。
 */
export class TimeLine extends Container {
  private readonly spacer = new Spacer(1);
  private readonly text: Text;
  private last: string | undefined;

  constructor(
    private readonly resolve: () => string | undefined,
    pad: number,
    private readonly style: (text: string) => string,
  ) {
    super();
    this.text = new Text("", pad, 0);
    this.addChild(this.spacer);
  }

  override render(width: number): readonly string[] {
    const next = this.resolve();
    if (next !== this.last) {
      this.last = next;
      this.clear();
      if (next === undefined) {
        this.addChild(this.spacer);
      } else {
        this.text.setText(this.style(next));
        this.addChild(this.text);
      }
    }
    return super.render(width);
  }
}

type StepComponent = ToolComponent | AssistantTextComponent;

/** 补丁调用的两个钩子：工具块顶部的空行、正文块上方的空行 */
export function attachStepTimes(theme: ThemeLike): {
  tool: (comp: ToolComponent) => TimeLine;
  text: (comp: AssistantTextComponent) => TimeLine;
} {
  const style = (text: string) => theme.fg("dim", text);
  // 计时状态跟着行节点走：节点在每个流式块都重建的子节点里按组件实例复用
  const line =
    <T extends StepComponent>(textOf: (comp: T, state: StepTimeState, now: number) => string | undefined) =>
    (comp: T): TimeLine => {
      const state: StepTimeState = {};
      return new TimeLine(() => textOf(comp, state, Date.now()), comp.outputPad, style);
    };
  return { tool: line(toolTimeText), text: line(assistantTextTimeText) };
}
