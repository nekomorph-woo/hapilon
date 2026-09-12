import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/**
 * options.ts — FloatingPane 配置类型
 */

export interface FloatingPaneOptions {
  /** 窗口标题（显示在顶部边框） */
  title: string;
  /** 内容行（支持 ANSI color codes） */
  lines: string[];
  /** 内容行主题槽位；与 lines 按索引对应，未提供时保持原始文本。 */
  lineStyles?: Array<Extract<ThemeColor, "text" | "muted" | "warning" | "error"> | undefined>;
  /** 底部状态行 */
  footer?: string;
  /** 浮层宽度：数字列数、百分比字符串，或 "fit-content"（按内容最宽行自适应，上限终端宽），默认 "90%" */
  width?: number | string | "fit-content";
  /** 浮层最大高度（终端百分比），默认 85 */
  maxHeight?: number;
}
