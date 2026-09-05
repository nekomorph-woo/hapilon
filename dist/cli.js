#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { COMMANDS } from "./commands.js";
import { resolvePiCli } from "./pi-cli-path.js";
import { discoverExtensions } from "./extensions.js";
async function main() {
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
    // --mode 存在时抑制 hapilon banner，避免在非 TUI 模式下污染 stdout
    const { hasFlag, readHapilonConfig, writeHapilonConfig, injectDefaultArgs, stripHapilonFlags } = await import("./config-io.js");
    const isNonInteractive = hasFlag(args, "-p") || hasFlag(args, "--print") || hasFlag(args, "--mode");
    const noSafety = hasFlag(args, "--no-safety");
    const piCli = resolvePiCli();
    const { agentDir } = await import("./hapilon-home.js");
    const agentDirPath = agentDir();
    if (!existsSync(agentDirPath)) {
        console.warn("~/.hapilon/ not configured. Run `hapilon setup` to configure providers.");
    }
    // 确保 Pi 静默启动（隐藏内置 header + loaded resources）
    const { ensureQuietStartup } = await import("./providers.js");
    ensureQuietStartup(agentDirPath);
    const { getVersion } = await import("./help.js");
    const config = readHapilonConfig();
    // 自有 flag 剥离（#38）：--no-safety / --sandbox 是 hapilon 启动器语义，
    // pi 不认识——不剥离 pi 直接报 Unknown option 退出。检测（hasFlag）在
    // 剥离前的原始 args 上完成，piArgs 只装 pi 该看到的。
    const piArgs = injectDefaultArgs(stripHapilonFlags(args), config);
    // 禁用 Pi 原生上下文识别（hpl-context 扩展已接管）
    piArgs.push("--no-context-files", "--no-skills");
    // 首次启动安全提示（即使 --no-safety 也展示，这是告知性的）
    if (!config.safetyNoticeShown && !isNonInteractive) {
        console.log("\n🛡️  hapilon 安全扩展已激活：");
        console.log("   • 危险命令拦截 — sudo rm、mkfs、fork bomb 等将被阻止");
        console.log("   • 文件路径保护 — .env / SSH key 等敏感文件受保护");
        console.log("   • 使用 --no-safety 可临时关闭所有安全检查\n");
        try {
            writeHapilonConfig({ ...config, safetyNoticeShown: true });
        }
        catch (err) {
            console.warn("无法写入安全提示状态到配置文件（权限不足？），将在下次启动时重新提示。");
        }
    }
    // ── 安全门 settings 通道（#37）────────────────────────────────
    // hpl-safety-gate / hpl-protected-paths 写入 settings.json，
    // 父会话与 subagent 会话都会加载——安全规则无处不在。
    // --no-safety 则从 settings 移除，同样作用于所有会话。
    const safetySettings = await import("./safety-settings.js");
    if (noSafety) {
        safetySettings.removeSafetyExtensions(agentDirPath);
    }
    else {
        safetySettings.ensureSafetyExtensions(agentDirPath);
    }
    // 扩展默认配置预置（map #31）：文件不存在才写，用户改过永不覆盖
    const { ensureExtensionConfigs } = await import("./ensure-extension-configs.js");
    ensureExtensionConfigs(agentDirPath);
    // 自动扫描 hapilon 内置扩展，通过 -e 注入到 pi（仅父会话生效）。
    // 安全门走 settings 通道（上方），这里一律排除，避免重复加载。
    const allExtensions = discoverExtensions().filter((e) => !safetySettings.isSafetyExtensionPath(e));
    // 第三方 npm 扩展（#37）：与 hpl-* 同一 -e 通道注入。
    // 走 node_modules 而非 pi install，保证 subagent session 不重新激活。
    const { resolveNpmExtensionPaths } = await import("./npm-extensions.js");
    const npmExtensions = resolveNpmExtensionPaths();
    const extensionFlags = [...allExtensions, ...npmExtensions].flatMap((e) => ["-e", e]);
    // --no-econ（#52）：单会话关闭 bash 输出压缩，映射为扩展的会话内覆盖
    const noEcon = hasFlag(args, "--no-econ");
    if (noEcon) {
        const { setSessionDisabled } = await import("./extensions/hpl-econ/index.js");
        setSessionDisabled(true);
    }
    // 构建统一的 Pi 环境变量（sandbox 与默认路径共用）
    const { extensionNames: namesOf } = await import("./extensions.js");
    // header 展示用：-e 注入的 + 安全门（--no-safety 时安全门已移除，如实不显示）
    const displayedExtensions = noSafety
        ? allExtensions
        : [...allExtensions, ...safetySettings.safetyExtensionPaths()];
    const piEnv = {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDirPath,
        PI_SKIP_VERSION_CHECK: "1",
        HAPILON_EXTENSIONS: JSON.stringify(namesOf(displayedExtensions)),
        HAPILON_VERSION: getVersion(),
    };
    // ── OS 沙箱 ────────────────────────────────────────────────────
    const useSandbox = hasFlag(args, "--sandbox");
    if (useSandbox) {
        const platform = process.platform;
        if (platform === "win32") {
            console.warn("⚠ --sandbox 暂不支持 Windows。使用命令+文件策略保护。");
        }
        else {
            // Linux 预检 bwrap（issue #5）：缺失时打印发行版安装提示并退出
            if (platform === "linux") {
                const { bwrapInstalled, bwrapInstallHint } = await import("./sandbox.js");
                if (!bwrapInstalled()) {
                    console.error(bwrapInstallHint().join("\n"));
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
            const shellEscape = (a) => {
                if (!/[ "\$\\]/.test(a))
                    return a;
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
    }
    // ── 默认启动（无沙箱）─────────────────────────────────────────
    const child = spawn(process.execPath, [piCli, ...extensionFlags, ...piArgs], {
        cwd: process.cwd(),
        stdio: "inherit",
        env: piEnv,
    });
    child.on("error", (err) => {
        console.error(`Failed to start Hapilon: ${err.message}`);
        process.exitCode = 1;
    });
    child.on("exit", (code) => {
        process.exitCode = code ?? 1;
    });
}
try {
    await main();
}
catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Hapilon 运行错误: ${msg}`);
    process.exitCode = 1;
}
