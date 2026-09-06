import { existsSync } from "node:fs";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { getVersion } from "./help.js";
import { hasFlag, migrateLegacyDefaultsEffect, readHapilonConfigEffect, writeHapilonConfigEffect, stripHapilonFlags } from "../config/config-io.js";
import { hapilonHomeEffect } from "../config/hapilon-home.js";
import { ensureQuietStartupEffect } from "../providers/providers.js";
import { resolvePiCliEffect } from "../providers/pi-cli-path.js";
import { ensureSafetyExtensionsEffect, isSafetyExtensionPath, removeSafetyExtensionsEffect, safetyExtensionPaths } from "../safety/safety-settings.js";
import { discoverExtensionsEffect, extensionNames } from "../extensions/loader.js";
import { ensureExtensionConfigsEffect } from "../extensions/ensure-configs.js";
import { resolveNpmExtensionPathsEffect } from "../extensions/npm-extensions.js";
import { deriveCliIdentity } from "./identity.js";
export class StartupError extends Data.TaggedError("StartupError") {
}
const toStartupError = (error) => new StartupError({ message: error instanceof Error ? error.message : String(error) });
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
    const allExtensions = (yield* discoverExtensionsEffect()).filter((extension) => !isSafetyExtensionPath(extension));
    const npmExtensions = yield* resolveNpmExtensionPathsEffect.pipe(Effect.mapError(toStartupError));
    const extensionFlags = [...allExtensions, ...npmExtensions].flatMap((extension) => ["-e", extension]);
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
    const piEnv = {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDirPath,
        PI_SKIP_VERSION_CHECK: "1",
        HAPILON_EXTENSIONS: JSON.stringify(extensionNames(displayedExtensions)),
        HAPILON_VERSION: getVersion(),
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
