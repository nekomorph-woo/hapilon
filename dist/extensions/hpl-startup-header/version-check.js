/**
 * version-check.ts — Pi 版本更新检查
 *
 * NOTE: 不检查 PI_SKIP_VERSION_CHECK！该变量是 cli.ts 为关闭 Pi 内置检查
 * 而设置的，本扩展运行在同一进程内，若沿用 Pi 的 getLatestPiRelease 会恒返回
 * undefined。此处必须自行 fetch。
 */
import { parseSemver } from "../../providers.js";
const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const TIMEOUT_MS = 3000;
export function isNewerPiVersion(latest, current) {
    const lp = parseSemver(latest);
    const cp = parseSemver(current);
    for (let i = 0; i < 3; i++) {
        if (lp[i] > cp[i])
            return true;
        if (lp[i] < cp[i])
            return false;
    }
    return false; // equal → not newer
}
export async function fetchLatestPiVersion(currentVersion, fetchFn = globalThis.fetch) {
    if (process.env.PI_OFFLINE)
        return undefined;
    try {
        const response = await fetchFn(LATEST_VERSION_URL, {
            headers: {
                "User-Agent": `Hapilon/${currentVersion}`,
                accept: "application/json",
            },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok)
            return undefined;
        const data = (await response.json());
        if (typeof data.version === "string" && data.version.trim()) {
            return data.version.trim();
        }
    }
    catch (err) {
        // 网络异常静默 — TUI 内 console.error 会撕裂终端渲染
        // 设置 HAPILON_DEBUG=1 可启用诊断日志
        if (process.env["HAPILON_DEBUG"]) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[hpl-startup-header] version check failed: ${msg}\n`);
        }
    }
    return undefined;
}
