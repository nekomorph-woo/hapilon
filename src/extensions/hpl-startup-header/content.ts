/**
 * content.ts — 纯函数：header 内容构建 + 布局
 *
 * 数据与渲染分离，所有业务逻辑无副作用可单测。
 */

import type { TUI } from "@earendil-works/pi-tui";
import { hyperlink, getCapabilities } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { readAddedWorkspaceDirs, type WorkspaceEntry } from "./workspace.js";

// ─── Types ────────────────────────────────────────────────────────────

export interface HeaderData {
  version: string | undefined;
  modelProvider: string | undefined;
  modelName: string | undefined;
  cwd: string;
  homeDir: string;
  addedDirsCount?: number;
  extensions: string[] | undefined;
  piUpdate: string | undefined;
}

interface HeaderState {
  expanded: boolean;
  piUpdate?: string;
}

/** Component 子类型：扩展了 setExpanded 以支持 ctrl+o 联动 */
export interface StartupHeaderComponent {
  render(width: number): string[];
  invalidate(): void;
  setExpanded(expanded: boolean): void;
}

// ─── Logo ─────────────────────────────────────────────────────────────
// 原图案保留，按字符中心对齐修复（#27）：中心 7.5/8.0/8.0/8.0 收敛。
// resize 不变形由 centerLines 块感知保证（见下）。

export function hapilonLogo(): string[] {
  return [
    "      ▗▖",
    "    ▐▛███▜▌",
    "   ▝▜█████▛▘",
    "     ▘▘ ▝▝",
  ];
}

/** logo 专用 accent 通道，交给 Pi 主题在明暗终端中选择可读颜色。 */
export function isLogoLine(line: string): boolean {
  const inner = line.startsWith("│") && line.endsWith("│")
    ? line.slice(1, -1)
    : line;
  // 宽屏布局把左右列拼在同一行；这类行不能整行染成 logo accent。
  if (inner.includes("│")) return false;
  return /^\s*[▗▖▐▛█▜▝▘]/.test(inner);
}

// ─── Box Drawing ──────────────────────────────────────────────────────

const H_BAR = "─";
const TL = "╭";
const TR = "╮";
const BL = "╰";
const BR = "╯";
const V = "│";

export function drawBox(
  lines: string[],
  width: number,
  title?: string,
): string[] {
  // Guard: Pi's TUI renderer rejects lines wider than available width.
  // At width < 3, borders alone would overflow. Return empty to avoid crash.
  if (width < 3) return [];
  const innerW = width - 2;
  const result: string[] = [];

  if (title) {
    const remain = innerW - title.length;
    if (remain > 0) {
      result.push(TL + title + H_BAR.repeat(remain) + TR);
    } else {
      const display = title.length > innerW
        ? title.slice(0, innerW - 1) + "…"
        : title;
      result.push(TL + display.slice(0, innerW) + TR);
    }
  } else {
    result.push(TL + H_BAR.repeat(innerW) + TR);
  }

  for (const line of lines) {
    const trimmed = line.length > innerW ? line.slice(0, innerW) : line;
    const padded =
      trimmed + " ".repeat(Math.max(0, innerW - trimmed.length));
    result.push(V + padded + V);
  }

  result.push(BL + H_BAR.repeat(innerW) + BR);
  return result;
}

// ─── Column Layout ────────────────────────────────────────────────────

