import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { ensureHapilonDirs, hapilonHome } from "./hapilon-home.js";
import {
  COMMON,
  ALL_PROVIDERS,
  writeAuthFile,
  writeSettingsFile,
  writeSkeletonFiles,
  semverGte,
} from "./providers.js";

// ─── Setup ───────────────────────────────────────────────────────────

export function setupQuick(): void {
  const dirs = ensureHapilonDirs();
  writeSkeletonFiles(dirs.agent);
  console.log(`Created ~/.hapilon/ skeleton at ${dirs.base}`);
  console.log("Run `hapilon setup` (without --quick) for interactive provider configuration.");
}

export async function setupInteractive(): Promise<void> {
  const rl = createInterface({
    input: stdin,
    output: stdout,
    terminal: stdin.isTTY === true,
  });
  const lines = rl[Symbol.asyncIterator]();

  async function question(q: string): Promise<string> {
    stdout.write(q);
    const { value, done } = await lines.next();
    return done ? "" : value;
  }

  const dirs = ensureHapilonDirs();

  const yesno = async (q: string): Promise<boolean> => {
    const a = (await question(q + "（y/N）")).trim().toLowerCase();
    return a === "y" || a === "yes";
  };

  const collected: Record<string, string> = {};

  try {
    console.log("\n══════ Hapilon Provider Setup ══════\n");

    for (const p of COMMON) {
      if (await yesno(`你有 ${p.name} API Key？`)) {
        const key = (await question(`  输入 ${p.name} API Key（留空跳过）: `)).trim();
        if (key) collected[p.id] = key;
      }
    }

    const remaining = ALL_PROVIDERS.filter(
      (p) => !Object.hasOwn(collected, p.id),
    );

    if (remaining.length > 0 && (await yesno("\n还有其他 provider 要配置吗？"))) {
      console.log("\n可用的 Provider（输入 ID 添加）:");
      for (const p of remaining) {
        console.log(`  ${p.id}  — ${p.name}`);
      }
      while (true) {
        const answer = (await question("\n输入 provider ID（留空结束）: ")).trim();
        if (!answer) break;
        const match = ALL_PROVIDERS.find((p) => p.id === answer);
        if (!match) {
          console.log(`  ❌ 未知 provider: ${answer}`);
          continue;
        }
        if (Object.hasOwn(collected, answer)) {
          console.log(`  ℹ ${match.name} 已配置`);
          continue;
        }
        const key = (await question(`  输入 ${match.name} API Key（留空跳过）: `)).trim();
        if (key) collected[match.id] = key;
      }
    }
  } finally {
    rl.close();
  }

  writeAuthFile(dirs.agent, collected);
  writeSettingsFile(dirs.agent, {});

  const names = Object.keys(collected).map(
    (id) => ALL_PROVIDERS.find((p) => p.id === id)?.name ?? id,
  );

  console.log("\n══════ 配置摘要 ══════");
  if (names.length > 0) {
    console.log(`✅ auth.json 已配置: ${names.join(", ")}`);
  } else {
    console.log("ℹ 未配置任何 provider。auth.json 为空。");
  }
  console.log("ℹ OAuth provider（Codex / Claude Pro / GitHub Copilot）请通过 pi TUI 的 /login 配置");
  console.log(`\n配置已写入 ${dirs.agent}`);
}

// ─── Doctor ──────────────────────────────────────────────────────────

export function doctor(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(__dirname, "..", "package.json");
  let version = "unknown";
  try {
    version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch { /* ignore */ }

  console.log(`hapilon v${version}`);
  console.log(`Node.js ${process.version}  ${semverGte(process.version, "v22.19.0") ? "✅" : "❌ 需要 >=22.19"}`);

  const home = hapilonHome();
  const agentDir = join(home, "agent");

  console.log(`\n~/.hapilon/:         ${existsSync(home) ? "✅" : "⚠ 未创建"}`);
  console.log(`~/.hapilon/agent/:   ${existsSync(agentDir) ? "✅" : "⚠ 未创建"}`);

  const authPath = join(agentDir, "auth.json");
  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf8"));
      const keys = Object.keys(auth);
      console.log(`\nauth.json:`);
      if (keys.length > 0) {
        for (const id of keys) {
          const entry = auth[id];
          const masked = entry.key.length > 8
            ? entry.key.slice(0, 4) + "…" + entry.key.slice(-4)
            : "********";
          console.log(`  ✅ ${id}: ${masked}`);
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
}
