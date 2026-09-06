import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Data, Effect } from "effect";
export class EconConfigError extends Data.TaggedError("EconConfigError") {
}
/** 组合甲 · 稳妥默认（issue #52 实测裁决） */
export const ECON_DEFAULTS = {
    enabled: true,
    threshold: 8 * 1024,
    headLines: 40,
    tailLines: 20,
};
/** /econ 菜单提供的档位 */
export const THRESHOLD_CHOICES = [4 * 1024, 8 * 1024, 16 * 1024, 32 * 1024];
export const RETENTION_CHOICES = [
    { head: 20, tail: 10 },
    { head: 40, tail: 20 },
    { head: 80, tail: 40 },
];
export function econConfigPath(agentDirPath) {
    return join(agentDirPath, "econ-config.json");
}
/** 读配置；文件缺失/损坏时逐字段回落默认（损坏时 warn 一次，不吞——Fail Fast 交给调用方决定） */
const readEconSettingsSync = (agentDirPath) => {
    const path = econConfigPath(agentDirPath);
    if (!existsSync(path))
        return { ...ECON_DEFAULTS };
    try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        return {
            enabled: typeof raw.enabled === "boolean" ? raw.enabled : ECON_DEFAULTS.enabled,
            threshold: typeof raw.threshold === "number" && raw.threshold > 0 ? raw.threshold : ECON_DEFAULTS.threshold,
            headLines: typeof raw.headLines === "number" && raw.headLines > 0 ? raw.headLines : ECON_DEFAULTS.headLines,
            tailLines: typeof raw.tailLines === "number" && raw.tailLines > 0 ? raw.tailLines : ECON_DEFAULTS.tailLines,
        };
    }
    catch (err) {
        console.warn(`[hpl-econ] econ-config.json 解析失败，使用默认参数：${err instanceof Error ? err.message : String(err)}`);
        return { ...ECON_DEFAULTS };
    }
};
export const readEconSettingsEffect = (agentDirPath) => Effect.sync(() => readEconSettingsSync(agentDirPath));
export function readEconSettings(agentDirPath) {
    return Effect.runSync(readEconSettingsEffect(agentDirPath));
}
/** 写配置（/econ 菜单「Save as default」）；目录不存在时创建 */
export const writeEconSettingsEffect = (agentDirPath, settings) => Effect.try({
    try: () => {
        if (!existsSync(agentDirPath)) {
            mkdirSync(agentDirPath, { recursive: true, mode: 0o700 });
        }
        writeFileSync(econConfigPath(agentDirPath), JSON.stringify(settings, null, 2) + "\n", "utf8");
    },
    catch: (err) => new EconConfigError({ message: err instanceof Error ? err.message : String(err) }),
});
export function writeEconSettings(agentDirPath, settings) {
    const result = Effect.runSync(Effect.either(writeEconSettingsEffect(agentDirPath, settings)));
    if (result._tag === "Left")
        throw new Error(result.left.message);
}
/** env 通道：HAPILON_ECON_OFF=1 时旁路（脚本化场景） */
export function envDisabled() {
    return process.env.HAPILON_ECON_OFF === "1";
}
