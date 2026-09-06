/**
 * sandbox.ts — OS 沙箱支持（--sandbox flag）
 *
 * 目前提供 Linux bwrap 预检（issue #5）：
 * - bwrapInstalled(): bwrap 是否可用
 * - bwrapInstallHint(): bwrap 缺失时的发行版安装提示
 *
 * 拆为独立模块：cli.ts 顶层有 await main() 副作用，测试不直接 import。
 */
import { spawnSync } from "node:child_process";
import { Effect } from "effect";
/**
 * 检测 bwrap 是否可用（`which bwrap`，PATH 外不可见则视为缺失）。
 * spawnFn 可注入（测试用）；默认走真实 spawnSync。
 */
export const bwrapInstalledEffect = (spawnFn = spawnSync) => Effect.try({
    try: () => spawnFn("which", ["bwrap"], { stdio: "ignore" }).status === 0,
    catch: (err) => err,
}).pipe(Effect.catchAll(() => Effect.succeed(false)));
export function bwrapInstalled(spawnFn = spawnSync) {
    const result = Effect.runSync(Effect.either(bwrapInstalledEffect(spawnFn)));
    if (result._tag === "Left")
        throw new Error(result.left.message);
    return result.right;
}
/** bwrap 缺失时的发行版安装提示（纯文本，供测试断言） */
export function bwrapInstallHint() {
    return [
        "🛡️  --sandbox 需要 bubblewrap (bwrap) 支持。请先安装：",
        "  • Debian/Ubuntu: sudo apt install bubblewrap",
        "  • Fedora/RHEL:   sudo dnf install bubblewrap",
        "  • Arch:          sudo pacman -S bubblewrap",
    ];
}
