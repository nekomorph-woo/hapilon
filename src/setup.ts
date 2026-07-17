import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { ensureHapilonDirs, hapilonHome } from "./hapilon-home.js";
import {
  COMMON,
  ALL_PROVIDERS,
  writeAuthFileNative,
  writeSkeletonFiles,
  readAuthFile,
  mergeAuthEntries,
  ensureSettingsFile,
  maskKey,
  semverGte,
} from "./providers.js";

// ─── OAuth guide ──────────────────────────────────────────────────────

const OAUTH_PROVIDERS = [
  { id: "xai",              name: "xAI / Grok",         login: "/login xai" },
  { id: "codex",            name: "Codex (OpenAI)",     login: "/login codex" },
  { id: "anthropic-sub",    name: "Claude Pro",          login: "/login anthropic-sub" },
  { id: "github-copilot",   name: "GitHub Copilot",      login: "/login github-copilot" },
];

function printOAuthGuide(): void {
  console.log("\n── OAuth 方式登录 ──");
  console.log("以下 provider 支持 OAuth 登录，无需手动输入 API Key：\n");
  for (const p of OAUTH_PROVIDERS) {
    console.log(`  ${p.name.padEnd(22)} → ${p.login}`);
  }
  console.log("\n进入 hapilon TUI 后输入对应命令，Pi 会弹出浏览器完成授权。");
  console.log("Token 自动保存在 ~/.hapilon/agent/auth.json（与 API key 共存）。");
}

// ─── Setup ───────────────────────────────────────────────────────────

export function setupQuick(): void {
  const dirs = ensureHapilonDirs();
  writeSkeletonFiles(dirs.agent);
  console.log(`Created ~/.hapilon/ skeleton at ${dirs.base}`);
  console.log("Run `hapilon setup` (without --quick) for interactive provider configuration.");
  printOAuthGuide();
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

  // issue #1: 先读已有配置，交互提示"已配置"状态，写入时增量合并
  const existingAuth = readAuthFile(dirs.agent);

  const yesno = async (q: string): Promise<boolean> => {
    const a = (await question(q + "（y/N）")).trim().toLowerCase();
    return a === "y" || a === "yes";
  };

  const collected: Record<string, string> = {};

  try {
    console.log("\n══════ Hapilon Provider Setup ══════\n");

    for (const p of COMMON) {
      const configured = Object.hasOwn(existingAuth, p.id);
      const prompt = configured
        ? `你有 ${p.name} API Key？（已配置 ${maskKey(existingAuth[p.id].key)}，重新输入将覆盖）`
        : `你有 ${p.name} API Key？`;
      if (await yesno(prompt)) {
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

  // issue #1: 增量合并——已有条目（含 OAuth token）保留，本次输入覆盖同名条目
  const auth = mergeAuthEntries(existingAuth, collected);
  writeAuthFileNative(dirs.agent, auth);
  ensureSettingsFile(dirs.agent);

  const names = Object.keys(collected).map(
    (id) => ALL_PROVIDERS.find((p) => p.id === id)?.name ?? id,
  );

  console.log("\n══════ 配置摘要 ══════");
  const total = Object.keys(auth).length;
  if (names.length > 0) {
    console.log(`✅ auth.json 本次新增/更新: ${names.join(", ")}（共 ${total} 个 provider）`);
  } else if (total > 0) {
    console.log(`ℹ 本次未新增 provider。auth.json 现有 ${total} 个 provider。`);
  } else {
    console.log("ℹ 未配置任何 provider。auth.json 为空。");
  }
  printOAuthGuide();
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
          const masked = maskKey(entry.key);
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
