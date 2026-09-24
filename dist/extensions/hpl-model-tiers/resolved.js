import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
export const MODEL_TIERS = ["opus", "sonnet", "haiku"];
/** 与 pi 内核 ThinkingLevel 对齐的档位名全集。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const isThinkingLevel = (value) => typeof value === "string" && THINKING_LEVELS.includes(value);
/**
 * 剥离模式串尾部的 :thinking 后缀（与 pi parseModelPattern 同语义：仅当后缀是
 * 合法档位名时剥离；非法后缀视为模式本身的一部分）。返回裸模式与档位。
 */
export function splitThinkingSuffix(pattern) {
    const colon = pattern.lastIndexOf(":");
    if (colon <= 0 || colon === pattern.length - 1)
        return { pattern };
    const suffix = pattern.slice(colon + 1);
    if (isThinkingLevel(suffix)) {
        return { pattern: pattern.slice(0, colon), thinking: suffix };
    }
    return { pattern };
}
/** `tier:<name>[<index>]` 模型指代；index 缺省为 0。非法格式返回 undefined。 */
export function parseTierReference(spec) {
    const matched = /^tier:(opus|sonnet|haiku)(?:\[(\d+)\])?$/.exec(spec.trim());
    if (!matched)
        return undefined;
    return { tier: matched[1], index: matched[2] === undefined ? 0 : Number(matched[2]) };
}
const EMPTY_RESOLVED = { opus: [], sonnet: [], haiku: [] };
function parseModelList(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((item) => {
        if (!item || typeof item !== "object")
            return [];
        const raw = item;
        if (typeof raw.provider !== "string" || typeof raw.id !== "string")
            return [];
        return [{
                provider: raw.provider,
                id: raw.id,
                ...(typeof raw.name === "string" ? { name: raw.name } : {}),
                ...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
                ...(isThinkingLevel(raw.thinking) ? { thinking: raw.thinking } : {}),
                ...(typeof raw.group === "number" && Number.isInteger(raw.group) && raw.group >= 0
                    ? { group: raw.group }
                    : {}),
            }];
    });
}
/** 唯一的 model-tiers-resolved.json 读取实现：损坏条目忽略，读取失败降为空档。 */
export const readResolvedTiersEffect = Effect.try({
    try: () => {
        const path = join(hapilonHome(), "model-tiers-resolved.json");
        if (!existsSync(path))
            return { ...EMPTY_RESOLVED };
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return { ...EMPTY_RESOLVED };
        const raw = parsed;
        const opus = parseModelList(raw.opus);
        const sonnet = parseModelList(raw.sonnet);
        const haiku = parseModelList(raw.haiku);
        return { opus, sonnet, haiku };
    },
    catch: (error) => error,
}).pipe(Effect.catchAll((error) => Effect.sync(() => {
    console.warn(`[hpl-recap] resolved tiers 读取失败，按空档降级：${String(error)}`);
    return { ...EMPTY_RESOLVED };
})));
