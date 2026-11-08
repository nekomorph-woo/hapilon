import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync, } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { argv, execPath, platform } from "node:process";
import { Data, Effect } from "effect";
import { hapilonHome } from "../config/hapilon-home.js";
export class HerdrSetupError extends Data.TaggedError("HerdrSetupError") {
}
// ─── 内置资产 ─────────────────────────────────────────────────────────
// 三球图标：白月球右上被琥珀太阳咬、左下被蓝地球（青绿大陆斑）咬；颜色内置（tint:false）。
// 地球挖口缝 1.5 是极限档 16px 可辨的上限——太阳同宽的 2.2 会把月牙挤到看不见
const GEMINI_ICON_SVG = '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>hapilon</title>' +
    '<defs><mask id="bite"><rect width="24" height="24" fill="#fff"/><circle cx="17.5" cy="6.5" r="4.6" fill="#000"/><circle cx="5.9" cy="18.1" r="6.1" fill="#000"/></mask>' +
    '<clipPath id="globe"><circle cx="5.9" cy="18.1" r="4.6"/></clipPath></defs>' +
    '<circle cx="10.5" cy="13.5" r="7.2" fill="#ffffff" mask="url(#bite)"/>' +
    '<circle cx="17.5" cy="6.5" r="2.4" fill="#FFB020"/>' +
    '<g clip-path="url(#globe)"><circle cx="5.9" cy="18.1" r="4.6" fill="#4DA3FF"/>' +
    '<ellipse cx="4.8" cy="16.8" rx="2" ry="1.2" fill="#2DD4BF" transform="rotate(-24 4.8 16.8)"/>' +
    '<ellipse cx="7.5" cy="19.5" rx="1.49" ry="0.95" fill="#2DD4BF" transform="rotate(28 7.5 19.5)"/></g>' +
    '</svg>\n';
const PROGRAM_ENTRY = {
    name: "Hapilon",
    icon: "", // setup 时按内容 hash 填
    run: ["hapilon"],
    tint: false, // 图标自带颜色
    tile: "#1c1d21",
    color: "#ffffff",
};
// ─── 纯函数（单测覆盖） ────────────────────────────────────────────────
/** shim 双形态：POSIX 走 sh，Windows 产 .cmd（herdr 拿 sh 脚本在 Windows 无法执行）。
 * nodePath 写死绝对路径：hc run / GUI 派生的终端不加载 shell 配置，PATH 里可能没有 nvm 的 node */
export function shimScript(cliPath, home, windows = false, nodePath = execPath) {
    if (windows) {
        return `@echo off\nrem herdr-app start-agent 检测用的可执行入口（setup-herdr 生成）\nset "HAPILON_HOME=${home}"\n"${nodePath}" "${cliPath}" %*\n`;
    }
    return `#!/bin/sh\n# herdr-app start-agent 检测用的可执行入口（setup-herdr 生成）\nHAPILON_HOME="${home}" exec "${nodePath}" "${cliPath}" "$@"\n`;
}
export function iconFileName(svg) {
    const hash = createHash("sha256").update(svg).digest("hex").slice(0, 8);
    return `hapilon-${hash}.svg`;
}
/** 合并 hapilon 条目进 programs.json 原文；raw 为 null 表示新建。其余条目原样保留 */
export function mergePrograms(raw, entry) {
    let data;
    try {
        data = raw ? JSON.parse(raw) : {};
    }
    catch {
        throw new Error("programs.json 不是合法 JSON，请手工修复后重跑 setup-herdr");
    }
    const programs = { ...(data.programs ?? {}), hapilon: entry };
    return JSON.stringify({ ...data, programs }, null, 2) + "\n";
}
/** 从当前进程推导运行形态：dev checkout 里跑出 dev shim，release 安装跑出 release shim */
export function deriveShimInputs() {
    const cliPath = realpathSync(argv[1] ?? "");
    return { cliPath, home: hapilonHome() };
}
// ─── 文件写入 Effect ──────────────────────────────────────────────────
const writeTextEffect = (path, content, mode) => Effect.try({
    try: () => {
        writeFileSync(path, content, "utf8");
        if (mode !== undefined)
            chmodSync(path, mode);
    },
    catch: (err) => new HerdrSetupError({ message: `写入 ${path} 失败: ${err instanceof Error ? err.message : String(err)}` }),
});
const forceSymlinkEffect = (target, linkPath) => Effect.try({
    try: () => {
        try {
            unlinkSync(linkPath);
        }
        catch {
            // 不存在即目标状态
        }
        symlinkSync(target, linkPath);
    },
    catch: (err) => new HerdrSetupError({ message: `创建链接 ${linkPath} 失败: ${err instanceof Error ? err.message : String(err)}` }),
});
// ─── 主流程 ───────────────────────────────────────────────────────────
export function setupHerdr() {
    const program = Effect.gen(function* () {
        const herdrDir = join(homedir(), ".config", "herdr-app");
        if (!existsSync(herdrDir)) {
            console.log("未检测到 herdr-app（~/.config/herdr-app 不存在）。先安装 herdr-app，再跑本命令。");
            return;
        }
        const { cliPath, home } = deriveShimInputs();
        const isWin = platform === "win32";
        const localBin = join(homedir(), ".local", "bin");
        mkdirSync(localBin, { recursive: true });
        const icon = iconFileName(GEMINI_ICON_SVG);
        // Windows 上 run 写 shim 完整路径：herdr 不经 shell spawn，裸命令名解析不到 .cmd
        const entry = { ...PROGRAM_ENTRY, icon: `my-icons/${icon}`, ...(isWin ? { run: [join(localBin, "hapilon.cmd")] } : {}) };
        // 图标：按内容 hash 命名——herdr 按 icon 路径缓存 SVG 内容，同路径覆盖写不刷新，
        // 内容变化时换新文件名；旧 hapilon-*.svg 清掉防堆积
        const myIcons = join(herdrDir, "my-icons");
        mkdirSync(myIcons, { recursive: true });
        yield* writeTextEffect(join(myIcons, icon), GEMINI_ICON_SVG);
        for (const f of readdirSync(myIcons)) {
            if (f.startsWith("hapilon-") && f !== icon)
                unlinkSync(join(myIcons, f));
        }
        // shim：~/.local/bin/hapilon(+cmd) + hapi 链接（start-agent 菜单按「本机是否装了命令」过滤）
        // Windows 无符号链接特权要求，两个 .cmd 都直写
        const shimPath = join(localBin, isWin ? "hapilon.cmd" : "hapilon");
        yield* writeTextEffect(shimPath, shimScript(cliPath, home, isWin), isWin ? undefined : 0o755);
        if (isWin) {
            yield* writeTextEffect(join(localBin, "hapi.cmd"), shimScript(cliPath, home, isWin));
        }
        else {
            yield* forceSymlinkEffect("hapilon", join(localBin, "hapi"));
        }
        // programs.json：合并写，保留用户其他条目
        const programsPath = join(herdrDir, "programs.json");
        const raw = existsSync(programsPath) ? readFileSync(programsPath, "utf8") : null;
        yield* writeTextEffect(programsPath, mergePrograms(raw, entry));
        console.log("herdr-app 集成就绪：");
        console.log(`  图标    ${join(myIcons, icon)}`);
        console.log(`  入口    ${shimPath}（HAPILON_HOME=${home}）`);
        console.log(`  程序表  ${programsPath}`);
        console.log("programs.json 热生效；herdr 里 ⌥⌘A 即可启动 Hapilon。");
    });
    return Effect.runPromise(program).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`setup-herdr 失败: ${msg}`);
        process.exitCode = 1;
    });
}
