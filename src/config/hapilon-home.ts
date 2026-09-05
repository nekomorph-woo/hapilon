import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

export interface HapilonDirs {
  base: string;
  agent: string;
  sessions: string;
  logs: string;
  cache: string;
}

/**
 * 展开路径开头的 ~ 与 ~/（env 赋值如 `HAPILON_HOME=~/x` 在 shell 中不展开，
 * 实测 zsh env 前缀、doctor 显示均会带字面 ~）。
 * 其余路径原样返回。
 */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Resolve HAPILON_HOME, defaulting to ~/.hapilon/ */
export function hapilonHome(): string {
  const env = process.env.HAPILON_HOME;
  if (env && env.length > 0) {
    const expanded = expandTilde(env);
    if (!isAbsolute(expanded)) {
      throw new Error(
        `HAPILON_HOME 必须是绝对路径（收到 "${env}"）。相对路径会随启动目录漂移，请改用绝对路径或 ~/ 前缀。`,
      );
    }
    return expanded;
  }
  return join(homedir(), ".hapilon");
}

/** ~/.hapilon/agent/（pi 配置目录）——单一来源，替代各处重复 join */
export function agentDir(): string {
  return join(hapilonHome(), "agent");
}

/** Create ~/.hapilon/ subdirectories with 0700 permissions */
export function ensureHapilonDirs(): HapilonDirs {
  const base = hapilonHome();
  const dirs: HapilonDirs = {
    base,
    agent: join(base, "agent"),
    sessions: join(base, "sessions"),
    logs: join(base, "logs"),
    cache: join(base, "cache"),
  };
  for (const p of Object.values(dirs)) {
    if (!existsSync(p)) {
      try {
        mkdirSync(p, { recursive: true, mode: 0o700 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to create directory ${p}: ${msg}`);
      }
    }
  }
  return dirs;
}

/** 返回 ~/.hapilon/config.json 的完整路径 */
export function configFilePath(): string {
  return join(hapilonHome(), "config.json");
}
