import { Text } from "@earendil-works/pi-tui";
export function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    if (total < 60)
        return `${total}s`;
    return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}
/**
 * 产出补丁（assistant-message.js）调用的两个 globalThis 钩子：
 * - node(comp, runIndex)：折叠思考块的标签节点改由这里构造，顺带登记计时状态；
 * - tick(comp)：TUI 每帧回调，流式期间让秒数走表（工作 spinner 已在 80ms 节拍驱动重绘）。
 */
export function attachThinkingHooks(theme) {
    const style = (text) => theme.italic(theme.fg("thinkingText", text));
    const label = (comp, run) => run.timed ? `${comp.hiddenThinkingLabel} ${formatElapsed((run.end ?? Date.now()) - run.start)}` : comp.hiddenThinkingLabel;
    return {
        node(comp, runIndex) {
            const runs = (comp.__hapiThinkingRuns ??= new Map());
            let run = runs.get(runIndex);
            if (!run) {
                // start = 折叠块首次渲染的时刻；非流式（历史消息）同刻封口，不显示耗时
                const start = Date.now();
                run = { start, timed: comp.isStreaming, end: comp.isStreaming ? undefined : start };
                runs.set(runIndex, run);
            }
            else if (run.timed && run.end === undefined && !comp.isStreaming) {
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
            if (!comp.isStreaming)
                return;
            for (const run of comp.__hapiThinkingRuns?.values() ?? []) {
                if (!run.timed || run.end !== undefined || !run.node)
                    continue;
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
