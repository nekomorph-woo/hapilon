#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolvePiCli } from "./pi-cli-path.js";
import { discoverExtensions } from "./extensions.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ── --help / -h intercept (any position) ───────────────────────────

  if (args.includes("--help") || args.includes("-h")) {
    const { printHelp } = await import("./help.js");
    printHelp();
    return;
  }

  // ── Command routing ──────────────────────────────────────────────

  const command = args[0];

  if (command === "setup") {
    const isQuick =
      args.includes("--quick") || args.includes("-q");
    const mod = await import("./setup.js");
    if (isQuick) {
      mod.setupQuick();
    } else {
      await mod.setupInteractive();
    }
    return;
  }

  if (command === "doctor") {
    const mod = await import("./setup.js");
    mod.doctor();
    return;
  }

  if (command === "help") {
    const { printHelp, printHelpFor } = await import("./help.js");
    const cmdName = args[1];
    if (cmdName) {
      printHelpFor(cmdName);
    } else {
      printHelp();
    }
    return;
  }

  if (command === "config") {
    const { handleConfig } = await import("./config.js");
    await handleConfig(args);
    return;
  }

  // ── Unknown command guard ────────────────────────────────────────

  if (command && !command.startsWith("-")) {
    console.error(`未知命令: ${command}`);
    console.error("输入 hapilon help 查看帮助");
    process.exit(1);
  }

  // ── Default: launch pi ───────────────────────────────────────────

  // --mode 存在时抑制 hapilon banner，避免在非 TUI 模式下污染 stdout
  const { hasFlag, readHapilonConfig, writeHapilonConfig, injectDefaultArgs } = await import(
    "./config-io.js"
  );
  const isNonInteractive =
    hasFlag(args, "-p") || hasFlag(args, "--print") || hasFlag(args, "--mode");
  const noSafety = hasFlag(args, "--no-safety");

  if (!isNonInteractive) {
    console.log("hapilon_v0.1.0_alpha");
  }

  const piCli = resolvePiCli();
  const { hapilonHome } = await import(
    "./hapilon-home.js"
  );
  const home = hapilonHome();
  const agentDir = join(home, "agent");

  if (!existsSync(agentDir)) {
    console.warn(
      "~/.hapilon/ not configured. Run `hapilon setup` to configure providers.",
    );
  }

  const config = readHapilonConfig();
  const piArgs = injectDefaultArgs(args, config);

  // 首次启动安全提示（即使 --no-safety 也展示，这是告知性的）
  if (!config.safetyNoticeShown && !isNonInteractive) {
    console.log("\n🛡️  hapilon 安全扩展已激活：");
    console.log("   • 危险命令拦截 — sudo rm、mkfs、fork bomb 等将被阻止");
    console.log("   • 文件路径保护 — .env / SSH key 等敏感文件受保护");
    console.log("   • 使用 --no-safety 可临时关闭所有安全检查\n");
    try {
      writeHapilonConfig({ ...config, safetyNoticeShown: true });
    } catch (err) {
      console.warn("无法写入安全提示状态到配置文件（权限不足？），将在下次启动时重新提示。");
    }
  }

  // 自动扫描 hapilon 内置扩展，通过 -e 注入到 pi
  const allExtensions = discoverExtensions();
  const loadedExtensions = noSafety
    ? allExtensions.filter(
        (e) =>
          !e.endsWith("/safety-gate/index.js") &&
          !e.endsWith("/safety-gate.js") &&
          !e.endsWith("/protected-paths/index.js") &&
          !e.endsWith("/protected-paths.js"),
      )
    : allExtensions;
  const extensionFlags = loadedExtensions.flatMap((e) => ["-e", e]);

  const child = spawn(
    process.execPath,
    [piCli, ...extensionFlags, ...piArgs],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
      },
    },
  );

  child.on("error", (err) => {
    console.error(
      `Failed to start Hapilon: ${err.message}`,
    );
    process.exitCode = 1;
  });

  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

try {
  await main();
} catch (err) {
  const msg =
    err instanceof Error ? err.message : String(err);
  console.error(`Hapilon 运行错误: ${msg}`);
  process.exitCode = 1;
}