export function layoutColumns(
  left: string[],
  right: string[],
  width: number,
): string[] {
  // Guard: prevent RangeError on String.repeat(negative) at tiny widths
  if (width < 3) return [];
  if (width < 80) {
    const result: string[] = [...left];
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
  const result: string[] = [];

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

function isExtensionListLine(line: string, extensions: string[] | undefined): boolean {
  if (!extensions || extensions.length === 0) return false;
  const inner = line.startsWith(V) && line.endsWith(V)
    ? line.slice(1, -1)
    : line;
  const separator = inner.indexOf(" │ ");
  const right = separator >= 0 ? inner.slice(separator + 3) : inner;
  const trimmedRight = right.trimEnd();
  return extensions.some((extension) => trimmedRight === `  ${extension}`);
}

function colorStartupLine(
  line: string,
  theme: Theme,
  hasLinks: boolean,
): string {
  let colored = line;

  // Hyperlink: replace raw URL with clickable link (includes its own dim)
  if (hasLinks && colored.includes("pi.dev/changelog")) {
    colored = colored.replace(
      "pi.dev/changelog",
      hyperlink("pi.dev/changelog", "https://pi.dev/changelog"),
    );
  }

  // Headers — bold
  if (
    colored.includes("Tips for getting started") ||
    colored.includes("Extensions (")
  ) {
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
  // 判据对 boxed 行（│ 前缀）也要命中：trimStart 剥不掉边框字符，先剥 V。
  const bare = colored.startsWith(V) && colored.endsWith(V) ? colored.slice(1, -1) : colored;
  if (bare.trimStart().startsWith("※ +") && bare.includes(" dirs")) {
    return theme.fg("muted", colored);
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

export function parseExtensionsEnv(
  raw: string | undefined,
): string[] | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed as string[];
    }
  } catch {
    // fall through
  }
  console.warn(
    "[hpl-startup-header] Invalid HAPILON_EXTENSIONS env, ignoring",
  );
  return undefined;
}

// ─── Content Builders ─────────────────────────────────────────────────

function centerLine(line: string, maxWidth: number): string {
  if (line.length >= maxWidth) return line;
  const pad = Math.floor((maxWidth - line.length) / 2);
  return " ".repeat(pad) + line;
}

/**
 * 将多行文本在给定宽度内居中（左边补空格）。
 *
 * 首部连续非空行视为「块」（logo），整体共享 pad 居中——
 * 行间相对位置固定，resize 时整块平移不变形（修复 #27：
 * 逐行独立取整导致的行间抖动）。其余行保持独立居中。
 */
export function centerLines(lines: string[], maxWidth: number): string[] {
  let blockEnd = 0;
  while (blockEnd < lines.length && lines[blockEnd] !== "") blockEnd++;

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
 * 将 workspace 路径压缩为 header 友好格式；完整路径仍由 /workspace 展示。
 * home 下保留 ~ 和首段、末两段；其它绝对路径保留根下前两段和末段，
 * 使 /Volumes/Under_M2 这类工作盘锚点仍然可辨认。
 */
export function shortenWorkspacePath(cwd: string, homeDir: string): string {
  const normalizedCwd = cwd.replace(/[\\/]+$/, "") || cwd;
  const normalizedHome = homeDir.replace(/[\\/]+$/, "") || homeDir;
  const isHome = normalizedCwd === normalizedHome ||
    normalizedCwd.startsWith(`${normalizedHome}/`) ||
    normalizedCwd.startsWith(`${normalizedHome}\\`);

  if (isHome) {
    if (normalizedCwd === normalizedHome) return "~";
    const relative = normalizedCwd.slice(normalizedHome.length).replace(/^[\\/]+/, "");
    const parts = relative.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 3) return `~/${parts.join("/")}`;
    return `~/${parts[0]}/…/${parts.slice(-2).join("/")}`;
  }

  const isAbsolute = normalizedCwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalizedCwd);
  if (!isAbsolute) return normalizedCwd;
  const root = normalizedCwd.startsWith("/") ? "/" : "";
  const parts = normalizedCwd.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 3) return `${root}${parts.join("/")}`;
  const prefix = parts.slice(0, 2).join("/");
  return `${root}${prefix}/…/${parts.at(-1)}`;
}

export function buildLeftColumn(data: HeaderData): string[] {
  const left: string[] = [];

  for (const line of hapilonLogo()) {
    left.push(line);
  }
  left.push("");

  left.push("Welcome back!");

  if (data.modelProvider && data.modelName) {
    left.push(`${data.modelProvider} · ${data.modelName}`);
  } else {
    left.push("no model selected");
  }

  left.push(shortenWorkspacePath(data.cwd, data.homeDir));
  if ((data.addedDirsCount ?? 0) > 0) {
    left.push(`※ +${data.addedDirsCount} dirs`);
  }

  return left;
}

