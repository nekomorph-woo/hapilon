import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Data, Effect } from "effect";

export class AuthWriteError extends Data.TaggedError("AuthWriteError")<{
  message: string;
}> {}

/**
 * 在 Pi agent 目录写入/合并 quietStartup: true 设置。
 *
 * - settings.json 不存在（含 agentDir 不存在）→ 创建目录并写入 {"quietStartup":true}
 * - 已存在且含其他键 → 合并写回，其他键保留
 * - 已为 true → 不写文件（幂等）
 * - JSON 解析失败 或 解析结果非对象 → console.warn + 不动原文件
 */
export const ensureQuietStartupEffect = (agentDir: string): Effect.Effect<void, AuthWriteError> => Effect.gen(function* () {
  const path = join(agentDir, "settings.json");

  if (!existsSync(agentDir)) {
    yield* Effect.try({
      try: () => mkdirSync(agentDir, { recursive: true, mode: 0o700 }),
      catch: (err) => new AuthWriteError({ message: err instanceof Error ? err.message : String(err) }),
    });
    yield* Effect.try({
      try: () => writeFileSync(path, JSON.stringify({ quietStartup: true }, null, 2) + "\n", "utf8"),
      catch: (err) => new AuthWriteError({ message: err instanceof Error ? err.message : String(err) }),
    });
    return;
  }

  if (!existsSync(path)) {
    yield* Effect.try({
      try: () => writeFileSync(path, JSON.stringify({ quietStartup: true }, null, 2) + "\n", "utf8"),
      catch: (err) => new AuthWriteError({ message: err instanceof Error ? err.message : String(err) }),
    });
    return;
  }

  let existing: SettingsJson;
  try {
    const raw = readFileSync(path, "utf8");
    existing = JSON.parse(raw);
  } catch {
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
  yield* Effect.try({
    try: () => writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", "utf8"),
    catch: (err) => new AuthWriteError({ message: err instanceof Error ? err.message : String(err) }),
  });
});

export function ensureQuietStartup(agentDir: string): void {
  const result = Effect.runSync(Effect.either(ensureQuietStartupEffect(agentDir)));
  if (result._tag === "Left") throw new Error(result.left.message);
}

// ─── Shared Semver Helpers ────────────────────────────────────────────

/**
 * 解析 semver 字符串为 [major, minor, patch] 三元组。
 * 非数字组件降级为 0。不抛异常。
 */
export function parseSemver(v: string): [number, number, number] {
  const parts = v.replace(/^v/, "").split(".");
  return [Number(parts[0]) || 0, Number(parts[1]) || 0, Number(parts[2]) || 0];
}

/** settings.json 的宽松类型：仅约束 quietStartup 键，其余任意 */
export interface SettingsJson {
  quietStartup?: boolean;
  [key: string]: unknown;
}

// ─── Version Helper ──────────────────────────────────────────────────

export function semverGte(v1: string, v2: string): boolean {
  const p1 = parseSemver(v1);
  const p2 = parseSemver(v2);
  for (let i = 0; i < 3; i++) {
    if (p1[i] > p2[i]) return true;
    if (p1[i] < p2[i]) return false;
  }
  return true;
}

// ─── Key Masking ───────────────────────────────────────────────────────

/** 脱敏显示 API key：sk-a1b2c3d4e5f6g7h8 → sk-a…g7h8 */
export function maskKey(key: string): string {
  if (key.length <= 4) return "****";
  if (key.length <= 8) return key.slice(0, 2) + "…" + key.slice(-2);
  return key.slice(0, 4) + "…" + key.slice(-4);
}
