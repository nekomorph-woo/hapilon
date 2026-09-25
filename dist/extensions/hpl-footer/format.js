/**
 * format.ts — hpl-footer 文本拼装纯函数
 *
 * usage 累加、token/窗口格式化、三行文本构建、宽度布局。
 */
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
// 宽度一律以 pi-tui 的表为准：判定「渲染行超宽 → 中止进程」的就是它，
// 自带一张表必然漂移（⏳/⚡/⭐ 等 emoji 表现形曾被记 1 列，状态行因此超宽崩溃）。
export { visibleWidth };
/** 自适应 token 格式：<1000 原样 / 2.2k / 34k / 1.0M */
export function formatTokens(n) {
    if (n < 1000)
        return n.toString();
    if (n < 10000)
        return `${(n / 1000).toFixed(1)}k`;
    if (n < 1000000)
        return `${Math.round(n / 1000)}k`;
    if (n < 10000000)
        return `${(n / 1000000).toFixed(1)}M`;
    return `${Math.round(n / 1000000)}M`;
}
/** 窗口小写紧凑格式：200k / 1m */
export function formatWindow(n) {
    if (n < 1000)
        return n.toString();
    if (n < 1000000)
        return `${Math.round(n / 1000)}k`;
    const m = n / 1000000;
    return m % 1 === 0 ? `${m}m` : `${m.toFixed(1)}m`;
}
/** 重置倒计时：~45m / ~2h / ~6d（不足 1 分钟显示 <1m） */
export function formatResetCountdown(remainingMs) {
    const minutes = Math.floor(remainingMs / 60000);
    if (minutes < 1)
        return "~<1m";
    if (minutes < 60)
        return `~${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48)
        return minutes % 60 > 0 ? `~${hours}h${minutes % 60}m` : `~${hours}h`;
    return `~${Math.floor(hours / 24)}d`;
}
/**
 * footer 限额段："18%/5h~2h 76%/mo~9d"（窗口标签缺失退化为 "18%"）。
 * 余额型（deepseek）走 balance 模板。
 */
export function buildQuotaSegment(windows, balance, now) {
    if (balance !== undefined)
        return `¥${balance}`;
    return windows
        .map((w) => {
        const base = w.window !== undefined
            ? `${Math.round(w.percent)}%/${w.window}`
            : `${Math.round(w.percent)}%`;
        if (w.resetAt === undefined || w.resetAt <= now)
            return base;
        return `${base}${formatResetCountdown(w.resetAt - now)}`;
    })
        .join(" ");
}
/** 第 1 行：`cwd | branch`；无分支时仅 cwd */
export function buildLine1(cwd, branch) {
    return branch ? `${cwd} | ${branch}` : cwd;
}
/**
 * 第 2 行右侧：模型名 • 档位。仅 reasoning 模型带档位，且只留 level
 * （去掉 "thinking " 前缀，与内置 footer 的展示分道）。
 */
export function buildModelRight(model, thinkingLevel) {
    const name = model?.id ?? "no-model";
    return model?.reasoning ? `${name} • ${thinkingLevel}` : name;
}
/** 单行状态清洗：换行/制表压成单空格 */
function sanitizeStatus(text) {
    return text.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
}
/** 第 3 行：` | ` 分隔扩展状态；空数组返回 null（整行隐藏） */
export function buildStatusLine(statuses) {
    if (statuses.length === 0)
        return null;
    return statuses.map(sanitizeStatus).join(" | ");
}
/** 家目录前缀缩写为 ~（仅目录边界匹配） */
export function shortenHome(cwd, home) {
    if (!home)
        return cwd;
    if (cwd === home)
        return "~";
    if (cwd.startsWith(home + "/"))
        return "~" + cwd.slice(home.length);
    return cwd;
}
/** 纯文本超宽按可见宽度截断并追加省略号 */
export function truncatePlain(text, width, ellipsis = "...") {
    if (visibleWidth(text) <= width)
        return text;
    const avail = width - visibleWidth(ellipsis);
    // 窄到装不下省略号时不加：宁可少提示，也不能吐出一条超宽行（TUI 直接中止）
    if (avail <= 0)
        return truncateByWidth(text, width);
    return truncateByWidth(text, avail) + ellipsis;
}
/** 遍历会话条目累加 assistant usage；命中率取最后一条 assistant 消息 */
export function aggregateUsage(entries) {
    let input = 0;
    let output = 0;
    let cacheHitRate;
    for (const e of entries) {
        if (e.type !== "message" || e.message?.role !== "assistant" || !e.message.usage)
            continue;
        const u = e.message.usage;
        input += u.input;
        output += u.output;
        const promptTokens = u.input + u.cacheRead + u.cacheWrite;
        cacheHitRate = promptTokens > 0 ? (u.cacheRead / promptTokens) * 100 : undefined;
    }
    return { input, output, cacheHitRate };
}
// ─── 第 2 行左侧 ────────────────────────────────────────────────────
/**
 * 拼装第 2 行左侧统计（符号流布局）：
 * `↑ N ↓ N hit N% ctx N%/W [HOT]`
 * 0 值项跳过；占用未知（null）时百分比显示 `?`
 */
export function buildStatsLeft(stats, ctxPercent, ctxWindow, ding) {
    const parts = [];
    if (stats.input)
        parts.push(`↑ ${formatTokens(stats.input)}`);
    if (stats.output)
        parts.push(`↓ ${formatTokens(stats.output)}`);
    if (stats.cacheHitRate !== undefined)
        parts.push(` • hit ${stats.cacheHitRate.toFixed(1)}%`);
    const percentStr = ctxPercent === null ? "?" : `${ctxPercent.toFixed(1)}%`;
    parts.push(` • ctx ${percentStr}/${formatWindow(ctxWindow)}`);
    parts.push(ding);
    return parts.join(" ");
}
// ─── ANSI 宽度与布局 ────────────────────────────────────────────────
/** 按可见宽度截断为前缀子串（不含省略号），宽字符不切半 */
function truncateByWidth(text, width) {
    return visibleWidth(text) <= width ? text : sliceByColumn(text, 0, width, true);
}
/**
 * 右侧优先的两端布局：右侧（模型/quota 等短段）优先完整保留，空间不足时截左段。
 * 宽裕时与左对齐一致（右对齐补空格）；右段自身超过行宽（极窄）时截右段——
 * 任意 width 下可见宽度 ≤ width（超宽会让 pi TUI 直接中止进程，team 窄分割面板实测触发）。
 * 只用可见宽度计数，ANSI 码不影响判定。
 */
export function layoutLineRight(left, right, width) {
    const minPadding = 2;
    const rightWidth = visibleWidth(right);
    let leftPart = left;
    if (visibleWidth(leftPart) + minPadding + rightWidth > width) {
        leftPart = truncateByWidth(leftPart, Math.max(0, width - rightWidth - minPadding));
    }
    const leftWidth = visibleWidth(leftPart);
    if (leftWidth + rightWidth > width)
        return truncateByWidth(right, width);
    return leftPart + " ".repeat(width - leftWidth - rightWidth) + right;
}
