import { Text } from "@earendil-works/pi-tui";

/** 单条思考折叠块的计时状态（按消息内 run 序号挂在组件实例上） */
export interface ThinkingRun {
  start: number;
  end?: number;
  /** 历史消息（从未流式）不计时，只显示原标签 */
  timed: boolean;
  node?: Text;
  /** 上次写入节点的完整文本（Text.text 在类型里是 private，用 run 自己记） */
  lastText?: string;
}

/** AssistantMessageComponent 的最小接面（pi 未公开该类，按补丁里用到的字段接） */
export interface ThinkingComponent {
  isStreaming: boolean;
  hiddenThinkingLabel: string;
  outputPad: number;
  timestamp?: number | string;
  lastMessage?: { timestamp?: number | string };
  __hapiThinkingRuns?: Map<number, ThinkingRun>;
}

/** pi 主题的最小接面：折叠标签用的同一组样式（斜体 + thinkingText 前景色） */
export interface ThinkingStyle {
  fg(slot: string, text: string): string;
  italic(text: string): string;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 本地时间 HH:mm:ss；pi 的时刻实时路径给 ISO 字串，回放路径给毫秒数 */
export function formatClock(ts: number | string): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 产出补丁（assistant-message.js）调用的两个 globalThis 钩子：
 * - node(comp, runIndex)：折叠思考块的标签节点改由这里构造，顺带登记计时状态；
 * - tick(comp)：TUI 每帧回调，流式期间让秒数走表（工作 spinner 已在 80ms 节拍驱动重绘）。
 * 标签带开始时刻（clock=true）：流式的取首次渲染时刻，历史消息取消息自己的 timestamp，
 * 历史只有开始时刻没有耗时。
 */
export function attachThinkingHooks(theme: ThinkingStyle, options: { clock?: boolean } = {}): {
  node: (comp: ThinkingComponent, runIndex: number) => Text;
  tick: (comp: ThinkingComponent) => void;
} {
  const style = (text: string) => theme.italic(theme.fg("thinkingText", text));
  const label = (comp: ThinkingComponent, run: ThinkingRun) => {
    const parts = [comp.hiddenThinkingLabel];
    const startAt = run.timed ? run.start : (comp.timestamp ?? comp.lastMessage?.timestamp);
    if (options.clock !== false && startAt !== undefined) parts.push(formatClock(startAt));
    if (run.timed) parts.push(formatElapsed((run.end ?? Date.now()) - run.start));
    return parts.join(" ");
  };
  return {
    node(comp, runIndex) {
      const runs = (comp.__hapiThinkingRuns ??= new Map());
      let run = runs.get(runIndex);
      if (!run) {
        // start = 折叠块首次渲染的时刻；非流式（历史消息）同刻封口，不显示耗时
        const start = Date.now();
        run = { start, timed: comp.isStreaming, end: comp.isStreaming ? undefined : start };
        runs.set(runIndex, run);
      } else if (run.timed && run.end === undefined && !comp.isStreaming) {
        // 流式结束那一刻冻结耗时
        run.end = Date.now();
      }
      const text = style(label(comp, run));
      const node = new Text(text, comp.outputPad, 0);
      run.node = node;
      run.lastText = text;
      return node;
    },
    tick(comp) {
      if (!comp.isStreaming) return;
      for (const run of comp.__hapiThinkingRuns?.values() ?? []) {
        if (!run.timed || run.end !== undefined || !run.node) continue;
        const text = style(label(comp, run));
        // Text 按 text 判等缓存，秒数没变就不动缓存
        if (run.lastText !== text) {
          run.node.setText(text);
          run.lastText = text;
        }
      }
    },
  };
}
