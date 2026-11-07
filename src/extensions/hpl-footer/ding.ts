/**
 * ding.ts — footer 上下文占用徽章（纯函数）
 *
 * 盲文点阵水位条：8 点对应 0-100%，从底部逐层点亮；
 * 未知占用显示 `<?>`；≥80% 进入呼吸档：满格烧开轮换 + 背景呼吸。
 */

export type RGB = readonly [number, number, number];

/** 呼吸档阈值：≥80% 换烧开轮换 + 背景起伏；低于此值为静态水位点阵 */
const BREATH_START = 80;
/** 字符轮换拍周期 ms */
const GLYPH_STEP_MS = 1500;
/** 背景亮度呼吸拍周期 ms：与字符拍错开（1.5s vs 3s），两个节奏各自可辨 */
const BG_STEP_MS = 3000;
/** 盲文点阵四态：全亮起，右上逐拍熄灭再复位（烧开冒泡感） */
const BREATH_GLYPHS = ["⣿", "⣾", "⣽", "⣼"] as const;
/** 盲文水位点阵：8 点对应 0-100%（每 12.5% 一档），从底部逐层点亮；0 档留 1 点作心跳标记，避免看起来像空白坏了 */
const LEVEL_GLYPHS = ["⡀", "⡀", "⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"] as const;

function breathing(percent: number | null): boolean {
  return percent !== null && percent >= BREATH_START;
}

function breathBeat(nowMs: number, stepMs: number): number {
  return Math.floor(nowMs / stepMs) % 4;
}

/** 徽章字符：未知 `<?>`；低于呼吸档为静态水位点阵；呼吸档为烧开轮换。 */
export function dingGlyph(percent: number | null, nowMs: number = Date.now()): string {
  if (percent === null) return "<?>";
  if (percent < BREATH_START) {
    const n = Math.min(8, Math.max(0, Math.round((percent / 100) * 8)));
    return `<${LEVEL_GLYPHS[n]}>`;
  }
  return `<${BREATH_GLYPHS[breathBeat(nowMs, GLYPH_STEP_MS)]}>`;
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
 * 两端半角尖括号包裹徽章；
 * 字色仍按未调制基色算：80–90 段的 RED 提亮会跨亮度阈值，字色随拍翻转是闪烁事故。
 */
export function renderDing(percent: number | null, nowMs: number = Date.now()): string {
  const label = dingGlyph(percent, nowMs);
  if (!label) return "";
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
