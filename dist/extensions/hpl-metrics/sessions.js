/**
 * sessions.ts — 会话文件枚举（ponytail 与 skills 统计共享的数据源入口）。
 * 只做文件层枚举：找 ~/.hapilon* home、列 *.jsonl；解析按用途在各自模块。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
/** 扫描范围：~ 下所有 .hapilon* home（dev/prod 都收） */
export function hapilonHomes(homeDir = homedir()) {
    try {
        return readdirSync(homeDir)
            .filter((name) => name.startsWith(".hapilon"))
            .map((name) => join(homeDir, name))
            .filter((path) => {
            try {
                return statSync(path).isDirectory() && existsSync(join(path, "agent", "sessions"));
            }
            catch {
                return false;
            }
        });
    }
    catch {
        return [];
    }
}
/** 枚举某 home 下的会话文件 */
export function listSessionFiles(home) {
    const root = join(home, "agent", "sessions");
    const files = [];
    for (const dir of readdirSync(root)) {
        const dirPath = join(root, dir);
        try {
            if (!statSync(dirPath).isDirectory())
                continue;
        }
        catch {
            continue;
        }
        for (const name of readdirSync(dirPath)) {
            if (name.endsWith(".jsonl"))
                files.push(join(dirPath, name));
        }
    }
    return files;
}
