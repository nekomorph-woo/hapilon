/**
 * content.ts — 纯函数：header 内容构建 + 布局
 *
 * 双布局随机（与猫猫随机同机制）：
 *   A = 猫左 + 状态右（collapsed 一行 / expanded 完整面板）
 *   B = 猫居中 + 底部信息条（collapsed 一行横带 / expanded 多行面板）
 *
 * 数据与渲染分离，所有业务逻辑无副作用可单测。
 */

import { notify } from "../notify.js";
import type { TUI } from "@earendil-works/pi-tui";
import { hyperlink, getCapabilities } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";

// ─── Types ────────────────────────────────────────────────────────────

export interface HeaderData {
  version: string | undefined;
  modelProvider: string | undefined;
  modelName: string | undefined;
  cwd: string;
  homeDir: string;
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
// 首屏 logo：8 只盲文点阵猫，每次启动随机出现一只。
// 点阵图取自参考图直接降采样编码（2×4 点/字符），8 行 × 10 列恒定，
// 因此换图不会改变首屏布局高度。新增图案只需往 LOGOS 里加一组等长行。

const LOGOS: readonly string[][] = [
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
    "⠀⠀⢸⣿⣿⣿⠀⠀⠀⠀",
    "⠀⠀⠈⣹⣿⣿⣄⠀⢠⣄",
    "⣼⣷⠄⢿⣿⣿⣿⡄⠀⣿",
    "⢶⣷⠀⣼⣿⣿⣿⣣⡴⠋",
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

// 模块加载时定一只 + 定一个布局：resize / 重绘复用同一只，不会闪跳。
const LOGO_INDEX = Math.floor(Math.random() * LOGOS.length);


/**
 * V2 撞色：猫身保持主题 accent，只给小元素换色——warning（黄）给月/蝶/窗
 * 这类发光体与小生物，error 给尾巴，dim 给地面/草地/窗台。撞色面积压在
 * 小元素上（小面积点缀），主体轮廓不花。
 */
export type LogoPaint = readonly (readonly [
  row: number,
  start: number,
  end: number,
  token: ThemeColor,
])[];

// 与 LOGOS 一一对应；区间 [start, end) 按 LOGOS 行的盲文字符下标。
const LOGO_PAINTS: readonly LogoPaint[] = [
  // 0 坐姿：左侧翘尾 + 地面阴影线
  [[5, 0, 3, "error"], [6, 0, 3, "error"], [7, 0, 9, "dim"]],
  // 1 坐姿+月：右上月牙 + 尾尖 + 地面
  [[0, 8, 10, "warning"], [1, 8, 10, "warning"], [6, 7, 9, "error"], [7, 0, 9, "dim"]],
  // 2 窗边：右侧小窗框 + 底部台面线
  [[5, 6, 8, "warning"], [6, 0, 9, "dim"]],
  // 3 窗前：左侧竖尾 + 右侧窗沿
  [[3, 0, 1, "error"], [4, 0, 2, "error"], [5, 0, 2, "error"], [3, 8, 10, "warning"], [4, 9, 10, "warning"]],
  // 4 蜷猫：左上小尾巴 + 蜷卧地面线
  [[3, 1, 4, "error"], [6, 1, 9, "dim"]],
  // 5 瘦高：右下整条垂尾
  [[5, 6, 9, "error"], [6, 5, 9, "error"], [7, 4, 7, "error"]],
  // 6 窗台：猫爪两侧的窗台横线
  [[5, 0, 2, "dim"], [5, 6, 10, "dim"]],
  // 7 草地+蝶：右上蝴蝶 + 左侧翘尾 + 草叶与草地
  [[1, 8, 10, "warning"], [2, 8, 10, "warning"], [4, 1, 3, "error"], [5, 1, 3, "error"], [5, 8, 10, "dim"], [6, 0, 10, "dim"]],
];

/**
 * 给一行 logo 上色：默认 accent，命中区间的字符段换各自槽位。
 * line 可能带外框边框与居中 pad，区间相对盲文首字符，定位不受影响；
 * 区间越出行尾时安全截断。同一行的区间须互不重叠且按起点升序（数据保证）。
 */
export function paintLogoLine(
  line: string,
  paint: LogoPaint,
  row: number,
  theme: Theme,
): string {
  const logoStart = line.search(/[\u2580-\u259F\u2800-\u28FF]/);
  if (logoStart < 0) return theme.fg("accent", line);
  const hits = paint
    .filter(([r]) => r === row)
    .map(([, s, e, token]) => ({ from: logoStart + s, to: logoStart + e, token }));
  let out = "";
  let cursor = 0;
  for (const h of hits) {
    if (h.from >= line.length) break;
    if (h.from > cursor) out += theme.fg("accent", line.slice(cursor, h.from));
    const end = Math.min(h.to, line.length);
    out += theme.fg(h.token, line.slice(h.from, end));
    cursor = end;
  }
  out += cursor < line.length ? theme.fg("accent", line.slice(cursor)) : "";
  return out;
}

export function hapilonLogo(): string[] {
  return [...LOGOS[LOGO_INDEX]!];
}

/** 布局常量：B（猫居中+底部条）。保留导出以兼容测试。 */
export function currentLayoutIndex(): number {
  return 1;
}

// ─── 共享工具 ─────────────────────────────────────────────────────────

const H_BAR = "─";

function isLogoLine(line: string): boolean {
  return /[\u2580-\u259F\u2800-\u28FF]/.test(line);
}

function isExtensionListLine(line: string, extensions: string[] | undefined): boolean {
  if (!extensions || extensions.length === 0) return false;
  return extensions.some((ext) => line.includes(ext));
}

export function parseExtensionsEnv(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).slice(0, 30) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 将 workspace 路径压缩为 header 友好格式。
 * home 下保留 ~ 和首段、末两段；其它绝对路径保留根下前两段和末段。
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

/** 一行状态摘要：hapi vX.Y.Z · provider/model · 路径 */
function statusLine(data: HeaderData): string {
  const parts: string[] = [];
  if (data.version) parts.push(`hapilon v${data.version}`);
  if (data.modelProvider && data.modelName) {
    parts.push(`${data.modelProvider}/${data.modelName}`);
  }
  parts.push(shortenWorkspacePath(data.cwd, data.homeDir));
  return parts.join(" · ");
}

/** 展开面板的信息行（扩展/版本/快捷键） */
function expandedInfoLines(data: HeaderData): string[] {
  const lines: string[] = [];
  if (data.extensions && data.extensions.length > 0) {
    lines.push(`Extensions (${data.extensions.length})`);
    for (const ext of data.extensions) {
      lines.push(`  ${ext}`);
    }
    lines.push("");
  }
  if (data.piUpdate) {
    lines.push(`Pi ${data.piUpdate} available · pi.dev/changelog`);
  }
  lines.push("");
  lines.push("esc interrupt · ctrl+c/d exit · shift+tab thinking · ctrl+p model · / commands · ! bash");
  return lines;
}

// ─── 布局 B：猫居中 + 底部信息条 ─────────────────────────────────────

function buildLayoutB(data: HeaderData, expanded: boolean, width: number): string[] {
  const logo = hapilonLogo();
  const lines: string[] = [];
  const logoWidth = Math.max(...logo.map((l) => l.length));
  const leftPad = Math.max(1, Math.floor((width - logoWidth) / 2));

  // 猫居中
  for (const row of logo) {
    lines.push(" ".repeat(leftPad) + row);
  }
  lines.push("");

  if (!expanded) {
    const bar = H_BAR.repeat(Math.min(width - 4, 60));
    const barPad = Math.max(1, Math.floor((width - bar.length) / 2));
    lines.push(" ".repeat(barPad) + bar);
    const status = statusLine(data) + " · ctrl+o expand";
    const statusPad = Math.max(1, Math.floor((width - status.length) / 2));
    lines.push(" ".repeat(Math.max(0, statusPad)) + status);
  } else {
    const bar = H_BAR.repeat(Math.min(width - 4, 60));
    const barPad = Math.max(1, Math.floor((width - bar.length) / 2));
    lines.push(" ".repeat(barPad) + bar);
    for (const info of expandedInfoLines(data)) {
      const infoPad = Math.max(1, Math.floor((width - info.length) / 2));
      lines.push(" ".repeat(Math.max(0, infoPad)) + info);
    }
  }
  return lines;
}

// ─── 上色 ─────────────────────────────────────────────────────────────

function colorStartupLine(line: string, theme: Theme): string {
  const trimmed = line.trim();
  if (trimmed === "") return line;
  if (line.startsWith("─")) return theme.fg("border", line);
  if (trimmed.startsWith("ctrl+o")) return theme.fg("dim", line);
  if (trimmed.startsWith("esc ")) return theme.fg("muted", line);
  if (trimmed.startsWith("Extensions")) return theme.fg("text", line);
  if (trimmed.startsWith("Pi ")) return theme.fg("muted", line);
  if (/^hapilon v/.test(trimmed)) return theme.fg("text", line);
  return theme.fg("text", line);
}

// ─── Component Factory ────────────────────────────────────────────────

export function createStartupHeader(
  ctx: {
    model?: { provider?: string; name?: string; id?: string } | undefined;
    cwd: string;
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
        extensions: parseExtensionsEnv(
          process.env["HAPILON_EXTENSIONS"],
        ),
        piUpdate: state.piUpdate,
      };

      const raw = buildLayoutB(data, state.expanded, width);

      // 上色：logo 行走撞色管线，其余行走文本管线
      let logoRow = 0;
      return raw.map((line) => {
        if (line.trim() === "") return line;
        if (isLogoLine(line)) {
          return paintLogoLine(line, LOGO_PAINTS[LOGO_INDEX]!, logoRow++, theme);
        }
        // Hyperlink: 版本更新行
        if (getCapabilities().hyperlinks && line.includes("pi.dev/changelog")) {
          return colorStartupLine(
            line.replace("pi.dev/changelog", hyperlink("pi.dev/changelog", "https://pi.dev/changelog")),
            theme,
          );
        }
        return colorStartupLine(line, theme);
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
