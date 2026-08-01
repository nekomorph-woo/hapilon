/**
 * rules.ts — 危险命令规则定义
 *
 * BLOCK_PATTERNS — 高危命令（硬阻止，不可逆损害）
 * CONFIRM_PATTERNS — 中危命令（弹确认框）
 * SHELL_INJECTION_PATTERNS — shell 注入技巧检测
 *
 * 来源：社区 6 套方案 + 真实事故 (PocketOS DB 清空、spinspire 生产推送、boucle2026 find-exec 删除)
 */

export const BLOCK_PATTERNS: Array<{ test: (cmd: string) => boolean; label: string }> = [
  // ── 文件系统破坏 ──
  {
    // `-rf` 与目标之间允许插参（`rm -rf --one-file-system /` 等仍应 BLOCK），issue #6
    test: (c) => /\b(?:sudo\s+)?rm\s+-rf\b(?:\s+[^\s]+)*\s+(\/|~|\/\*)/.test(c),
    label: "rm -rf 根目录/home",
  },
  {
    test: (c) => /\bfind\b.+-exec\s+rm\b/.test(c) || /\bfind\b.+-delete\b/.test(c),
    label: "find 批量删除",
  },

  // ── 磁盘/文件系统 ──
  {
    test: (c) => /\bmkfs\.\w+/.test(c),
    label: "mkfs 格式化命令",
  },
  {
    test: (c) => /\bdd\b.*\bof=\/dev\//.test(c),
    label: "dd 写入块设备",
  },
  {
    test: (c) => />\s*\/dev\/(sd[a-z]+|nvme\w+|hd[a-z]+|xvd[a-z]+|vd[a-z]+|mmcblk\d+|disk\d+|dm-\d+)/.test(c),
    label: "输出重定向到块设备",
  },

  // ── 系统进程/电源 ──
  {
    test: (c) => /\bkill\s+-9\s+-1\b|\bkillall\s+-9\b/.test(c),
    label: "kill 全部进程",
  },
  {
    test: (c) => /\b(shutdown|reboot|halt|poweroff|init\s+[06])\b/.test(c),
    label: "关机/重启命令",
  },

  // ── Git 不可逆操作 ──
  {
    test: (c) => /\bgit\s+clean\s+(-fdx|-xfd|-fd|-df|-fx)\b/.test(c),
    label: "git clean 删除未跟踪文件",
  },
  {
    test: (c) => /\bgit\s+reflog\s+expire\b/.test(c) || /\bgit\s+gc\s+--prune=now\b/.test(c),
    label: "git reflog/gc 销毁恢复链",
  },

  // ── Docker 不可逆操作 ──
  {
    test: (c) => /\bdocker\s+system\s+prune\s+-af?\b/.test(c),
    label: "docker system prune 删除全部",
  },
  {
    test: (c) => /\bdocker\s+volume\s+prune\s+-f\b/.test(c),
    label: "docker volume prune 删除数据卷",
  },

  // ── 权限破坏 ──
  {
    test: (c) => /\bchmod\s+(-R\s+)?(777|0777)\s+\//.test(c) ||
      /\bchmod\s+.*\b[augo]+[+-=][rwxXst]+\s+\//.test(c),
    label: "chmod 提权根目录",
  },
  {
    test: (c) => /\bchmod\s+-R\s+000\b/.test(c),
    label: "chmod -R 000 锁定文件",
  },
  {
    test: (c) => /\bchown\s+-R\s+\//.test(c),
    label: "chown -R 根目录",
  },

  // ── fork bomb ──
  {
    // 尾冒号 `;:` 可选——`:(){ :|:& };`（无尾冒号变体）同为 fork bomb，issue #6
    test: (c) => /:\(\)\s*\{\s*:\|\s*:\s*&\s*\};\s*:?/.test(c.replace(/\s+/g, " ")),
    label: "fork bomb",
  },
];

