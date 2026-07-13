/**
 * protected-paths.ts — 文件路径保护扩展
 *
 * 通过 pi.on("tool_call", ...) 拦截 write/edit/read 工具调用：
 *   - write/edit → 检查 path 是否在受写保护列表中 → block
 *   - read → 检查 path 是否在受读保护列表中 → confirm
 *
 * 写保护匹配策略：
 *   - basename 匹配：文件类型级保护（如 *.pem、id_rsa、authorized_keys）
 *     无论文件在哪个目录，只要文件名匹配即拦截
 *   - resolved 全路径匹配：目录位置级保护（如 ~/.ssh/*、.git/config）
 *     必须在特定目录位置下才拦截
 *
 * 用法: hapilon 启动时自动加载（discoverExtensions() → -e 注入）
 * 来源: doc/pi-wiki.md §4.3 tool_call 事件
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

// ─── 写保护模式（write/edit 直接 block）───────────────────────────
//
// test 函数参数说明：
//   resolved — 解析后的绝对路径（含 symlink 解析）
//   name     — basename(resolved)，用于文件类型级匹配
//
// 设计意图：
//   用 name 匹配 = 文件类型级保护，只要文件名匹配就拦截（无论目录位置）
//   用 resolved 匹配 = 目录位置级保护，仅在特定目录下拦截

const WRITE_PROTECTED: Array<{ test: (resolved: string, name: string) => boolean; label: string }> = [
  // 环境变量文件（文件类型级：任何目录下的 .env* 都保护）
  { test: (_r, name) => /^\.env/.test(name), label: "env 文件" },

  // 包管理器锁文件（文件类型级：篡改可投毒依赖）
  {
    test: (_r, name) =>
      [
        "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "pnpm-lock.yml",
        "bun.lockb", "composer.lock", "Gemfile.lock", "Cargo.lock", "poetry.lock",
      ].includes(name),
    label: "包管理器锁文件",
  },

  // Git 敏感路径（目录位置级）
  { test: (r) => r.endsWith("/.git/config"), label: ".git/config" },
  { test: (r) => r.includes("/.git/hooks/"), label: ".git/hooks" },
  { test: (r) => r.endsWith("/.gitmodules"), label: ".gitmodules" },

  // CI/CD 管道（目录位置级：修改可在 CI 环境执行任意代码）
  { test: (r) => r.includes("/.github/workflows/"), label: "GitHub Actions workflow" },
  { test: (r) => r.endsWith("/.gitlab-ci.yml"), label: ".gitlab-ci.yml" },

  // SSH 密钥与授权（文件类型级）
  {
    test: (_r, name) =>
      ["id_rsa", "id_rsa.pub", "id_ed25519", "id_ed25519.pub",
       "id_ecdsa", "id_ecdsa.pub", "authorized_keys"].includes(name),
    label: "SSH 密钥",
  },
  // SSH 目录（目录位置级）
  { test: (r) => r.startsWith(homedir() + "/.ssh/"), label: "~/.ssh" },

  // 凭证文件（目录位置级：精确路径匹配）
  { test: (r) => r === homedir() + "/.netrc", label: "~/.netrc" },
  { test: (r) => r === homedir() + "/.git-credentials", label: "~/.git-credentials" },
  { test: (r) => r === homedir() + "/.docker/config.json", label: "Docker 凭证" },
  { test: (r) => r === homedir() + "/.kube/config", label: "K8s 凭证" },
  // kubeconfig（文件类型级：任何目录）
  { test: (_r, name) => name.endsWith(".kubeconfig"), label: "kubeconfig" },
  { test: (r) => r === homedir() + "/.npmrc", label: "npm token" },
  // AWS 目录（目录位置级）
  { test: (r) => r.startsWith(homedir() + "/.aws/"), label: "~/.aws" },

  // 证书与密钥文件（文件类型级：后缀匹配）
  {
    test: (_r, name) => /\.(pem|key|crt|cer|p12|pfx|jks|asc)$/.test(name),
    label: "证书/密钥文件",
  },
  {
    test: (_r, name) =>
      name.endsWith(".keystore") || name.endsWith(".truststore"),
    label: "Java 密钥库",
  },
];

// ─── 读保护模式（read 弹 confirm）─────────────────────────────────

const READ_CONFIRM: Array<{ test: (resolved: string) => boolean; label: string }> = [
  { test: (r) => r.startsWith(homedir() + "/.ssh/"), label: "~/.ssh" },
  { test: (r) => r === homedir() + "/.aws/credentials", label: "~/.aws/credentials" },
  { test: (r) => r === homedir() + "/.aws/config", label: "~/.aws/config" },
  { test: (r) => r.startsWith(homedir() + "/.config/gcloud/"), label: "GCloud 凭证" },
  { test: (r) => r === homedir() + "/.docker/config.json", label: "Docker 凭证" },
  { test: (r) => r === homedir() + "/.kube/config", label: "K8s 凭证" },
  { test: (r) => r.endsWith(".kubeconfig"), label: "kubeconfig" },
  { test: (r) => r === homedir() + "/.npmrc", label: "npm token" },
];

// ─── 纯函数（导出供测试）───────────────────────────────────────────

export type PathVerdict = "block" | "confirm" | "allow";

/**
 * 展开路径中的 ~ 为 home 目录。
 */
