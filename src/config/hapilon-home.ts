import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { Data, Effect } from "effect";

export class HapilonHomeError extends Data.TaggedError("HapilonHomeError")<{
  message: string;
}> {}

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
export const hapilonHomeEffect: Effect.Effect<string, HapilonHomeError> = Effect.gen(function* () {
  const env = yield* Effect.sync(() => process.env.HAPILON_HOME);
  if (env && env.length > 0) {
    const expanded = expandTilde(env);
    if (!isAbsolute(expanded)) {
      return yield* Effect.fail(new HapilonHomeError({
        message: `HAPILON_HOME 必须是绝对路径（收到 "${env}"）。相对路径会随启动目录漂移，请改用绝对路径或 ~/ 前缀。`,
      }));
    }
    return expanded;
  }
  return join(homedir(), ".hapilon");
});

export function hapilonHome(): string {
  const result = Effect.runSync(Effect.either(hapilonHomeEffect));
  if (result._tag === "Left") {
    throw new Error(result.left.message);
  }
  return result.right;
}

/** ~/.hapilon/agent/（pi 配置目录）——单一来源，替代各处重复 join */
export const agentDirEffect: Effect.Effect<string, HapilonHomeError> = Effect.map(
  hapilonHomeEffect,
  (base) => join(base, "agent"),
);

export function agentDir(): string {
  const result = Effect.runSync(Effect.either(agentDirEffect));
  if (result._tag === "Left") throw new Error(result.left.message);
  return result.right;
}

/** Create ~/.hapilon/ subdirectories with 0700 permissions */
export const ensureHapilonDirsEffect: Effect.Effect<HapilonDirs, HapilonHomeError> = Effect.gen(function* () {
  const base = yield* hapilonHomeEffect;
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
        return yield* Effect.fail(new HapilonHomeError({ message: `Failed to create directory ${p}: ${msg}` }));
      }
    }
  }
  return dirs;
});

export function ensureHapilonDirs(): HapilonDirs {
  const result = Effect.runSync(Effect.either(ensureHapilonDirsEffect));
  if (result._tag === "Left") {
    throw new Error(result.left.message);
  }
  return result.right;
}

/** 返回 ~/.hapilon/config.json 的完整路径 */
export const configFilePathEffect: Effect.Effect<string, HapilonHomeError> = Effect.map(
  hapilonHomeEffect,
  (base) => join(base, "config.json"),
);

export function configFilePath(): string {
  const result = Effect.runSync(Effect.either(configFilePathEffect));
  if (result._tag === "Left") throw new Error(result.left.message);
  return result.right;
}
