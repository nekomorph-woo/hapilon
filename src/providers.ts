import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

// ─── Provider Definitions ────────────────────────────────────────────

export interface ProviderDef {
  id: string;
  name: string;
}

export const COMMON: ProviderDef[] = [
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

export const ALL_PROVIDERS: ProviderDef[] = [
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
export function writeAuthFileNative(
  agentDir: string,
  auth: Record<string, { type: string; key: string }>,
): void {
  const path = join(agentDir, "auth.json");
  writeFileSync(path, JSON.stringify(auth, null, 2) + "\n", "utf8");
  chmodSync(path, 0o600);
}

export function writeSettingsFile(
  agentDir: string,
  config: Record<string, unknown>,
): void {
  const path = join(agentDir, "settings.json");
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// ─── Version Helper ──────────────────────────────────────────────────

export function semverGte(v1: string, v2: string): boolean {
  const p1 = v1.replace(/^v/, "").split(".").map(Number);
  const p2 = v2.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const a = p1[i] ?? 0;
    const b = p2[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

// ─── Skeleton Writer ─────────────────────────────────────────────────

const MODELS_TEMPLATE = `{\n  "_guide": "Custom providers only. The 33 built-in providers (DeepSeek, OpenAI, Anthropic, etc.) are always available once auth is configured in auth.json. Add custom entries here only for self-hosted models (Ollama, vLLM, LM Studio) or proxy overrides. Docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md",\n  "providers": {}\n}\n`;

export function writeSkeletonFiles(agentDir: string): void {
  const skeletons: Record<string, string> = {
    "auth.json": "{}",
    "settings.json": "{}",
    "models.json": MODELS_TEMPLATE,
  };
  for (const [name, content] of Object.entries(skeletons)) {
    const p = join(agentDir, name);
    if (!existsSync(p)) {
      writeFileSync(p, content + "\n", "utf8");
      if (name === "auth.json") chmodSync(p, 0o600);
    }
  }
}

// ─── Auth File Reader ──────────────────────────────────────────────────

/** 读取并解析 auth.json，不存在或损坏时返回 {} */
export function readAuthFile(
  agentDir: string,
): Record<string, { type: string; key: string }> {
  const path = join(agentDir, "auth.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn("Warning: auth.json 格式异常，将以空配置处理");
      return {};
    }
    // Validate each entry has {type, key} shape
    for (const [id, entry] of Object.entries(parsed)) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as Record<string, unknown>).type !== "string" ||
        typeof (entry as Record<string, unknown>).key !== "string"
      ) {
        console.warn(
          `Warning: auth.json 条目 ${id} 格式不正确（需要 {type, key}），已跳过`,
        );
        delete parsed[id];
      }
    }
    return parsed;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(
      `Warning: auth.json 解析失败 (${detail})，将以空配置处理`,
    );
    return {};
  }
}

// ─── Key Masking ───────────────────────────────────────────────────────

/** 脱敏显示 API key：sk-a1b2c3d4e5f6g7h8 → sk-a…g7h8 */
export function maskKey(key: string): string {
  if (key.length <= 4) return "****";
  if (key.length <= 8) return key.slice(0, 2) + "…" + key.slice(-2);
  return key.slice(0, 4) + "…" + key.slice(-4);
}

// ─── Provider Lookup ───────────────────────────────────────────────────

/** 在 ALL_PROVIDERS 中按 id 查找 */
export function findProviderDef(id: string): ProviderDef | undefined {
  return ALL_PROVIDERS.find((p) => p.id === id);
}
