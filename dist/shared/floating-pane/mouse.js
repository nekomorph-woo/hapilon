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
// 全屏（alt-screen）下鼠标模式归 pi-tui 所有（?1000?1002?1003?1004?1006）：viewer 若在
// 关闭时写 MOUSE_OFF 会关掉 SGR 编码、留下 ?1002/?1003 悬空，此后滚轮事件以旧编码上报、
// 被 pi-tui 静默丢弃——滚动永久失效。因此全屏下一律不碰鼠标序列；只有 regular 模式
// （pi-tui 不开鼠标）才由 viewer 自己开关。
export function overlayMouseOn(tui) {
    if (!tui || tui.mode === "fullscreen")
        return;
    tui.terminal?.write(OVERLAY_MOUSE_ON);
}
export function overlayMouseOff(tui) {
    if (!tui || tui.mode === "fullscreen")
        return;
    tui.terminal?.write(MOUSE_OFF);
}
/**
 * 解析 SGR mouse event，返回 { button, col, row, press } 或 null。
 * button 64 = wheel up, 65 = wheel down
 */
export function parseMouseEvent(data) {
    const m = data.match(SGR_MOUSE_RE);
    if (!m)
        return null;
    return {
        button: parseInt(m[1], 10),
        col: parseInt(m[2], 10),
        row: parseInt(m[3], 10),
        press: m[4] === "M",
    };
}