export function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return homedir() + p.slice(1);
  }
  return p;
}

/**
 * 解析目标路径为绝对路径，并跟随符号链接获得真实路径。
 * 若目标不存在（ENOENT），则使用未解析的路径。
 */
function resolveTarget(targetPath: string, cwd: string): string {
  if (!targetPath) return resolve(cwd, ".");
  const expanded = expandTilde(targetPath);
  const absPath = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  try {
    return realpathSync(absPath);
  } catch (err: unknown) {
    // ENOENT：目标尚不存在（如 write 新文件），使用未解析路径
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return absPath;
    }
    // 其他错误（如权限不足）→ 也使用未解析路径，安全侧仍有 basename 匹配
    return absPath;
  }
}

/**
 * 对文件路径进行安全分类。
 *
 * @param targetPath 工具参数中的目标路径（可能是相对/绝对/~）
 * @param toolName 工具类型：write/edit → 写保护检查，read → 读保护检查
 * @param cwd 当前工作目录（默认 process.cwd()）
 */
export function classifyPath(
  targetPath: string,
  toolName: string,
  cwd?: string,
): PathVerdict {
  const cwd_ = cwd ?? process.cwd();
  const resolved = resolveTarget(targetPath, cwd_);
  const name = basename(resolved);

  if (toolName === "write" || toolName === "edit") {
    for (const pattern of WRITE_PROTECTED) {
      if (pattern.test(resolved, name)) return "block";
    }
    return "allow";
  }

  if (toolName === "read") {
    for (const pattern of READ_CONFIRM) {
      if (pattern.test(resolved)) return "confirm";
    }
    return "allow";
  }

  // 未知工具类型 → 放行
  return "allow";
}

// ─── 扩展入口 ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // 拦截 write 和 edit（写保护）
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const filePath: string = event.input.path ?? "";
      if (!filePath) return;

      const toolName = isToolCallEventType("edit", event) ? "edit" : "write";

      const verdict = classifyPath(filePath, toolName, ctx.cwd);
      if (verdict === "block") {
        return {
          block: true,
          reason: `🛡️ 受保护的文件路径，不允许写入：${filePath}`,
        };
      }
      return;
    }

    // 拦截 read（读保护—弹确认）
    if (isToolCallEventType("read", event)) {
      const filePath: string = event.input.path ?? "";
      if (!filePath) return;

      const verdict = classifyPath(filePath, "read", ctx.cwd);
      if (verdict !== "confirm") return;

      if (!ctx.hasUI) {
        // 非交互模式无法确认 → 安全侧拒绝
        return {
          block: true,
          reason: `🛡️ 非交互模式下禁止读取敏感文件：${filePath}`,
        };
      }

      try {
        const approved = await ctx.ui.confirm(
          "⚠️ 敏感文件读取确认",
          `Agent 正在尝试读取敏感文件：\n\n> ${filePath}\n\n是否允许？`,
        );
        if (!approved) {
          return {
            block: true,
            reason: `用户拒绝了读取敏感文件：${filePath}`,
          };
        }
      } catch (err) {
        // confirm 调用异常 → 安全侧拒绝，保留日志可观测
        console.warn("安全确认对话框异常:", err instanceof Error ? err.message : String(err));
        return {
          block: true,
          reason: `🛡️ 确认对话框异常，已阻止读取：${filePath}`,
        };
      }
    }
  });
}
