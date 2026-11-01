import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync, } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { argv } from "node:process";
import { Data, Effect } from "effect";
import { hapilonHome } from "../config/hapilon-home.js";
export class HerdrSetupError extends Data.TaggedError("HerdrSetupError") {
}
// ─── 内置资产 ─────────────────────────────────────────────────────────
// 双子图标：大圆右上咬一口，小点嵌在缺口里（对比盲文/小屋方案后定稿）
const GEMINI_ICON_SVG = '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>hapilon</title>' +
    '<defs><mask id="bite"><rect width="24" height="24" fill="#fff"/><circle cx="17.5" cy="6.5" r="4.6" fill="#000"/></mask></defs>' +
    '<circle cx="10.5" cy="13.5" r="7.2" mask="url(#bite)"/>' +
    '<circle cx="17.5" cy="6.5" r="2.4"/>' +
    '</svg>\n';
const PROGRAM_ENTRY = {
    name: "Hapilon",
    icon: "", // setup 时按内容 hash 填
    run: ["hapilon"],
    tint: true,
    tile: "#1c1d21",
    color: "#ffffff",
};
// ─── 纯函数（单测覆盖） ────────────────────────────────────────────────
export function shimScript(cliPath, home) {
    return `#!/bin/sh\n# herdr-app start-agent 检测用的可执行入口（setup-herdr 生成）\nHAPILON_HOME="${home}" exec node "${cliPath}" "$@"\n`;
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
        const icon = iconFileName(GEMINI_ICON_SVG);
        const entry = { ...PROGRAM_ENTRY, icon: `my-icons/${icon}` };
        // 图标：按内容 hash 命名——herdr 按 icon 路径缓存 SVG 内容，同路径覆盖写不刷新，
        // 内容变化时换新文件名；旧 hapilon-*.svg 清掉防堆积
        const myIcons = join(herdrDir, "my-icons");
        mkdirSync(myIcons, { recursive: true });
        yield* writeTextEffect(join(myIcons, icon), GEMINI_ICON_SVG);
        for (const f of readdirSync(myIcons)) {
            if (f.startsWith("hapilon-") && f !== icon)
                unlinkSync(join(myIcons, f));
        }
        // shim：~/.local/bin/hapilon + hapi 链接（start-agent 菜单按「本机是否装了命令」过滤）
        const localBin = join(homedir(), ".local", "bin");
        mkdirSync(localBin, { recursive: true });
        const shimPath = join(localBin, "hapilon");
        yield* writeTextEffect(shimPath, shimScript(cliPath, home), 0o755);
        yield* forceSymlinkEffect("hapilon", join(localBin, "hapi"));
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
