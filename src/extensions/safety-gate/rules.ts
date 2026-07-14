/**
 * rules.ts — 危险命令规则定义
 *
 * BLOCK_PATTERNS — 高危命令（永远阻止）
 * CONFIRM_PATTERNS — 中危命令（弹确认框）
 * SHELL_INJECTION_PATTERNS — shell 注入技巧检测
 */

export const BLOCK_PATTERNS: Array<{ test: (cmd: string) => boolean; label: string }> = [
  {
    test: (c) => /\b(?:sudo\s+)?rm\s+-rf\s+(\/|~|\/\*)/.test(c),
    label: "rm -rf 根目录/home",
  },
  {
    test: (c) => /\bmkfs\.\w+/.test(c),
    label: "mkfs 格式化命令",
  },
  {
    test: (c) => /\bdd\b.*\bof=\/dev\//.test(c),
    label: "dd 写入块设备",
  },
  {
    test: (c) => /\bchmod\s+(-R\s+)?(777|0777)\s+\//.test(c) ||
      /\bchmod\s+.*\b[augo]+[+-=][rwxXst]+\s+\//.test(c),
    label: "chmod 提权根目录",
  },
  {
    test: (c) => /\bchown\s+-R\s+\//.test(c),
    label: "chown -R 根目录",
  },
  {
    test: (c) => />\s*\/dev\/(sd[a-z]+|nvme\w+|hd[a-z]+|xvd[a-z]+|vd[a-z]+|mmcblk\d+|disk\d+|dm-\d+)/.test(c),
    label: "输出重定向到块设备",
  },
  {
    test: (c) => /:\(\)\s*\{\s*:\|\s*:\s*&\s*\};:/.test(c.replace(/\s+/g, " ")),
    label: "fork bomb",
  },
];

export const CONFIRM_PATTERNS: Array<{ test: (cmd: string) => boolean; label: string }> = [
  {
    test: (c) => /\brm\s+-rf\b/.test(c) && !/\brm\s+-rf\s+(\/|~|\/\*)/.test(c),
    label: "rm -rf",
  },
  {
    test: (c) => /\bgit\s+push\s+.*--force/.test(c),
    label: "git push --force",
  },
  {
    test: (c) => /\b(curl|wget)\b.+\|\s*(sudo\s+)?\s*(sh|bash)\b/.test(c),
    label: "curl/wget 管道到 shell",
  },
  {
    test: (c) => (
      /\bchmod\s+(777|0777)\b/.test(c) ||
      /\bchmod\s+.*\b[augo]+[+-=][rwxXst]+\b/.test(c)
    ) && !/\bchmod\s+(-R\s+)?(777|0777)\s+\//.test(c) &&
      !/\bchmod\s+.*\b[augo]+[+-=][rwxXst]+\s+\//.test(c),
    label: "chmod 提权",
  },
  {
    test: (c) => /\bgit\s+reset\s+--hard\b/.test(c),
    label: "git reset --hard",
  },
  {
    test: (c) => /\bdocker\s+rm\s+(-f\b|--force\b)/.test(c),
    label: "docker rm -f",
  },
  {
    test: (c) => /\beval\b/.test(c),
    label: "eval",
  },
];

export const SHELL_INJECTION_PATTERNS: RegExp[] = [
  /`/,
  /\$\(/,
  /<\(/,
  />\(/,
];
