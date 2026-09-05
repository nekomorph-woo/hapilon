/**
 * rules.ts — 路径保护规则定义
 *
 * 三组规则：
 *   WRITE_BLOCK — 高危，永远硬阻止（SSH/凭证/证书）
 *   WRITE_CONFIRM — 中危，弹确认框（.env/lock 文件/CI 管道）
 *   READ_CONFIRM — 读保护，弹确认框（敏感凭证文件）
 *
 * test 函数参数：
 *   resolved — 解析后的绝对路径（含 symlink 解析+`..` 归一化）
 *   name     — basename(resolved)
 */

import { basename } from "node:path";
import { homedir } from "node:os";

// ─── 写保护 — 高危 block ─────────────────────────────────────────

export const WRITE_BLOCK: Array<{ test: (resolved: string, name: string) => boolean; label: string }> = [
  // Git 敏感路径
  { test: (r) => r.endsWith("/.git/config"), label: ".git/config" },
  { test: (r) => r.includes("/.git/hooks/"), label: ".git/hooks" },

  // SSH 密钥与授权
  {
    test: (_r, name) =>
      ["id_rsa", "id_rsa.pub", "id_ed25519", "id_ed25519.pub",
       "id_ecdsa", "id_ecdsa.pub", "authorized_keys"].includes(name),
    label: "SSH 密钥",
  },
  { test: (r) => r.startsWith(homedir() + "/.ssh/"), label: "~/.ssh" },

  // 凭证文件（精确路径）
  { test: (r) => r === homedir() + "/.netrc", label: "~/.netrc" },
  { test: (r) => r === homedir() + "/.git-credentials", label: "~/.git-credentials" },
  { test: (r) => r === homedir() + "/.docker/config.json", label: "Docker 凭证" },
  { test: (r) => r === homedir() + "/.kube/config", label: "K8s 凭证" },
  { test: (r) => r === homedir() + "/.npmrc", label: "npm token" },
  { test: (r) => r.startsWith(homedir() + "/.aws/"), label: "~/.aws" },

  // 证书与密钥文件
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

// ─── 写保护 — 中危 confirm ──────────────────────────────────────

export const WRITE_CONFIRM: Array<{ test: (resolved: string, name: string) => boolean; label: string }> = [
  // 环境变量文件
  { test: (_r, name) => /^\.env/.test(name), label: "env 文件" },

  // 包管理器锁文件
  {
    test: (_r, name) =>
      [
        "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "pnpm-lock.yml",
        "bun.lockb", "composer.lock", "Gemfile.lock", "Cargo.lock", "poetry.lock",
      ].includes(name),
    label: "包管理器锁文件",
  },

  // Git 配置（非敏感）
  { test: (r) => r.endsWith("/.gitmodules"), label: ".gitmodules" },

  // CI/CD 管道
  { test: (r) => r.includes("/.github/workflows/"), label: "GitHub Actions workflow" },
  { test: (r) => r.endsWith("/.gitlab-ci.yml"), label: ".gitlab-ci.yml" },

  // kubeconfig（非 ~/.kube/config）
  { test: (_r, name) => name.endsWith(".kubeconfig"), label: "kubeconfig" },
];

// ─── 读保护 — confirm ──────────────────────────────────────────

export const READ_CONFIRM: Array<{ test: (resolved: string) => boolean; label: string }> = [
  { test: (r) => r.startsWith(homedir() + "/.ssh/"), label: "~/.ssh" },
  { test: (r) => r === homedir() + "/.aws/credentials", label: "~/.aws/credentials" },
  { test: (r) => r === homedir() + "/.aws/config", label: "~/.aws/config" },
  { test: (r) => r.startsWith(homedir() + "/.config/gcloud/"), label: "GCloud 凭证" },
  { test: (r) => r === homedir() + "/.docker/config.json", label: "Docker 凭证" },
  { test: (r) => r === homedir() + "/.kube/config", label: "K8s 凭证" },
  { test: (r) => r.endsWith(".kubeconfig"), label: "kubeconfig" },
  { test: (r) => r === homedir() + "/.npmrc", label: "npm token" },
  // 环境变量文件（issue #39）：secret 只该被应用运行时读取；
  // agent 读了就进 LLM 上下文/transcript/API 日志。主会话 confirm，
  // subagent 在 index.ts 另行 block。.env.example 例外（模板无 secret）。
  {
    test: (r, name = basename(r)) =>
      /^\.env/.test(name) && !/^\.env\.example$/.test(name) && !/^\.env\.sample$/.test(name),
    label: "env 文件",
  },
];
