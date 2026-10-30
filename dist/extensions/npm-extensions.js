import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect } from "effect";
export class NpmExtensionError extends Data.TaggedError("NpmExtensionError") {
}
/**
 * npm 扩展接线：
 *
 * hapilon 通过 `-e` 把 node_modules 里的第三方 pi 扩展注入 pi 内核，
 * 与 hpl-* 内置扩展同一加载通道。不走 `pi install`——那会写
 * `~/.hapilon/settings.json` 的 packages，导致 subagent session 重新发现
 * 并激活这些扩展（pi-subagents 明确要求 subagent 不激活自身）。
 *
 * 入口解析用 createRequire 从 hapilon 自身安装位置出发（不依赖 cwd），
 * 这样用户在任意目录启动 hapilon 都能找到正确版本的扩展。
 */
/** 纳入 hapilon 的第三方扩展（npm 包名 → 包内扩展入口）；需先于 hpl 组加载的见 NPM_EXTENSIONS_BEFORE_HPL */
const NPM_EXTENSIONS = [
    ["@tintinweb/pi-tasks", "dist/index.js"],
    ["@tintinweb/pi-subagents", "dist/index.js"],
    // 集成四包（入口取自各包 pi.extensions 声明，原型验证过）
    ["@ff-labs/pi-fff", "src/index.ts"],
    ["@zhushanwen/pi-ask-user", "index.ts"],
    ["@narumitw/pi-btw", "dist/index.ts"],
    ["pi-web-access", "index.ts"],
    // goal 自治循环：任务树/自动续跑/auditor 完成门。goalsRoot 经 startup 注入
    // PI_GOAL_ROOT 重定向到项目 .hapilon/goals；auditor 走 createAgentSession
    // 程序化派生，不经 Agent/TaskExecute 工具，故 hpl-subagent-models 不改写其模型
    // （settings 不配 model 时回落当前会话模型，跟随 model-tiers）；
    // maxAutonomousRuns 默认值由 ensure-configs 种子到 agentDir 的 pi-goal-x-settings.json。
    ["pi-goal-x", "extensions/goal.ts"],
    // MCP 桥接已切 pi 内置（builtin:mcp）：agentDir/mcp.json 由内核直接读取，不再需要 adapter 扩展。
    // 后台任务原语（background/monitor/jobs 三 tool）：命令退出经
    // pi.sendMessage(triggerTurn) 唤醒 agent。选极简版 @nklisch 而非
    // ismailsaleekh 主包——主包 /tasks 与 pi-tasks 撞名且带 Fusion 等冗余。
    // setStatus key "background-tasks" 与 hpl-orchestra "team" 不冲突。
    // 注意 background 直通 /bin/sh 不经 hpl-safety-gate（v1 接受）。
    ["@nklisch/pi-background-tasks", "extensions/background-tasks.ts"],
    // 上下文增量压缩（billion-context / ACP）：进程内 acp-kernel，注入
    // compress/decompress/search_context/acp_status 模型侧工具与 /acp 系命令。
    // 它会 cancel pi 原生 compaction（session_before_compact 钩子）——压缩权移交。
    // ⚠ 互斥：永不与 `bili plugin install pi` 的 native 形态双开（双压）。
    // 内置 delegate subagent 由 hapilon 种子的 ~/.pi/acp.json（delegate.enabled:false）关闭。
    ["billion-context-pi", "dist/index.js"],
    // 计算机与浏览器驾驶（实测对过的扩展）：
    // computer-use 走 Cua Driver（macOS 需辅助功能+屏幕录制权限），工具前缀 computer_use_*；
    // browser-use 拉起 chrome-devtools-mcp 子进程，工具前缀 browser_*，Electron 应用可挂远程调试端口。
    // 两者都只在主会话可用（-e 不进 subagent），S7 的实测驾驶由主会话执行。
    ["@amaster.ai/pi-computer-use", "dist/index.js"],
    ["@amaster.ai/pi-browser-use", "dist/index.js"],
];
/**
 * 先于 hpl 组加载的 npm 扩展。ponytail 5.x 改用结构化 sections 注入
 * （systemPromptOptions.sections），而 pi 中 forceSystemPrompt 与 sections
 * 互斥——它必须排在 hpl-system-prompt 之前，贡献才会被内联进全量替换的
 * prompt 尾部（见 assembleSystemPrompt 的 extensionSections）。
 * 顺序由 startup 的拼接序 + npm-extensions.test + ponytail-load-order 集成测试钉死。
 */
