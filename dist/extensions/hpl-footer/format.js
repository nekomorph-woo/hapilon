/**
 * format.ts — hpl-footer 文本拼装纯函数
 *
 * usage 累加、token/窗口格式化、三行文本构建、宽度布局。
 */
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
    const avail = Math.max(0, width - visibleWidth(ellipsis));
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
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
/** 终端宽字符的简化区间（East Asian Wide 子集：CJK / 假名 / 全角 / Hangul / emoji） */
function isWide(cp) {
    return ((cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
        (cp >= 0x2e80 && cp <= 0xa4cf) || // 部首 / 注音 / 假名 / 全角标点 / CJK / 彝文
        (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音节
        (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
        (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
        (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
        (cp >= 0xffe0 && cp <= 0xffe6) || // 全角货币符号
        (cp >= 0x1f000 && cp <= 0x1faff) || // emoji 及补充平面符号
        (cp >= 0x20000 && cp <= 0x2fa1f) // CJK Ext B-F
    );
}
/** 单个 codepoint 的终端显示宽度：宽字符 2 列，控制字符 0 列，其余 1 列 */
function charWidth(ch) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0))
        return 0;
    return isWide(cp) ? 2 : 1;
}
/** 剥离 ANSI 转义码后的可见宽度（CJK / emoji 按 2 列计） */
export function visibleWidth(text) {
    let width = 0;
    for (const ch of text.replace(ANSI_PATTERN, ""))
        width += charWidth(ch);
    return width;
}
/** 按可见宽度截断为前缀子串（不含省略号），不切断代理对 */
function truncateByWidth(text, width) {
    if (visibleWidth(text) <= width)
        return text;
    let out = "";
    let w = 0;
    for (const ch of text) {
        const cw = charWidth(ch);
        if (w + cw > width)
            break;
        out += ch;
        w += cw;
    }
    return out;
}
/**
 * 左右两端对齐布局：宽度足够时中间补空格右对齐；
 * 不足时按可见宽度截断右侧（右侧为纯文本）；left 本身超宽时截断 left——
 * 不截断会让 pi TUI 以 "Rendered line exceeds terminal width" 直接崩溃
 * （team 模式的窄分割面板实测触发）。
 */
export function layoutLine(left, right, width) {
    const minPadding = 2;
    let leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    if (leftWidth + minPadding + rightWidth <= width) {
        return left + " ".repeat(width - leftWidth - rightWidth) + right;
    }
    if (leftWidth + minPadding > width) {
        left = truncateByWidth(left, Math.max(0, width - minPadding));
        leftWidth = visibleWidth(left);
    }
    const availableForRight = width - leftWidth - minPadding;
    if (availableForRight > 0) {
        return left + " ".repeat(minPadding) + truncateByWidth(right, availableForRight);
    }
    return left;
}
