/**
 * mouse.ts — SGR mouse reporting 序列
 *
 * 与 pi-pop 相同：viewer 打开时启 mouse reporting 让滚轮滚动内容。
 * 使用 X10 (`?9h`) + SGR (`?1006h`) 而非 `?1000h`（避免某些 terminal snap viewport）。
 */

/** 启用 mouse reporting（滚轮按下事件） */
export const OVERLAY_MOUSE_ON = "\x1b[?1000h\x1b[?1006h";

/** 关闭所有 mouse mode */
export const MOUSE_OFF = "\x1b[?9l\x1b[?1000l\x1b[?1006l";

/** SGR mouse report: ESC [ < btn ; col ; row (M=press, m=release) */
export const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * 解析 SGR mouse event，返回 { button, col, row, press } 或 null。
 * button 64 = wheel up, 65 = wheel down
 */
export function parseMouseEvent(data: string): { button: number; col: number; row: number; press: boolean } | null {
  const m = data.match(SGR_MOUSE_RE);
  if (!m) return null;
  return {
    button: parseInt(m[1]!, 10),
    col: parseInt(m[2]!, 10),
    row: parseInt(m[3]!, 10),
    press: m[4] === "M",
  };
}
