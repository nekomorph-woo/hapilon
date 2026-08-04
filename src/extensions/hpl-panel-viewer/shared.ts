/**
 * shared.ts — 全局 state + config 默认值 + 常量
 *
 * 与 pi-pop 同模式：单对象跨模块共享，无 live-binding 体操。
 */

/** 面板状态 gutter 标记：展开 ▼ / 折叠 ▶ */
export function panelMarker(expanded: boolean): string {
  return expanded ? "▼" : "▶";
}
export const POP_ICON = "▣";

/** 扫描间隔(ms) */
export const SWEEP_MS = 300;

/** 默认快捷键 */
export const DEFAULT_KEYS = ["shift+alt+down", "ctrl+q"];
/** 默认折叠行数上限（0=关闭） */
export const DEFAULT_MAX_LINES = 5;

/** 用户配置（运行时态，由 config.ts 持久化到 ~/.hapilon/config.json） */
export const config = {
  include: [] as string[],
  exclude: [] as string[],
  keys: [...DEFAULT_KEYS],
  maxLines: DEFAULT_MAX_LINES,
};

/** 全局跨模块共享状态 */
export const state: {
  openViewer: ((target?: unknown) => void) | null;
  activeViewer: { scrollBy(n: number): void } | null;
  activeTui: unknown;
  viewerOpen: boolean;
} = {
  openViewer: null,
  activeViewer: null,
  activeTui: null,
  viewerOpen: false,
};
