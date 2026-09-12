import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { Data, Effect } from "effect";
import { getVersion } from "./help.js";
import { hasFlag, migrateLegacyDefaultsEffect, readHapilonConfigEffect, writeHapilonConfigEffect, stripHapilonFlags } from "../config/config-io.js";
import { hapilonHomeEffect } from "../config/hapilon-home.js";
import { ensureQuietStartupEffect } from "../providers/providers.js";
import { resolvePiCliEffect } from "../providers/pi-cli-path.js";
import { ensureSafetyExtensionsEffect, isSafetyExtensionPath, removeSafetyExtensionsEffect, safetyExtensionPaths } from "../safety/safety-settings.js";
import { discoverExtensionsEffect, extensionNames } from "../extensions/loader.js";
import { ensureExtensionConfigsEffect } from "../extensions/ensure-configs.js";
import { ensurePiPatch, warnIfPiPatchStale } from "../patch/ensure-pi-patch.js";
import { resolveNpmExtensionPathsEffect } from "../extensions/npm-extensions.js";
import { deriveCliIdentity } from "./identity.js";
export class StartupError extends Data.TaggedError("StartupError") {
}
const toStartupError = (error) => new StartupError({ message: error instanceof Error ? error.message : String(error) });
/**
 * 探测 herdr 官方 pi 集成扩展（herdr integration install pi 安装到原生 pi
 * agentDir/extensions/，路径与文件名是其安装协议约定）。hapilon 重定向了
 * PI_CODING_AGENT_DIR，原生全局扩展目录不再被 pi 扫描，需显式 -e 加载。
 * 文件不存在（未装 herdr / 未装集成）→ undefined，静默跳过。
 */
export function discoverHerdrPiExtension(userPiAgentDir) {
    const agentDir = userPiAgentDir || join(homedir(), ".pi", "agent");
    const extensionPath = join(agentDir, "extensions", "herdr-agent-state.ts");
    return existsSync(extensionPath) ? extensionPath : undefined;
}
export const prepareStartupEffect = (args) => Effect.gen(function* () {
    const home = yield* hapilonHomeEffect.pipe(Effect.mapError(toStartupError));
    const agentDirPath = join(home, "agent");
    const isNonInteractive = hasFlag(args, "-p") || hasFlag(args, "--print") || hasFlag(args, "--mode");
    const noSafety = hasFlag(args, "--no-safety");
    const noEcon = hasFlag(args, "--no-econ");
    const piCli = yield* resolvePiCliEffect.pipe(Effect.mapError(toStartupError));
    if (!existsSync(agentDirPath) && !isNonInteractive) {
        const identity = deriveCliIdentity();
        console.warn(`${identity.homeDisplay}/ not configured. Run \`${identity.cliName} setup\` to configure providers.`);
    }
    yield* ensureQuietStartupEffect(agentDirPath).pipe(Effect.mapError(toStartupError));
    yield* migrateLegacyDefaultsEffect;
    const config = yield* readHapilonConfigEffect;
    const piArgs = stripHapilonFlags(args);
    piArgs.push("--no-context-files", "--no-skills");
    if (!config.safetyNoticeShown && !isNonInteractive) {
        console.log("\n🛡️  hapilon 安全扩展已激活：");
        console.log("   • 危险命令拦截 — sudo rm、mkfs、fork bomb 等将被阻止");
        console.log("   • 文件路径保护 — .env / SSH key 等敏感文件受保护");
        console.log("   • 使用 --no-safety 可临时关闭所有安全检查\n");
        yield* writeHapilonConfigEffect({ ...config, safetyNoticeShown: true }).pipe(Effect.catchTag("ConfigWriteError", () => Effect.sync(() => {
            console.warn("无法写入安全提示状态到配置文件（权限不足？），将在下次启动时重新提示。");
        })));
    }
    if (noSafety) {
        yield* removeSafetyExtensionsEffect(agentDirPath).pipe(Effect.mapError(toStartupError));
    }
    else {
        yield* ensureSafetyExtensionsEffect(agentDirPath).pipe(Effect.mapError(toStartupError));
    }
    yield* ensureExtensionConfigsEffect(agentDirPath).pipe(Effect.mapError(toStartupError));
    // pi 单独升级时 postinstall 不会重跑，主题补丁靠这里补上（约 3ms，已补丁即只读判标记）
    yield* Effect.sync(() => warnIfPiPatchStale(ensurePiPatch()));
    const allExtensions = (yield* discoverExtensionsEffect()).filter((extension) => !isSafetyExtensionPath(extension));
    const npmExtensions = yield* resolveNpmExtensionPathsEffect.pipe(Effect.mapError(toStartupError));
    // herdr 集成探测须读用户的原生 PI_CODING_AGENT_DIR，而非下方 piEnv 覆盖后的 hapilon agentDir
    const herdrExtension = discoverHerdrPiExtension(process.env["PI_CODING_AGENT_DIR"]);
    const extensionFlags = [...allExtensions, ...npmExtensions, ...herdrExtension ? [herdrExtension] : []]
        .flatMap((extension) => ["-e", extension]);
    if (noEcon) {
        const econ = yield* Effect.tryPromise({
            try: () => import("../extensions/hpl-econ/index.js"),
            catch: toStartupError,
        });
        econ.setSessionDisabled(true);
    }
    const displayedExtensions = noSafety
        ? allExtensions
        : [...allExtensions, ...safetyExtensionPaths()];
    // hapilon 自身入口绝对路径：供 hpl-orchestra 等扩展在 worker/reviewer
    // 面板重新拉起完整 hapilon（扩展跑在 pi 子进程里，argv[1] 是 pi 的 cli.js，
    // 不能用——review P0 #1）。本模块编译后在 dist/cli/ 下，上一级即 dist/cli.js。
    const hapilonCliPath = fileURLToPath(new URL("../cli.js", import.meta.url));
    const piEnv = {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDirPath,
        PI_SKIP_VERSION_CHECK: "1",
        HAPILON_EXTENSIONS: JSON.stringify(extensionNames(displayedExtensions)),
        HAPILON_VERSION: getVersion(),
        HAPILON_CLI_PATH: hapilonCliPath,
        // 隐藏 ponytail footer 指示器；ponytail ruleset 仍保持激活。
        PONYTAIL_HIDE_STATUS: "1",
    };
    return {
        piCli,
        piArgs,
        extensionFlags,
        piEnv,
        useSandbox: hasFlag(args, "--sandbox"),
        isNonInteractive,
        agentDirPath,
    };
});
