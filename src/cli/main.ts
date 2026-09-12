#!/usr/bin/env node

import { spawn } from "node:child_process";
import { COMMANDS } from "./commands.js";
import { Effect } from "effect";
import { prepareStartupEffect } from "./startup.js";
import { hasFlag } from "../config/config-io.js";

export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ── --help / -h intercept (any position) ───────────────────────────

  if (args.includes("--help") || args.includes("-h")) {
    const { printHelp } = await import("./help.js");
    printHelp();
    return;
  }

  // ── --version / -v intercept（不透传 pi：用户问的是 hapilon 版本）──

  if (args.includes("--version") || args.includes("-v")) {
    const { getVersion } = await import("./help.js");
    console.log(getVersion());
    return;
  }

  // ── Command routing（由 commands.ts 注册表驱动，issue #4）───────

  const command = args[0];
  const cmd = COMMANDS.find((c) => c.name === command);
  if (cmd?.handler) {
    await cmd.handler(args);
    return;
  }

  // ── Default: launch pi ───────────────────────────────────────────
  // 未知命令不拦截（issue #14）：hapilon [other] 原样传给 pi 处理，
  // 与 TODO-1 spec 路由表「原样传给 pi」一致，hapilon 是 pi 的薄包装。

  const plan = await Effect.runPromise(prepareStartupEffect(args));
  const {
    piCli,
    piArgs,
    extensionFlags,
    piEnv,
    useSandbox,
    isNonInteractive,
    agentDirPath,
  } = plan;
  // ── OS 沙箱 ────────────────────────────────────────────────────

  if (useSandbox) {
    const platform = process.platform;

    // Linux 预检 bwrap（issue #5）：缺失时打印发行版安装提示并退出
    if (platform === "linux") {
      const { bwrapInstalled, bwrapInstallHint } = await import("../safety/sandbox.js");
      if (!bwrapInstalled()) {
        console.error(bwrapInstallHint().join("\n"));
        process.exit(1);
      }
    }

    // Windows 预检（ASRT alpha，srt-win）：检查 srt-sandbox 账户与 WFP 围栏
    // 是否就绪（windows-install 一次性装机，自提权一次 UAC）。未就绪时
    // 给出安装指引并退出，避免 initialize() 半路失败的模糊报错。
    // --setup-windows：就地执行装机（UAC 弹窗授权），完成后继续本次启动。
    if (platform === "win32") {
      const srt = await import("@anthropic-ai/sandbox-runtime");
      let status = await srt.checkWindowsSandboxStatusAsync();
      let userReady = status.user.provisioned && status.user.credPresent;
      // cannot-read：非管理员读不了 BFE 枚举，不视为未装机（凭 verify 兜底）
      let wfpReady = status.wfp.state === "installed" || status.wfp.state === "cannot-read";
      if ((!userReady || !wfpReady) && hasFlag(args, "--setup-windows")) {
        console.log("🛡️  正在执行 Windows 沙箱装机（请在 UAC 弹窗中授权）…");
        const result = await srt.installWindowsSandboxAsync();
        if (result.cancelled) {
          console.error("已取消授权，沙箱未安装。");
          process.exit(1);
        }
        status = await srt.checkWindowsSandboxStatusAsync();
        userReady = status.user.provisioned && status.user.credPresent;
        wfpReady = status.wfp.state === "installed" || status.wfp.state === "cannot-read";
      }
      if (!userReady || !wfpReady) {
        console.error("🛡️  --sandbox 在 Windows 需要 one-time 装机（自提权，一次 UAC）：");
        console.error("   npx @anthropic-ai/sandbox-runtime windows-install");
        console.error("   该命令创建 srt-sandbox 本地账户并安装 WFP 出站围栏，可重复执行。");
        if (!isNonInteractive) {
          console.error("\n也可现在直接执行安装（需要管理员授权）：");
          console.error("  hapilon --sandbox --setup-windows");
        }
        process.exit(1);
      }
    }

    if (!isNonInteractive) {
      console.log("🛡️  OS 沙箱已激活");
    }

    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    await SandboxManager.initialize({
      filesystem: {
        denyRead: ["~/.ssh", "~/.aws", "~/.netrc"],
        // agentDir 必须可写：pi 运行时维护 settings.json 及其 .lock
        // （#37 起 settings 还承载安全门通道，#38 修复 sandbox 路径的
        // EPERM warning——沙箱挡住了 hapilon 自己的配置写入）
        allowWrite: [".", "/tmp", agentDirPath],
        denyWrite: [".env", ".git/config"],
      },
      network: {
        allowedDomains: ["*"],
        deniedDomains: [],
      },
    });

    const shellEscape = (a: string): string => {
      if (!/[ "\$\\]/.test(a)) return a;
      return `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    };
    const cmdStr = [process.execPath, piCli, ...extensionFlags, ...piArgs]
      .map(shellEscape)
      .join(" ");
    const sandboxedCmd = await SandboxManager.wrapWithSandbox(cmdStr);

    const child = spawn(sandboxedCmd, {
      shell: true,
      stdio: "inherit",
      cwd: process.cwd(),
      env: piEnv,
    });

    child.on("error", (err) => {
      console.error(`Failed to start Hapilon (sandbox): ${err.message}`);
      process.exitCode = 1;
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
    return; // 沙箱路径直接返回，不走默认 spawn
  }

  // ── 默认启动（无沙箱）─────────────────────────────────────────

  const child = spawn(
    process.execPath,
    [piCli, ...extensionFlags, ...piArgs],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: piEnv,
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
