import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

/** 读取 hapilon 版本；CLI 展示层沿用坏文件时 unknown 的降级语义。 */
export const readVersionEffect: Effect.Effect<string, never> = Effect.sync(() => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(__dirname, "..", "..", "package.json");
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch {
    console.warn("Warning: 无法读取版本号");
    return "unknown";
  }
});
