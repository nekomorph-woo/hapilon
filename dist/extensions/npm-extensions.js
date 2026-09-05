import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
/**
 * npm 扩展接线（#37）：
 *
 * hapilon 通过 `-e` 把 node_modules 里的第三方 pi 扩展注入 pi 内核，
 * 与 hpl-* 内置扩展同一加载通道。不走 `pi install`——那会写
 * `~/.hapilon/settings.json` 的 packages，导致 subagent session 重新发现
 * 并激活这些扩展（pi-subagents 明确要求 subagent 不激活自身）。
 *
 * 入口解析用 createRequire 从 hapilon 自身安装位置出发（不依赖 cwd），
 * 这样用户在任意目录启动 hapilon 都能找到正确版本的扩展。
 */
/** 纳入 hapilon 的第三方扩展（npm 包名 → 包内扩展入口） */
const NPM_EXTENSIONS = [
    ["@tintinweb/pi-tasks", "dist/index.js"],
    ["@tintinweb/pi-subagents", "dist/index.js"],
    // #43 集成四包（入口取自各包 pi.extensions 声明，#42 原型验证过）
    ["@ff-labs/pi-fff", "src/index.ts"],
    ["@zhushanwen/pi-ask-user", "index.ts"],
    ["@narumitw/pi-btw", "dist/index.ts"],
    ["pi-web-access", "index.ts"],
    // #49 MCP 桥接（入口取自包内 pi.extensions 声明）
    ["pi-mcp-adapter", "index.ts"],
    // #55 极简编码规则（防御性编程减脂）。必须在末位：其 before_agent_start
    // 是「尾部追加」语义，先于 hpl-system-prompt（全量替换）执行会被抹掉。
    // 顺序由 npm-extensions.test.ts 的末位断言 + ponytail-load-order 集成测试钉死。
    ["@dietrichgebert/ponytail", "pi-extension/index.js"],
];
/**
 * 解析单个包的扩展入口（导出仅为可测试性）。
 * resolve 抛错即包不存在或子路径被 exports 锁死——由降级逻辑与调用方处理。
 */
export function resolveExtensionEntry(pkg, entry, resolve) {
    // 主路径：resolve <pkg>/package.json 再拼入口。
    // 部分包（如 pi-mcp-adapter，#49；ponytail，#55）用 exports 字段锁死子路径，
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
        let dir = dirname(resolve(pkg));
        while (dir !== dirname(dir) && !existsSync(join(dir, "package.json"))) {
            dir = dirname(dir);
        }
        if (!existsSync(join(dir, "package.json"))) {
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
    // 从本模块位置解析（dist/npm-extensions.js），锚定 hapilon 的 node_modules
    const require = createRequire(import.meta.url);
    return NPM_EXTENSIONS.map(([pkg, entry]) => resolveExtensionEntry(pkg, entry, (id) => require.resolve(id)));
}
