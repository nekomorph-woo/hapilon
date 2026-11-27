import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attachToolTime } from "./tool-time.js";

/** 补丁（ensure-pi-patch 的 __hapiMessageTime 规则）调用钩子时传入的组件接面 */
export interface MessageComponent {
  /** 历史渲染传毫秒数；实时路径回落消息对象的 ISO 字串 */
  timestamp?: number | string;
  lastMessage?: { timestamp?: string };
  outputPad: number;
}

export interface ThemeLike {
  fg(slot: string, text: string): string;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 本地时间 MM-DD HH:mm:ss；年份对会话内的消息没有信息量 */
export function formatMessageTime(ts: number | string): string {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 时间戳行：暗色、与消息左缩进对齐、补满整行（Container 的行都是定宽）。
 * 流式期间建的组件没有 timestamp，回落消息对象上的；两者都没有就不出这一行。
 */
export function messageTimeLine(comp: MessageComponent, width: number, theme: ThemeLike): string | undefined {
  const ts = comp.timestamp ?? comp.lastMessage?.timestamp;
  if (ts === undefined) return undefined;
  return theme.fg("dim", " ".repeat(comp.outputPad).concat(formatMessageTime(ts)).padEnd(width));
}

// 每条 user / assistant 消息上方一行时间戳，每个工具块顶部的空行换成开始时刻与耗时。
// 钩子由补丁在消息组件与工具组件里调用；钩子缺席（裸 pi、print 模式、settings.messageTime=false）
// 时补丁回落原样。
export default function messageTime(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const theme = ctx.ui?.theme as ThemeLike | undefined;
    const enabled = (pi.getSettings() as Record<string, unknown>).messageTime !== false;
    const g = globalThis as unknown as Record<string, unknown>;
    g.__hapiMessageTime = enabled && theme?.fg
      ? (comp: MessageComponent, width: number) => messageTimeLine(comp, width, theme)
      : undefined;
    g.__hapiToolTime = enabled && theme?.fg ? attachToolTime(theme) : undefined;
  });
}
