/**
 * pi-listing.ts — spawn pi --list-models 与表格解析
 *
 * 从 config.ts 拆出的独立模块（issue #4）：职责单一，测试从本模块导入。
 */
import { spawn } from "node:child_process";
import { resolvePiCli } from "./pi-cli-path.js";
import { agentDir } from "./hapilon-home.js";
/**
 * 解析 pi --list-models 输出的表格。
 * 表头行（provider model context ...）跳过；targetProvider 时只留该 provider 行。
 */
export function parseModelsTable(output, targetProvider) {
    const lines = output.trim().split("\n");
    if (lines.length < 2)
        return [];
    const dataLines = lines.slice(1);
    return dataLines
        .map((line) => line.trim().split(/\s{2,}/))
        .filter((cols) => {
        if (cols.length < 2)
            return false;
        if (targetProvider && cols[0] !== targetProvider)
            return false;
        return true;
    })
        .map((cols) => ({
        provider: cols[0],
        model: cols[1],
        context: cols[2] ?? "?",
    }));
}
/** spawn `pi --list-models`，按 provider 过滤并解析（失败 reject 带 stderr） */
export function listModelsForProvider(providerId) {
    const piCli = resolvePiCli();
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [piCli, "--list-models"], {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...process.env,
                PI_CODING_AGENT_DIR: agentDir(),
            },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => {
            stdout += d.toString("utf8");
        });
        child.stderr.on("data", (d) => {
            stderr += d.toString("utf8");
        });
        child.on("error", (err) => reject(new Error(`无法启动 pi: ${err.message}`)));
        child.on("exit", (code) => {
            if (code !== 0) {
                reject(new Error(`pi --list-models 失败 (exit ${code}): ${stderr}`));
                return;
            }
            try {
                resolve(parseModelsTable(stdout, providerId));
            }
            catch (e) {
                reject(new Error(`解析 pi --list-models 输出失败: ${e.message}`));
            }
        });
    });
}
