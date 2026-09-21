/**
 * content.ts — 纯函数：header 内容构建 + 布局
 *
 * 数据与渲染分离，所有业务逻辑无副作用可单测。
 */
import { hyperlink, getCapabilities } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
// ─── Logo ─────────────────────────────────────────────────────────────
// 首屏 logo：8 只盲文点阵猫，每次启动随机出现一只。
// 点阵图取自参考图直接降采样编码（2×4 点/字符），8 行 × 10 列恒定，
// 因此换图不会改变首屏布局高度。新增图案只需往 LOGOS 里加一组等长行。
const LOGOS = [
    // 0 坐姿
    [
        "⠀⠀⠀⠀⠀⣀⠀⢀⡀⠀",
        "⠀⠀⠀⠀⠀⣻⣶⣾⣷⡀",
        "⠀⠀⠀⠀⠀⢻⣿⣿⡿⠃",
        "⠀⠀⠀⢀⣴⣿⣿⣿⣿⡄",
        "⠀⠀⠀⣾⣿⣿⣿⣿⣿⡇",
        "⣰⡶⢸⣿⣿⣿⣿⣿⣿⣿",
        "⢻⣧⣀⣻⣿⣿⣿⣿⣿⠟",
        "⠀⠉⠉⠉⠉⠉⠉⠉⠀⠀",
    ],
    // 1 坐姿+月
    [
        "⠀⠀⠀⠀⠀⠀⠀⠀⢲⣦",
        "⠀⠀⠀⠀⠀⠀⠀⠀⠾⠏",
        "⠀⢰⣄⣀⣠⡆⠀⠀⠀⠀",
        "⠀⣾⣿⣿⣿⣷⠀⠀⠀⠀",
        "⠀⣨⣿⣿⣿⣄⠀⠀⠀⠀",
        "⣰⣿⣿⣿⣿⣿⡆⠀⠀⠀",
        "⣿⣿⣿⣿⣿⣿⡿⣤⡄⠀",
        "⠈⠛⠿⠿⠿⠷⠾⠛⠁⠀",
    ],
    // 2 窗边
    [
        "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
        "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
        "⠀⣠⠀⢀⡄⠀⠀⠀⠀⠀",
        "⠀⣿⣿⣿⡇⠀⠀⠀⠀⠀",
        "⢀⣾⣿⣿⡅⠀⠀⠀⠀⠀",
        "⣼⣿⣿⣿⣷⠀⢲⡆⠀⠀",
        "⠙⠿⠿⠿⠿⠶⠾⠃⠀⠀",
        "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    ],
    // 3 窗前
    [
        "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
        "⠀⠀⠀⡀⣀⠀⠀⠀⠀⠀",
        "⠀⠀⢰⣿⣿⡄⠀⠀⠀⠀",
        "⢀⠀⠈⣹⣿⣿⣄⠀⢠⣄",
        "⣼⣷⠄⢿⣿⣿⣿⡄⠀⣿",
        "⢶⣷⠀⣼⣿⣿⣿⣣⡴⠋",
        "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
        "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    ],
    // 4 蜷猫
    [
        "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
        "⠀⠀⠀⠀⠀⢰⣦⣀⣠⡆",
        "⠀⠀⠀⠀⠀⣿⣿⣿⣿⣷",
        "⠀⣤⣶⣿⣿⣿⣿⣿⣿⡃",
        "⣼⣿⣿⣿⣿⡿⠿⢿⣿⣷",
        "⢿⣿⣿⣿⡏⠀⣶⣆⢹⡟",
        "⠈⠛⠿⠿⠿⠿⠟⠋⠀⠀",
        "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    ],
    // 5 瘦高
    [
        "⠀⠀⢸⣦⣤⣴⡇⠀⠀⠀",
        "⠀⠀⢿⣿⣿⣿⡟⠀⠀⠀",
        "⠀⢀⣾⣿⣿⣿⣧⠀⠀⠀",
        "⠀⢸⣿⣿⣿⣿⣿⡄⠀⠀",
        "⠀⣿⣿⣿⣿⣿⣿⣿⠀⠀",
        "⠀⠙⠿⠿⠿⠿⢿⣯⡀⠀",
        "⠀⠀⠀⠀⠀⣀⣀⣽⠇⠀",
        "⠀⠀⠀⠀⠰⣟⠛⠁⠀⠀",
    ],
    // 6 窗台
    [
        "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
        "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
        "⠀⠀⠀⡀⢀⡀⠀⠀⠀⠀",
        "⠀⠀⢸⣿⣿⡇⠀⠀⠀⠀",
        "⠀⠀⣰⣿⣿⡆⠀⠀⠀⠀",
        "⣀⣀⣿⣿⣿⣿⣀⣀⣀⣀",
        "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
        "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    ],
    // 7 草地+蝶
    [
        "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
        "⠀⠀⠀⠀⠀⠀⠀⠀⣀⣤",
        "⠀⠀⠀⠀⣄⣠⡄⠀⠛⠉",
        "⠀⠀⠀⠰⣿⣿⡿⠀⠀⠀",
        "⠀⣴⠃⢠⣿⣿⣷⡀⠀⠀",
        "⠀⠻⣦⣿⣿⣿⣿⠃⣀⡆",
        "⠀⠀⠐⠙⠛⠛⠙⠀⠘⠊",
        "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    ],
];
// 模块加载时定一只：resize / 重绘复用同一只，不会闪跳。
const LOGO_INDEX = Math.floor(Math.random() * LOGOS.length);
export function hapilonLogo() {
    return [...LOGOS[LOGO_INDEX]];
}
/** logo 专用 accent 通道，交给 Pi 主题在明暗终端中选择可读颜色。 */
export function isLogoLine(line) {
    const inner = line.startsWith("│") && line.endsWith("│")
        ? line.slice(1, -1)
        : line;
    // 宽屏布局把左右列拼在同一行；这类行不能整行染成 logo accent。
    if (inner.includes("│"))
        return false;
    // 方块元素（▀▁…▟ 含 ░▒▓）与盲文点阵（U+2800–U+28FF）都算 logo 笔画。
    return /^\s*[\u2580-\u259F\u2800-\u28FF]/.test(inner);
}
// ─── Box Drawing ──────────────────────────────────────────────────────
const H_BAR = "─";
const TL = "╭";
const TR = "╮";
const BL = "╰";
const BR = "╯";
const V = "│";
export function drawBox(lines, width, title) {
    // Guard: Pi's TUI renderer rejects lines wider than available width.
    // At width < 3, borders alone would overflow. Return empty to avoid crash.
    if (width < 3)
        return [];
    const innerW = width - 2;
    const result = [];
    if (title) {
        const remain = innerW - title.length;
        if (remain > 0) {
            result.push(TL + title + H_BAR.repeat(remain) + TR);
        }
        else {
            const display = title.length > innerW
                ? title.slice(0, innerW - 1) + "…"
                : title;
            result.push(TL + display.slice(0, innerW) + TR);
        }
    }
    else {
        result.push(TL + H_BAR.repeat(innerW) + TR);
    }
    for (const line of lines) {
        const trimmed = line.length > innerW ? line.slice(0, innerW) : line;
        const padded = trimmed + " ".repeat(Math.max(0, innerW - trimmed.length));
        result.push(V + padded + V);
    }
    result.push(BL + H_BAR.repeat(innerW) + BR);
    return result;
}
// ─── Column Layout ────────────────────────────────────────────────────
export function layoutColumns(left, right, width) {
    // Guard: prevent RangeError on String.repeat(negative) at tiny widths
    if (width < 3)
        return [];
    if (width < 80) {
        const result = [...left];
        if (right.length > 0) {
            result.push(H_BAR.repeat(width - 2));
            result.push(...right);
        }
        return result;
    }
    const innerW = width - 2;
    const sep = " │ ";
    const leftW = Math.floor((innerW - sep.length) * 0.55);
    const rightW = innerW - leftW - sep.length;
    const maxRows = Math.max(left.length, right.length);
    const result = [];
    for (let i = 0; i < maxRows; i++) {
        const l = i < left.length ? left[i] : "";
        const r = i < right.length ? right[i] : "";
        const lTrimmed = l.length > leftW ? l.slice(0, leftW) : l;
        const rTrimmed = r.length > rightW ? r.slice(0, rightW) : r;
        const lp = lTrimmed + " ".repeat(leftW - lTrimmed.length);
        const rp = rTrimmed + " ".repeat(rightW - rTrimmed.length);
        result.push(lp + sep + rp);
    }
    return result;
}
function isExtensionListLine(line, extensions) {
    if (!extensions || extensions.length === 0)
        return false;
    const inner = line.startsWith(V) && line.endsWith(V)
        ? line.slice(1, -1)
        : line;
    const separator = inner.indexOf(" │ ");
    const right = separator >= 0 ? inner.slice(separator + 3) : inner;
    const trimmedRight = right.trimEnd();
    return extensions.some((extension) => trimmedRight === `  ${extension}`);
}
function colorStartupLine(line, theme, hasLinks) {
    let colored = line;
    // Hyperlink: replace raw URL with clickable link (includes its own dim)
    if (hasLinks && colored.includes("pi.dev/changelog")) {
        colored = colored.replace("pi.dev/changelog", hyperlink("pi.dev/changelog", "https://pi.dev/changelog"));
    }
    // Headers — bold
    if (colored.includes("Tips for getting started") ||
        colored.includes("Extensions (")) {
        return theme.fg("text", theme.bold(colored));
    }
    // Divider — dim
    if (colored.trim().match(/^─+$/)) {
        return theme.fg("dim", colored);
    }
    // ctrl+o 提示保持 dim。
    if (colored.includes("ctrl+o for")) {
        return theme.fg("dim", colored);
    }
    // 其余缩进行（Tips 内容 / 快捷键）保持 dim。
    if (/^  \S/.test(colored)) {
        return theme.fg("dim", colored);
    }
    // Changelog line — dim (the raw text before hyperlink replacement)
    if (colored.includes("pi.dev/")) {
        return theme.fg("dim", colored);
    }
    // Body
    return theme.fg("text", colored);
}
// ─── Env Helper ───────────────────────────────────────────────────────
export function parseExtensionsEnv(raw) {
    if (raw === undefined)
        return undefined;
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
            return parsed;
        }
    }
    catch {
        // fall through
    }
    console.warn("[hpl-startup-header] Invalid HAPILON_EXTENSIONS env, ignoring");
    return undefined;
}
// ─── Content Builders ─────────────────────────────────────────────────
function centerLine(line, maxWidth) {
    if (line.length >= maxWidth)
        return line;
    const pad = Math.floor((maxWidth - line.length) / 2);
    return " ".repeat(pad) + line;
}
/**
 * 将多行文本在给定宽度内居中（左边补空格）。
 *
 * 首部连续非空行视为「块」（logo），整体共享 pad 居中——
 * 行间相对位置固定，resize 时整块平移不变形（把「逐行独立取整」改成整体取整）。其余行保持独立居中。
 */
export function centerLines(lines, maxWidth) {
    let blockEnd = 0;
    while (blockEnd < lines.length && lines[blockEnd] !== "")
        blockEnd++;
    if (blockEnd >= 2) {
        const block = lines.slice(0, blockEnd);
        const blockWidth = Math.max(...block.map((l) => l.length));
        const pad = blockWidth >= maxWidth ? 0 : Math.floor((maxWidth - blockWidth) / 2);
        const paddedBlock = block.map((l) => " ".repeat(pad) + l);
        const rest = lines.slice(blockEnd);
        return [...paddedBlock, ...rest.map((l) => centerLine(l, maxWidth))];
    }
    return lines.map((l) => centerLine(l, maxWidth));
}
/**
 * 将 workspace 路径压缩为 header 友好格式。
 * home 下保留 ~ 和首段、末两段；其它绝对路径保留根下前两段和末段，
 * 使 /Volumes/Under_M2 这类工作盘锚点仍然可辨认。
 */
export function shortenWorkspacePath(cwd, homeDir) {
    const normalizedCwd = cwd.replace(/[\\/]+$/, "") || cwd;
    const normalizedHome = homeDir.replace(/[\\/]+$/, "") || homeDir;
    const isHome = normalizedCwd === normalizedHome ||
        normalizedCwd.startsWith(`${normalizedHome}/`) ||
        normalizedCwd.startsWith(`${normalizedHome}\\`);
    if (isHome) {
        if (normalizedCwd === normalizedHome)
            return "~";
        const relative = normalizedCwd.slice(normalizedHome.length).replace(/^[\\/]+/, "");
        const parts = relative.split(/[\\/]+/).filter(Boolean);
        if (parts.length <= 3)
            return `~/${parts.join("/")}`;
        return `~/${parts[0]}/…/${parts.slice(-2).join("/")}`;
    }
    const isAbsolute = normalizedCwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalizedCwd);
    if (!isAbsolute)
        return normalizedCwd;
    const root = normalizedCwd.startsWith("/") ? "/" : "";
    const parts = normalizedCwd.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 3)
        return `${root}${parts.join("/")}`;
    const prefix = parts.slice(0, 2).join("/");
    return `${root}${prefix}/…/${parts.at(-1)}`;
}
export function buildLeftColumn(data) {
    const left = [];
    for (const line of hapilonLogo()) {
        left.push(line);
    }
    left.push("");
    left.push("Welcome back!");
    if (data.modelProvider && data.modelName) {
        left.push(`${data.modelProvider} · ${data.modelName}`);
    }
    else {
        left.push("no model selected");
    }
    left.push(shortenWorkspacePath(data.cwd, data.homeDir));
    return left;
}
export function buildRightColumn(data, expanded) {
    const right = [];
    // ── Tips（仅 expanded）──
    if (expanded) {
        right.push("Tips for getting started");
        right.push("  Run /context to check usage");
        right.push("  " + H_BAR.repeat(26));
    }
    // ── Extensions (N) + 扩展名列表（恒显示）──
    if (data.extensions && data.extensions.length > 0) {
        right.push(`Extensions (${data.extensions.length})`);
        for (const extName of data.extensions) {
            right.push(`  ${extName}`);
        }
        right.push("  " + H_BAR.repeat(26));
    }
    // ── What's new ──
    if (data.piUpdate) {
        right.push(`Pi ${data.piUpdate} available`);
        right.push("  pi.dev/changelog");
    }
    else {
        right.push("Pi is up to date");
    }
    // ── Help ──
    if (expanded) {
        right.push("  " + H_BAR.repeat(26));
        right.push("Keyboard shortcuts");
        right.push("  esc         interrupt");
        right.push("  ctrl+c/d    clear / exit");
        right.push("  shift+tab   cycle thinking");
        right.push("  ctrl+p      select model");
        right.push("  /           commands");
        right.push("  !           bash");
        right.push("  ctrl+g      external editor");
    }
    else {
        right.push("");
        right.push("ctrl+o for more");
    }
    return right;
}
/**
 * 构建完整 header 内容（含左/右栏），不包含外边框。
 * 合并 buildLeftColumn 与 buildRightColumn 的结果，方便测试和简单场景使用。
 */
export function buildHeaderLines(data, expanded) {
    const left = buildLeftColumn(data);
    const right = buildRightColumn(data, expanded);
    const innerW = 78; // 80 - 2
    const sepLen = " │ ".length;
    const leftW = Math.floor((innerW - sepLen) * 0.55);
    return layoutColumns(centerLines(left, leftW), right, 80);
}
// ─── Component Factory ────────────────────────────────────────────────
export function createStartupHeader(ctx, _tui, theme, state) {
    return {
        render(width) {
            const provider = ctx.model?.provider ?? process.env["HAPILON_MODEL_PROVIDER"];
            const modelName = ctx.model?.name ?? process.env["HAPILON_MODEL_NAME"];
            const data = {
                version: process.env["HAPILON_VERSION"],
                modelProvider: provider,
                modelName,
                cwd: ctx.cwd,
                homeDir: homedir(),
                extensions: parseExtensionsEnv(process.env["HAPILON_EXTENSIONS"]),
                piUpdate: state.piUpdate,
            };
            const versionStr = data.version ? ` v${data.version}` : "";
            const title = `─── Hapilon${versionStr}`;
            // Build columns
            const innerW = width - 2;
            const sepLen = " │ ".length;
            const leftW = Math.floor((innerW - sepLen) * 0.55);
            const rightW = innerW - leftW - sepLen;
            const rawLeft = buildLeftColumn(data);
            const rawRight = buildRightColumn(data, state.expanded);
            const centeredLeft = centerLines(rawLeft, leftW);
            const columns = layoutColumns(centeredLeft, rawRight, width);
            const boxed = drawBox(columns, width, title);
            // Apply visual hierarchy
            const hasLinks = getCapabilities().hyperlinks;
            return boxed.map((line, idx) => {
                if (idx === 0 || idx === boxed.length - 1) {
                    return theme.fg("border", line);
                }
                if (line.length === 0)
                    return line;
                let colored = line;
                if (isLogoLine(colored)) {
                    return theme.fg("accent", colored);
                }
                // Hyperlink: replace raw URL with clickable link (includes its own dim)
                if (hasLinks && colored.includes("pi.dev/changelog")) {
                    colored = colored.replace("pi.dev/changelog", hyperlink("pi.dev/changelog", "https://pi.dev/changelog"));
                }
                // 宽屏 logo 与右栏同行时，只给左段上 accent，右段继续走原分类管线。
                const columnSeparator = colored.indexOf(" │ ");
                if (columnSeparator >= 1 &&
                    isLogoLine(colored.slice(1, columnSeparator))) {
                    const logoPart = theme.fg("accent", colored.slice(0, columnSeparator));
                    const rightPart = colored.slice(columnSeparator);
                    return logoPart + (isExtensionListLine(colored, data.extensions)
                        ? theme.fg("muted", rightPart)
                        : colorStartupLine(rightPart, theme, false));
                }
                // 宽屏扩展名行只降低右栏，左栏保留原有 text/body 分类。
                if (columnSeparator >= 0 && isExtensionListLine(colored, data.extensions)) {
                    return colorStartupLine(colored.slice(0, columnSeparator), theme, false) +
                        theme.fg("muted", colored.slice(columnSeparator));
                }
                // 扩展名是次要信息，但在暗色主题中需比 dim 更亮一档。
                if (isExtensionListLine(colored, data.extensions)) {
                    return theme.fg("muted", colored);
                }
                return colorStartupLine(colored, theme, false);
            });
        },
        invalidate() {
            /* no-op */
        },
        setExpanded(expanded) {
            state.expanded = expanded;
        },
    };
}
