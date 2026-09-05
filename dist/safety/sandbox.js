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
/**
 * 检测 bwrap 是否可用（`which bwrap`，PATH 外不可见则视为缺失）。
 * spawnFn 可注入（测试用）；默认走真实 spawnSync。
 */
export function bwrapInstalled(spawnFn = spawnSync) {
    try {
        const r = spawnFn("which", ["bwrap"], { stdio: "ignore" });
        return r.status === 0;
    }
    catch {
        return false;
    }
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
