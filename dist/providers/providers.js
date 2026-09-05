import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
export const COMMON = [
    { id: "deepseek", name: "DeepSeek" },
    { id: "openai", name: "OpenAI" },
    { id: "anthropic", name: "Anthropic" },
    { id: "xai", name: "xAI" },
    { id: "google", name: "Google Gemini" },
    { id: "groq", name: "Groq" },
    { id: "mistral", name: "Mistral" },
    { id: "openrouter", name: "OpenRouter" },
    { id: "zai", name: "ZAI (GLM)" },
];
export const ALL_PROVIDERS = [
    ...COMMON,
    { id: "ant-ling", name: "Ant Ling" },
    { id: "azure-openai-responses", name: "Azure OpenAI" },
    { id: "nvidia", name: "NVIDIA NIM" },
    { id: "cerebras", name: "Cerebras" },
    { id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway" },
    { id: "cloudflare-workers-ai", name: "Cloudflare Workers AI" },
    { id: "vercel-ai-gateway", name: "Vercel AI Gateway" },
    { id: "zai-coding-cn", name: "ZAI Coding (China)" },
    { id: "opencode", name: "OpenCode Zen" },
    { id: "opencode-go", name: "OpenCode Go" },
    { id: "huggingface", name: "Hugging Face" },
    { id: "fireworks", name: "Fireworks" },
    { id: "together", name: "Together AI" },
    { id: "kimi-coding", name: "Kimi For Coding" },
    { id: "minimax", name: "MiniMax" },
    { id: "minimax-cn", name: "MiniMax (China)" },
    { id: "xiaomi", name: "Xiaomi MiMo" },
    { id: "xiaomi-token-plan-cn", name: "Xiaomi Token Plan (China)" },
    { id: "xiaomi-token-plan-ams", name: "Xiaomi Token Plan (Amsterdam)" },
    { id: "xiaomi-token-plan-sgp", name: "Xiaomi Token Plan (Singapore)" },
];
// ─── Config File Helpers ─────────────────────────────────────────────
/** 以 Pi 原生格式（{type, key}）写入 auth.json */
export function writeAuthFileNative(agentDir, auth) {
    const path = join(agentDir, "auth.json");
    writeFileSync(path, JSON.stringify(auth, null, 2) + "\n", "utf8");
    chmodSync(path, 0o600);
}
/**
 * 合并已有 auth 与本次收集的 API key（issue #1）：
 * 已有条目（含 OAuth token）原样保留，同 id 新 key 覆盖。返回新对象，不修改入参。
 */
export function mergeAuthEntries(existing, collected) {
    const merged = { ...existing };
    for (const [id, key] of Object.entries(collected)) {
        merged[id] = { type: "api_key", key };
    }
    return merged;
}
/** settings.json 仅在不存在时写入空骨架，存在时不触碰（issue #1） */
export function ensureSettingsFile(agentDir) {
    const path = join(agentDir, "settings.json");
    if (!existsSync(path)) {
        writeFileSync(path, "{}\n", "utf8");
    }
}
/**
 * 在 Pi agent 目录写入/合并 quietStartup: true 设置。
 *
 * - settings.json 不存在（含 agentDir 不存在）→ 创建目录并写入 {"quietStartup":true}
 * - 已存在且含其他键 → 合并写回，其他键保留
 * - 已为 true → 不写文件（幂等）
 * - JSON 解析失败 或 解析结果非对象 → console.warn + 不动原文件
 */
export function ensureQuietStartup(agentDir) {
    const path = join(agentDir, "settings.json");
    if (!existsSync(agentDir)) {
        mkdirSync(agentDir, { recursive: true, mode: 0o700 });
        writeFileSync(path, JSON.stringify({ quietStartup: true }, null, 2) + "\n", "utf8");
        return;
    }
    if (!existsSync(path)) {
        writeFileSync(path, JSON.stringify({ quietStartup: true }, null, 2) + "\n", "utf8");
        return;
    }
    let existing;
    try {
        const raw = readFileSync(path, "utf8");
        existing = JSON.parse(raw);
    }
    catch {
        console.warn("Warning: settings.json 解析失败，跳过 quietStartup 写入");
        return;
    }
    // 防御：JSON.parse 可返回 null / string / number / array
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
        console.warn("Warning: settings.json is not a JSON object, skipping quietStartup write");
        return;
    }
    if (existing.quietStartup === true) {
        return; // 幂等：已为 true，不写文件
    }
    existing.quietStartup = true;
    writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", "utf8");
}
// ─── Shared Semver Helpers ────────────────────────────────────────────
/**
 * 解析 semver 字符串为 [major, minor, patch] 三元组。
 * 非数字组件降级为 0。不抛异常。
 */
export function parseSemver(v) {
    const parts = v.replace(/^v/, "").split(".");
    return [Number(parts[0]) || 0, Number(parts[1]) || 0, Number(parts[2]) || 0];
}
// ─── Version Helper ──────────────────────────────────────────────────
export function semverGte(v1, v2) {
    const p1 = parseSemver(v1);
    const p2 = parseSemver(v2);
    for (let i = 0; i < 3; i++) {
        if (p1[i] > p2[i])
            return true;
        if (p1[i] < p2[i])
            return false;
    }
    return true;
}
// ─── Skeleton Writer ─────────────────────────────────────────────────
const MODELS_TEMPLATE = `{\n  "_guide": "Custom providers only. The 33 built-in providers (DeepSeek, OpenAI, Anthropic, etc.) are always available once auth is configured in auth.json. Add custom entries here only for self-hosted models (Ollama, vLLM, LM Studio) or proxy overrides. Docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md",\n  "providers": {}\n}\n`;
export function writeSkeletonFiles(agentDir) {
    const skeletons = {
        "auth.json": "{}",
        "settings.json": "{}",
        "models.json": MODELS_TEMPLATE,
    };
    for (const [name, content] of Object.entries(skeletons)) {
        const p = join(agentDir, name);
        if (!existsSync(p)) {
            writeFileSync(p, content + "\n", "utf8");
            if (name === "auth.json")
                chmodSync(p, 0o600);
        }
    }
}
// ─── Auth File Reader ──────────────────────────────────────────────────
/** 读取并解析 auth.json，不存在或损坏时返回 {} */
export function readAuthFile(agentDir) {
    const path = join(agentDir, "auth.json");
    if (!existsSync(path))
        return {};
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            console.warn("Warning: auth.json 格式异常，将以空配置处理");
            return {};
        }
        // Validate each entry has {type, key} shape
        for (const [id, entry] of Object.entries(parsed)) {
            if (typeof entry !== "object" ||
                entry === null ||
                typeof entry.type !== "string" ||
                typeof entry.key !== "string") {
                console.warn(`Warning: auth.json 条目 ${id} 格式不正确（需要 {type, key}），已跳过`);
                delete parsed[id];
            }
        }
        return parsed;
    }
    catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(`Warning: auth.json 解析失败 (${detail})，将以空配置处理`);
        return {};
    }
}
// ─── Key Masking ───────────────────────────────────────────────────────
/** 脱敏显示 API key：sk-a1b2c3d4e5f6g7h8 → sk-a…g7h8 */
export function maskKey(key) {
    if (key.length <= 4)
        return "****";
    if (key.length <= 8)
        return key.slice(0, 2) + "…" + key.slice(-2);
    return key.slice(0, 4) + "…" + key.slice(-4);
}
// ─── Provider Lookup ───────────────────────────────────────────────────
/** 在 ALL_PROVIDERS 中按 id 查找 */
export function findProviderDef(id) {
    return ALL_PROVIDERS.find((p) => p.id === id);
}
