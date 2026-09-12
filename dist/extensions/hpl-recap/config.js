import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
export const RECAP_DEFAULTS = {
    enabled: true,
    idleMinutes: 3,
    maxContextChars: 8000,
};
export function recapConfigPath() {
    return join(hapilonHome(), "recap-config.json");
}
function validPositiveNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}
export const readRecapConfigEffect = Effect.try({
    try: () => {
        const path = recapConfigPath();
        if (!existsSync(path))
            return { ...RECAP_DEFAULTS };
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            console.warn(`[hpl-recap] ${path} 顶层必须是对象，使用默认配置。`);
            return { ...RECAP_DEFAULTS };
        }
        const raw = parsed;
        const enabled = raw.enabled === undefined
            ? RECAP_DEFAULTS.enabled
            : typeof raw.enabled === "boolean"
                ? raw.enabled
                : (console.warn("[hpl-recap] enabled 非布尔值，使用默认值。"), RECAP_DEFAULTS.enabled);
        const idleMinutes = raw.idleMinutes === undefined
            ? RECAP_DEFAULTS.idleMinutes
            : validPositiveNumber(raw.idleMinutes)
                ? raw.idleMinutes
                : (console.warn("[hpl-recap] idleMinutes 非正有限数，使用默认值。"), RECAP_DEFAULTS.idleMinutes);
        const maxContextChars = raw.maxContextChars === undefined
            ? RECAP_DEFAULTS.maxContextChars
            : Number.isInteger(raw.maxContextChars) && validPositiveNumber(raw.maxContextChars)
                ? raw.maxContextChars
                : (console.warn("[hpl-recap] maxContextChars 非正整数，使用默认值。"), RECAP_DEFAULTS.maxContextChars);
        return { enabled, idleMinutes, maxContextChars };
    },
    catch: (error) => error,
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-recap] 配置读取失败，使用默认配置：${String(error)}`);
    return { ...RECAP_DEFAULTS };
})));
export function readRecapConfig() {
    return Effect.runSync(readRecapConfigEffect);
}
