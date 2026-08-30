/**
 * panels.ts — TUI component tree 面板发现 + 内容提取 + ▶/▼ markers
 *
 * 核心借鉴 pi-pop：
 * - collectExpandables: 递归遍历 tui.children 找 setExpanded 组件
 * - panelContent: 临时 expand→render→restore，conversation 无感知
 * - decorateExpandable: monkey-patch render() 注入左 gutter ▶/▼
 * - findNewestPanel: 标题正则匹配找最新面板
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import { panelMarker, SWEEP_MS, config, } from "./shared.js";
// ── TUI tree traversal ──────────────────────────────────────────────────
/** duck-type 判断是否可折叠 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isExpandable(comp) {
    return typeof comp === "object" && comp !== null &&
        typeof comp.setExpanded === "function";
}
/** 递归收集所有可折叠组件（深度优先，保持渲染顺序） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function collectExpandables(node, out) {
    if (isExpandable(node))
        out.push(node);
    const children = node?.children;
    if (Array.isArray(children)) {
        for (const child of children)
            collectExpandables(child, out);
    }
    return out;
}
/** pattern 匹配：先试 regex，失败 fallback 子串（不区分大小写） */
export function patternMatches(pattern, text) {
    try {
        return new RegExp(pattern, "i").test(text);
    }
    catch {
        return text.toLowerCase().includes(pattern.toLowerCase());
    }
}
/** 从渲染行取面板标题：第一非空行，去 ANSI + marker */
export function titleOfLines(lines) {
    for (const l of lines) {
        if (typeof l !== "string")
            continue;
        const plain = l.replace(/\x1b\[[0-9;]*m/g, "").replace(/^[\s▶▼]+/, "").trim();
        if (plain)
            return plain;
    }
    return "";
}
// ── Panel content extraction ───────────────────────────────────────────
/**
 * 读取面板渲染后内容（临时 expand→render→restore，conversation 不感知）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function panelContent(panel, width) {
    const render = panel.__hapiRender || panel.render.bind(panel);
    const was = panel.expanded ?? false;
    let lines;
    try {
        panel.setExpanded(true);
        lines = render(width);
    }
    finally {
        panel.setExpanded(was);
    }
    return Array.isArray(lines) ? lines.filter((l) => typeof l === "string") : [];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function panelTitle(comp, width) {
    let lines;
    try {
        lines = comp.render(width);
    }
    catch {
        return "(panel)";
    }
    return titleOfLines(lines) || "(panel)";
}
// ── Navigation ─────────────────────────────────────────────────────────
/** 导航面板列表（应用 config include/exclude 规则） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function navigableExpandables(tui) {
    const all = collectExpandables(tui, []);
    if (config.include.length === 0 && config.exclude.length === 0)
        return all;
    return all.filter((c) => {
        const t = panelTitle(c, tui.terminal.columns);
        const inc = config.include.length === 0 || config.include.some((p) => patternMatches(p, t));
        const exc = config.exclude.some((p) => patternMatches(p, t));
        return inc && !exc;
    });
}
/** 找最新匹配标题的面板 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function findNewestPanel(tui, pattern) {
    const width = tui.terminal.columns;
    let found = null;
    for (const c of collectExpandables(tui, [])) {
        if (patternMatches(pattern, panelTitle(c, width)))
            found = c;
    }
    return found;
}
// ── ▶/▼ markers ────────────────────────────────────────────────────────
const expandedState = new WeakMap();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function decorateExpandable(comp, theme) {
    if (comp.__hapiDecorated)
        return false;
    // 只装饰消息面板组件，跳过 Pi UI chrome（header、notification、extensions list 等）
    // 面板组件特征：有 toolName/toolCallId/message/contentBox 等属性
    if (!isPanelComponent(comp))
        return false;
    comp.__hapiDecorated = true;
    // keep expanded state in sync
    const origSetExpanded = comp.setExpanded.bind(comp);
    comp.setExpanded = (v) => {
        expandedState.set(comp, v === true);
        return origSetExpanded(v);
    };
    const origRender = comp.render.bind(comp);
    comp.__hapiRender = origRender;
    comp.render = (width) => {
        let lines = origRender(width);
        if (!Array.isArray(lines) || lines.length === 0)
            return lines;
        const expanded = comp.expanded ?? expandedState.get(comp) ?? false;
        const maxL = config.maxLines;
        // 折叠时截断到 maxLines，footer 以 ▼ 表明当前为折叠态
        if (maxL > 0 && !expanded && lines.length > maxL) {
            const hidden = lines.length - maxL;
            const footer = truncateToWidth(` ${theme.fg("dim", `…${hidden} more lines ▼`)}`, width, "", true);
            lines = [...lines.slice(0, maxL), footer];
        }
        // 注入状态 marker（▶ 折叠 / ▼ 展开）到第一行，继承原行背景色
        const firstIdx = lines.findIndex((l) => typeof l === "string" && l.trim().length > 0);
        if (firstIdx >= 0) {
            const orig = lines[firstIdx];
            // 从原行提取 background ANSI code（如 \x1b[48;2;...m）
            const bgMatch = orig.match(/\x1b\[48;[0-9;]*m/);
            const bg = bgMatch ? bgMatch[0] : "";
            // 标记 + 空格 = 前缀，继承原行背景
            const marker = bg + theme.fg("dim", panelMarker(expanded) + " ") + bg;
            const marked = marker + orig;
            lines[firstIdx] = truncateToWidth(marked, width, "", true);
        }
        return lines;
    };
    return true;
}
/**
 * 判定一个 expandable 组件是否是消息面板（而非 Pi UI chrome）。
 * Pi 的 header、notification、extensions list 也有 setExpanded，
 * 但它们没有 toolName/toolCallId/message/contentBox 等面板特征属性。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isPanelComponent(comp) {
    return !!(comp.toolName || // ToolExecutionComponent
        comp.toolCallId || // ToolExecutionComponent
        comp.message || // BashExecution/SkillInvocation/Branch/Compaction/Custom
        comp.contentBox || // Tool/Bash execution
        comp.args // ToolExecutionComponent
    );
}
/** 递归扫描 + decorate */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sweepExpandables(node, theme) {
    let changed = false;
    if (isExpandable(node))
        changed = decorateExpandable(node, theme);
    const children = node?.children;
    if (Array.isArray(children)) {
        for (const child of children)
            changed = sweepExpandables(child, theme) || changed;
    }
    return changed;
}
/** 启动定期扫描，注入 markers 到新出现的面板 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function improvePanelAppearance(tui, theme) {
    const sweep = setInterval(() => {
        if (tui.stopped)
            return;
        if (sweepExpandables(tui, theme))
            tui.requestRender();
    }, SWEEP_MS);
    sweep.unref?.();
}
