import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
/** Resolve HAPILON_HOME, defaulting to ~/.hapilon/ */
export function hapilonHome() {
    const env = process.env.HAPILON_HOME;
    return env && env.length > 0 ? env : join(homedir(), ".hapilon");
}
/** ~/.hapilon/agent/（pi 配置目录）——单一来源，替代各处重复 join */
export function agentDir() {
    return join(hapilonHome(), "agent");
}
/** Create ~/.hapilon/ subdirectories with 0700 permissions */
export function ensureHapilonDirs() {
    const base = hapilonHome();
    const dirs = {
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
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                throw new Error(`Failed to create directory ${p}: ${msg}`);
            }
        }
    }
    return dirs;
}
/** 返回 ~/.hapilon/config.json 的完整路径 */
export function configFilePath() {
    return join(hapilonHome(), "config.json");
}
