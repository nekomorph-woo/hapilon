/**
 * ponytail.ts — `/hapi-metrics ponytail`：把会话样本按分桶聚合，渲染成对照表
 *
 * 这测的是「体量与形状」，不是「对不对」：output token、成本、文本/代码比、编辑
 * 与文件规模。质量信号（reviewer 的 P0/P1、verify 是否跑通）需要另一套数据源与
 * 归属规则，留给后续子命令——所以这里在表尾明确写出该警告，避免读表的人过度解读。
 */
import { visibleWidth } from "@earendil-works/pi-tui";
export function median(values) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
/** 分组标签：模型取会话内出现过的全部模型（多模型会话标成 A+B） */
function groupKeyOf(sample, groupBy) {
    switch (groupBy) {
        case "ponytail":
            return `${sample.ponytail}${sample.ponytailSource === "assumed" ? "?" : ""}`;
        case "model":
            return sample.models.length === 0 ? "(未知)" : sample.models.join("+");
        case "day":
            return sample.startedAt.slice(0, 10) || "(无时间)";
        case "project": {
            const parts = sample.project.split("/").filter(Boolean);
            return parts.length === 0 ? "(无 cwd)" : parts[parts.length - 1];
        }
    }
}
export function groupSamples(samples, groupBy) {
    const buckets = new Map();
    for (const sample of samples) {
        const key = groupKeyOf(sample, groupBy);
        const bucket = buckets.get(key);
        if (bucket)
            bucket.push(sample);
        else
            buckets.set(key, [sample]);
    }
    const groups = [];
    for (const [key, bucket] of buckets) {
        const sum = (pick) => bucket.reduce((total, sample) => total + pick(sample), 0);
        groups.push({
            key,
            sessions: bucket.length,
            outputMedian: median(bucket.map((sample) => sample.outputTokens)),
            outputTotal: sum((sample) => sample.outputTokens),
            costUsd: sum((sample) => sample.costUsd),
            proseChars: sum((sample) => sample.proseChars),
            codeChars: sum((sample) => sample.codeChars),
            editCalls: sum((sample) => sample.editCalls + sample.writeCalls),
            filesTouched: sum((sample) => sample.filesTouched),
            bashCalls: sum((sample) => sample.bashCalls),
            subagentCalls: sum((sample) => sample.subagentCalls),
        });
    }
    // 会话数多的在前；同数量按标签，保证输出稳定（可 diff、可回归）
    return groups.sort((a, b) => b.sessions - a.sessions || a.key.localeCompare(b.key));
}
/** 按可见宽度补空格（中文占两列，必须用 visibleWidth 而不是 length） */
function pad(text, width, align = "left") {
    const gap = Math.max(0, width - visibleWidth(text));
    return align === "left" ? text + " ".repeat(gap) : " ".repeat(gap) + text;
}
function compact(value) {
    if (value >= 1_000_000)
        return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000)
        return `${(value / 1_000).toFixed(1)}k`;
    return String(Math.round(value));
}
/** 渲染成交互面板可用的文本行（表 + 表尾说明） */
export function renderPonytailLines(groups, meta) {
    const header = ["分组", "会话", "out中位", "out合计", "成本$", "文本/代码", "编辑/会话", "文件/会话", "bash/会话", "子代理/会话"];
    const rows = groups.map((group) => {
        const per = (value) => (group.sessions === 0 ? "0" : (value / group.sessions).toFixed(1));
        const ratio = group.codeChars === 0 ? "—" : (group.proseChars / group.codeChars).toFixed(1);
        return [
            group.key,
            String(group.sessions),
            compact(group.outputMedian),
            compact(group.outputTotal),
            group.costUsd.toFixed(3),
            ratio,
            per(group.editCalls),
            per(group.filesTouched),
            per(group.bashCalls),
            per(group.subagentCalls),
        ];
    });
    const all = [header, ...rows];
    const widths = header.map((_, index) => Math.max(...all.map((row) => visibleWidth(row[index] ?? ""))));
    const lines = [];
    lines.push(all[0].map((cell, index) => pad(cell, widths[index])).join("  "));
    lines.push(widths.map((width) => "─".repeat(width)).join("  "));
    for (const row of rows) {
        lines.push(row.map((cell, index) => pad(cell, widths[index], index === 0 ? "left" : "right")).join("  "));
    }
    if (rows.length === 0)
        lines.push("（没有符合条件的会话）");
    lines.push("");
    lines.push(`范围：${meta.homes.length === 0 ? "(未找到 .hapilon* home)" : meta.homes.join("  ")}`);
    lines.push(`样本：${meta.samples} 个会话` +
        (meta.since ? ` · 起始 ${meta.since}` : "") +
        (meta.project ? ` · 项目含「${meta.project}」` : "") +
        ` · 分组 ${meta.groupBy}`);
    lines.push(`ponytail 档位：${meta.ponytailFromSession}/${meta.samples} 个会话取自会话内记录` +
        `，其余按当前默认推测（带 ? 标记；全局配置的历史变更不可见）`);
    lines.push("");
    lines.push("⚠ 体量指标只说明「写得更少」，不说明「做得更对」：质量要看 reviewer 的 P0/P1、");
    lines.push("   verify 是否跑通、返工次数。跨模型/跨任务类型的差异不能直接归因于 ponytail，");
    lines.push("   要归因需要同模型、同类任务的对照（/ponytail off 与 full 各跑几轮）。");
    return lines;
}
