/**
 * ding.ts — [HOT] 上下文占用指示灯（纯函数）
 *
 * 文案分级 + 四段渐变背景色 + 亮度自适应字色。
 * 设计来源: _plans/hpl-footer-custom.md §3.2（spec #21: 文案 DING → HOT）
 */

export type RGB = readonly [number, number, number];

/** 按占用率返回 [HOT] 文案（含感叹号分级） */
export function dingLabel(percent: number | null): string {
  if (percent === null) return "[HOT]";
  if (percent >= 95) return "[HOT!!!!!]";
  if (percent >= 90) return "[HOT!!!!]";
  if (percent >= 85) return "[HOT!!!]";
  if (percent >= 80) return "[HOT!!]";
  if (percent >= 70) return "[HOT!]";
  return "[HOT]";
}

// ─── 渐变色 ─────────────────────────────────────────────────────────

const DARK_YELLOW: RGB = [64, 52, 0];
const YELLOW: RGB = [255, 200, 0];
const RED: RGB = [220, 40, 30];
const DARK_RED: RGB = [139, 0, 0];

/** 黑字（配亮背景）/ 白字（配暗背景） */
const FG_DARK: RGB = [30, 30, 30];
const FG_LIGHT: RGB = [245, 245, 245];

/** 相对亮度阈值（0-255 尺度）：高于此值视为亮背景 */
const LUMINANCE_THRESHOLD = 140;

function lerp(from: RGB, to: RGB, t: number): RGB {
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ];
}

/**
 * 按占用率返回背景色 + 自适应字色。
 *
 * 分段插值：
 *   p ≤ 0 或 null → 无背景
 *   (0, 70]  暗黄 → 正黄
 *   (70, 90] 正黄 → 红
 *   (90, 95] 红 → 深红
 *   > 95     深红恒定
 */
export function dingColor(percent: number | null): { bg: RGB | null; fg: RGB | null } {
  if (percent === null || percent <= 0) return { bg: null, fg: null };

  let bg: RGB;
  if (percent <= 70) {
    bg = lerp(DARK_YELLOW, YELLOW, percent / 70);
  } else if (percent <= 90) {
    bg = lerp(YELLOW, RED, (percent - 70) / 20);
  } else if (percent <= 95) {
    bg = lerp(RED, DARK_RED, (percent - 90) / 5);
  } else {
    bg = DARK_RED;
  }

  const luminance = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2];
  const fg = luminance > LUMINANCE_THRESHOLD ? FG_DARK : FG_LIGHT;
  return { bg, fg };
}

/** 组合文案与颜色，输出真彩 ANSI 包裹的最终字符串；无背景时输出纯文案 */
export function renderDing(percent: number | null): string {
  const label = dingLabel(percent);
  const { bg, fg } = dingColor(percent);
  if (!bg || !fg) return label;
  return `\x1b[48;2;${bg[0]};${bg[1]};${bg[2]}m\x1b[38;2;${fg[0]};${fg[1]};${fg[2]}m${label}\x1b[0m`;
}