export const NPM_EXTENSIONS_BEFORE_HPL = [
    ["@dietrichgebert/ponytail", "pi-extension/index.js"],
];
/**
 * 解析单个包的扩展入口（导出仅为可测试性）。
 * resolve 抛错即包不存在或子路径被 exports 锁死——由降级逻辑与调用方处理。
 */
function findNodeModulesPackageDir(pkg) {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
        const candidate = join(dir, "node_modules", pkg);
        if (existsSync(join(candidate, "package.json")))
            return candidate;
        const parent = dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
}
export function resolveExtensionEntry(pkg, entry, resolve) {
    // 主路径：resolve <pkg>/package.json 再拼入口。
    // 部分包（如 ponytail）用 exports 字段锁死子路径，
    // `./package.json` 不在白名单 → ERR_PACKAGE_PATH_NOT_EXPORTED。
    // 降级：resolve 包主入口，从其目录**向上找包根**（含 package.json 的目录）
    // 再拼接——主入口可能在深层子目录（ponytail 的主入口在 .opencode/plugins/），
    // 直接 dirname 拼接会错位。
    let pkgDir;
    try {
        pkgDir = dirname(resolve(`${pkg}/package.json`));
    }
    catch (err) {
        const locked = err instanceof Error && "code" in err && err.code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
        if (!locked)
            throw err;
        // 降级链：① resolve 包主入口再向上找包根（ponytail 布局）；
        // ② 主入口也被 exports 锁（如 billion-context-pi 只开放 import 条件）时，
        //    从本模块位置向上找 node_modules/<pkg> 包根。
        let dir;
        try {
            dir = dirname(resolve(pkg));
        }
        catch {
            dir = findNodeModulesPackageDir(pkg);
        }
        while (dir !== undefined && dir !== dirname(dir) && !existsSync(join(dir, "package.json"))) {
            dir = dirname(dir);
        }
        if (dir === undefined || !existsSync(join(dir, "package.json"))) {
            throw new Error(`[hapilon] npm 扩展降级寻址失败：${pkg} 找不到含 package.json 的包根`);
        }
        pkgDir = dir;
    }
    const path = join(pkgDir, entry);
    if (!existsSync(path)) {
        throw new Error(`[hapilon] npm 扩展入口缺失：${pkg} 应有 ${entry}，实际路径 ${path} 不存在。` +
            `请重新 npm install，或检查 ${pkg} 的版本（pi.extensions 布局可能已变更）。`);
    }
    return path;
}
/**
 * 解析所有 npm 扩展的绝对入口路径。
 *
 * 包缺失时 fail fast：直接抛错而不是静默跳过——扩展是声明式依赖，
 * 缺了就是安装损坏，应该立刻爆出来（原则：Errors Never Pass Silently）。
 *
 * @returns 入口绝对路径数组（与 NPM_EXTENSIONS 声明顺序一致）
 */
export function resolveNpmExtensionPaths() {
    const result = Effect.runSync(Effect.either(resolveNpmExtensionPathsEffect));
    if (result._tag === "Left")
        throw new Error(result.left.message);
    return result.right;
}
export const resolveExtensionEntryEffect = (pkg, entry, resolve) => Effect.try({
    try: () => resolveExtensionEntry(pkg, entry, resolve),
    catch: (err) => new NpmExtensionError({ message: err instanceof Error ? err.message : String(err) }),
});
/** 解析需先于 hpl 组加载的 npm 扩展入口（与 NPM_EXTENSIONS_BEFORE_HPL 同序） */
export const resolveNpmExtensionsBeforeHplEffect = Effect.gen(function* () {
    const require = createRequire(import.meta.url);
    return yield* Effect.forEach(NPM_EXTENSIONS_BEFORE_HPL, ([pkg, entry]) => resolveExtensionEntryEffect(pkg, entry, (id) => require.resolve(id)));
});
export const resolveNpmExtensionPathsEffect = Effect.gen(function* () {
    const require = createRequire(import.meta.url);
    return yield* Effect.forEach(NPM_EXTENSIONS, ([pkg, entry]) => resolveExtensionEntryEffect(pkg, entry, (id) => require.resolve(id)));
});
