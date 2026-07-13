/**
 * safety-gate.ts — 危险命令拦截扩展
 *
 * 通过 pi.on("tool_call", ...) 拦截 bash 工具调用，按风险等级：
 *   - BLOCK：高危命令直接阻止（rm -rf /~/*、sudo、mkfs、dd、fork bomb、chmod 777 /、
 *     chown -R /、输出重定向到块设备）
 *   - CONFIRM：中危命令弹确认框（rm -rf 非根、git push --force、curl|sh 等）
 *   - ALLOW：正常命令直接放行
 *
 * 外加 shell 注入检测（反引号、$()、<()、>()等）→ 直接 block。
 *
 * 用法: hapilon 启动时自动加载（discoverExtensions() → -e 注入）
 * 来源: doc/pi-wiki.md §4.3 tool_call 事件
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

// ─── Block 模式（高危）───────────────────────────────────────────────

const BLOCK_PATTERNS: Array<{ test: (cmd: string) => boolean; label: string }> = [
  // rm -rf / 及其变体（含 ~ 和 /*）
  {
    test: (c) => /\b(?:sudo\s+)?rm\s+-rf\s+(\/|~|\/\*)/.test(c),
    label: "rm -rf 根目录/home",
  },
  // mkfs 系列
  {
    test: (c) => /\bmkfs\.\w+/.test(c),
    label: "mkfs 格式化命令",
  },
  // dd 写入块设备
  {
    test: (c) => /\bdd\b.*\bof=\/dev\//.test(c),
    label: "dd 写入块设备",
  },
  // chmod 777 / 或 chmod -R 777 / 或 chmod 符号模式提权 /
  {
    test: (c) => /\bchmod\s+(-R\s+)?(777|0777)\s+\//.test(c) ||
      /\bchmod\s+.*\b[augo]+[+-=][rwxXst]+\s+\//.test(c),
    label: "chmod 提权根目录",
  },
  // chown -R /
  {
    test: (c) => /\bchown\s+-R\s+\//.test(c),
    label: "chown -R 根目录",
  },
  // 输出重定向到块设备（覆盖 sd/hd/xvd/vd/nvme/mmcblk/disk/dm 前缀）
  {
    test: (c) => />\s*\/dev\/(sd[a-z]+|nvme\w+|hd[a-z]+|xvd[a-z]+|vd[a-z]+|mmcblk\d+|disk\d+|dm-\d+)/.test(c),
    label: "输出重定向到块设备",
  },
  // fork bomb（容忍内部空格变体）
  {
    test: (c) => /:\(\)\s*\{\s*:\|\s*:\s*&\s*\};:/.test(c.replace(/\s+/g, " ")),
    label: "fork bomb",
  },
];

// ─── Confirm 模式（中危）─────────────────────────────────────────────

const CONFIRM_PATTERNS: Array<{ test: (cmd: string) => boolean; label: string }> = [
  // rm -rf（非根/~/home 目录）
  {
    test: (c) => /\brm\s+-rf\b/.test(c) && !/\brm\s+-rf\s+(\/|~|\/\*)/.test(c),
    label: "rm -rf",
  },
  // git push --force / --force-with-lease
  {
    test: (c) => /\bgit\s+push\s+.*--force/.test(c),
    label: "git push --force",
  },
  // curl/wget 管道到 sh/bash（含 sudo sh 变体）
  {
    test: (c) => /\b(curl|wget)\b.+\|\s*(sudo\s+)?\s*(sh|bash)\b/.test(c),
    label: "curl/wget 管道到 shell",
  },
  // chmod 777/0777 或符号模式提权（非根目录）
  {
    test: (c) => (
      /\bchmod\s+(777|0777)\b/.test(c) ||
      /\bchmod\s+.*\b[augo]+[+-=][rwxXst]+\b/.test(c)
    ) && !/\bchmod\s+(-R\s+)?(777|0777)\s+\//.test(c) &&
      !/\bchmod\s+.*\b[augo]+[+-=][rwxXst]+\s+\//.test(c),
    label: "chmod 提权",
  },
  // git reset --hard
  {
    test: (c) => /\bgit\s+reset\s+--hard\b/.test(c),
    label: "git reset --hard",
  },
  // docker rm -f / --force
  {
    test: (c) => /\bdocker\s+rm\s+(-f\b|--force\b)/.test(c),
    label: "docker rm -f",
  },
  // eval（独立词匹配）
  {
    test: (c) => /\beval\b/.test(c),
    label: "eval",
  },
];

// ─── Shell 注入检测 ─────────────────────────────────────────────────

const SHELL_INJECTION_PATTERNS: RegExp[] = [
  /`/,     // 反引号命令替换
  /\$\(/,  // $() 命令替换
  /<\(/,   // <() 进程替换
  />\(/,   // >() 进程替换
];

// ─── 纯函数（导出供测试）───────────────────────────────────────────

export type SafetyVerdict = "block" | "confirm" | "allow";

/**
 * 对 bash 命令进行安全分类。
 *
 * 检查顺序：
 * 1. shell 注入检测 → block（优先级最高）
 * 2. block 模式匹配 → block
 * 3. confirm 模式匹配 → confirm
 * 4. 其他 → allow
 */
export function classifyCommand(command: string): SafetyVerdict {
  const trimmed = command.trim();
  if (!trimmed) return "allow";

  // shell 注入直接 block
  if (hasShellInjection(trimmed)) return "block";

  // 高危 block（优先级高于 confirm）
  for (const pattern of BLOCK_PATTERNS) {
    if (pattern.test(trimmed)) return "block";
  }

  // 中危 confirm
  for (const pattern of CONFIRM_PATTERNS) {
    if (pattern.test(trimmed)) return "confirm";
  }

  return "allow";
}

/**
 * 检测命令中是否包含 shell 注入技巧（反引号、$()、<()、>()）。
 */
export function hasShellInjection(command: string): boolean {
  if (!command) return false;
  return SHELL_INJECTION_PATTERNS.some((re) => re.test(command));
}

// ─── 扩展入口 ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // 只拦截 bash 工具
    if (!isToolCallEventType("bash", event)) return;

    const command: string = event.input.command;
    if (!command) return;

    const verdict = classifyCommand(command);
    if (verdict === "allow") return;

    // block：直接阻止
    if (verdict === "block") {
      return {
        block: true,
        reason: `🛡️ 危险命令已阻止：${command.slice(0, 120)}`,
      };
    }

    // confirm：弹确认框
    if (!ctx.hasUI) {
      // 非交互模式无法确认 → 安全侧拒绝
      return {
        block: true,
        reason: `🛡️ 非交互模式下拦截中危命令：${command.slice(0, 120)}`,
      };
    }

    try {
      const approved = await ctx.ui.confirm(
        "⚠️ 危险操作确认",
        `检测到潜在危险操作：\n\n> ${command.slice(0, 200)}\n\n是否仍然执行？`,
      );
      if (!approved) {
        return {
          block: true,
          reason: `用户拒绝了此操作：${command.slice(0, 120)}`,
        };
      }
    } catch (err) {
      // confirm 调用异常 → 安全侧拒绝，但保留日志可观测
      console.warn("安全确认对话框异常:", err instanceof Error ? err.message : String(err));
      return {
        block: true,
        reason: `🛡️ 确认对话框异常，已阻止：${command.slice(0, 120)}`,
      };
    }
  });
}
