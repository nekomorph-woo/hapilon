import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { hapilonHome } from "../config/hapilon-home.js";
import { resolvePiCliEffect } from "../providers/pi-cli-path.js";
import { readVersionEffect } from "./version.js";
import { deriveCliIdentity } from "./identity.js";
import { maskKey, semverGte } from "../providers/providers.js";

export function doctor(): void {
  const version = Effect.runSync(readVersionEffect);

  console.log(`hapilon v${version}`);
  console.log(`Node.js ${process.version}  ${semverGte(process.version, "v22.19.0") ? "✅" : "❌ 需要 >=22.19"}`);

  const home = hapilonHome();
  const agentDir = join(home, "agent");
  const homeDisplay = deriveCliIdentity().homeDisplay;

  console.log(`\n${homeDisplay}/:         ${existsSync(home) ? "✅" : "⚠ 未创建"}`);
  console.log(`${homeDisplay}/agent/:   ${existsSync(agentDir) ? "✅" : "⚠ 未创建"}`);

  const authPath = join(agentDir, "auth.json");
  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf8"));
      const keys = Object.keys(auth);
      console.log(`\nauth.json:`);
      if (keys.length > 0) {
        for (const id of keys) {
          const entry = auth[id];
          // oauth 型条目（access/refresh）无 key 字段，显示类型而非脱敏值
          if (typeof entry?.key === "string") {
            console.log(`  ✅ ${id}: ${maskKey(entry.key)}`);
          } else {
            console.log(`  ✅ ${id}: (oauth，${entry?.type ?? "未知类型"})`);
          }
        }
      } else {
        console.log(`  ⚠ 空文件（未配置任何 provider）`);
      }
    } catch {
      console.log(`  ❌ 解析失败（JSON 语法错误）`);
    }
  } else {
    console.log(`\nauth.json:           ⚠ 不存在`);
  }

  const modelsPath = join(agentDir, "models.json");
  console.log(`models.json:         ${existsSync(modelsPath) ? "✅ 自定义模型" : "ℹ 不存在（正常）"}`);
  console.log(`\nPI_CODING_AGENT_DIR: ${agentDir}  ${existsSync(agentDir) ? "✅" : "⚠ 目标目录缺失"}`);

  // pi binary 可解析检查
  try {
    const piCli = Effect.runSync(resolvePiCliEffect);
    console.log(`pi binary:           ${existsSync(piCli) ? "✅" : "⚠ 解析到但文件缺失"} ${piCli}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`pi binary:           ❌ ${msg}`);
  }
}
