/**
 * ding.ts — [HOT] 上下文占用指示灯（纯函数）
 *
 * 文案分级 + 四段渐变背景色 + 亮度自适应字色。
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

/** 呼吸档阈值：≥80% 徽章换盲文点阵轮换 + 背景起伏 */
const BREATH_START = 80;
/** 字符轮换拍周期 ms */
const GLYPH_STEP_MS = 1500;
/** 背景亮度呼吸拍周期 ms：与字符拍错开（1.5s vs 3s），两个节奏各自可辨 */
const BG_STEP_MS = 3000;
/** 盲文点阵四态：全亮起，右下两点逐拍熄灭再复位 */
const BREATH_GLYPHS = ["⣿", "⣾", "⣽", "⣼"] as const;

function breathing(percent: number | null): boolean {
  return percent !== null && percent >= BREATH_START;
}

function breathBeat(nowMs: number, stepMs: number): number {
  return Math.floor(nowMs / stepMs) % 4;
}

/** 呼吸档输出轮换中的盲文字符（括号圆角近似，3 列），非呼吸档维持 [HOT] 文案；
 * index.ts 拿它做占位文本，宽度与 renderDing 输出一致，同一 nowMs 保证同拍。 */
export function dingGlyph(percent: number | null, nowMs: number = Date.now()): string {
  if (!breathing(percent)) return dingLabel(percent);
  return `(${BREATH_GLYPHS[breathBeat(nowMs, GLYPH_STEP_MS)]})`;
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

/** 组合文案与颜色，输出真彩 ANSI 包裹的最终字符串；无背景时输出纯文案。
 *
 * ≥80% 进入呼吸档：徽章文字换盲文字符四态轮换（⣿⣾⣽⣼，1.5s 一拍，只动右下两点，烧开冒泡感），
 * 背景亮度独立按 3s 拍起伏——快拍动字、慢拍动色，两个节奏视觉上可区分；
 * 两端半角括号做圆角近似（终端背景色块无真圆角）；
 * 字色仍按未调制基色算：80–90 段的 RED 提亮会跨亮度阈值，字色随拍翻转是闪烁事故。
 */
export function renderDing(percent: number | null, nowMs: number = Date.now()): string {
  const label = dingGlyph(percent, nowMs);
  const { bg, fg } = dingColor(percent);
  if (!bg || !fg) return label;
  const gain = breathing(percent)
    ? [1, 1.25, 1, 0.82][breathBeat(nowMs, BG_STEP_MS)]
    : 1;
  const bgNow: RGB = gain === 1 ? bg : [
    Math.min(255, Math.round(bg[0] * gain)),
    Math.min(255, Math.round(bg[1] * gain)),
    Math.min(255, Math.round(bg[2] * gain)),
  ];
  return `\x1b[48;2;${bgNow[0]};${bgNow[1]};${bgNow[2]}m\x1b[38;2;${fg[0]};${fg[1]};${fg[2]}m${label}\x1b[0m`;
}
