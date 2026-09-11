import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { hapilonHome } from "../../config/hapilon-home.js";
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
            }];
    });
}
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