export const CONFIRM_PATTERNS: Array<{ test: (cmd: string) => boolean; label: string }> = [
  // ── 文件删除 ──
  {
    // 排除与 BLOCK 规则同语义（含插参），避免「BLOCK 未覆盖则降级 confirm」的耦合缺口，issue #6
    test: (c) => /\brm\s+-rf\b/.test(c) && !/\b(?:sudo\s+)?rm\s+-rf\b(?:\s+[^\s]+)*\s+(\/|~|\/\*)/.test(c),
    label: "rm -rf",
  },
  {
    test: (c) => /\brm\s+-r\b/.test(c),
    label: "rm -r 递归删除",
  },

  // ── Git 操作（事故高发区）──
  {
    test: (c) => /\bgit\s+(checkout|restore)\s+(--\s+)?\S/.test(c) &&
      !/\bgit\s+(checkout|restore)\s+(-b\b|\.)/.test(c),
    label: "git checkout/restore 单文件",
  },
  {
    test: (c) => /\bgit\s+push\b(?!.*--force)/.test(c),
    label: "git push",
  },
  {
    test: (c) => /\bgit\s+push\s+.*--force/.test(c),
    label: "git push --force",
  },
  {
    test: (c) => /\bgit\s+(checkout\s+\.(?:\s|$)|restore\s+\.(?:\s|$))/.test(c),
    label: "git checkout . / restore .",
  },
  {
    test: (c) => /\bgit\s+reset\s+--hard\b/.test(c),
    label: "git reset --hard",
  },
  {
    test: (c) => /\bgit\s+branch\s+-D\b/.test(c),
    label: "git branch -D 强制删除分支",
  },
  {
    test: (c) => /\bgit\s+stash\s+(drop|clear)\b/.test(c),
    label: "git stash drop/clear",
  },
  {
    test: (c) => /\bgit\s+rebase\s+-i\b/.test(c),
    label: "git rebase -i 交互式变基",
  },
  {
    test: (c) => /\bgit\s+commit\s+--amend\b/.test(c),
    label: "git commit --amend 改写历史",
  },

  // ── 管道到 shell ──
  {
    test: (c) => /\b(curl|wget)\b.+\|\s*(sudo\s+)?\s*(sh|bash)\b/.test(c),
    label: "curl/wget 管道到 shell",
  },

  // ── 权限变更 ──
  {
    test: (c) => (
      /\bchmod\s+(777|0777)\b/.test(c) ||
      /\bchmod\s+.*\b[augo]+[+-=][rwxXst]+\b/.test(c)
    ) && !/\bchmod\s+(-R\s+)?(777|0777)\s+\//.test(c) &&
      !/\bchmod\s+.*\b[augo]+[+-=][rwxXst]+\s+\//.test(c),
    label: "chmod 提权",
  },
  {
    test: (c) => /\bchown\s+-R\b/.test(c) && !/chown\s+-R\s+\//.test(c),
    label: "chown -R 递归改所有者",
  },

  // ── 网络/远程 ──
  {
    test: (c) => /\bssh\s+\w+@\S+/.test(c),
    label: "SSH 远程连接",
  },
  {
    test: (c) => /\brsync\b.*\s--delete\b/.test(c),
    label: "rsync --delete 同步删除",
  },
  {
    test: (c) => /\bscp\s+\S+\s+\w+@\S+/.test(c),
    label: "SCP 远程传输",
  },

  // ── 系统文件写入 ──
  {
    test: (c) => /\b(?:sudo\s+)?(?:tee|cp|mv|cat\s*>)\s+\/etc\//.test(c) ||
      /(?:>>?)\s*\/etc\//.test(c),
    label: "系统配置文件写入",
  },

  // ── 包管理器全局安装 ──
  {
    test: (c) => /\b(npm\s+install\s+-g\b|npm\s+i\s+-g\b|yarn\s+global\s+add|pnpm\s+add\s+-g\b)/.test(c),
    label: "npm/yarn/pnpm 全局安装",
  },
  {
    test: (c) => /\bpip3?\s+install\b/.test(c) && !/\bpip3?\s+install\s+--user\b/.test(c),
    label: "pip 系统级安装",
  },
  {
    test: (c) => /\bgem\s+install\b/.test(c),
    label: "gem install 全局安装",
  },

  // ── Docker 操作 ──
  {
    test: (c) => /\bdocker\s+rm\s+(-f\b|--force\b)/.test(c),
    label: "docker rm -f",
  },
  {
    test: (c) => /\bdocker\s+compose\s+down\s+-v\b/.test(c) || /\bdocker-compose\s+down\s+-v\b/.test(c),
    label: "docker compose down -v 删除卷",
  },
  {
    test: (c) => /\bdocker\s+(?:container\s+)?prune\b/.test(c),
    label: "docker prune",
  },

  // ── eval ──
  {
    test: (c) => /\beval\b/.test(c),
    label: "eval",
  },

  // ── 批量文件修改 ──
  {
    test: (c) => /\bsed\s+-i\b/.test(c),
    label: "sed -i 批量替换",
  },

  // ── 磁盘安全擦除 ──
  {
    test: (c) => /\bshred\b/.test(c),
    label: "shred 安全擦除文件",
  },

  // ── 防火墙/网络 ──
  {
    test: (c) => /\b(iptables\s+-F|iptables\s+--flush|ufw\s+disable|ufw\s+--force\s+reset)\b/.test(c),
    label: "防火墙规则修改",
  },

  // ── 系统服务 ──
  {
    test: (c) => /\b(systemctl\s+(stop|disable|mask)|service\s+\S+\s+stop)\b/.test(c),
    label: "系统服务停止/禁用",
  },

  // ── K8s / 基础设施 ──
  {
    test: (c) => /\bkubectl\s+delete\s+(namespace|deployment|statefulset|pvc|pv)\b/.test(c),
    label: "kubectl 删除集群资源",
  },
  {
    test: (c) => /\bterraform\s+(destroy|apply\s+-destroy)\b/.test(c) || /\btofu\s+destroy\b/.test(c),
    label: "Terraform/OpenTofu destroy",
  },

  // ── macOS 磁盘工具 ──
  {
    test: (c) => /\bdiskutil\s+(eraseDisk|partitionDisk|unmount|unmountDisk)\b/.test(c),
    label: "diskutil 磁盘操作",
  },

  // ── 网络隧道（绕过安全边界）──
  {
    test: (c) => /\b(ngrok|localtunnel|lt\s+--port|serveo)\b/.test(c),
    label: "网络隧道暴露服务",
  },

  // ── 数据库危险操作 ──
  {
    test: (c) => /\b(DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE\s+(TABLE\s+)?)\b/i.test(c),
    label: "数据库 DROP/TRUNCATE",
  },
];

export const SHELL_INJECTION_PATTERNS: RegExp[] = [
  /`/,
  /\$\(/,
  /<\(/,
  />\(/,
];
