/**
 * options.ts — FloatingPane 配置类型
 */

export interface FloatingPaneOptions {
  /** 窗口标题（显示在顶部边框） */
  title: string;
  /** 内容行（支持 ANSI color codes） */
  lines: string[];
  /** 底部状态行 */
  footer?: string;
  /** 浮层宽度，默认 "90%"（如 70、80、"80%"） */
  width?: number | string;
  /** 浮层最大高度（终端百分比），默认 85 */
  maxHeight?: number;
}
