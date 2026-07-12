import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

export interface HapilonDirs {
  base: string;
  agent: string;
  sessions: string;
  logs: string;
  cache: string;
}

/** Resolve HAPILON_HOME, defaulting to ~/.hapilon/ */
export function hapilonHome(): string {
  const env = process.env.HAPILON_HOME;
  return env && env.length > 0 ? env : join(homedir(), ".hapilon");
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