export function buildRightColumn(
  data: HeaderData,
  expanded: boolean,
): string[] {
  const right: string[] = [];

  // ── Tips（仅 expanded）──
  if (expanded) {
    right.push("Tips for getting started");
    right.push("  Run /context to check usage");
    right.push("  " + H_BAR.repeat(26));
  }

  // ── Extensions (N) + 扩展名列表（恒显示，验收 §右栏）──
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
  } else {
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
  } else {
    right.push("");
    right.push("ctrl+o for more");
  }

  return right;
}

/**
 * 构建完整 header 内容（含左/右栏），不包含外边框。
 * 合并 buildLeftColumn 与 buildRightColumn 的结果，方便测试和简单场景使用。
 */
export function buildHeaderLines(
  data: HeaderData,
  expanded: boolean,
): string[] {
  const left = buildLeftColumn(data);
  const right = buildRightColumn(data, expanded);
  const innerW = 78; // 80 - 2
  const sepLen = " │ ".length;
  const leftW = Math.floor((innerW - sepLen) * 0.55);
  return layoutColumns(centerLines(left, leftW), right, 80);
}

// ─── Component Factory ────────────────────────────────────────────────

export function createStartupHeader(
  ctx: {
    model?: { provider?: string; name?: string; id?: string } | undefined;
    cwd: string;
    sessionManager?: { getBranch(): readonly WorkspaceEntry[] };
  },
  _tui: TUI,
  theme: Theme,
  state: HeaderState,
): StartupHeaderComponent {
  return {
    render(width: number): string[] {
      const provider =
        ctx.model?.provider ?? process.env["HAPILON_MODEL_PROVIDER"];
      const modelName =
        ctx.model?.name ?? process.env["HAPILON_MODEL_NAME"];

      const data: HeaderData = {
        version: process.env["HAPILON_VERSION"],
        modelProvider: provider,
        modelName,
        cwd: ctx.cwd,
        homeDir: homedir(),
        addedDirsCount: readAddedWorkspaceDirs(
          ctx.sessionManager?.getBranch() ?? [],
        ).length,
        extensions: parseExtensionsEnv(
          process.env["HAPILON_EXTENSIONS"],
        ),
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
        if (line.length === 0) return line;

        let colored = line;

        if (isLogoLine(colored)) {
          return theme.fg("accent", colored);
        }

        // Hyperlink: replace raw URL with clickable link (includes its own dim)
        if (hasLinks && colored.includes("pi.dev/changelog")) {
          colored = colored.replace(
            "pi.dev/changelog",
            hyperlink("pi.dev/changelog", "https://pi.dev/changelog"),
          );
        }

        // 宽屏 logo 与右栏同行时，只给左段上 accent，右段继续走原分类管线。
        const columnSeparator = colored.indexOf(" │ ");
        if (
          columnSeparator >= 1 &&
          isLogoLine(colored.slice(1, columnSeparator))
        ) {
          const logoPart = theme.fg("accent", colored.slice(0, columnSeparator));
          const rightPart = colored.slice(columnSeparator);
          return logoPart + (
            isExtensionListLine(colored, data.extensions)
              ? theme.fg("muted", rightPart)
            : colorStartupLine(rightPart, theme, false)
          );
        }

        // 宽屏目录计数行与右栏拼合时，仅降低左段，不影响右栏信息层级。
        const leftPart = columnSeparator >= 0 ? colored.slice(0, columnSeparator) : colored;
        // 剥 V 边框后判定（trimStart 不剥边框字符，boxed 行需先去 │）。
        const bareLeft = leftPart.startsWith(V) && leftPart.endsWith(V) ? leftPart.slice(1, -1) : leftPart;
        if (bareLeft.trimStart().startsWith("※ +") && bareLeft.includes(" dirs")) {
          if (columnSeparator >= 0) {
            return theme.fg("muted", leftPart) + colorStartupLine(
              colored.slice(columnSeparator),
              theme,
              false,
            );
          }
          return theme.fg("muted", colored);
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

    setExpanded(expanded: boolean) {
      state.expanded = expanded;
    },
  };
}
