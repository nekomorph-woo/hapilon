/**
 * hpl-blocked-files — 禁止读取/检索指定 agent 指令文件（默认 CLAUDE.md、AGENTS.md）
 *
 * 背景：hapi 已不把这些文件加载进上下文，但文件还在项目里，read/搜索/bash
 * 仍能碰到内容。本扩展在两个层面封死：
 *   tool_call   — read 路径命中 → 硬 block；bash/powershell 命令点名 → 硬 block；
 *                 带 exclude 入参的搜索工具（ffgrep/fffind 等）原地注入排除项
 *   tool_result — 工具文本输出里的禁文件路径行与 rg 命中行按行过滤，
 *                 兜住 pi 内置 grep/find（无 exclude 入参）与 ls
 *
 * ponytail: bash 通配符读取（cat *.md）不点名文件、输出是纯文本，拦不住；
 * 出现真实泄漏案例再考虑在 bash 输出层做内容指纹比对。
 */

import { basename } from "node:path";
import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { notify } from "../notify.js";

export const BLOCKED_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternation = BLOCKED_FILES.map(escapeRegExp).join("|");

// 纯路径行：行尾是禁文件名，前面是路径分隔符或空白（覆盖 find/ls 路径行与 ls -la）
const PATH_LINE_RE = new RegExp(`(?:^|[\\\\/\\s])(?:${alternation})$`, "i");
// rg/grep 命中行：路径段后跟 :行号 或 -行号（上下文行）
const HIT_LINE_RE = new RegExp(`(?:^|[\\\\/])(?:${alternation})[:\\-]\\d`, "i");
// bash/powershell 命令点名禁文件。大小写不敏感：macOS/Windows 文件系统不区分大小写
const COMMAND_RE = new RegExp(`\\b(?:${alternation})\\b`, "i");

/** read 的 path 是否指向禁文件；命中返回规范名 */
export function matchBlockedReadPath(p: string | undefined): string | null {
  const name = basename(p ?? "");
  return BLOCKED_FILES.find((n) => n.toLowerCase() === name.toLowerCase()) ?? null;
}

/** 命令字符串是否点名禁文件；命中返回命中的名字 */
export function matchBlockedCommand(command: string): string | null {
  const m = command.match(COMMAND_RE);
  return m ? m[0] : null;
}

/** 输出行是否引用禁文件（路径行或 rg 命中行） */
export function matchBlockedPathLine(line: string): boolean {
  const t = line.trim();
  return PATH_LINE_RE.test(t) || HIT_LINE_RE.test(t);
}

/** 给带 exclude 入参的搜索工具原地追加排除项（fff 系列接受 string | string[]） */
export function injectExclude(input: Record<string, unknown>): void {
  const names = [...BLOCKED_FILES];
  const cur = input.exclude;
  if (typeof cur === "string") input.exclude = `${cur},${names.join(",")}`;
  else if (Array.isArray(cur)) input.exclude = [...cur, ...names];
  else input.exclude = names;
}

/** 按行过滤工具文本输出 */
export function filterBlockedLines(text: string): { text: string; removed: number } {
  const lines = text.split("\n");
  const kept = lines.filter((l) => !matchBlockedPathLine(l));
  return { text: kept.join("\n"), removed: lines.length - kept.length };
}

// 支持 exclude 入参的搜索工具（@ff-labs/pi-fff 注册的自定义工具；exclude 是
// 可选字段，模型没传时 input 上无此 key，只能按工具名判断）。
// pi 内置 grep/find 无 exclude 参数，不动入参，靠 tool_result 过滤兕底。
const EXCLUDE_TOOLS: ReadonlySet<string> = new Set(["ffgrep", "fffind", "ln", "fff-multi-grep"]);

const denyReason = (name: string) =>
  `🚫 ${name} 是被禁止访问的文件（其它 agent 工具的指令文件），禁止读取、检索或列出。请不涉及该文件继续当前任务。`;

// 抽出事件处理函数便于单测；default export 仅是注册壳
export async function handleToolCallEvent(event: ToolCallEvent): Promise<{ block: true; reason: string } | undefined> {
  if (isToolCallEventType("read", event)) {
    const hit = matchBlockedReadPath(event.input.path);
    if (hit) {
      notify(`[hpl-blocked-files] 已拦截 read：${event.input.path}`);
      return { block: true, reason: denyReason(hit) };
    }
    return;
  }

  if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
    const hit = matchBlockedCommand(event.input.command ?? "");
    if (hit) {
      notify(`[hpl-blocked-files] 已拦截命令（引用 ${hit}）`);
      return { block: true, reason: denyReason(hit) };
    }
    return;
  }

  if (EXCLUDE_TOOLS.has(event.toolName)) injectExclude(event.input as Record<string, unknown>);
}

export async function handleToolResultEvent(event: ToolResultEvent): Promise<{ content: ToolResultEvent["content"] } | undefined> {
  let removed = 0;
  const content = event.content.map((c) => {
    if (c.type !== "text") return c;
    const r = filterBlockedLines(c.text);
    removed += r.removed;
    return r.removed > 0 ? { ...c, text: r.text } : c;
  });
  if (removed > 0) {
    notify(`[hpl-blocked-files] 已从 ${event.toolName} 结果过滤 ${removed} 行（禁文件相关）`);
    return { content };
  }
  return;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", handleToolCallEvent);
  pi.on("tool_result", handleToolResultEvent);
}
